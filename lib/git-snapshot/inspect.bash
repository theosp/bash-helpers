#!/usr/bin/env bash

_git_snapshot_inspect_format_epoch_local() {
  local epoch="$1"

  if date -r "${epoch}" '+%Y-%m-%d %H:%M:%S' >/dev/null 2>&1; then
    date -r "${epoch}" '+%Y-%m-%d %H:%M:%S'
    return 0
  fi

  if date -d "@${epoch}" '+%Y-%m-%d %H:%M:%S' >/dev/null 2>&1; then
    date -d "@${epoch}" '+%Y-%m-%d %H:%M:%S'
    return 0
  fi

  printf "%s" "${epoch}"
}

_git_snapshot_inspect_age() {
  local epoch="$1"
  local now delta

  now="$(date +%s)"
  if [[ ! "${epoch}" =~ ^[0-9]+$ || ! "${now}" =~ ^[0-9]+$ ]]; then
    printf "unknown"
    return 0
  fi

  delta=$((now - epoch))
  if (( delta < 0 )); then
    delta=0
  fi

  if (( delta < 60 )); then
    printf "%ss" "${delta}"
  elif (( delta < 3600 )); then
    printf "%sm" "$((delta / 60))"
  elif (( delta < 86400 )); then
    printf "%sh" "$((delta / 3600))"
  else
    printf "%sd" "$((delta / 86400))"
  fi
}

_git_snapshot_inspect_shorten_hash() {
  local hash="$1"
  local len="${2:-12}"

  if [[ -z "${hash}" || "${hash}" == "none" ]]; then
    printf "none"
    return 0
  fi

  printf "%s" "${hash:0:${len}}"
}

_git_snapshot_inspect_count_lines() {
  local content="$1"

  if [[ -z "${content}" ]]; then
    printf "0"
    return 0
  fi

  printf "%s\n" "${content}" | sed '/^$/d' | wc -l | tr -d ' '
}

_git_snapshot_inspect_csv_from_lines() {
  local input="$1"
  local csv

  if [[ -z "${input}" ]]; then
    printf "none"
    return 0
  fi

  csv="$(printf "%s\n" "${input}" | sed '/^$/d' | paste -sd ',' -)"
  if [[ -z "${csv}" ]]; then
    printf "none"
  else
    printf "%s" "${csv}"
  fi
}

_git_snapshot_inspect_patch_files() {
  local patch_file="$1"

  if [[ ! -s "${patch_file}" ]]; then
    return 0
  fi

  awk '/^diff --git / {p=$4; sub(/^b\//, "", p); if (!seen[p]++) print p}' "${patch_file}"
}

_git_snapshot_inspect_patch_stat() {
  local patch_file="$1"

  if [[ ! -s "${patch_file}" ]]; then
    return 0
  fi

  git apply --stat "${patch_file}" 2>/dev/null || true
}

_git_snapshot_inspect_tar_files() {
  local tar_file="$1"

  if [[ ! -f "${tar_file}" ]]; then
    return 0
  fi

  tar -tf "${tar_file}"
}

_git_snapshot_inspect_current_head() {
  local repo_abs="$1"

  git -C "${repo_abs}" rev-parse HEAD 2>/dev/null || true
}

_git_snapshot_inspect_current_branch() {
  local repo_abs="$1"
  local branch

  branch="$(git -C "${repo_abs}" symbolic-ref --short -q HEAD 2>/dev/null || true)"
  if [[ -z "${branch}" ]]; then
    printf "(detached)"
  else
    printf "%s" "${branch}"
  fi
}

_git_snapshot_inspect_refs_for_head() {
  local repo_abs="$1"
  local head="$2"
  local ref_scope="$3"

  if [[ -z "${head}" ]]; then
    return 0
  fi

  git -C "${repo_abs}" for-each-ref --format='%(refname:short)' "refs/${ref_scope}" --points-at "${head}" 2>/dev/null || true
}

_git_snapshot_inspect_relation() {
  local repo_abs="$1"
  local snapshot_head="$2"
  local current_head="$3"
  local relation="same"
  local ahead=0
  local behind=0
  local counts base

  if [[ -z "${current_head}" ]]; then
    printf "missing|0|0"
    return 0
  fi

  if [[ "${snapshot_head}" == "${current_head}" ]]; then
    printf "same|0|0"
    return 0
  fi

  counts="$(git -C "${repo_abs}" rev-list --left-right --count "${snapshot_head}...${current_head}" 2>/dev/null || true)"
  if [[ -n "${counts}" ]]; then
    # Git may delimit counts with spaces or tabs depending on environment/version.
    counts="${counts//$'\t'/ }"
    read -r behind ahead <<< "${counts}"
    behind="${behind:-0}"
    ahead="${ahead:-0}"
  fi

  if git -C "${repo_abs}" merge-base --is-ancestor "${snapshot_head}" "${current_head}" >/dev/null 2>&1; then
    relation="current-ahead"
  elif git -C "${repo_abs}" merge-base --is-ancestor "${current_head}" "${snapshot_head}" >/dev/null 2>&1; then
    relation="current-behind"
  else
    base="$(git -C "${repo_abs}" merge-base "${snapshot_head}" "${current_head}" 2>/dev/null || true)"
    if [[ -n "${base}" ]]; then
      relation="diverged"
    else
      relation="unrelated"
    fi
  fi

  printf "%s|%s|%s" "${relation}" "${ahead}" "${behind}"
}

_git_snapshot_inspect_apply_check_staged() {
  local repo_abs="$1"
  local repo_bundle_dir="$2"
  local patch_file="${repo_bundle_dir}/staged.patch"

  if [[ ! -s "${patch_file}" ]]; then
    printf "none"
    return 0
  fi

  if ! _git_snapshot_restore_assert_patch_bundle_format "${patch_file}" >/dev/null 2>&1; then
    printf "fail"
    return 0
  fi

  if git -C "${repo_abs}" apply --check --binary --index "${patch_file}" >/dev/null 2>&1; then
    printf "ok"
  else
    printf "fail"
  fi
}

_git_snapshot_inspect_apply_check_unstaged() {
  local repo_abs="$1"
  local repo_bundle_dir="$2"
  local patch_file="${repo_bundle_dir}/unstaged.patch"

  if [[ ! -s "${patch_file}" ]]; then
    printf "none"
    return 0
  fi

  if ! _git_snapshot_restore_assert_patch_bundle_format "${patch_file}" >/dev/null 2>&1; then
    printf "fail"
    return 0
  fi

  if git -C "${repo_abs}" apply --check --binary "${patch_file}" >/dev/null 2>&1; then
    printf "ok"
  else
    printf "fail"
  fi
}

_git_snapshot_inspect_untracked_collisions() {
  local repo_abs="$1"
  local repo_bundle_dir="$2"
  local tar_file="${repo_bundle_dir}/untracked.tar"
  local file collisions=""

  if [[ ! -f "${tar_file}" ]]; then
    return 0
  fi

  while IFS= read -r file; do
    [[ -z "${file}" ]] && continue
    if [[ -e "${repo_abs}/${file}" ]] || git -C "${repo_abs}" ls-files --error-unmatch "${file}" >/dev/null 2>&1; then
      collisions+="${file}"$'\n'
    fi
  done < <(_git_snapshot_inspect_tar_files "${tar_file}")

  printf "%s" "${collisions}" | sed '/^$/d'
}

_git_snapshot_inspect_repo_snapshot_branches_csv() {
  local repo_abs="$1"
  local snapshot_head="$2"
  local lines

  lines="$(_git_snapshot_inspect_refs_for_head "${repo_abs}" "${snapshot_head}" "heads")"
  _git_snapshot_inspect_csv_from_lines "${lines}"
}

_git_snapshot_inspect_repo_snapshot_tags_csv() {
  local repo_abs="$1"
  local snapshot_head="$2"
  local lines

  lines="$(_git_snapshot_inspect_refs_for_head "${repo_abs}" "${snapshot_head}" "tags")"
  _git_snapshot_inspect_csv_from_lines "${lines}"
}

_git_snapshot_inspect_repo_current_tags_csv() {
  local repo_abs="$1"
  local current_head="$2"
  local lines

  lines="$(_git_snapshot_inspect_refs_for_head "${repo_abs}" "${current_head}" "tags")"
  _git_snapshot_inspect_csv_from_lines "${lines}"
}
