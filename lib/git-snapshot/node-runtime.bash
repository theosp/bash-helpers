#!/usr/bin/env bash

_GIT_SNAPSHOT_NODE_RUNTIME_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
_GIT_SNAPSHOT_NODE_RUNTIME_ROOT="$(cd "${_GIT_SNAPSHOT_NODE_RUNTIME_DIR}/../.." && pwd -P)"
_GIT_SNAPSHOT_NODE_RUNTIME_VERSION_FILE="${_GIT_SNAPSHOT_NODE_RUNTIME_ROOT}/.nvmrc"
_GIT_SNAPSHOT_NODE_RUNTIME_VERSION_CACHE=""

_git_snapshot_node_runtime_report() {
  local reporter="${1:-}"
  local message="$2"

  if [[ -n "${reporter}" ]] && declare -F "${reporter}" >/dev/null 2>&1; then
    "${reporter}" "${message}"
    return
  fi

  printf "%s\n" "${message}" >&2
}

_git_snapshot_node_runtime_normalize_version() {
  local raw_version="${1:-}"

  printf "%s\n" "${raw_version}" | awk '
    NF {
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", $0)
      sub(/^v/, "", $0)
      print $0
      exit
    }
  '
}

_git_snapshot_node_runtime_current_version() {
  local raw_version=""
  local normalized_version=""

  if ! command -v node >/dev/null 2>&1; then
    return 1
  fi

  raw_version="$(node -v 2>/dev/null || true)"
  normalized_version="$(_git_snapshot_node_runtime_normalize_version "${raw_version}")"
  [[ -n "${normalized_version}" ]] || return 1

  printf "%s\n" "${normalized_version}"
}

_git_snapshot_node_runtime_current_matches() {
  local expected_version="$1"
  local current_version=""

  current_version="$(_git_snapshot_node_runtime_current_version)" || return 1
  [[ "${current_version}" == "${expected_version}" ]]
}

git_snapshot_node_runtime_version() {
  local reporter="${1:-}"

  if [[ -n "${_GIT_SNAPSHOT_NODE_RUNTIME_VERSION_CACHE}" ]]; then
    printf "%s\n" "${_GIT_SNAPSHOT_NODE_RUNTIME_VERSION_CACHE}"
    return 0
  fi

  if [[ ! -f "${_GIT_SNAPSHOT_NODE_RUNTIME_VERSION_FILE}" ]]; then
    _git_snapshot_node_runtime_report "${reporter}" "Missing Node runtime pin file: ${_GIT_SNAPSHOT_NODE_RUNTIME_VERSION_FILE}"
    return 1
  fi

  _GIT_SNAPSHOT_NODE_RUNTIME_VERSION_CACHE="$(awk '
    /^[[:space:]]*#/ { next }
    NF {
      print $1
      exit
    }
  ' "${_GIT_SNAPSHOT_NODE_RUNTIME_VERSION_FILE}")"

  if [[ -z "${_GIT_SNAPSHOT_NODE_RUNTIME_VERSION_CACHE}" ]]; then
    _git_snapshot_node_runtime_report "${reporter}" "Node runtime pin file is empty: ${_GIT_SNAPSHOT_NODE_RUNTIME_VERSION_FILE}"
    return 1
  fi

  printf "%s\n" "${_GIT_SNAPSHOT_NODE_RUNTIME_VERSION_CACHE}"
}

git_snapshot_node_runtime_use() {
  local reporter="${1:-}"
  local version=""
  local nvm_sh=""
  local current_version=""

  if ! version="$(git_snapshot_node_runtime_version "${reporter}")"; then
    return 1
  fi

  if _git_snapshot_node_runtime_current_matches "${version}"; then
    return 0
  fi

  export NVM_DIR="${NVM_DIR:-${HOME}/.nvm}"
  nvm_sh="${NVM_DIR}/nvm.sh"

  if [[ ! -f "${nvm_sh}" ]]; then
    _git_snapshot_node_runtime_report "${reporter}" "Missing ${nvm_sh}. Set NVM_DIR, install nvm and Node ${version}, or ensure node -v resolves to ${version} first."
    return 1
  fi

  # shellcheck source=/dev/null
  source "${nvm_sh}"

  if ! command -v nvm >/dev/null 2>&1; then
    _git_snapshot_node_runtime_report "${reporter}" "Failed to load nvm from ${nvm_sh}."
    return 1
  fi

  if ! nvm use "${version}" >/dev/null 2>&1; then
    _git_snapshot_node_runtime_report "${reporter}" "Unable to select Node ${version} via nvm. Install it with: nvm install ${version}"
    return 1
  fi

  if _git_snapshot_node_runtime_current_matches "${version}"; then
    return 0
  fi

  current_version="$(_git_snapshot_node_runtime_current_version || true)"
  if [[ -n "${current_version}" ]]; then
    _git_snapshot_node_runtime_report "${reporter}" "nvm did not activate Node ${version}; current node is ${current_version}."
    return 1
  fi

  _git_snapshot_node_runtime_report "${reporter}" "nvm reported Node ${version} active, but node is unavailable on PATH."
  return 1
}
