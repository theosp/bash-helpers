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
  git-snapshot create [snapshot_id] [--clear] [--yes]
  git-snapshot reset-all [--snapshot|--no-snapshot] [--porcelain]
  git-snapshot rename <old_snapshot_id> <new_snapshot_id> [--porcelain]
  git-snapshot list [--include-auto] [--porcelain]
  git-snapshot inspect <snapshot_id> [--repo <rel_path>] [--staged|--unstaged|--untracked|--all] [--all-repos] [--name-only|--stat|--diff] [--porcelain]
  git-snapshot restore-check <snapshot_id> [--repo <rel_path>] [--all-repos] [--details] [--files] [--limit <n>|--no-limit] [--porcelain]
  git-snapshot verify <snapshot_id> [--repo <rel_path>] [--strict-head] [--porcelain]
  git-snapshot restore <snapshot_id> [--on-conflict <reject|rollback>] [--porcelain]
  git-snapshot delete <snapshot_id>
  git-snapshot debug-dirty

Command details
---------------
create [snapshot_id] [--clear] [--yes]
  Creates snapshot data under:
    ~/git-snapshots/<root-most-repo-name>/<snapshot_id>
  If `snapshot_id` is omitted, id format is generated as:
    YYYY-MM-DD--HH-MM-SS
  If an id collision occurs for the same generated timestamp:
    YYYY-MM-DD--HH-MM-SS-02 (then -03, ...)
  Flags:
  - `--clear` : clear snapshotted repos after capture (`reset --hard`, `clean -fd`)
  - `--yes`   : bypass clear confirmation prompt (valid only with `--clear`)
  Clear behavior:
  - confirmation prompt: `Proceed with clear? [y/N]:`
  - no submodule checkout/update alignment is performed
  - submodule HEAD drift is warning-only and does not fail clear
  - clear is best-effort; failures are reported and command exits non-zero
  Output contract:
  - final output line is always the snapshot id (including clear-failure cases)
  - informational lines can appear above it

reset-all [--snapshot|--no-snapshot] [--porcelain]
  Clears root-most repo + initialized recursive submodules:
    - `git reset --hard`
    - `git clean -fd`
  Snapshot choice policy:
  - `--snapshot`    : create auto snapshot before clear
  - `--no-snapshot` : clear without pre-clear snapshot
  - neither flag    : ask `Create auto snapshot before clear? [y/N]:`
  - both flags      : usage error
  Notes:
  - no extra destructive confirmation is asked after snapshot decision
  - non-interactive mode requires `--snapshot` or `--no-snapshot`
  - auto snapshots use label prefix `before-reset-all-` and origin `auto`
  - submodule HEAD drift is warning-only and does not fail clear
  - clear is best-effort; failures are reported and command exits non-zero
  Porcelain output:
  - `reset_all_snapshot\tcreated=<true|false>\tsnapshot_id=<id-or-empty>`
  - `reset_all_summary\tresult=<success|failed>\tsnapshot_created=<true|false>\tsnapshot_id=<id-or-empty>\trepos_total=<n>\trepos_cleared=<n>\trepos_failed=<n>\texit_code=<0|1>`

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
  Default list view hides auto-generated internal snapshots.
  Optional flags:
  - `--include-auto` : include auto-generated snapshots in listing output
  Human output columns:
  - ID
  - Created (local timezone)
  - Age
  - Repos
  - Root (snapshot source root path; shown when visible snapshots are not all from current root)
  - Auto (`*` means auto-generated; shown only when `--include-auto` is used)
  Note:
  - snapshot registry is keyed by root repo folder name
  - repositories sharing the same folder name share one snapshot registry
  Porcelain output:
  - one `snapshot\t...` line per snapshot
  - fields: id, created_at_epoch, repo_count, root_repo, origin

  inspect
  Inspects captured bundle content without mutating current repos.
  This command shows what was captured, not what changed since capture.
  Default human output includes summary + per-repo `--stat` detail.

  Category flags (combine as needed):
  - `--staged`    : include staged category
  - `--unstaged`  : include unstaged category
  - `--untracked` : include untracked category
  - `--all`       : include staged + unstaged + untracked
  - default       : all categories enabled when no category flags are passed

  Scope/detail flags:
  - `--all-repos` : include clean repos in summary output (default: off, changed repos only)

  Render flags (mutually exclusive):
  - `--name-only` : file paths only (default: off)
  - `--stat`      : git apply --stat summary (default: on)
  - `--diff`      : raw patch body for staged/unstaged (default: off)

restore-check
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

verify
  Verifies whether current working-set state matches what the snapshot captured.
  Default verification scope:
  - staged patch bytes
  - unstaged patch bytes
  - untracked non-ignored file set+content
  Default head policy:
  - HEAD mismatch is warning-only (`--strict-head` turns it into mismatch/failure)
  Caveat:
  - default mode does not guarantee full tracked clean-file equivalence across branches/commits
  Optional flags:
  - `--repo <rel_path>` : verify one snapshot repo path
  - `--strict-head`     : require current HEAD to equal snapshot HEAD
  - `--porcelain`       : stable machine output
  Exit codes:
  - 0 : verified (or warnings only)
  - 3 : mismatches detected
  - 1 : usage/runtime error

restore
  Restores tracked + untracked non-ignored state from snapshot bundles.
  Conflict policy:
  - default (`--on-conflict reject`):
    - applies compatible hunks
    - leaves `*.rej` files for rejected hunks
    - preserves colliding untracked paths and reports them
    - exits 4 when manual resolution is required
  - `--on-conflict rollback`:
    - preserves atomic behavior
    - auto-rollbacks to a safety snapshot on restore failure
  Optional flags:
  - `--porcelain` : stable machine output (`restore_*` rows)
  Exit codes:
  - 0 : restore completed successfully
  - 4 : partial restore (reject/collision) in reject mode
  - 1 : usage/runtime error or failed restore
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

GIT_SNAPSHOT_CONFIRM_CLEAR=YES
  Non-interactive clear confirmation override for `create --clear`.

Examples
--------
Create and inspect:
  git-snapshot create
  git-snapshot create --clear --yes
  git-snapshot reset-all --snapshot
  git-snapshot create before-rebase
  git-snapshot create before-task-switch --clear
  git-snapshot rename before-rebase before-rebase-validated
  git-snapshot list

Machine output:
  git-snapshot reset-all --no-snapshot --porcelain
  git-snapshot list --porcelain
  git-snapshot list --include-auto --porcelain
  git-snapshot inspect before-rebase --porcelain

Deep inspection:
  git-snapshot inspect before-rebase
  git-snapshot inspect before-rebase --stat
  git-snapshot inspect before-rebase --name-only
  git-snapshot inspect before-rebase --repo modules/sub1 --staged --diff
  git-snapshot inspect before-rebase --all-repos --name-only
  git-snapshot inspect before-rebase --porcelain
  git-snapshot restore-check before-rebase
  git-snapshot restore-check before-rebase --details
  git-snapshot restore-check before-rebase --files
  git-snapshot restore-check before-rebase --porcelain
  git-snapshot verify before-rebase
  git-snapshot verify before-rebase --strict-head
  git-snapshot verify before-rebase --porcelain

Restore:
  git-snapshot restore before-rebase
  git-snapshot restore before-rebase --on-conflict rollback
  git-snapshot restore before-rebase --porcelain

Troubleshooting
---------------
- "Refusing to operate outside enforced prefix":
  resolved root repo is outside `GIT_SNAPSHOT_ENFORCE_ROOT_PREFIX`.
- restore-check exits 3:
  one or more repos are not restore-compatible in current state.
- verify exits 3:
  one or more snapshot working-set mismatches were detected.
- restore failed:
  inspect error details, then use safety snapshot id printed by restore flow.
- restore exits 4:
  partial restore in reject mode; resolve `*.rej` and collision files, then verify.
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
  local snapshot_origin="${5:-user}"

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
  _git_snapshot_store_write_snapshot_meta "${snapshot_path}" "${snapshot_id}" "${root_repo}" "${repo_count}" "" "${snapshot_origin}"

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

  _git_snapshot_ui_human_repo_label "${root_repo}" "${rel_path}"
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

_git_snapshot_preview_lines_inline() {
  local content="$1"
  local limit="${2:-5}"
  local total=0
  local shown=0
  local line
  local preview=""

  while IFS= read -r line; do
    [[ -z "${line}" ]] && continue
    total=$((total + 1))
    if [[ "${shown}" -lt "${limit}" ]]; then
      if [[ -n "${preview}" ]]; then
        preview+=", "
      fi
      preview+="${line}"
      shown=$((shown + 1))
    fi
  done <<< "${content}"

  if [[ "${total}" -eq 0 ]]; then
    printf "none"
    return 0
  fi

  if [[ "${total}" -gt "${shown}" ]]; then
    printf "%s (+%s more)" "${preview}" "$((total - shown))"
    return 0
  fi

  printf "%s" "${preview}"
}

_git_snapshot_clear_single_repo() {
  local repo_abs="$1"
  local err_output=""

  if ! git -C "${repo_abs}" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    printf "not a git working tree"
    return 1
  fi

  if ! err_output="$(git -C "${repo_abs}" reset --hard 2>&1 >/dev/null)"; then
    if [[ -z "${err_output}" ]]; then
      err_output="unknown error"
    fi
    printf "git reset --hard failed (%s)" "${err_output}"
    return 1
  fi

  if ! err_output="$(git -C "${repo_abs}" clean -fd 2>&1 >/dev/null)"; then
    if [[ -z "${err_output}" ]]; then
      err_output="unknown error"
    fi
    printf "git clean -fd failed (%s)" "${err_output}"
    return 1
  fi

  return 0
}

_git_snapshot_detect_submodule_drift_paths() {
  local root_repo="$1"

  git -C "${root_repo}" submodule status --recursive 2>/dev/null | awk '/^\+/ {print $2}'
}

_git_snapshot_clear_from_rel_paths() {
  local root_repo="$1"
  local rel_paths="$2"
  local emit_human="${3:-true}"
  local operation_label="${4:---clear}"
  local total_repos=0
  local cleared_repos=0
  local failed_repos=0
  local rel_path repo_abs failure_reason human_repo_label
  local -a failures=()
  local drift_paths=""
  local drift_count=0

  GSN_CLEAR_TOTAL_REPOS=0
  GSN_CLEAR_CLEARED_REPOS=0
  GSN_CLEAR_FAILED_REPOS=0
  GSN_CLEAR_FAILURES=""
  GSN_CLEAR_DRIFT_COUNT=0
  GSN_CLEAR_DRIFT_PATHS=""

  while IFS= read -r rel_path; do
    [[ -z "${rel_path}" ]] && continue
    total_repos=$((total_repos + 1))
    repo_abs="${root_repo}/${rel_path}"
    human_repo_label="$(_git_snapshot_human_repo_label "${root_repo}" "${rel_path}")"

    if ! failure_reason="$(_git_snapshot_clear_single_repo "${repo_abs}")"; then
      failed_repos=$((failed_repos + 1))
      failures+=("${human_repo_label}: ${failure_reason}")
      continue
    fi

    cleared_repos=$((cleared_repos + 1))
  done <<< "${rel_paths}"

  drift_paths="$(_git_snapshot_detect_submodule_drift_paths "${root_repo}")"
  if [[ -n "${drift_paths}" ]]; then
    while IFS= read -r _drift_path; do
      [[ -z "${_drift_path}" ]] && continue
      drift_count=$((drift_count + 1))
    done <<< "${drift_paths}"
  fi

  GSN_CLEAR_TOTAL_REPOS="${total_repos}"
  GSN_CLEAR_CLEARED_REPOS="${cleared_repos}"
  GSN_CLEAR_FAILED_REPOS="${failed_repos}"
  GSN_CLEAR_DRIFT_COUNT="${drift_count}"
  GSN_CLEAR_DRIFT_PATHS="${drift_paths}"
  if [[ "${failed_repos}" -gt 0 ]]; then
    GSN_CLEAR_FAILURES="$(printf "%s\n" "${failures[@]}")"
  fi

  if [[ "${emit_human}" == "true" && "${drift_count}" -gt 0 ]]; then
    _git_snapshot_ui_warn "Submodule HEAD drift remains by design (no checkout/update in ${operation_label}):"
    while IFS= read -r _drift_path; do
      [[ -z "${_drift_path}" ]] && continue
      _git_snapshot_ui_warn "  - ${_drift_path}"
    done <<< "${drift_paths}"
  fi

  if [[ "${failed_repos}" -gt 0 ]]; then
    if [[ "${emit_human}" == "true" ]]; then
      _git_snapshot_ui_err "Clear completed with failures (${failed_repos}/${total_repos} repos)."
      for failure_reason in "${failures[@]}"; do
        _git_snapshot_ui_err "  - ${failure_reason}"
      done
    fi
    return 1
  fi

  if [[ "${emit_human}" == "true" ]]; then
    _git_snapshot_ui_info "Clear completed (${cleared_repos}/${total_repos} repos)."
  fi
  return 0
}

_git_snapshot_clear_from_snapshot() {
  local root_repo="$1"
  local snapshot_id="$2"
  local snapshot_path
  local rel_paths=""
  local repo_id rel_path _head _status_hash

  snapshot_path="$(_git_snapshot_store_snapshot_path "${root_repo}" "${snapshot_id}")"
  _git_snapshot_store_assert_snapshot_exists "${root_repo}" "${snapshot_id}" || return 1

  while IFS=$'\t' read -r repo_id rel_path _head _status_hash; do
    [[ -z "${repo_id}" ]] && continue
    rel_paths+="${rel_path}"$'\n'
  done < <(_git_snapshot_store_read_repo_entries "${snapshot_path}")

  _git_snapshot_clear_from_rel_paths "${root_repo}" "${rel_paths}" true "--clear"
}

_git_snapshot_clear_root_scope() {
  local root_repo="$1"
  local emit_human="${2:-true}"
  local operation_label="${3:-reset-all}"
  local rel_paths=""
  local rel_path

  while IFS= read -r rel_path; do
    [[ -z "${rel_path}" ]] && continue
    rel_paths+="${rel_path}"$'\n'
  done < <(_git_snapshot_repo_collect_all_relative_paths "${root_repo}")

  _git_snapshot_clear_from_rel_paths "${root_repo}" "${rel_paths}" "${emit_human}" "${operation_label}"
}

_git_snapshot_cmd_create() {
  local root_repo="$1"
  shift
  local snapshot_id_override=""
  local do_clear="false"
  local skip_clear_confirmation="false"
  local snapshot_id snapshot_path
  local clear_status=0

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --clear)
        do_clear="true"
        ;;
      --yes)
        skip_clear_confirmation="true"
        ;;
      -*)
        _git_snapshot_ui_err "Unknown option for create: $1"
        return 1
        ;;
      *)
        if [[ -z "${snapshot_id_override}" ]]; then
          snapshot_id_override="$1"
        else
          _git_snapshot_ui_err "Unexpected argument for create: $1"
          return 1
        fi
        ;;
    esac
    shift
  done

  if [[ "${skip_clear_confirmation}" == "true" && "${do_clear}" != "true" ]]; then
    _git_snapshot_ui_err "--yes is only valid with --clear"
    return 1
  fi

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

  if [[ "${do_clear}" == "true" && "${skip_clear_confirmation}" != "true" ]]; then
    _git_snapshot_ui_confirm_yes_no "Proceed with clear? [y/N]: " "GIT_SNAPSHOT_CONFIRM_CLEAR" "YES" || return 1
  fi

  snapshot_id="$(_git_snapshot_create_internal "${root_repo}" "snapshot" false "${snapshot_id_override}" "user")" || return 1
  snapshot_path="$(_git_snapshot_store_snapshot_path "${root_repo}" "${snapshot_id}")"
  _git_snapshot_store_load_snapshot_meta "${snapshot_path}" || return 1
  _git_snapshot_ui_info "Created snapshot ${snapshot_id} (repos=${REPO_COUNT})"

  if [[ "${do_clear}" == "true" ]]; then
    if ! _git_snapshot_clear_from_snapshot "${root_repo}" "${snapshot_id}"; then
      clear_status=1
    fi
  fi

  printf "%s\n" "${snapshot_id}"
  return "${clear_status}"
}

_git_snapshot_cmd_reset_all() {
  local root_repo="$1"
  shift
  local porcelain="false"
  local snapshot_choice="ask"
  local should_create_snapshot="false"
  local snapshot_created="false"
  local snapshot_id=""
  local clear_status=0
  local summary_result="success"
  local emit_clear_human="true"

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --snapshot)
        if [[ "${snapshot_choice}" == "no" ]]; then
          _git_snapshot_ui_err "--snapshot and --no-snapshot cannot be used together"
          return 1
        fi
        snapshot_choice="yes"
        ;;
      --no-snapshot)
        if [[ "${snapshot_choice}" == "yes" ]]; then
          _git_snapshot_ui_err "--snapshot and --no-snapshot cannot be used together"
          return 1
        fi
        snapshot_choice="no"
        ;;
      --porcelain)
        porcelain="true"
        ;;
      -*)
        _git_snapshot_ui_err "Unknown option for reset-all: $1"
        return 1
        ;;
      *)
        _git_snapshot_ui_err "Unexpected argument for reset-all: $1"
        return 1
        ;;
    esac
    shift
  done

  if [[ "${snapshot_choice}" == "yes" ]]; then
    should_create_snapshot="true"
  elif [[ "${snapshot_choice}" == "no" ]]; then
    should_create_snapshot="false"
  else
    if _git_snapshot_ui_choose_yes_no_default_no "Create auto snapshot before clear? [y/N]: " "Use --snapshot or --no-snapshot."; then
      should_create_snapshot="true"
    else
      local choice_code=$?
      if [[ "${choice_code}" -eq 1 ]]; then
        should_create_snapshot="false"
      else
        return 1
      fi
    fi
  fi

  if [[ "${should_create_snapshot}" == "true" ]]; then
    snapshot_id="$(_git_snapshot_create_internal "${root_repo}" "before-reset-all" false "" "auto")" || {
      if [[ "${porcelain}" == "true" ]]; then
        printf "reset_all_snapshot\tcreated=false\tsnapshot_id=\n"
        printf "reset_all_summary\tresult=failed\tsnapshot_created=false\tsnapshot_id=\trepos_total=0\trepos_cleared=0\trepos_failed=0\texit_code=1\n"
      fi
      return 1
    }
    snapshot_created="true"
    if [[ "${porcelain}" != "true" ]]; then
      _git_snapshot_ui_info "Created auto snapshot ${snapshot_id} before reset-all."
    fi
  else
    if [[ "${porcelain}" != "true" ]]; then
      _git_snapshot_ui_info "Proceeding without pre-clear snapshot."
    fi
  fi

  if [[ "${porcelain}" == "true" ]]; then
    emit_clear_human="false"
    printf "reset_all_snapshot\tcreated=%s\tsnapshot_id=%s\n" "${snapshot_created}" "${snapshot_id}"
  fi

  if ! _git_snapshot_clear_root_scope "${root_repo}" "${emit_clear_human}" "reset-all"; then
    clear_status=1
    summary_result="failed"
  fi

  if [[ "${porcelain}" == "true" ]]; then
    printf "reset_all_summary\tresult=%s\tsnapshot_created=%s\tsnapshot_id=%s\trepos_total=%s\trepos_cleared=%s\trepos_failed=%s\texit_code=%s\n" \
      "${summary_result}" \
      "${snapshot_created}" \
      "${snapshot_id}" \
      "${GSN_CLEAR_TOTAL_REPOS:-0}" \
      "${GSN_CLEAR_CLEARED_REPOS:-0}" \
      "${GSN_CLEAR_FAILED_REPOS:-0}" \
      "${clear_status}"
  fi

  return "${clear_status}"
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
  local include_auto="false"

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --include-auto)
        include_auto="true"
        ;;
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
  local hidden_auto_count=0
  local visible_count=0
  if [[ "${porcelain}" == "true" ]]; then
    while IFS= read -r snapshot_id; do
      [[ -z "${snapshot_id}" ]] && continue
      snapshot_path="$(_git_snapshot_store_snapshot_path "${root_repo}" "${snapshot_id}")"
      _git_snapshot_store_load_snapshot_meta "${snapshot_path}"
      if [[ "${include_auto}" != "true" && "${SNAPSHOT_ORIGIN}" == "auto" ]]; then
        hidden_auto_count=$((hidden_auto_count + 1))
        continue
      fi
      visible_count=$((visible_count + 1))
      printf "snapshot\tid=%s\tcreated_at_epoch=%s\trepo_count=%s\troot_repo=%s\torigin=%s\n" "${snapshot_id}" "${CREATED_AT_EPOCH}" "${REPO_COUNT}" "${ROOT_REPO}" "${SNAPSHOT_ORIGIN}"
    done < <(_git_snapshot_store_list_snapshot_ids "${root_repo}")
    return 0
  fi

  local rows=""
  local show_root_column="false"
  local distinct_root_count=0
  local unique_roots=""
  local only_root=""
  while IFS= read -r snapshot_id; do
    [[ -z "${snapshot_id}" ]] && continue
    snapshot_path="$(_git_snapshot_store_snapshot_path "${root_repo}" "${snapshot_id}")"
    _git_snapshot_store_load_snapshot_meta "${snapshot_path}"
    if [[ "${include_auto}" != "true" && "${SNAPSHOT_ORIGIN}" == "auto" ]]; then
      hidden_auto_count=$((hidden_auto_count + 1))
      continue
    fi
    visible_count=$((visible_count + 1))
    rows+="${CREATED_AT_EPOCH}"$'\t'"${snapshot_id}"$'\t'"${REPO_COUNT}"$'\t'"${SNAPSHOT_ORIGIN}"$'\t'"${ROOT_REPO}"$'\n'
  done < <(_git_snapshot_store_list_snapshot_ids "${root_repo}")

  unique_roots="$(printf "%s" "${rows}" | awk -F'\t' 'NF >= 5 && $5 != "" {print $5}' | sort -u)"
  distinct_root_count="$(printf "%s\n" "${unique_roots}" | awk 'NF {count++} END {print count + 0}')"
  if [[ "${distinct_root_count}" -gt 1 ]]; then
    show_root_column="true"
  elif [[ "${distinct_root_count}" -eq 1 ]]; then
    only_root="$(printf "%s\n" "${unique_roots}" | awk 'NF {print; exit}')"
    if [[ "${only_root}" != "${root_repo}" ]]; then
      show_root_column="true"
    fi
  fi

  if [[ "${visible_count}" -eq 0 ]]; then
    if [[ "${include_auto}" == "true" ]]; then
      printf "No snapshots found (%s)\n" "${root_repo}"
      printf "\n"
      printf "Note: snapshot registry is keyed by root repo folder name. Repositories sharing the same folder name share this registry.\n"
      return 0
    fi
    printf "No user-created snapshots found (%s)\n" "${root_repo}"
    if [[ "${hidden_auto_count}" -gt 0 ]]; then
      printf "Hint: %s auto-generated snapshot(s) hidden. Run: git-snapshot list --include-auto\n" "${hidden_auto_count}"
    fi
    printf "\n"
    printf "Note: snapshot registry is keyed by root repo folder name. Repositories sharing the same folder name share this registry.\n"
    return 0
  fi

  printf "Snapshots (%s)\n" "${root_repo}"
  if [[ "${include_auto}" == "true" ]]; then
    if [[ "${show_root_column}" == "true" ]]; then
      printf "%-28s %-19s %-6s %-7s %-48s %-4s\n" "ID" "Created" "Age" "Repos" "Root" "Auto"
    else
      printf "%-28s %-19s %-6s %-7s %-4s\n" "ID" "Created" "Age" "Repos" "Auto"
    fi
  else
    if [[ "${show_root_column}" == "true" ]]; then
      printf "%-28s %-19s %-6s %-7s %-48s\n" "ID" "Created" "Age" "Repos" "Root"
    else
      printf "%-28s %-19s %-6s %-7s\n" "ID" "Created" "Age" "Repos"
    fi
  fi
  while IFS=$'\t' read -r epoch snapshot_id repo_count snapshot_origin snapshot_root_repo; do
    [[ -z "${snapshot_id}" ]] && continue
    local created age
    created="$(_git_snapshot_inspect_format_epoch_local "${epoch}")"
    age="$(_git_snapshot_inspect_age "${epoch}")"
    if [[ "${include_auto}" == "true" ]]; then
      local auto_marker=""
      if [[ "${snapshot_origin}" == "auto" ]]; then
        auto_marker="*"
      fi
      if [[ "${show_root_column}" == "true" ]]; then
        printf "%-28s %-19s %-6s %-7s %-48s %-4s\n" "${snapshot_id}" "${created}" "${age}" "${repo_count}" "${snapshot_root_repo}" "${auto_marker}"
      else
        printf "%-28s %-19s %-6s %-7s %-4s\n" "${snapshot_id}" "${created}" "${age}" "${repo_count}" "${auto_marker}"
      fi
    else
      if [[ "${show_root_column}" == "true" ]]; then
        printf "%-28s %-19s %-6s %-7s %-48s\n" "${snapshot_id}" "${created}" "${age}" "${repo_count}" "${snapshot_root_repo}"
      else
        printf "%-28s %-19s %-6s %-7s\n" "${snapshot_id}" "${created}" "${age}" "${repo_count}"
      fi
    fi
  done < <(printf "%s" "${rows}" | sort -t$'\t' -k1,1nr)

  if [[ "${include_auto}" == "true" ]]; then
    printf "* = auto-generated snapshot\n"
  elif [[ "${hidden_auto_count}" -gt 0 ]]; then
    printf "Hint: %s auto-generated snapshot(s) hidden. Run: git-snapshot list --include-auto\n" "${hidden_auto_count}"
  fi
  printf "\n"
  printf "Note: snapshot registry is keyed by root repo folder name. Repositories sharing the same folder name share this registry.\n"
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
    diff)
      while IFS= read -r patch_line; do
        printf "    %s\n" "${patch_line}"
      done < "${patch_file}"
      ;;
  esac
}

_git_snapshot_cmd_inspect() {
  local root_repo="$1"
  shift

  local snapshot_id=""
  local repo_filter=""
  local porcelain="false"
  local include_staged="false"
  local include_unstaged="false"
  local include_untracked="false"
  local render_mode="stat"
  local render_flag_count=0
  local show_all_repos="false"

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
      --name-only)
        render_mode="name-only"
        render_flag_count=$((render_flag_count + 1))
        ;;
      --stat)
        render_mode="stat"
        render_flag_count=$((render_flag_count + 1))
        ;;
      --diff)
        render_mode="diff"
        render_flag_count=$((render_flag_count + 1))
        ;;
      -* )
        _git_snapshot_ui_err "Unknown option for inspect: $1"
        return 1
        ;;
      *)
        if [[ -z "${snapshot_id}" ]]; then
          snapshot_id="$1"
        else
          _git_snapshot_ui_err "Unexpected argument for inspect: $1"
          return 1
        fi
        ;;
    esac
    shift
  done

  if [[ -z "${snapshot_id}" ]]; then
    _git_snapshot_ui_err "Missing snapshot_id for inspect"
    return 1
  fi
  if (( render_flag_count > 1 )); then
    _git_snapshot_ui_err "Only one of --name-only/--stat/--diff is allowed"
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
        printf "inspect\tsnapshot_id=%s\trepo=%s\tcategory=staged\tfile_count=%s\n" "${snapshot_id}" "${rel_path}" "${GSN_STAGED_COUNT}"
        while IFS= read -r file; do
          [[ -z "${file}" ]] && continue
          printf "inspect_file\trepo=%s\tcategory=staged\tfile=%s\n" "${rel_path}" "${file}"
        done <<< "${GSN_STAGED_FILES}"
      fi
      if [[ "${include_unstaged}" == "true" ]]; then
        printf "inspect\tsnapshot_id=%s\trepo=%s\tcategory=unstaged\tfile_count=%s\n" "${snapshot_id}" "${rel_path}" "${GSN_UNSTAGED_COUNT}"
        while IFS= read -r file; do
          [[ -z "${file}" ]] && continue
          printf "inspect_file\trepo=%s\tcategory=unstaged\tfile=%s\n" "${rel_path}" "${file}"
        done <<< "${GSN_UNSTAGED_FILES}"
      fi
      if [[ "${include_untracked}" == "true" ]]; then
        printf "inspect\tsnapshot_id=%s\trepo=%s\tcategory=untracked\tfile_count=%s\n" "${snapshot_id}" "${rel_path}" "${GSN_UNTRACKED_COUNT}"
        while IFS= read -r file; do
          [[ -z "${file}" ]] && continue
          printf "inspect_file\trepo=%s\tcategory=untracked\tfile=%s\n" "${rel_path}" "${file}"
        done <<< "${GSN_UNTRACKED_FILES}"
      fi
    done < <(_git_snapshot_store_read_repo_entries "${snapshot_path}")
    return 0
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

  printf "Snapshot inspect: %s\n" "${snapshot_id}"
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
      _git_snapshot_diff_render_human_category "Staged" "${GSN_STAGED_FILES}" "${GSN_STAGED_COUNT}" "${render_mode}" "${staged_patch}" "0"
    fi
    if [[ "${include_unstaged}" == "true" ]]; then
      _git_snapshot_diff_render_human_category "Unstaged" "${GSN_UNSTAGED_FILES}" "${GSN_UNSTAGED_COUNT}" "${render_mode}" "${unstaged_patch}" "0"
    fi
    if [[ "${include_untracked}" == "true" ]]; then
      _git_snapshot_print_file_group_human_limited "Untracked" "${GSN_UNTRACKED_FILES}" "${GSN_UNTRACKED_COUNT}" "0"
    fi
  done <<< "${summary_rows}"

  printf "\nHint: use --name-only for file paths or --diff for full patch output. Add --all-repos to include clean repos.\n"
}

_git_snapshot_cmd_restore_check() {
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
        _git_snapshot_ui_err "Unknown option for restore-check: $1"
        return 1
        ;;
      *)
        if [[ -z "${snapshot_id}" ]]; then
          snapshot_id="$1"
        else
          _git_snapshot_ui_err "Unexpected argument for restore-check: $1"
          return 1
        fi
        ;;
    esac
    shift
  done

  if [[ -z "${snapshot_id}" ]]; then
    _git_snapshot_ui_err "Missing snapshot_id for restore-check"
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

      printf "restore_check\tsnapshot_id=%s\trepo=%s\trelation=%s\tahead=%s\tbehind=%s\tapply_check_staged=%s\tapply_check_unstaged=%s\tuntracked_collision_count=%s\thas_issues=%s\n" \
        "${snapshot_id}" "${rel_path}" "${GSN_RELATION}" "${GSN_AHEAD_COUNT}" "${GSN_BEHIND_COUNT}" "${GSN_APPLY_CHECK_STAGED}" "${GSN_APPLY_CHECK_UNSTAGED}" "${GSN_UNTRACKED_COLLISION_COUNT}" "${GSN_REPO_HAS_ISSUES}"
      if [[ "${files}" == "true" ]]; then
        while IFS= read -r file; do
          [[ -z "${file}" ]] && continue
          printf "restore_check_file\trepo=%s\tcategory=collision\tfile=%s\n" "${rel_path}" "${file}"
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
  printf "Snapshot restore-check: %s\n" "${snapshot_id}"
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

_git_snapshot_write_current_untracked_manifest() {
  local repo_abs="$1"
  local output_file="$2"
  local rel_path hash

  : > "${output_file}"
  while IFS= read -r -d '' rel_path; do
    [[ -z "${rel_path}" ]] && continue
    hash="$(shasum -a 256 "${repo_abs}/${rel_path}" | awk '{print $1}')"
    printf "%s\t%s\n" "${rel_path}" "${hash}" >> "${output_file}"
  done < <(git -C "${repo_abs}" ls-files --others --exclude-standard -z)

  LC_ALL=C sort -o "${output_file}" "${output_file}"
}

_git_snapshot_write_snapshot_untracked_manifest() {
  local repo_bundle_dir="$1"
  local output_file="$2"
  local tar_file="${repo_bundle_dir}/untracked.tar"
  local rel_path hash

  : > "${output_file}"
  if [[ ! -f "${tar_file}" ]]; then
    return 0
  fi

  while IFS= read -r rel_path; do
    [[ -z "${rel_path}" ]] && continue
    hash="$(tar -xOf "${tar_file}" "${rel_path}" | shasum -a 256 | awk '{print $1}')"
    printf "%s\t%s\n" "${rel_path}" "${hash}" >> "${output_file}"
  done < <(tar -tf "${tar_file}")

  LC_ALL=C sort -o "${output_file}" "${output_file}"
}

_git_snapshot_cmd_verify() {
  local root_repo="$1"
  shift

  local snapshot_id=""
  local repo_filter=""
  local repo_filter_cmd_fragment=""
  local porcelain="false"
  local strict_head="false"

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
      --strict-head)
        strict_head="true"
        ;;
      -*)
        _git_snapshot_ui_err "Unknown option for verify: $1"
        return 1
        ;;
      *)
        if [[ -z "${snapshot_id}" ]]; then
          snapshot_id="$1"
        else
          _git_snapshot_ui_err "Unexpected argument for verify: $1"
          return 1
        fi
        ;;
    esac
    shift
  done

  if [[ -z "${snapshot_id}" ]]; then
    _git_snapshot_ui_err "Missing snapshot_id for verify"
    return 1
  fi

  _git_snapshot_validate_snapshot_id "${snapshot_id}"
  _git_snapshot_store_assert_snapshot_exists "${root_repo}" "${snapshot_id}"
  local snapshot_path
  snapshot_path="$(_git_snapshot_store_snapshot_path "${root_repo}" "${snapshot_id}")"

  if [[ -n "${repo_filter}" ]]; then
    _git_snapshot_validate_repo_filter "${snapshot_path}" "${repo_filter}"
    repo_filter_cmd_fragment=" --repo ${repo_filter}"
  fi

  local repos_checked=0
  local mismatch_count=0
  local warning_count=0
  local mismatch_rows=""
  local warning_rows=""
  local repo_id rel_path snapshot_head _status_hash

  while IFS=$'\t' read -r repo_id rel_path snapshot_head _status_hash; do
    [[ -z "${repo_id}" ]] && continue
    if [[ -n "${repo_filter}" && "${rel_path}" != "${repo_filter}" ]]; then
      continue
    fi
    repos_checked=$((repos_checked + 1))

    local repo_abs repo_bundle_dir current_head
    local human_repo_label
    local head_state="same"
    local staged_state="match"
    local unstaged_state="match"
    local untracked_state="match"
    local has_mismatch="false"
    local has_warning="false"
    local repo_mismatch_rows=""
    local repo_warning_rows=""

    repo_abs="${root_repo}/${rel_path}"
    repo_bundle_dir="$(_git_snapshot_store_repo_dir_for_id "${snapshot_path}" "${repo_id}")"
    human_repo_label="$(_git_snapshot_human_repo_label "${root_repo}" "${rel_path}")"

    if ! git -C "${repo_abs}" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
      head_state="missing"
      staged_state="missing"
      unstaged_state="missing"
      untracked_state="missing"
      has_mismatch="true"
      repo_mismatch_rows+="${human_repo_label}: repo missing at path=${human_repo_label}"$'\n'
    else
      current_head="$(git -C "${repo_abs}" rev-parse HEAD 2>/dev/null || true)"
      if [[ "${current_head}" != "${snapshot_head}" ]]; then
        head_state="mismatch"
        if [[ "${strict_head}" == "true" ]]; then
          has_mismatch="true"
          repo_mismatch_rows+="${human_repo_label}: head mismatch snapshot=${snapshot_head} current=${current_head}"$'\n'
        else
          has_warning="true"
          repo_warning_rows+="${human_repo_label}: head mismatch snapshot=${snapshot_head} current=${current_head}"$'\n'
        fi
      fi

      local expected_staged_hash current_staged_hash
      local expected_staged_files current_staged_files
      local expected_staged_count current_staged_count
      local expected_staged_preview current_staged_preview
      local expected_unstaged_hash current_unstaged_hash
      local expected_unstaged_files current_unstaged_files
      local expected_unstaged_count current_unstaged_count
      local expected_unstaged_preview current_unstaged_preview
      local expected_untracked_files current_untracked_files
      local expected_untracked_count current_untracked_count
      local expected_untracked_preview current_untracked_preview
      expected_staged_hash="$(shasum -a 256 "${repo_bundle_dir}/staged.patch" | awk '{print $1}')"
      current_staged_hash="$(git -C "${repo_abs}" diff --cached --binary | shasum -a 256 | awk '{print $1}')"
      if [[ "${expected_staged_hash}" != "${current_staged_hash}" ]]; then
        staged_state="mismatch"
        has_mismatch="true"
        expected_staged_files="$(_git_snapshot_inspect_patch_files "${repo_bundle_dir}/staged.patch")"
        current_staged_files="$(git -C "${repo_abs}" diff --cached --name-only | sed '/^$/d')"
        expected_staged_count="$(_git_snapshot_inspect_count_lines "${expected_staged_files}")"
        current_staged_count="$(_git_snapshot_inspect_count_lines "${current_staged_files}")"
        expected_staged_preview="$(_git_snapshot_preview_lines_inline "${expected_staged_files}" 5)"
        current_staged_preview="$(_git_snapshot_preview_lines_inline "${current_staged_files}" 5)"
        repo_mismatch_rows+="${human_repo_label}: staged patch differs (snapshot=${expected_staged_count} [${expected_staged_preview}] | current=${current_staged_count} [${current_staged_preview}])"$'\n'
      fi

      expected_unstaged_hash="$(shasum -a 256 "${repo_bundle_dir}/unstaged.patch" | awk '{print $1}')"
      current_unstaged_hash="$(git -C "${repo_abs}" diff --binary | shasum -a 256 | awk '{print $1}')"
      if [[ "${expected_unstaged_hash}" != "${current_unstaged_hash}" ]]; then
        unstaged_state="mismatch"
        has_mismatch="true"
        expected_unstaged_files="$(_git_snapshot_inspect_patch_files "${repo_bundle_dir}/unstaged.patch")"
        current_unstaged_files="$(git -C "${repo_abs}" diff --name-only | sed '/^$/d')"
        expected_unstaged_count="$(_git_snapshot_inspect_count_lines "${expected_unstaged_files}")"
        current_unstaged_count="$(_git_snapshot_inspect_count_lines "${current_unstaged_files}")"
        expected_unstaged_preview="$(_git_snapshot_preview_lines_inline "${expected_unstaged_files}" 5)"
        current_unstaged_preview="$(_git_snapshot_preview_lines_inline "${current_unstaged_files}" 5)"
        repo_mismatch_rows+="${human_repo_label}: unstaged patch differs (snapshot=${expected_unstaged_count} [${expected_unstaged_preview}] | current=${current_unstaged_count} [${current_unstaged_preview}])"$'\n'
      fi

      local expected_untracked_manifest current_untracked_manifest
      expected_untracked_manifest="$(mktemp)"
      current_untracked_manifest="$(mktemp)"
      _git_snapshot_write_snapshot_untracked_manifest "${repo_bundle_dir}" "${expected_untracked_manifest}"
      _git_snapshot_write_current_untracked_manifest "${repo_abs}" "${current_untracked_manifest}"
      if ! cmp -s "${expected_untracked_manifest}" "${current_untracked_manifest}"; then
        untracked_state="mismatch"
        has_mismatch="true"
        expected_untracked_files="$(_git_snapshot_inspect_tar_files "${repo_bundle_dir}/untracked.tar")"
        current_untracked_files="$(git -C "${repo_abs}" ls-files --others --exclude-standard | sed '/^$/d')"
        expected_untracked_count="$(_git_snapshot_inspect_count_lines "${expected_untracked_files}")"
        current_untracked_count="$(_git_snapshot_inspect_count_lines "${current_untracked_files}")"
        expected_untracked_preview="$(_git_snapshot_preview_lines_inline "${expected_untracked_files}" 5)"
        current_untracked_preview="$(_git_snapshot_preview_lines_inline "${current_untracked_files}" 5)"
        repo_mismatch_rows+="${human_repo_label}: untracked set/content differs (snapshot=${expected_untracked_count} [${expected_untracked_preview}] | current=${current_untracked_count} [${current_untracked_preview}])"$'\n'
      fi
      rm -f "${expected_untracked_manifest}" "${current_untracked_manifest}"
    fi

    if [[ "${has_mismatch}" == "true" ]]; then
      mismatch_count=$((mismatch_count + 1))
      while IFS= read -r row; do
        [[ -z "${row}" ]] && continue
        mismatch_rows+="${row}"$'\n'
      done <<< "${repo_mismatch_rows}"
    fi
    if [[ "${has_warning}" == "true" ]]; then
      warning_count=$((warning_count + 1))
      while IFS= read -r row; do
        [[ -z "${row}" ]] && continue
        warning_rows+="${row}"$'\n'
      done <<< "${repo_warning_rows}"
    fi

    if [[ "${porcelain}" == "true" ]]; then
      printf "verify\tsnapshot_id=%s\trepo=%s\thead=%s\tstaged=%s\tunstaged=%s\tuntracked=%s\tstrict_head=%s\thas_mismatch=%s\thas_warning=%s\n" \
        "${snapshot_id}" "${rel_path}" "${head_state}" "${staged_state}" "${unstaged_state}" "${untracked_state}" "${strict_head}" "${has_mismatch}" "${has_warning}"
    fi
  done < <(_git_snapshot_store_read_repo_entries "${snapshot_path}")

  if [[ "${porcelain}" == "true" ]]; then
    printf "verify_summary\tsnapshot_id=%s\trepos_checked=%s\tmismatches=%s\twarnings=%s\tstrict_head=%s\n" \
      "${snapshot_id}" "${repos_checked}" "${mismatch_count}" "${warning_count}" "${strict_head}"
  else
    printf "Snapshot verify: %s\n" "${snapshot_id}"
    printf "Root: %s\n" "${root_repo}"
    printf "Strict head: %s\n" "${strict_head}"
    printf "Repos checked: %s | mismatches: %s | warnings: %s\n" "${repos_checked}" "${mismatch_count}" "${warning_count}"

    if [[ "${mismatch_count}" -eq 0 ]]; then
      printf "Verification: match within snapshot scope.\n"
    else
      printf "Verification: mismatches detected.\n"
    fi

    if [[ -n "${warning_rows}" ]]; then
      printf "\nWarnings:\n"
      while IFS= read -r row; do
        [[ -z "${row}" ]] && continue
        printf "  - %s\n" "${row}"
      done <<< "${warning_rows}"
    fi

    if [[ -n "${mismatch_rows}" ]]; then
      printf "\nMismatches:\n"
      while IFS= read -r row; do
        [[ -z "${row}" ]] && continue
        printf "  - %s\n" "${row}"
      done <<< "${mismatch_rows}"
    fi

    if [[ "${mismatch_count}" -gt 0 ]]; then
      printf "\nFollow-up commands for deeper details:\n"
      printf "  - git-snapshot inspect %s%s --staged --unstaged --untracked --name-only\n" "${snapshot_id}" "${repo_filter_cmd_fragment}"
      printf "    Shows full captured file lists for staged/unstaged/untracked snapshot content.\n"
      printf "  - git-snapshot inspect %s%s --staged --unstaged --diff\n" "${snapshot_id}" "${repo_filter_cmd_fragment}"
      printf "    Shows full patch bodies for tracked snapshot changes.\n"
      printf "  - git-snapshot restore-check %s%s --details --files --no-limit\n" "${snapshot_id}" "${repo_filter_cmd_fragment}"
      printf "    Shows restore-readiness diagnostics against current tree (apply checks + collisions).\n"
    fi

    if [[ "${strict_head}" != "true" ]]; then
      printf "\nHint: run \"git-snapshot verify %s --strict-head\" to also require HEAD commit equality.\n" "${snapshot_id}"
      printf "Default verify mode is file-state focused for long-running workflows where commits may move.\n"
      printf "If strict-head also passes, tracked + untracked non-ignored state is exact to snapshot scope (ignored files remain out of scope).\n"
    fi
  fi

  if [[ "${mismatch_count}" -gt 0 ]]; then
    return 3
  fi
  return 0
}

_git_snapshot_cmd_restore() {
  local root_repo="$1"
  shift
  local snapshot_id=""
  local on_conflict="reject"
  local porcelain="false"

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --on-conflict)
        if [[ -z "${2:-}" ]]; then
          _git_snapshot_ui_err "Missing value for --on-conflict"
          return 1
        fi
        on_conflict="$2"
        shift
        ;;
      --on-conflict=*)
        on_conflict="${1#*=}"
        ;;
      --porcelain)
        porcelain="true"
        ;;
      -*)
        _git_snapshot_ui_err "Unknown option for restore: $1"
        return 1
        ;;
      *)
        if [[ -z "${snapshot_id}" ]]; then
          snapshot_id="$1"
        else
          _git_snapshot_ui_err "Unexpected argument for restore: $1"
          return 1
        fi
        ;;
    esac
    shift
  done

  if [[ -z "${snapshot_id}" ]]; then
    _git_snapshot_ui_err "Missing snapshot_id for restore"
    return 1
  fi
  if [[ "${on_conflict}" != "reject" && "${on_conflict}" != "rollback" ]]; then
    _git_snapshot_ui_err "Invalid value for --on-conflict: ${on_conflict} (expected reject|rollback)"
    return 1
  fi

  _git_snapshot_validate_snapshot_id "${snapshot_id}"
  _git_snapshot_store_assert_snapshot_exists "${root_repo}" "${snapshot_id}"

  if [[ "${porcelain}" != "true" ]]; then
    _git_snapshot_ui_warn "Restore will overwrite tracked changes and delete untracked files (ignored files stay untouched)."
    _git_snapshot_ui_warn "A safety snapshot will be created automatically before restore."
  fi
  _git_snapshot_ui_confirm_typed "Type RESTORE to continue: " "RESTORE"

  if [[ "${on_conflict}" == "rollback" ]]; then
    _git_snapshot_restore_with_optional_rollback "${root_repo}" "${snapshot_id}" false "${porcelain}"
  else
    _git_snapshot_restore_with_reject_mode "${root_repo}" "${snapshot_id}" "${porcelain}"
  fi
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
      _git_snapshot_cmd_create "${root_repo}" "$@"
      ;;
    reset-all)
      _git_snapshot_cmd_reset_all "${root_repo}" "$@"
      ;;
    rename)
      _git_snapshot_cmd_rename "${root_repo}" "$@"
      ;;
    list)
      _git_snapshot_cmd_list "${root_repo}" "$@"
      ;;
    inspect)
      _git_snapshot_cmd_inspect "${root_repo}" "$@"
      ;;
    restore-check)
      _git_snapshot_cmd_restore_check "${root_repo}" "$@"
      ;;
    verify)
      _git_snapshot_cmd_verify "${root_repo}" "$@"
      ;;
    restore)
      _git_snapshot_cmd_restore "${root_repo}" "$@"
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
