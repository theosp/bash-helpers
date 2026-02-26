#!/usr/bin/env bash

_git_snapshot_restore_assert_patch_bundle_format() {
  local patch_file="$1"

  if [[ ! -s "${patch_file}" ]]; then
    return 0
  fi

  if ! grep -q '^diff --git ' "${patch_file}"; then
    _git_snapshot_ui_err "Invalid patch bundle format: ${patch_file}"
    return 1
  fi

  return 0
}

_git_snapshot_restore_validate_untracked_tar() {
  local tar_file="$1"
  local entry

  if [[ ! -f "${tar_file}" ]]; then
    return 0
  fi

  if ! tar -tf "${tar_file}" >/dev/null 2>&1; then
    _git_snapshot_ui_err "Invalid untracked tar bundle format: ${tar_file}"
    return 1
  fi

  while IFS= read -r entry; do
    [[ -z "${entry}" ]] && continue

    case "${entry}" in
      /*|..|../*|*/../*|*/..)
        _git_snapshot_ui_err "Unsafe untracked tar entry detected: ${entry}"
        return 1
        ;;
    esac
  done < <(tar -tf "${tar_file}")

  return 0
}

_git_snapshot_restore_single_repo() {
  local repo_abs="$1"
  local repo_bundle_dir="$2"

  git -C "${repo_abs}" reset --hard >/dev/null || return 1
  git -C "${repo_abs}" clean -fd >/dev/null || return 1

  if [[ -s "${repo_bundle_dir}/staged.patch" ]]; then
    _git_snapshot_restore_assert_patch_bundle_format "${repo_bundle_dir}/staged.patch" || return 1
    git -C "${repo_abs}" apply --check --binary --whitespace=nowarn --index "${repo_bundle_dir}/staged.patch" || return 1
    git -C "${repo_abs}" apply --binary --whitespace=nowarn --index "${repo_bundle_dir}/staged.patch" || return 1
  fi

  if [[ -s "${repo_bundle_dir}/unstaged.patch" ]]; then
    _git_snapshot_restore_assert_patch_bundle_format "${repo_bundle_dir}/unstaged.patch" || return 1
    git -C "${repo_abs}" apply --check --binary --whitespace=nowarn "${repo_bundle_dir}/unstaged.patch" || return 1
    git -C "${repo_abs}" apply --binary --whitespace=nowarn "${repo_bundle_dir}/unstaged.patch" || return 1
  fi

  if [[ -f "${repo_bundle_dir}/untracked.tar" ]]; then
    _git_snapshot_restore_validate_untracked_tar "${repo_bundle_dir}/untracked.tar" || return 1
    tar -xf "${repo_bundle_dir}/untracked.tar" -C "${repo_abs}" || return 1
  fi
}

_git_snapshot_restore_with_optional_rollback() {
  local root_repo="$1"
  local target_snapshot_id="$2"
  local skip_safety_snapshot="${3:-false}"

  local target_snapshot_path
  target_snapshot_path="$(_git_snapshot_store_snapshot_path "${root_repo}" "${target_snapshot_id}")"

  _git_snapshot_store_assert_snapshot_exists "${root_repo}" "${target_snapshot_id}"

  local safety_snapshot_id=""
  if [[ "${skip_safety_snapshot}" != "true" ]]; then
    safety_snapshot_id="$(_git_snapshot_create_internal "${root_repo}" "safety-before-restore-${target_snapshot_id}" false)"
    _git_snapshot_ui_info "Created safety snapshot: ${safety_snapshot_id}"
  fi

  local restore_failed=false
  local mismatch_lines=()
  local rel_path head_expected current_head repo_abs repo_bundle_dir status_hash_expected status_hash_actual repo_id human_repo_label

  # Apply bundles for all repos first. Parent repo status can depend on nested
  # submodule working-tree state, so status-hash verification must run after
  # the full apply pass completes.
  while IFS=$'\t' read -r repo_id rel_path head_expected _status_hash_expected; do
    [[ -z "${repo_id}" ]] && continue
    repo_abs="${root_repo}/${rel_path}"
    human_repo_label="$(_git_snapshot_ui_human_repo_label "${root_repo}" "${rel_path}")"
    repo_bundle_dir="$(_git_snapshot_store_repo_dir_for_id "${target_snapshot_path}" "${repo_id}")"

    current_head="$(git -C "${repo_abs}" rev-parse HEAD 2>/dev/null || true)"
    if [[ "${current_head}" != "${head_expected}" ]]; then
      _git_snapshot_ui_warn "HEAD mismatch for ${human_repo_label}: snapshot=${head_expected}, current=${current_head}; attempting best-effort restore."
    fi

    if ! _git_snapshot_restore_single_repo "${repo_abs}" "${repo_bundle_dir}"; then
      _git_snapshot_ui_err "Restore failed while applying bundles for repo=${human_repo_label}"
      restore_failed=true
      break
    fi
  done < <(_git_snapshot_store_read_repo_entries "${target_snapshot_path}")

  if [[ "${restore_failed}" != "true" ]]; then
    while IFS=$'\t' read -r repo_id rel_path _head_expected status_hash_expected; do
      [[ -z "${repo_id}" ]] && continue
      repo_abs="${root_repo}/${rel_path}"
      human_repo_label="$(_git_snapshot_ui_human_repo_label "${root_repo}" "${rel_path}")"
      status_hash_actual="$(_git_snapshot_status_hash_for_repo "${repo_abs}")"
      if [[ "${status_hash_actual}" != "${status_hash_expected}" ]]; then
        mismatch_lines+=("${human_repo_label}: expected=${status_hash_expected} actual=${status_hash_actual}")
        restore_failed=true
      fi
    done < <(_git_snapshot_store_read_repo_entries "${target_snapshot_path}")
  fi

  if [[ "${restore_failed}" == "true" ]]; then
    for line in "${mismatch_lines[@]:-}"; do
      [[ -n "${line}" ]] && _git_snapshot_ui_err "Status hash mismatch: ${line}"
    done

    if [[ -n "${safety_snapshot_id}" ]]; then
      _git_snapshot_ui_warn "Attempting automatic rollback using safety snapshot ${safety_snapshot_id}"
      if ! _git_snapshot_restore_with_optional_rollback "${root_repo}" "${safety_snapshot_id}" true; then
        _git_snapshot_ui_err "Rollback failed. Repository may be partially restored."
        return 1
      fi
      _git_snapshot_ui_warn "Rollback completed."
    fi

    return 1
  fi

  _git_snapshot_ui_info "Restore completed successfully for snapshot ${target_snapshot_id}."
}
