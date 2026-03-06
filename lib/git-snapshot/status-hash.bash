#!/usr/bin/env bash

_git_snapshot_status_hash_hash_stdin() {
  shasum -a 256 | awk '{print $1}'
}

_git_snapshot_status_hash_hash_file() {
  local file_path="$1"
  shasum -a 256 "${file_path}" | awk '{print $1}'
}

_git_snapshot_status_hash_emit_untracked_signature() {
  local repo_path="$1"
  local rel_path="$2"
  local abs_path="${repo_path}/${rel_path}"
  local mode="other"
  local hash="missing"
  local symlink_target=""

  if [[ -L "${abs_path}" ]]; then
    mode="120000"
    symlink_target="$(readlink "${abs_path}" 2>/dev/null || true)"
    hash="$(printf "%s" "${symlink_target}" | _git_snapshot_status_hash_hash_stdin)"
  elif [[ -f "${abs_path}" ]]; then
    if [[ -x "${abs_path}" ]]; then
      mode="100755"
    else
      mode="100644"
    fi
    hash="$(git -C "${repo_path}" hash-object --no-filters -- "${rel_path}" 2>/dev/null || _git_snapshot_status_hash_hash_file "${abs_path}")"
  elif [[ -e "${abs_path}" ]]; then
    hash="present"
  fi

  printf "untracked\t%s\t%s\t%s\n" "${rel_path}" "${mode}" "${hash}"
}

_git_snapshot_status_hash_for_repo() {
  local repo_path="$1"
  local staged_hash=""
  local unstaged_hash=""
  local rel_path=""

  staged_hash="$(git -C "${repo_path}" diff --cached --binary | _git_snapshot_status_hash_hash_stdin)"
  unstaged_hash="$(git -C "${repo_path}" diff --binary | _git_snapshot_status_hash_hash_stdin)"

  {
    printf "staged\t%s\n" "${staged_hash}"
    printf "unstaged\t%s\n" "${unstaged_hash}"

    while IFS= read -r -d '' rel_path; do
      [[ -z "${rel_path}" ]] && continue
      _git_snapshot_status_hash_emit_untracked_signature "${repo_path}" "${rel_path}"
    done < <(git -C "${repo_path}" ls-files --others --exclude-standard -z)
  } | _git_snapshot_status_hash_hash_stdin
}
