#!/usr/bin/env bash

_git_snapshot_ui_err() {
  printf "[git-snapshot] ERROR: %s\n" "$*" >&2
}

_git_snapshot_ui_warn() {
  printf "[git-snapshot] WARNING: %s\n" "$*" >&2
}

_git_snapshot_ui_info() {
  printf "[git-snapshot] %s\n" "$*"
}

_git_snapshot_ui_confirm_typed() {
  local prompt="$1"
  local expected="$2"

  if [[ "${GIT_SNAPSHOT_CONFIRM_RESTORE:-}" == "${expected}" ]]; then
    return 0
  fi

  if [[ ! -t 0 ]]; then
    _git_snapshot_ui_err "Confirmation required (${expected}) but stdin is not interactive. Set GIT_SNAPSHOT_CONFIRM_RESTORE=${expected}."
    return 1
  fi

  local typed=""
  printf "%s" "${prompt}" >&2
  IFS= read -r typed

  if [[ "${typed}" != "${expected}" ]]; then
    _git_snapshot_ui_err "Confirmation mismatch. Expected '${expected}'."
    return 1
  fi

  return 0
}
