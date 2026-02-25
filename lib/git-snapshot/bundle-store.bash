#!/usr/bin/env bash

_git_snapshot_store_root_for_repo() {
  local root_repo="$1"
  local repo_name

  repo_name="$(basename "${root_repo}")"
  printf "%s/git-snapshots/%s\n" "${HOME}" "${repo_name}"
}

_git_snapshot_store_ensure_dirs() {
  local root_repo="$1"
  mkdir -p "$(_git_snapshot_store_root_for_repo "${root_repo}")"
}

_git_snapshot_store_new_snapshot_id() {
  local label="${1:-snapshot}"
  local ts

  ts="$(date +%Y%m%d-%H%M%S)"
  printf "%s-%s-%s-%s\n" "${label}" "${ts}" "$$" "${RANDOM}"
}

_git_snapshot_store_snapshot_path() {
  local root_repo="$1"
  local snapshot_id="$2"

  printf "%s/%s\n" "$(_git_snapshot_store_root_for_repo "${root_repo}")" "${snapshot_id}"
}

_git_snapshot_store_assert_snapshot_exists() {
  local root_repo="$1"
  local snapshot_id="$2"
  local snapshot_path

  snapshot_path="$(_git_snapshot_store_snapshot_path "${root_repo}" "${snapshot_id}")"
  if [[ ! -d "${snapshot_path}" ]]; then
    _git_snapshot_ui_err "Snapshot not found: ${snapshot_id}"
    return 1
  fi
}

_git_snapshot_store_list_snapshot_ids() {
  local root_repo="$1"
  local snapshots_root

  snapshots_root="$(_git_snapshot_store_root_for_repo "${root_repo}")"
  if [[ ! -d "${snapshots_root}" ]]; then
    return 0
  fi

  find "${snapshots_root}" -mindepth 1 -maxdepth 1 -type d -print 2>/dev/null | xargs -n1 basename | sort
}

_git_snapshot_store_write_snapshot_meta() {
  local snapshot_path="$1"
  local snapshot_id="$2"
  local root_repo="$3"
  local repo_count="$4"

  {
    printf "SNAPSHOT_ID=%q\n" "${snapshot_id}"
    printf "CREATED_AT_EPOCH=%q\n" "$(date +%s)"
    printf "ROOT_REPO=%q\n" "${root_repo}"
    printf "REPO_COUNT=%q\n" "${repo_count}"
  } > "${snapshot_path}/meta.env"
}

_git_snapshot_store_load_snapshot_meta() {
  local snapshot_path="$1"
  # shellcheck source=/dev/null
  source "${snapshot_path}/meta.env"
}

_git_snapshot_store_repo_dir_for_id() {
  local snapshot_path="$1"
  local repo_id="$2"
  printf "%s/repos/%s\n" "${snapshot_path}" "${repo_id}"
}

_git_snapshot_store_write_repo_entry() {
  local repos_tsv="$1"
  local repo_id="$2"
  local rel_path="$3"
  local head="$4"
  local status_hash="$5"

  printf "%s\t%s\t%s\t%s\n" "${repo_id}" "${rel_path}" "${head}" "${status_hash}" >> "${repos_tsv}"
}

_git_snapshot_store_read_repo_entries() {
  local snapshot_path="$1"
  cat "${snapshot_path}/repos.tsv"
}
