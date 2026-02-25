#!/usr/bin/env bash

_git_snapshot_repo_resolve_root_most() {
  local start_dir="${1:-$PWD}"
  local repo_root

  if ! repo_root="$(git -C "${start_dir}" rev-parse --show-toplevel 2>/dev/null)"; then
    _git_snapshot_ui_err "Current directory is not inside a git repository: ${start_dir}"
    return 1
  fi

  repo_root="$(cd "${repo_root}" && pwd -P)"

  local super
  while true; do
    super="$(git -C "${repo_root}" rev-parse --show-superproject-working-tree 2>/dev/null || true)"
    if [[ -z "${super}" ]]; then
      break
    fi
    repo_root="$(cd "${super}" && pwd -P)"
  done

  printf "%s\n" "${repo_root}"
}

_git_snapshot_repo_assert_under_enforced_prefix() {
  local root_repo="$1"
  local enforce_prefix="${GIT_SNAPSHOT_ENFORCE_ROOT_PREFIX:-}"

  if [[ -z "${enforce_prefix}" ]]; then
    return 0
  fi

  local prefix_real root_real

  if ! prefix_real="$(cd "${enforce_prefix}" && pwd -P 2>/dev/null)"; then
    _git_snapshot_ui_err "GIT_SNAPSHOT_ENFORCE_ROOT_PREFIX does not exist or is not accessible: ${enforce_prefix}"
    return 1
  fi

  root_real="$(cd "${root_repo}" && pwd -P)"

  if [[ "${root_real}" == "${prefix_real}" ]]; then
    return 0
  fi

  case "${root_real}/" in
    "${prefix_real}/"*) return 0 ;;
  esac

  _git_snapshot_ui_err "Refusing to operate outside enforced prefix. root_repo=${root_real}, enforced_prefix=${prefix_real}"
  return 1
}

_git_snapshot_repo_collect_all_relative_paths() {
  local root_repo="$1"

  printf ".\n"

  local line path
  while IFS= read -r line; do
    [[ -z "${line}" ]] && continue
    line="${line#[-+ U]}"
    path="${line#* }"
    path="${path%% *}"
    [[ -z "${path}" ]] && continue
    printf "%s\n" "${path}"
  done < <(git -C "${root_repo}" submodule status --recursive 2>/dev/null || true)
}

_git_snapshot_repo_collect_dirty_relative_paths() {
  local root_repo="$1"
  local rel repo_abs

  while IFS= read -r rel; do
    repo_abs="${root_repo}/${rel}"
    if [[ -n "$(git -C "${repo_abs}" status --porcelain=v1 --untracked-files=all 2>/dev/null || true)" ]]; then
      printf "%s\n" "${rel}"
    fi
  done < <(_git_snapshot_repo_collect_all_relative_paths "${root_repo}")
}
