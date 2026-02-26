#!/usr/bin/env bash

_git_snapshot_store_base64_encode() {
  local value="$1"
  printf "%s" "${value}" | base64 | tr -d '\n'
}

_git_snapshot_store_base64_decode() {
  local value="$1"

  if printf "%s" "${value}" | base64 -d >/dev/null 2>&1; then
    printf "%s" "${value}" | base64 -d
    return 0
  fi

  if printf "%s" "${value}" | base64 -D >/dev/null 2>&1; then
    printf "%s" "${value}" | base64 -D
    return 0
  fi

  if printf "%s" "${value}" | base64 --decode >/dev/null 2>&1; then
    printf "%s" "${value}" | base64 --decode
    return 0
  fi

  _git_snapshot_ui_err "Unable to decode base64 snapshot metadata value."
  return 1
}

_git_snapshot_store_decode_legacy_meta_value() {
  local value="$1"

  # Legacy metadata used shell-style escaping (%q). Decode without eval/source.
  printf "%b" "${value}"
}

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
  local root_repo="$1"
  local label="${2:-snapshot}"
  local ts
  local stem
  local candidate
  local sequence=1

  ts="$(date +%Y-%m-%d--%H-%M-%S)"

  if [[ -n "${label}" && "${label}" != "snapshot" ]]; then
    stem="${label}-${ts}"
  else
    stem="${ts}"
  fi

  candidate="${stem}"
  while [[ -e "$(_git_snapshot_store_snapshot_path "${root_repo}" "${candidate}")" ]]; do
    sequence=$((sequence + 1))
    candidate="$(printf "%s-%02d" "${stem}" "${sequence}")"
  done

  printf "%s\n" "${candidate}"
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
  local created_at_epoch="${5:-}"

  if [[ -z "${created_at_epoch}" ]]; then
    created_at_epoch="$(date +%s)"
  fi

  {
    printf "FORMAT=git_snapshot_meta_v2\n"
    printf "SNAPSHOT_ID_B64=%s\n" "$(_git_snapshot_store_base64_encode "${snapshot_id}")"
    printf "CREATED_AT_EPOCH=%s\n" "${created_at_epoch}"
    printf "ROOT_REPO_B64=%s\n" "$(_git_snapshot_store_base64_encode "${root_repo}")"
    printf "REPO_COUNT=%s\n" "${repo_count}"
  } > "${snapshot_path}/meta.env"
}

_git_snapshot_store_rename_snapshot() {
  local root_repo="$1"
  local old_snapshot_id="$2"
  local new_snapshot_id="$3"
  local old_snapshot_path new_snapshot_path

  old_snapshot_path="$(_git_snapshot_store_snapshot_path "${root_repo}" "${old_snapshot_id}")"
  new_snapshot_path="$(_git_snapshot_store_snapshot_path "${root_repo}" "${new_snapshot_id}")"

  if [[ ! -d "${old_snapshot_path}" ]]; then
    _git_snapshot_ui_err "Snapshot not found: ${old_snapshot_id}"
    return 1
  fi

  if [[ -e "${new_snapshot_path}" ]]; then
    _git_snapshot_ui_err "Snapshot already exists: ${new_snapshot_id}"
    return 1
  fi

  mv "${old_snapshot_path}" "${new_snapshot_path}"

  if ! _git_snapshot_store_load_snapshot_meta "${new_snapshot_path}"; then
    _git_snapshot_ui_err "Failed to read metadata after rename; rolling back snapshot path."
    mv "${new_snapshot_path}" "${old_snapshot_path}" 2>/dev/null || true
    return 1
  fi

  if ! _git_snapshot_store_write_snapshot_meta "${new_snapshot_path}" "${new_snapshot_id}" "${ROOT_REPO}" "${REPO_COUNT}" "${CREATED_AT_EPOCH}"; then
    _git_snapshot_ui_err "Failed to update snapshot metadata after rename; rolling back snapshot path."
    mv "${new_snapshot_path}" "${old_snapshot_path}" 2>/dev/null || true
    return 1
  fi

  return 0
}

_git_snapshot_store_load_snapshot_meta() {
  local snapshot_path="$1"
  local meta_file="${snapshot_path}/meta.env"

  if [[ ! -f "${meta_file}" ]]; then
    _git_snapshot_ui_err "Snapshot metadata file is missing: ${meta_file}"
    return 1
  fi

  local format=""
  local snapshot_id=""
  local created_at_epoch=""
  local root_repo=""
  local repo_count=""
  local legacy_snapshot_id=""
  local legacy_created_at_epoch=""
  local legacy_root_repo=""
  local legacy_repo_count=""
  local line key value

  while IFS= read -r line || [[ -n "${line}" ]]; do
    [[ -z "${line}" ]] && continue

    if [[ "${line}" != *"="* ]]; then
      _git_snapshot_ui_err "Invalid snapshot metadata line (missing '='): ${line}"
      return 1
    fi

    key="${line%%=*}"
    value="${line#*=}"

    case "${key}" in
      FORMAT)
        format="${value}"
        ;;
      SNAPSHOT_ID_B64)
        snapshot_id="$(_git_snapshot_store_base64_decode "${value}")" || return 1
        ;;
      CREATED_AT_EPOCH)
        created_at_epoch="${value}"
        legacy_created_at_epoch="${value}"
        ;;
      ROOT_REPO_B64)
        root_repo="$(_git_snapshot_store_base64_decode "${value}")" || return 1
        ;;
      REPO_COUNT)
        repo_count="${value}"
        legacy_repo_count="${value}"
        ;;
      SNAPSHOT_ID)
        legacy_snapshot_id="$(_git_snapshot_store_decode_legacy_meta_value "${value}")"
        ;;
      ROOT_REPO)
        legacy_root_repo="$(_git_snapshot_store_decode_legacy_meta_value "${value}")"
        ;;
      *)
        _git_snapshot_ui_err "Unexpected snapshot metadata key: ${key}"
        return 1
        ;;
    esac
  done < "${meta_file}"

  if [[ "${format}" == "git_snapshot_meta_v2" ]]; then
    SNAPSHOT_ID="${snapshot_id}"
    CREATED_AT_EPOCH="${created_at_epoch}"
    ROOT_REPO="${root_repo}"
    REPO_COUNT="${repo_count}"
  else
    # Legacy snapshot format fallback (pre-v2). Decode safely without source/eval.
    SNAPSHOT_ID="${legacy_snapshot_id}"
    CREATED_AT_EPOCH="${legacy_created_at_epoch}"
    ROOT_REPO="${legacy_root_repo}"
    REPO_COUNT="${legacy_repo_count}"
  fi

  if [[ -z "${SNAPSHOT_ID}" || -z "${ROOT_REPO}" || -z "${CREATED_AT_EPOCH}" || -z "${REPO_COUNT}" ]]; then
    _git_snapshot_ui_err "Snapshot metadata is incomplete: ${meta_file}"
    return 1
  fi

  if [[ ! "${CREATED_AT_EPOCH}" =~ ^[0-9]+$ ]]; then
    _git_snapshot_ui_err "Snapshot metadata has invalid CREATED_AT_EPOCH: ${CREATED_AT_EPOCH}"
    return 1
  fi

  if [[ ! "${REPO_COUNT}" =~ ^[0-9]+$ ]]; then
    _git_snapshot_ui_err "Snapshot metadata has invalid REPO_COUNT: ${REPO_COUNT}"
    return 1
  fi
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
