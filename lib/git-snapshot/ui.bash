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

_git_snapshot_ui_human_repo_label() {
  local root_repo="$1"
  local rel_path="$2"

  if [[ "${rel_path}" == "." ]]; then
    basename "${root_repo}"
    return 0
  fi

  printf "%s" "${rel_path}"
}

_git_snapshot_ui_confirm_yes_no() {
  local prompt="$1"
  local env_var_name="$2"
  local env_expected="$3"
  local env_val=""

  if [[ -n "${env_var_name}" ]]; then
    env_val="${!env_var_name:-}"
  fi
  if [[ -n "${env_val}" && "${env_val}" == "${env_expected}" ]]; then
    return 0
  fi

  if [[ ! -t 0 ]]; then
    _git_snapshot_ui_err "Confirmation required ([y/N]) but stdin is not interactive. Set ${env_var_name}=${env_expected} or use --yes."
    return 1
  fi

  local typed=""
  printf "%s" "${prompt}" >&2
  IFS= read -r typed

  case "${typed}" in
    y|Y|yes|YES)
      return 0
      ;;
    *)
      _git_snapshot_ui_err "Operation cancelled."
      return 1
      ;;
  esac
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

_git_snapshot_ui_choose_yes_no_default_no() {
  local prompt="$1"
  local non_interactive_guidance="$2"

  if [[ ! -t 0 ]]; then
    _git_snapshot_ui_err "Choice required ([y/N]) but stdin is not interactive. ${non_interactive_guidance}"
    return 2
  fi

  local typed=""
  printf "%s" "${prompt}" >&2
  IFS= read -r typed

  case "${typed}" in
    y|Y|yes|YES)
      return 0
      ;;
    ""|n|N|no|NO)
      return 1
      ;;
    *)
      _git_snapshot_ui_err "Invalid response. Expected y/yes or n/no."
      return 2
      ;;
  esac
}

_git_snapshot_ui_choose_yes_no_default_yes() {
  local prompt="$1"
  local non_interactive_guidance="$2"

  if [[ ! -t 0 ]]; then
    _git_snapshot_ui_err "Choice required ([Y/n]) but stdin is not interactive. ${non_interactive_guidance}"
    return 2
  fi

  local typed=""
  printf "%s" "${prompt}" >&2
  IFS= read -r typed

  case "${typed}" in
    ""|y|Y|yes|YES)
      return 0
      ;;
    n|N|no|NO)
      return 1
      ;;
    *)
      _git_snapshot_ui_err "Invalid response. Expected y/yes or n/no."
      return 2
      ;;
  esac
}
