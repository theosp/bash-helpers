#!/usr/bin/env bash

_git_snapshot_usage() {
  cat <<'USAGE'
Usage:
  git-snapshot create [snapshot_id]
  git-snapshot list
  git-snapshot show <snapshot_id>
  git-snapshot restore <snapshot_id>
  git-snapshot delete <snapshot_id>
  git-snapshot debug-dirty

Environment:
  GIT_SNAPSHOT_ENFORCE_ROOT_PREFIX=<path>  # Optional hard safety scope
  GIT_SNAPSHOT_CONFIRM_RESTORE=RESTORE      # Non-interactive restore confirmation
USAGE
}

_git_snapshot_create_internal() {
  local root_repo="$1"
  local label="${2:-snapshot}"
  local print_info="${3:-true}"

  _git_snapshot_store_ensure_dirs "${root_repo}"

  local snapshot_id snapshot_path
  snapshot_id="$(_git_snapshot_store_new_snapshot_id "${label}")"
  snapshot_path="$(_git_snapshot_store_snapshot_path "${root_repo}" "${snapshot_id}")"

  mkdir -p "${snapshot_path}/repos"

  local rel_paths=()
  local rel
  while IFS= read -r rel; do
    [[ -z "${rel}" ]] && continue
    rel_paths+=("${rel}")
  done < <(_git_snapshot_repo_collect_all_relative_paths "${root_repo}")

  local repo_count="${#rel_paths[@]}"
  _git_snapshot_store_write_snapshot_meta "${snapshot_path}" "${snapshot_id}" "${root_repo}" "${repo_count}"

  local repos_tsv="${snapshot_path}/repos.tsv"
  : > "${repos_tsv}"

  local repo_index=0
  local repo_id repo_abs repo_dir head status_hash
  local has_untracked
  local -a untracked_files=()

  for rel in "${rel_paths[@]}"; do
    repo_index=$((repo_index + 1))
    repo_id="repo-$(printf "%04d" "${repo_index}")"
    repo_abs="${root_repo}/${rel}"
    repo_dir="$(_git_snapshot_store_repo_dir_for_id "${snapshot_path}" "${repo_id}")"

    mkdir -p "${repo_dir}"

    head="$(git -C "${repo_abs}" rev-parse HEAD 2>/dev/null || true)"
    status_hash="$(_git_snapshot_status_hash_for_repo "${repo_abs}")"

    git -C "${repo_abs}" diff --cached --binary > "${repo_dir}/staged.patch"
    git -C "${repo_abs}" diff --binary > "${repo_dir}/unstaged.patch"

    has_untracked=false
    untracked_files=()
    while IFS= read -r -d '' file_path; do
      has_untracked=true
      untracked_files+=("${file_path}")
    done < <(git -C "${repo_abs}" ls-files --others --exclude-standard -z)

    if [[ "${has_untracked}" == "true" ]]; then
      (
        cd "${repo_abs}"
        tar -cf "${repo_dir}/untracked.tar" "${untracked_files[@]}"
      )
    fi

    _git_snapshot_store_write_repo_entry "${repos_tsv}" "${repo_id}" "${rel}" "${head}" "${status_hash}"
  done

  if [[ "${print_info}" == "true" ]]; then
    _git_snapshot_ui_info "Created snapshot ${snapshot_id} (repos=${repo_count})"
  fi
  printf "%s\n" "${snapshot_id}"
}

_git_snapshot_cmd_create() {
  local root_repo="$1"
  local snapshot_id_override="${2:-}"

  if [[ -n "${snapshot_id_override}" ]]; then
    _git_snapshot_store_ensure_dirs "${root_repo}"
    local path
    path="$(_git_snapshot_store_snapshot_path "${root_repo}" "${snapshot_id_override}")"
    if [[ -e "${path}" ]]; then
      _git_snapshot_ui_err "Snapshot already exists: ${snapshot_id_override}"
      return 1
    fi
  fi

  _git_snapshot_create_internal "${root_repo}" "snapshot" true
}

_git_snapshot_cmd_list() {
  local root_repo="$1"
  local snapshot_id snapshot_path

  while IFS= read -r snapshot_id; do
    [[ -z "${snapshot_id}" ]] && continue
    snapshot_path="$(_git_snapshot_store_snapshot_path "${root_repo}" "${snapshot_id}")"
    _git_snapshot_store_load_snapshot_meta "${snapshot_path}"
    printf "%s\trepos=%s\tcreated_at=%s\n" "${snapshot_id}" "${REPO_COUNT}" "${CREATED_AT_EPOCH}"
  done < <(_git_snapshot_store_list_snapshot_ids "${root_repo}")
}

_git_snapshot_cmd_show() {
  local root_repo="$1"
  local snapshot_id="$2"

  _git_snapshot_store_assert_snapshot_exists "${root_repo}" "${snapshot_id}"
  local snapshot_path
  snapshot_path="$(_git_snapshot_store_snapshot_path "${root_repo}" "${snapshot_id}")"

  _git_snapshot_store_load_snapshot_meta "${snapshot_path}"

  printf "snapshot_id=%s\n" "${SNAPSHOT_ID}"
  printf "created_at_epoch=%s\n" "${CREATED_AT_EPOCH}"
  printf "root_repo=%s\n" "${ROOT_REPO}"
  printf "repo_count=%s\n" "${REPO_COUNT}"

  local repo_id rel_path head status_hash repo_dir
  while IFS=$'\t' read -r repo_id rel_path head status_hash; do
    [[ -z "${repo_id}" ]] && continue
    repo_dir="$(_git_snapshot_store_repo_dir_for_id "${snapshot_path}" "${repo_id}")"
    printf "repo\tid=%s\tpath=%s\thead=%s\tstatus_hash=%s\tbundle_dir=%s\n" "${repo_id}" "${rel_path}" "${head}" "${status_hash}" "${repo_dir}"
  done < <(_git_snapshot_store_read_repo_entries "${snapshot_path}")
}

_git_snapshot_cmd_restore() {
  local root_repo="$1"
  local snapshot_id="$2"

  _git_snapshot_store_assert_snapshot_exists "${root_repo}" "${snapshot_id}"

  _git_snapshot_ui_warn "Restore will overwrite tracked changes and delete untracked files (ignored files stay untouched)."
  _git_snapshot_ui_warn "A safety snapshot will be created automatically before restore."
  _git_snapshot_ui_confirm_typed "Type RESTORE to continue: " "RESTORE"

  _git_snapshot_restore_with_optional_rollback "${root_repo}" "${snapshot_id}" false
}

_git_snapshot_cmd_delete() {
  local root_repo="$1"
  local snapshot_id="$2"
  local snapshot_path

  _git_snapshot_store_assert_snapshot_exists "${root_repo}" "${snapshot_id}"
  snapshot_path="$(_git_snapshot_store_snapshot_path "${root_repo}" "${snapshot_id}")"

  rm -rf "${snapshot_path}"
  _git_snapshot_ui_info "Deleted snapshot ${snapshot_id}"
}

_git_snapshot_cmd_debug_dirty() {
  local root_repo="$1"
  _git_snapshot_repo_collect_dirty_relative_paths "${root_repo}"
}

git_snapshot_main() {
  local command="${1:-}"
  shift || true

  if [[ -z "${command}" ]]; then
    _git_snapshot_usage
    return 1
  fi

  local root_repo
  root_repo="$(_git_snapshot_repo_resolve_root_most "${PWD}")"
  _git_snapshot_repo_assert_under_enforced_prefix "${root_repo}"

  case "${command}" in
    create)
      _git_snapshot_cmd_create "${root_repo}" "${1:-}"
      ;;
    list)
      _git_snapshot_cmd_list "${root_repo}"
      ;;
    show)
      if [[ -z "${1:-}" ]]; then
        _git_snapshot_ui_err "Missing snapshot_id for show"
        return 1
      fi
      _git_snapshot_cmd_show "${root_repo}" "${1}"
      ;;
    restore)
      if [[ -z "${1:-}" ]]; then
        _git_snapshot_ui_err "Missing snapshot_id for restore"
        return 1
      fi
      _git_snapshot_cmd_restore "${root_repo}" "${1}"
      ;;
    delete)
      if [[ -z "${1:-}" ]]; then
        _git_snapshot_ui_err "Missing snapshot_id for delete"
        return 1
      fi
      _git_snapshot_cmd_delete "${root_repo}" "${1}"
      ;;
    debug-dirty)
      _git_snapshot_cmd_debug_dirty "${root_repo}"
      ;;
    *)
      _git_snapshot_ui_err "Unknown command: ${command}"
      _git_snapshot_usage
      return 1
      ;;
  esac
}
