#!/usr/bin/env bash

_git_snapshot_usage() {
  cat <<'USAGE'
Git Snapshot CLI
================

`git-snapshot` captures and restores working-tree state for the root-most
superproject and its initialized recursive submodules.

The command is optimized for two audiences and keeps both contracts explicit:
1) Humans (default output): readable summaries and actionable diagnostics
2) Automation (`--porcelain`): stable key-value output suitable for scripting

State model (what is captured)
------------------------------
- `HEAD` commit per repo
- staged diff (`git diff --cached --binary`)
- unstaged diff (`git diff --binary`)
- untracked non-ignored files tarball (`git ls-files --others --exclude-standard`)

Restore target exactness
- Tracked files state
- Untracked non-ignored files state
- Ignored files remain out of scope

Usage
-----
  git-snapshot create [snapshot_id]
  git-snapshot rename <old_snapshot_id> <new_snapshot_id> [--porcelain]
  git-snapshot list [--porcelain]
  git-snapshot show <snapshot_id> [--repo <rel_path>] [--verbose] [--porcelain]
  git-snapshot diff <snapshot_id> [--repo <rel_path>] [--staged|--unstaged|--untracked|--all] [--all-repos] [--files|--name-only|--stat|--patch] [--limit <n>|--no-limit] [--porcelain]
  git-snapshot compare <snapshot_id> [--repo <rel_path>] [--all-repos] [--details] [--files] [--limit <n>|--no-limit] [--porcelain]
  git-snapshot restore <snapshot_id>
  git-snapshot delete <snapshot_id>
  git-snapshot debug-dirty

Command details
---------------
create [snapshot_id]
  Creates snapshot data under:
    ~/git-snapshots/<root-most-repo-name>/<snapshot_id>
  If `snapshot_id` is omitted, id format is generated as:
    YYYY-MM-DD--HH-MM-SS
  If an id collision occurs for the same generated timestamp:
    YYYY-MM-DD--HH-MM-SS-02 (then -03, ...)
  Output contract:
  - final output line is always the snapshot id
  - informational lines can appear above it

rename <old_snapshot_id> <new_snapshot_id>
  Renames an existing snapshot id.
  Behavior:
  - fails if old id does not exist
  - fails if new id already exists
  - rewrites snapshot metadata to the new id (creation time preserved)
  Optional flags:
  - `--porcelain` : prints one stable key/value line

list
  Lists snapshots for the resolved root-most repo.
  Human output columns:
  - ID
  - Created (local timezone)
  - Age
  - Repos
  Porcelain output:
  - one `snapshot\t...` line per snapshot
  - fields: id, created_at_epoch, repo_count, root_repo

show
  Explains a snapshot in depth and prints per-repo sections:
  - snapshot commit and refs
  - current commit and refs
  - relation to current HEAD:
    - same
    - current-ahead
    - current-behind
    - diverged
    - unrelated
    - missing
  - captured file inventory:
    - staged files
    - unstaged files
    - untracked files
  - restore readiness signals:
    - apply staged (ok/fail/none)
    - apply unstaged (ok/fail/none)
    - untracked collisions count

  Flags:
  - `--repo <rel_path>` : restrict to one repo path from the snapshot
  - `--verbose`         : include internal metadata (checksum, full hashes, bundle path)
  - `--porcelain`       : stable machine format

diff
  Inspects captured bundle content without mutating current repos.
  This command shows what was captured, not what changed since capture.
  Default human output is summary-first (repo/file counts, changed repos only).

  Category flags (combine as needed):
  - `--staged` `--unstaged` `--untracked` `--all` (default is all)

  Summary/detail flags:
  - `--all-repos` : include clean repos in summary output
  - `--files`     : per-file listing (same as `--name-only`)
  - `--limit <n>` : cap listed files in detail mode (default 20)
  - `--no-limit`  : disable file-list limits

  Render flags (mutually exclusive):
  - `--name-only` : file paths only (detail mode)
  - `--stat`      : git apply --stat summary (detail mode)
  - `--patch`     : raw patch body (staged/unstaged)

compare
  Compares snapshot restore readiness against current tree (non-mutating):
  - commit relation
  - apply-check status for staged/unstaged patches
  - untracked collision detection
  Default human output is summary-first (issues only).
  Optional flags:
  - `--all-repos` : include clean repos in summary output
  - `--details`   : print per-repo detail sections
  - `--files`     : include captured file inventories (implies `--details`)
  - `--limit <n>` : cap listed files in detail mode (default 20)
  - `--no-limit`  : disable file-list limits

  Exit codes:
  - 0 : all compared repos are cleanly compatible
  - 3 : compatibility issues found
  - 1 : usage/runtime error

restore
  Restores tracked + untracked non-ignored state from snapshot bundles.
  Workflow:
  1) create safety snapshot of current state
  2) apply snapshot restore
  3) verify status hashes
  4) auto-rollback to safety snapshot on restore failure
  Requires explicit confirmation (or `GIT_SNAPSHOT_CONFIRM_RESTORE=RESTORE`).

delete
  Deletes snapshot data directory for the given id.

debug-dirty
  Prints dirty repo paths discovered in root and initialized submodules.

Environment
-----------
GIT_SNAPSHOT_ENFORCE_ROOT_PREFIX=<path>
  Optional hard scope guard.
  If set, commands abort unless resolved root-most repo is under this prefix.
  Useful for test sandboxes and controlled automation contexts.

GIT_SNAPSHOT_CONFIRM_RESTORE=RESTORE
  Non-interactive restore confirmation override.

Examples
--------
Create and inspect:
  git-snapshot create
  git-snapshot create before-rebase
  git-snapshot rename before-rebase before-rebase-validated
  git-snapshot list
  git-snapshot show before-rebase

Machine output:
  git-snapshot list --porcelain
  git-snapshot show before-rebase --porcelain

Deep inspection:
  git-snapshot diff before-rebase
  git-snapshot diff before-rebase --stat
  git-snapshot diff before-rebase --name-only
  git-snapshot diff before-rebase --repo modules/sub1 --staged --patch
  git-snapshot diff before-rebase --all-repos --files --limit 50
  git-snapshot diff before-rebase --porcelain
  git-snapshot compare before-rebase
  git-snapshot compare before-rebase --details
  git-snapshot compare before-rebase --files
  git-snapshot compare before-rebase --porcelain

Restore:
  git-snapshot restore before-rebase

Troubleshooting
---------------
- "Refusing to operate outside enforced prefix":
  resolved root repo is outside `GIT_SNAPSHOT_ENFORCE_ROOT_PREFIX`.
- compare exits 3:
  one or more repos are not restore-compatible in current state.
- restore failed:
  inspect error details, then use safety snapshot id printed by restore flow.
USAGE
}

_git_snapshot_validate_snapshot_id() {
  local snapshot_id="$1"

  if [[ -z "${snapshot_id}" ]]; then
    _git_snapshot_ui_err "snapshot_id cannot be empty"
    return 1
  fi

  if [[ "${snapshot_id}" == "." || "${snapshot_id}" == ".." ]]; then
    _git_snapshot_ui_err "Invalid snapshot_id '${snapshot_id}'. Reserved path segment."
    return 1
  fi

  if [[ "${snapshot_id}" == *"/"* ]]; then
    _git_snapshot_ui_err "Invalid snapshot_id '${snapshot_id}'. '/' is not allowed."
    return 1
  fi

  if [[ ! "${snapshot_id}" =~ ^[A-Za-z0-9._-]+$ ]]; then
    _git_snapshot_ui_err "Invalid snapshot_id '${snapshot_id}'. Allowed: [A-Za-z0-9._-]"
    return 1
  fi

  return 0
}

_git_snapshot_validate_repo_filter() {
  local snapshot_path="$1"
  local repo_filter="$2"
  local matched=false
  local _repo_id _rel_path _head _status_hash

  while IFS=$'\t' read -r _repo_id _rel_path _head _status_hash; do
    [[ -z "${_repo_id}" ]] && continue
    if [[ "${_rel_path}" == "${repo_filter}" ]]; then
      matched=true
      break
    fi
  done < <(_git_snapshot_store_read_repo_entries "${snapshot_path}")

  if [[ "${matched}" != "true" ]]; then
    _git_snapshot_ui_err "Unknown snapshot repo path: ${repo_filter}"
    return 1
  fi

  return 0
}

_git_snapshot_create_internal() {
  local root_repo="$1"
  local label="${2:-snapshot}"
  local print_info="${3:-true}"
  local explicit_snapshot_id="${4:-}"

  _git_snapshot_store_ensure_dirs "${root_repo}"

  local snapshot_id snapshot_path
  if [[ -n "${explicit_snapshot_id}" ]]; then
    snapshot_id="${explicit_snapshot_id}"
  else
    snapshot_id="$(_git_snapshot_store_new_snapshot_id "${root_repo}" "${label}")"
  fi
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

_git_snapshot_calculate_repo_state() {
  local root_repo="$1"
  local snapshot_path="$2"
  local repo_id="$3"
  local rel_path="$4"
  local snapshot_head="$5"
  local status_hash="$6"

  GSN_REPO_ID="${repo_id}"
  GSN_REL_PATH="${rel_path}"
  GSN_SNAPSHOT_HEAD="${snapshot_head}"
  GSN_STATUS_HASH="${status_hash}"
  GSN_REPO_ABS="${root_repo}/${rel_path}"
  GSN_REPO_BUNDLE_DIR="$(_git_snapshot_store_repo_dir_for_id "${snapshot_path}" "${repo_id}")"

  GSN_STAGED_FILES="$(_git_snapshot_inspect_patch_files "${GSN_REPO_BUNDLE_DIR}/staged.patch")"
  GSN_UNSTAGED_FILES="$(_git_snapshot_inspect_patch_files "${GSN_REPO_BUNDLE_DIR}/unstaged.patch")"
  GSN_UNTRACKED_FILES="$(_git_snapshot_inspect_tar_files "${GSN_REPO_BUNDLE_DIR}/untracked.tar")"

  GSN_STAGED_COUNT="$(_git_snapshot_inspect_count_lines "${GSN_STAGED_FILES}")"
  GSN_UNSTAGED_COUNT="$(_git_snapshot_inspect_count_lines "${GSN_UNSTAGED_FILES}")"
  GSN_UNTRACKED_COUNT="$(_git_snapshot_inspect_count_lines "${GSN_UNTRACKED_FILES}")"

  if git -C "${GSN_REPO_ABS}" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    GSN_REPO_AVAILABLE="true"
    GSN_CURRENT_HEAD="$(_git_snapshot_inspect_current_head "${GSN_REPO_ABS}")"
    GSN_CURRENT_BRANCH="$(_git_snapshot_inspect_current_branch "${GSN_REPO_ABS}")"
    GSN_SNAPSHOT_BRANCHES_CSV="$(_git_snapshot_inspect_repo_snapshot_branches_csv "${GSN_REPO_ABS}" "${GSN_SNAPSHOT_HEAD}")"
    GSN_SNAPSHOT_TAGS_CSV="$(_git_snapshot_inspect_repo_snapshot_tags_csv "${GSN_REPO_ABS}" "${GSN_SNAPSHOT_HEAD}")"
    GSN_CURRENT_TAGS_CSV="$(_git_snapshot_inspect_repo_current_tags_csv "${GSN_REPO_ABS}" "${GSN_CURRENT_HEAD}")"

    local relation_data
    relation_data="$(_git_snapshot_inspect_relation "${GSN_REPO_ABS}" "${GSN_SNAPSHOT_HEAD}" "${GSN_CURRENT_HEAD}")"
    GSN_RELATION="${relation_data%%|*}"
    local rest="${relation_data#*|}"
    GSN_AHEAD_COUNT="${rest%%|*}"
    GSN_BEHIND_COUNT="${rest##*|}"

    GSN_APPLY_CHECK_STAGED="$(_git_snapshot_inspect_apply_check_staged "${GSN_REPO_ABS}" "${GSN_REPO_BUNDLE_DIR}")"
    GSN_APPLY_CHECK_UNSTAGED="$(_git_snapshot_inspect_apply_check_unstaged "${GSN_REPO_ABS}" "${GSN_REPO_BUNDLE_DIR}")"
    GSN_UNTRACKED_COLLISIONS="$(_git_snapshot_inspect_untracked_collisions "${GSN_REPO_ABS}" "${GSN_REPO_BUNDLE_DIR}")"
    GSN_UNTRACKED_COLLISION_COUNT="$(_git_snapshot_inspect_count_lines "${GSN_UNTRACKED_COLLISIONS}")"
  else
    GSN_REPO_AVAILABLE="false"
    GSN_CURRENT_HEAD="none"
    GSN_CURRENT_BRANCH="(missing)"
    GSN_SNAPSHOT_BRANCHES_CSV="none"
    GSN_SNAPSHOT_TAGS_CSV="none"
    GSN_CURRENT_TAGS_CSV="none"
    GSN_RELATION="missing"
    GSN_AHEAD_COUNT="0"
    GSN_BEHIND_COUNT="0"
    GSN_APPLY_CHECK_STAGED="fail"
    GSN_APPLY_CHECK_UNSTAGED="fail"
    GSN_UNTRACKED_COLLISIONS=""
    GSN_UNTRACKED_COLLISION_COUNT="0"
  fi

  GSN_REPO_HAS_ISSUES="false"
  if [[ "${GSN_REPO_AVAILABLE}" != "true" || "${GSN_APPLY_CHECK_STAGED}" == "fail" || "${GSN_APPLY_CHECK_UNSTAGED}" == "fail" || "${GSN_UNTRACKED_COLLISION_COUNT}" != "0" ]]; then
    GSN_REPO_HAS_ISSUES="true"
  fi
}

_git_snapshot_print_file_group_human() {
  local title="$1"
  local content="$2"
  local count="$3"

  printf "  %s (%s):\n" "${title}" "${count}"
  if [[ "${count}" == "0" ]]; then
    printf "    (none)\n"
    return 0
  fi

  while IFS= read -r file; do
    [[ -z "${file}" ]] && continue
    printf "    - %s\n" "${file}"
  done <<< "${content}"
}

_git_snapshot_parse_positive_int() {
  local raw="$1"
  local label="$2"

  if [[ ! "${raw}" =~ ^[0-9]+$ ]]; then
    _git_snapshot_ui_err "Invalid value for ${label}: ${raw} (expected non-negative integer)"
    return 1
  fi

  printf "%s" "${raw}"
}

_git_snapshot_human_repo_label() {
  local root_repo="$1"
  local rel_path="$2"

  if [[ "${rel_path}" == "." ]]; then
    basename "${root_repo}"
    return 0
  fi

  printf "%s" "${rel_path}"
}

_git_snapshot_print_lines_limited() {
  local content="$1"
  local limit="$2"
  local prefix="${3:-    - }"
  local shown=0
  local total=0

  while IFS= read -r line; do
    [[ -z "${line}" ]] && continue
    total=$((total + 1))
    if [[ "${limit}" == "0" || "${shown}" -lt "${limit}" ]]; then
      printf "%s%s\n" "${prefix}" "${line}"
      shown=$((shown + 1))
    fi
  done <<< "${content}"

  if [[ "${limit}" != "0" && "${total}" -gt "${shown}" ]]; then
    printf "    ... +%s more\n" "$((total - shown))"
  fi
}

_git_snapshot_print_file_group_human_limited() {
  local title="$1"
  local content="$2"
  local count="$3"
  local limit="$4"

  printf "  %s (%s):\n" "${title}" "${count}"
  if [[ "${count}" == "0" ]]; then
    printf "    (none)\n"
    return 0
  fi

  _git_snapshot_print_lines_limited "${content}" "${limit}" "    - "
}

_git_snapshot_cmd_create() {
  local root_repo="$1"
  local snapshot_id_override="${2:-}"

  if [[ -n "${snapshot_id_override}" ]]; then
    _git_snapshot_validate_snapshot_id "${snapshot_id_override}"
    _git_snapshot_store_ensure_dirs "${root_repo}"
    local path
    path="$(_git_snapshot_store_snapshot_path "${root_repo}" "${snapshot_id_override}")"
    if [[ -e "${path}" ]]; then
      _git_snapshot_ui_err "Snapshot already exists: ${snapshot_id_override}"
      return 1
    fi
  fi

  _git_snapshot_create_internal "${root_repo}" "snapshot" true "${snapshot_id_override}"
}

_git_snapshot_cmd_rename() {
  local root_repo="$1"
  shift

  local old_snapshot_id=""
  local new_snapshot_id=""
  local porcelain="false"

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --porcelain)
        porcelain="true"
        ;;
      -*)
        _git_snapshot_ui_err "Unknown option for rename: $1"
        return 1
        ;;
      *)
        if [[ -z "${old_snapshot_id}" ]]; then
          old_snapshot_id="$1"
        elif [[ -z "${new_snapshot_id}" ]]; then
          new_snapshot_id="$1"
        else
          _git_snapshot_ui_err "Unexpected argument for rename: $1"
          return 1
        fi
        ;;
    esac
    shift
  done

  if [[ -z "${old_snapshot_id}" ]]; then
    _git_snapshot_ui_err "Missing old_snapshot_id for rename"
    return 1
  fi
  if [[ -z "${new_snapshot_id}" ]]; then
    _git_snapshot_ui_err "Missing new_snapshot_id for rename"
    return 1
  fi

  _git_snapshot_validate_snapshot_id "${old_snapshot_id}"
  _git_snapshot_validate_snapshot_id "${new_snapshot_id}"

  if [[ "${old_snapshot_id}" == "${new_snapshot_id}" ]]; then
    _git_snapshot_ui_err "old_snapshot_id and new_snapshot_id must differ"
    return 1
  fi

  _git_snapshot_store_assert_snapshot_exists "${root_repo}" "${old_snapshot_id}"
  local new_snapshot_path
  new_snapshot_path="$(_git_snapshot_store_snapshot_path "${root_repo}" "${new_snapshot_id}")"
  if [[ -e "${new_snapshot_path}" ]]; then
    _git_snapshot_ui_err "Snapshot already exists: ${new_snapshot_id}"
    return 1
  fi

  _git_snapshot_store_rename_snapshot "${root_repo}" "${old_snapshot_id}" "${new_snapshot_id}"

  if [[ "${porcelain}" == "true" ]]; then
    printf "renamed\told_id=%s\tnew_id=%s\n" "${old_snapshot_id}" "${new_snapshot_id}"
  else
    _git_snapshot_ui_info "Renamed snapshot ${old_snapshot_id} -> ${new_snapshot_id}"
  fi
}

_git_snapshot_cmd_list() {
  local root_repo="$1"
  shift
  local porcelain="false"

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --porcelain)
        porcelain="true"
        ;;
      *)
        _git_snapshot_ui_err "Unknown option for list: $1"
        return 1
        ;;
    esac
    shift
  done

  local snapshot_id snapshot_path
  if [[ "${porcelain}" == "true" ]]; then
    while IFS= read -r snapshot_id; do
      [[ -z "${snapshot_id}" ]] && continue
      snapshot_path="$(_git_snapshot_store_snapshot_path "${root_repo}" "${snapshot_id}")"
      _git_snapshot_store_load_snapshot_meta "${snapshot_path}"
      printf "snapshot\tid=%s\tcreated_at_epoch=%s\trepo_count=%s\troot_repo=%s\n" "${snapshot_id}" "${CREATED_AT_EPOCH}" "${REPO_COUNT}" "${ROOT_REPO}"
    done < <(_git_snapshot_store_list_snapshot_ids "${root_repo}")
    return 0
  fi

  local rows=""
  while IFS= read -r snapshot_id; do
    [[ -z "${snapshot_id}" ]] && continue
    snapshot_path="$(_git_snapshot_store_snapshot_path "${root_repo}" "${snapshot_id}")"
    _git_snapshot_store_load_snapshot_meta "${snapshot_path}"
    rows+="${CREATED_AT_EPOCH}"$'\t'"${snapshot_id}"$'\t'"${REPO_COUNT}"$'\n'
  done < <(_git_snapshot_store_list_snapshot_ids "${root_repo}")

  if [[ -z "${rows}" ]]; then
    printf "No snapshots found (%s)\n" "${root_repo}"
    return 0
  fi

  printf "Snapshots (%s)\n" "${root_repo}"
  printf "%-28s %-19s %-6s %-5s\n" "ID" "Created" "Age" "Repos"
  while IFS=$'\t' read -r epoch snapshot_id repo_count; do
    [[ -z "${snapshot_id}" ]] && continue
    local created age
    created="$(_git_snapshot_inspect_format_epoch_local "${epoch}")"
    age="$(_git_snapshot_inspect_age "${epoch}")"
    printf "%-28s %-19s %-6s %-5s\n" "${snapshot_id}" "${created}" "${age}" "${repo_count}"
  done < <(printf "%s" "${rows}" | sort -rn)
}

_git_snapshot_cmd_show() {
  local root_repo="$1"
  shift

  local snapshot_id=""
  local porcelain="false"
  local verbose="false"
  local repo_filter=""

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --porcelain)
        porcelain="true"
        ;;
      --verbose)
        verbose="true"
        ;;
      --repo)
        if [[ -z "${2:-}" ]]; then
          _git_snapshot_ui_err "Missing value for --repo"
          return 1
        fi
        repo_filter="$2"
        shift
        ;;
      -* )
        _git_snapshot_ui_err "Unknown option for show: $1"
        return 1
        ;;
      *)
        if [[ -z "${snapshot_id}" ]]; then
          snapshot_id="$1"
        else
          _git_snapshot_ui_err "Unexpected argument for show: $1"
          return 1
        fi
        ;;
    esac
    shift
  done

  if [[ -z "${snapshot_id}" ]]; then
    _git_snapshot_ui_err "Missing snapshot_id for show"
    return 1
  fi

  _git_snapshot_validate_snapshot_id "${snapshot_id}"
  _git_snapshot_store_assert_snapshot_exists "${root_repo}" "${snapshot_id}"

  local snapshot_path
  snapshot_path="$(_git_snapshot_store_snapshot_path "${root_repo}" "${snapshot_id}")"
  _git_snapshot_store_load_snapshot_meta "${snapshot_path}"

  if [[ -n "${repo_filter}" ]]; then
    _git_snapshot_validate_repo_filter "${snapshot_path}" "${repo_filter}"
  fi

  if [[ "${porcelain}" == "true" ]]; then
    printf "snapshot_id=%s\n" "${SNAPSHOT_ID}"
    printf "created_at_epoch=%s\n" "${CREATED_AT_EPOCH}"
    printf "root_repo=%s\n" "${ROOT_REPO}"
    printf "repo_count=%s\n" "${REPO_COUNT}"
  else
    printf "Snapshot: %s\n" "${SNAPSHOT_ID}"
    printf "Root: %s\n" "${ROOT_REPO}"
    printf "Created: %s (%s ago)\n" "$(_git_snapshot_inspect_format_epoch_local "${CREATED_AT_EPOCH}")" "$(_git_snapshot_inspect_age "${CREATED_AT_EPOCH}")"
    printf "Repos: %s\n" "${REPO_COUNT}"
  fi

  local repo_id rel_path snapshot_head status_hash
  while IFS=$'\t' read -r repo_id rel_path snapshot_head status_hash; do
    [[ -z "${repo_id}" ]] && continue
    if [[ -n "${repo_filter}" && "${rel_path}" != "${repo_filter}" ]]; then
      continue
    fi

    _git_snapshot_calculate_repo_state "${root_repo}" "${snapshot_path}" "${repo_id}" "${rel_path}" "${snapshot_head}" "${status_hash}"

    local snapshot_head_short current_head_short
    snapshot_head_short="$(_git_snapshot_inspect_shorten_hash "${GSN_SNAPSHOT_HEAD}")"
    current_head_short="$(_git_snapshot_inspect_shorten_hash "${GSN_CURRENT_HEAD}")"

    if [[ "${porcelain}" == "true" ]]; then
      printf "repo\tid=%s\tpath=%s\tsnapshot_head=%s\tcurrent_head=%s\trelation=%s\tahead=%s\tbehind=%s\tsnapshot_branches=%s\tsnapshot_tags=%s\tcurrent_branch=%s\tcurrent_tags=%s\tstaged_count=%s\tunstaged_count=%s\tuntracked_count=%s\tapply_check_staged=%s\tapply_check_unstaged=%s\tuntracked_collision_count=%s\n" \
        "${repo_id}" "${rel_path}" "${GSN_SNAPSHOT_HEAD}" "${GSN_CURRENT_HEAD}" "${GSN_RELATION}" "${GSN_AHEAD_COUNT}" "${GSN_BEHIND_COUNT}" "${GSN_SNAPSHOT_BRANCHES_CSV}" "${GSN_SNAPSHOT_TAGS_CSV}" "${GSN_CURRENT_BRANCH}" "${GSN_CURRENT_TAGS_CSV}" "${GSN_STAGED_COUNT}" "${GSN_UNSTAGED_COUNT}" "${GSN_UNTRACKED_COUNT}" "${GSN_APPLY_CHECK_STAGED}" "${GSN_APPLY_CHECK_UNSTAGED}" "${GSN_UNTRACKED_COLLISION_COUNT}"
      if [[ "${verbose}" == "true" ]]; then
        printf "repo_debug\tid=%s\tpath=%s\tintegrity_checksum=%s\tbundle_dir=%s\n" "${repo_id}" "${rel_path}" "${GSN_STATUS_HASH}" "${GSN_REPO_BUNDLE_DIR}"
      fi
      continue
    fi

    local human_repo_label
    human_repo_label="$(_git_snapshot_human_repo_label "${root_repo}" "${rel_path}")"
    printf "\nRepo: %s\n" "${human_repo_label}"
    printf "  Snapshot commit: %s (branches: %s; tags: %s)\n" "${snapshot_head_short}" "${GSN_SNAPSHOT_BRANCHES_CSV}" "${GSN_SNAPSHOT_TAGS_CSV}"
    printf "  Current commit:  %s (branch: %s; tags: %s)\n" "${current_head_short}" "${GSN_CURRENT_BRANCH}" "${GSN_CURRENT_TAGS_CSV}"

    if [[ "${GSN_RELATION}" == "same" || "${GSN_RELATION}" == "missing" ]]; then
      printf "  Relation: %s\n" "${GSN_RELATION}"
    else
      printf "  Relation: %s (ahead %s, behind %s)\n" "${GSN_RELATION}" "${GSN_AHEAD_COUNT}" "${GSN_BEHIND_COUNT}"
    fi

    _git_snapshot_print_file_group_human "Staged" "${GSN_STAGED_FILES}" "${GSN_STAGED_COUNT}"
    _git_snapshot_print_file_group_human "Unstaged" "${GSN_UNSTAGED_FILES}" "${GSN_UNSTAGED_COUNT}"
    _git_snapshot_print_file_group_human "Untracked" "${GSN_UNTRACKED_FILES}" "${GSN_UNTRACKED_COUNT}"

    printf "  Restore readiness:\n"
    printf "    - apply staged: %s\n" "${GSN_APPLY_CHECK_STAGED}"
    printf "    - apply unstaged: %s\n" "${GSN_APPLY_CHECK_UNSTAGED}"
    printf "    - untracked collisions: %s\n" "${GSN_UNTRACKED_COLLISION_COUNT}"

    if [[ "${GSN_UNTRACKED_COLLISION_COUNT}" != "0" ]]; then
      while IFS= read -r collision; do
        [[ -z "${collision}" ]] && continue
        printf "      * %s\n" "${collision}"
      done <<< "${GSN_UNTRACKED_COLLISIONS}"
    fi

    if [[ "${verbose}" == "true" ]]; then
      printf "  Internal:\n"
      printf "    - integrity checksum: %s\n" "${GSN_STATUS_HASH}"
      printf "    - bundle dir: %s\n" "${GSN_REPO_BUNDLE_DIR}"
      printf "    - snapshot head (full): %s\n" "${GSN_SNAPSHOT_HEAD}"
      printf "    - current head (full): %s\n" "${GSN_CURRENT_HEAD}"
    fi
  done < <(_git_snapshot_store_read_repo_entries "${snapshot_path}")
}

_git_snapshot_diff_render_human_category() {
  local title="$1"
  local files="$2"
  local count="$3"
  local mode="$4"
  local patch_file="$5"
  local limit="${6:-0}"

  printf "  %s (%s):\n" "${title}" "${count}"

  if [[ "${count}" == "0" ]]; then
    printf "    (none)\n"
    return 0
  fi

  case "${mode}" in
    name-only)
      _git_snapshot_print_lines_limited "${files}" "${limit}" "    - "
      ;;
    stat)
      local stat_out
      stat_out="$(_git_snapshot_inspect_patch_stat "${patch_file}")"
      if [[ -z "${stat_out}" ]]; then
        _git_snapshot_print_lines_limited "${files}" "${limit}" "    - "
      else
        while IFS= read -r stat_line; do
          [[ -z "${stat_line}" ]] && continue
          printf "    %s\n" "${stat_line}"
        done <<< "${stat_out}"
      fi
      ;;
    patch)
      while IFS= read -r patch_line; do
        printf "    %s\n" "${patch_line}"
      done < "${patch_file}"
      ;;
  esac
}

_git_snapshot_cmd_diff() {
  local root_repo="$1"
  shift

  local snapshot_id=""
  local repo_filter=""
  local porcelain="false"
  local include_staged="false"
  local include_unstaged="false"
  local include_untracked="false"
  local render_mode="summary"
  local render_flag_count=0
  local show_all_repos="false"
  local limit="20"

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --repo)
        if [[ -z "${2:-}" ]]; then
          _git_snapshot_ui_err "Missing value for --repo"
          return 1
        fi
        repo_filter="$2"
        shift
        ;;
      --porcelain)
        porcelain="true"
        ;;
      --staged)
        include_staged="true"
        ;;
      --unstaged)
        include_unstaged="true"
        ;;
      --untracked)
        include_untracked="true"
        ;;
      --all)
        include_staged="true"
        include_unstaged="true"
        include_untracked="true"
        ;;
      --all-repos)
        show_all_repos="true"
        ;;
      --files)
        render_mode="name-only"
        render_flag_count=$((render_flag_count + 1))
        ;;
      --name-only)
        render_mode="name-only"
        render_flag_count=$((render_flag_count + 1))
        ;;
      --stat)
        render_mode="stat"
        render_flag_count=$((render_flag_count + 1))
        ;;
      --patch)
        render_mode="patch"
        render_flag_count=$((render_flag_count + 1))
        ;;
      --limit)
        if [[ -z "${2:-}" ]]; then
          _git_snapshot_ui_err "Missing value for --limit"
          return 1
        fi
        limit="$(_git_snapshot_parse_positive_int "${2}" "--limit")" || return 1
        shift
        ;;
      --no-limit)
        limit="0"
        ;;
      -* )
        _git_snapshot_ui_err "Unknown option for diff: $1"
        return 1
        ;;
      *)
        if [[ -z "${snapshot_id}" ]]; then
          snapshot_id="$1"
        else
          _git_snapshot_ui_err "Unexpected argument for diff: $1"
          return 1
        fi
        ;;
    esac
    shift
  done

  if [[ -z "${snapshot_id}" ]]; then
    _git_snapshot_ui_err "Missing snapshot_id for diff"
    return 1
  fi
  if (( render_flag_count > 1 )); then
    _git_snapshot_ui_err "Only one of --files/--name-only/--stat/--patch is allowed"
    return 1
  fi

  if [[ "${include_staged}" == "false" && "${include_unstaged}" == "false" && "${include_untracked}" == "false" ]]; then
    include_staged="true"
    include_unstaged="true"
    include_untracked="true"
  fi

  _git_snapshot_validate_snapshot_id "${snapshot_id}"
  _git_snapshot_store_assert_snapshot_exists "${root_repo}" "${snapshot_id}"
  local snapshot_path
  snapshot_path="$(_git_snapshot_store_snapshot_path "${root_repo}" "${snapshot_id}")"

  if [[ -n "${repo_filter}" ]]; then
    _git_snapshot_validate_repo_filter "${snapshot_path}" "${repo_filter}"
  fi

  local repo_id rel_path snapshot_head status_hash
  if [[ "${porcelain}" == "true" ]]; then
    while IFS=$'\t' read -r repo_id rel_path snapshot_head status_hash; do
      [[ -z "${repo_id}" ]] && continue
      if [[ -n "${repo_filter}" && "${rel_path}" != "${repo_filter}" ]]; then
        continue
      fi

      _git_snapshot_calculate_repo_state "${root_repo}" "${snapshot_path}" "${repo_id}" "${rel_path}" "${snapshot_head}" "${status_hash}"

      if [[ "${include_staged}" == "true" ]]; then
        printf "diff\tsnapshot_id=%s\trepo=%s\tcategory=staged\tfile_count=%s\n" "${snapshot_id}" "${rel_path}" "${GSN_STAGED_COUNT}"
        while IFS= read -r file; do
          [[ -z "${file}" ]] && continue
          printf "diff_file\trepo=%s\tcategory=staged\tfile=%s\n" "${rel_path}" "${file}"
        done <<< "${GSN_STAGED_FILES}"
      fi
      if [[ "${include_unstaged}" == "true" ]]; then
        printf "diff\tsnapshot_id=%s\trepo=%s\tcategory=unstaged\tfile_count=%s\n" "${snapshot_id}" "${rel_path}" "${GSN_UNSTAGED_COUNT}"
        while IFS= read -r file; do
          [[ -z "${file}" ]] && continue
          printf "diff_file\trepo=%s\tcategory=unstaged\tfile=%s\n" "${rel_path}" "${file}"
        done <<< "${GSN_UNSTAGED_FILES}"
      fi
      if [[ "${include_untracked}" == "true" ]]; then
        printf "diff\tsnapshot_id=%s\trepo=%s\tcategory=untracked\tfile_count=%s\n" "${snapshot_id}" "${rel_path}" "${GSN_UNTRACKED_COUNT}"
        while IFS= read -r file; do
          [[ -z "${file}" ]] && continue
          printf "diff_file\trepo=%s\tcategory=untracked\tfile=%s\n" "${rel_path}" "${file}"
        done <<< "${GSN_UNTRACKED_FILES}"
      fi
    done < <(_git_snapshot_store_read_repo_entries "${snapshot_path}")
    return 0
  fi

  local show_details="false"
  if [[ "${render_mode}" != "summary" ]]; then
    show_details="true"
  fi

  local repos_in_scope=0
  local repos_with_changes=0
  local repos_listed=0
  local total_staged=0
  local total_unstaged=0
  local total_untracked=0
  local summary_rows=""

  while IFS=$'\t' read -r repo_id rel_path snapshot_head status_hash; do
    [[ -z "${repo_id}" ]] && continue
    if [[ -n "${repo_filter}" && "${rel_path}" != "${repo_filter}" ]]; then
      continue
    fi

    _git_snapshot_calculate_repo_state "${root_repo}" "${snapshot_path}" "${repo_id}" "${rel_path}" "${snapshot_head}" "${status_hash}"
    repos_in_scope=$((repos_in_scope + 1))

    local staged_count=0
    local unstaged_count=0
    local untracked_count=0
    if [[ "${include_staged}" == "true" ]]; then
      staged_count="${GSN_STAGED_COUNT}"
      total_staged=$((total_staged + staged_count))
    fi
    if [[ "${include_unstaged}" == "true" ]]; then
      unstaged_count="${GSN_UNSTAGED_COUNT}"
      total_unstaged=$((total_unstaged + unstaged_count))
    fi
    if [[ "${include_untracked}" == "true" ]]; then
      untracked_count="${GSN_UNTRACKED_COUNT}"
      total_untracked=$((total_untracked + untracked_count))
    fi

    local repo_has_changes="false"
    if [[ "${staged_count}" != "0" || "${unstaged_count}" != "0" || "${untracked_count}" != "0" ]]; then
      repo_has_changes="true"
      repos_with_changes=$((repos_with_changes + 1))
    fi

    if [[ "${show_all_repos}" == "true" || "${repo_has_changes}" == "true" ]]; then
      repos_listed=$((repos_listed + 1))
      summary_rows+="${repo_id}"$'\t'"${rel_path}"$'\t'"${snapshot_head}"$'\t'"${status_hash}"$'\t'"${staged_count}"$'\t'"${unstaged_count}"$'\t'"${untracked_count}"$'\t'"${repo_has_changes}"$'\n'
    fi
  done < <(_git_snapshot_store_read_repo_entries "${snapshot_path}")

  printf "Snapshot diff: %s\n" "${snapshot_id}"
  printf "Root: %s\n" "${root_repo}"
  printf "Repos in scope: %s | repos with captured changes: %s\n" "${repos_in_scope}" "${repos_with_changes}"
  printf "File totals: staged=%s unstaged=%s untracked=%s\n" "${total_staged}" "${total_unstaged}" "${total_untracked}"

  if [[ "${repos_listed}" == "0" ]]; then
    printf "No captured file changes in selected scope.\n"
    return 0
  fi

  if [[ "${show_all_repos}" == "true" ]]; then
    printf "\nRepo summary (including clean captures):\n"
  else
    printf "\nRepo summary (changed captures only):\n"
  fi

  local summary_repo_id summary_rel_path summary_snapshot_head summary_status_hash summary_staged summary_unstaged summary_untracked summary_has_changes
  while IFS=$'\t' read -r summary_repo_id summary_rel_path summary_snapshot_head summary_status_hash summary_staged summary_unstaged summary_untracked summary_has_changes; do
    [[ -z "${summary_repo_id}" ]] && continue
    local state_label="clean"
    if [[ "${summary_has_changes}" == "true" ]]; then
      state_label="changed"
    fi
    local human_summary_label
    human_summary_label="$(_git_snapshot_human_repo_label "${root_repo}" "${summary_rel_path}")"
    printf "  - %s [%s]\n" "${human_summary_label}" "${state_label}"
    printf "    staged=%s unstaged=%s untracked=%s\n" "${summary_staged}" "${summary_unstaged}" "${summary_untracked}"
  done <<< "${summary_rows}"

  if [[ "${show_details}" != "true" ]]; then
    printf "\nHint: use --files, --stat, or --patch for per-file detail. Add --all-repos to include clean repos.\n"
    return 0
  fi

  printf "\nDetails (%s mode):\n" "${render_mode}"
  while IFS=$'\t' read -r summary_repo_id summary_rel_path summary_snapshot_head summary_status_hash summary_staged summary_unstaged summary_untracked summary_has_changes; do
    [[ -z "${summary_repo_id}" ]] && continue
    if [[ "${summary_has_changes}" != "true" ]]; then
      continue
    fi

    _git_snapshot_calculate_repo_state "${root_repo}" "${snapshot_path}" "${summary_repo_id}" "${summary_rel_path}" "${summary_snapshot_head}" "${summary_status_hash}"

    local staged_patch="${GSN_REPO_BUNDLE_DIR}/staged.patch"
    local unstaged_patch="${GSN_REPO_BUNDLE_DIR}/unstaged.patch"

    local human_detail_label
    human_detail_label="$(_git_snapshot_human_repo_label "${root_repo}" "${summary_rel_path}")"
    printf "\nRepo: %s\n" "${human_detail_label}"
    if [[ "${include_staged}" == "true" ]]; then
      _git_snapshot_diff_render_human_category "Staged" "${GSN_STAGED_FILES}" "${GSN_STAGED_COUNT}" "${render_mode}" "${staged_patch}" "${limit}"
    fi
    if [[ "${include_unstaged}" == "true" ]]; then
      _git_snapshot_diff_render_human_category "Unstaged" "${GSN_UNSTAGED_FILES}" "${GSN_UNSTAGED_COUNT}" "${render_mode}" "${unstaged_patch}" "${limit}"
    fi
    if [[ "${include_untracked}" == "true" ]]; then
      _git_snapshot_print_file_group_human_limited "Untracked" "${GSN_UNTRACKED_FILES}" "${GSN_UNTRACKED_COUNT}" "${limit}"
    fi
  done <<< "${summary_rows}"
}

_git_snapshot_cmd_compare() {
  local root_repo="$1"
  shift

  local snapshot_id=""
  local repo_filter=""
  local porcelain="false"
  local details="false"
  local files="false"
  local show_all_repos="false"
  local limit="20"

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --repo)
        if [[ -z "${2:-}" ]]; then
          _git_snapshot_ui_err "Missing value for --repo"
          return 1
        fi
        repo_filter="$2"
        shift
        ;;
      --porcelain)
        porcelain="true"
        ;;
      --details)
        details="true"
        ;;
      --files)
        files="true"
        details="true"
        ;;
      --all-repos)
        show_all_repos="true"
        ;;
      --limit)
        if [[ -z "${2:-}" ]]; then
          _git_snapshot_ui_err "Missing value for --limit"
          return 1
        fi
        limit="$(_git_snapshot_parse_positive_int "${2}" "--limit")" || return 1
        shift
        ;;
      --no-limit)
        limit="0"
        ;;
      -* )
        _git_snapshot_ui_err "Unknown option for compare: $1"
        return 1
        ;;
      *)
        if [[ -z "${snapshot_id}" ]]; then
          snapshot_id="$1"
        else
          _git_snapshot_ui_err "Unexpected argument for compare: $1"
          return 1
        fi
        ;;
    esac
    shift
  done

  if [[ -z "${snapshot_id}" ]]; then
    _git_snapshot_ui_err "Missing snapshot_id for compare"
    return 1
  fi

  _git_snapshot_validate_snapshot_id "${snapshot_id}"
  _git_snapshot_store_assert_snapshot_exists "${root_repo}" "${snapshot_id}"
  local snapshot_path
  snapshot_path="$(_git_snapshot_store_snapshot_path "${root_repo}" "${snapshot_id}")"

  if [[ -n "${repo_filter}" ]]; then
    _git_snapshot_validate_repo_filter "${snapshot_path}" "${repo_filter}"
  fi

  local repo_id rel_path snapshot_head status_hash
  if [[ "${porcelain}" == "true" ]]; then
    local issues_found="false"
    while IFS=$'\t' read -r repo_id rel_path snapshot_head status_hash; do
      [[ -z "${repo_id}" ]] && continue
      if [[ -n "${repo_filter}" && "${rel_path}" != "${repo_filter}" ]]; then
        continue
      fi

      _git_snapshot_calculate_repo_state "${root_repo}" "${snapshot_path}" "${repo_id}" "${rel_path}" "${snapshot_head}" "${status_hash}"

      if [[ "${GSN_REPO_HAS_ISSUES}" == "true" ]]; then
        issues_found="true"
      fi

      printf "compare\tsnapshot_id=%s\trepo=%s\trelation=%s\tahead=%s\tbehind=%s\tapply_check_staged=%s\tapply_check_unstaged=%s\tuntracked_collision_count=%s\thas_issues=%s\n" \
        "${snapshot_id}" "${rel_path}" "${GSN_RELATION}" "${GSN_AHEAD_COUNT}" "${GSN_BEHIND_COUNT}" "${GSN_APPLY_CHECK_STAGED}" "${GSN_APPLY_CHECK_UNSTAGED}" "${GSN_UNTRACKED_COLLISION_COUNT}" "${GSN_REPO_HAS_ISSUES}"
      if [[ "${files}" == "true" ]]; then
        while IFS= read -r file; do
          [[ -z "${file}" ]] && continue
          printf "compare_file\trepo=%s\tcategory=collision\tfile=%s\n" "${rel_path}" "${file}"
        done <<< "${GSN_UNTRACKED_COLLISIONS}"
      fi
    done < <(_git_snapshot_store_read_repo_entries "${snapshot_path}")

    if [[ "${issues_found}" == "true" ]]; then
      return 3
    fi
    return 0
  fi

  local repos_checked=0
  local issues_count=0
  local listed_count=0
  local summary_rows=""

  while IFS=$'\t' read -r repo_id rel_path snapshot_head status_hash; do
    [[ -z "${repo_id}" ]] && continue
    if [[ -n "${repo_filter}" && "${rel_path}" != "${repo_filter}" ]]; then
      continue
    fi

    _git_snapshot_calculate_repo_state "${root_repo}" "${snapshot_path}" "${repo_id}" "${rel_path}" "${snapshot_head}" "${status_hash}"
    repos_checked=$((repos_checked + 1))
    if [[ "${GSN_REPO_HAS_ISSUES}" == "true" ]]; then
      issues_count=$((issues_count + 1))
    fi

    if [[ "${show_all_repos}" == "true" || "${GSN_REPO_HAS_ISSUES}" == "true" ]]; then
      listed_count=$((listed_count + 1))
      summary_rows+="${repo_id}"$'\t'"${rel_path}"$'\t'"${snapshot_head}"$'\t'"${status_hash}"$'\t'"${GSN_RELATION}"$'\t'"${GSN_AHEAD_COUNT}"$'\t'"${GSN_BEHIND_COUNT}"$'\t'"${GSN_APPLY_CHECK_STAGED}"$'\t'"${GSN_APPLY_CHECK_UNSTAGED}"$'\t'"${GSN_UNTRACKED_COLLISION_COUNT}"$'\t'"${GSN_REPO_HAS_ISSUES}"$'\n'
    fi
  done < <(_git_snapshot_store_read_repo_entries "${snapshot_path}")

  local clean_count=$((repos_checked - issues_count))
  printf "Snapshot compare: %s\n" "${snapshot_id}"
  printf "Root: %s\n" "${root_repo}"
  printf "Repos checked: %s | issues: %s | clean: %s\n" "${repos_checked}" "${issues_count}" "${clean_count}"

  if [[ "${issues_count}" == "0" ]]; then
    printf "Compatibility: clean (no blocking restore issues).\n"
  else
    printf "Compatibility: issues detected.\n"
  fi

  if [[ "${listed_count}" == "0" ]]; then
    printf "No issue repos to list. Use --all-repos for a full matrix.\n"
  else
    if [[ "${show_all_repos}" == "true" ]]; then
      printf "\nRepo summary (full matrix):\n"
    else
      printf "\nRepo summary (issues only):\n"
    fi

    local summary_repo_id summary_rel_path summary_snapshot_head summary_status_hash summary_relation summary_ahead summary_behind summary_apply_staged summary_apply_unstaged summary_collision_count summary_has_issues
    while IFS=$'\t' read -r summary_repo_id summary_rel_path summary_snapshot_head summary_status_hash summary_relation summary_ahead summary_behind summary_apply_staged summary_apply_unstaged summary_collision_count summary_has_issues; do
      [[ -z "${summary_repo_id}" ]] && continue
      local status_label="clean"
      if [[ "${summary_has_issues}" == "true" ]]; then
        status_label="issues"
      fi

      local relation_label="${summary_relation}"
      if [[ "${summary_relation}" != "same" && "${summary_relation}" != "missing" ]]; then
        relation_label="${summary_relation}(+${summary_ahead}/-${summary_behind})"
      fi

      local human_summary_label
      human_summary_label="$(_git_snapshot_human_repo_label "${root_repo}" "${summary_rel_path}")"
      printf "  - %s status=%s\n" "${human_summary_label}" "${status_label}"
      printf "    relation=%s staged=%s unstaged=%s collisions=%s\n" "${relation_label}" "${summary_apply_staged}" "${summary_apply_unstaged}" "${summary_collision_count}"
    done <<< "${summary_rows}"
  fi

  if [[ "${details}" == "true" ]]; then
    local summary_repo_id summary_rel_path summary_snapshot_head summary_status_hash summary_relation summary_ahead summary_behind summary_apply_staged summary_apply_unstaged summary_collision_count summary_has_issues
    printf "\nDetails:\n"
    while IFS=$'\t' read -r summary_repo_id summary_rel_path summary_snapshot_head summary_status_hash summary_relation summary_ahead summary_behind summary_apply_staged summary_apply_unstaged summary_collision_count summary_has_issues; do
      [[ -z "${summary_repo_id}" ]] && continue
      _git_snapshot_calculate_repo_state "${root_repo}" "${snapshot_path}" "${summary_repo_id}" "${summary_rel_path}" "${summary_snapshot_head}" "${summary_status_hash}"

      local human_detail_label
      human_detail_label="$(_git_snapshot_human_repo_label "${root_repo}" "${summary_rel_path}")"
      printf "\nRepo: %s\n" "${human_detail_label}"
      printf "  Relation: %s" "${GSN_RELATION}"
      if [[ "${GSN_RELATION}" != "same" && "${GSN_RELATION}" != "missing" ]]; then
        printf " (ahead %s, behind %s)" "${GSN_AHEAD_COUNT}" "${GSN_BEHIND_COUNT}"
      fi
      printf "\n"
      printf "  Apply staged: %s\n" "${GSN_APPLY_CHECK_STAGED}"
      printf "  Apply unstaged: %s\n" "${GSN_APPLY_CHECK_UNSTAGED}"
      printf "  Untracked collisions: %s\n" "${GSN_UNTRACKED_COLLISION_COUNT}"
      printf "  Compatibility: %s\n" "$([[ "${GSN_REPO_HAS_ISSUES}" == "true" ]] && printf "issues" || printf "clean")"

      if [[ "${files}" == "true" ]]; then
        _git_snapshot_print_file_group_human_limited "Captured staged" "${GSN_STAGED_FILES}" "${GSN_STAGED_COUNT}" "${limit}"
        _git_snapshot_print_file_group_human_limited "Captured unstaged" "${GSN_UNSTAGED_FILES}" "${GSN_UNSTAGED_COUNT}" "${limit}"
        _git_snapshot_print_file_group_human_limited "Captured untracked" "${GSN_UNTRACKED_FILES}" "${GSN_UNTRACKED_COUNT}" "${limit}"
        if [[ "${GSN_UNTRACKED_COLLISION_COUNT}" != "0" ]]; then
          printf "  Collision files (%s):\n" "${GSN_UNTRACKED_COLLISION_COUNT}"
          _git_snapshot_print_lines_limited "${GSN_UNTRACKED_COLLISIONS}" "${limit}" "    - "
        fi
      fi
    done <<< "${summary_rows}"
  else
    printf "\nHint: use --details for per-repo detail and --files for captured file lists.\n"
  fi

  if [[ "${issues_count}" -gt "0" ]]; then
    return 3
  fi
  return 0
}

_git_snapshot_cmd_restore() {
  local root_repo="$1"
  local snapshot_id="$2"

  _git_snapshot_validate_snapshot_id "${snapshot_id}"
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

  _git_snapshot_validate_snapshot_id "${snapshot_id}"
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
    rename)
      _git_snapshot_cmd_rename "${root_repo}" "$@"
      ;;
    list)
      _git_snapshot_cmd_list "${root_repo}" "$@"
      ;;
    show)
      _git_snapshot_cmd_show "${root_repo}" "$@"
      ;;
    diff)
      _git_snapshot_cmd_diff "${root_repo}" "$@"
      ;;
    compare)
      _git_snapshot_cmd_compare "${root_repo}" "$@"
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
    --help|-h|help)
      _git_snapshot_usage
      ;;
    *)
      _git_snapshot_ui_err "Unknown command: ${command}"
      _git_snapshot_usage
      return 1
      ;;
  esac
}
