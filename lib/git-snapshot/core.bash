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
  git-snapshot inspect <snapshot_id> [--repo <rel_path>] [--staged|--unstaged|--untracked|--all] [--all-repos] [--name-only|--stat|--diff] [--gui] [--porcelain]
  git-snapshot restore-check <snapshot_id> [--repo <rel_path>] [--all-repos] [--details] [--files] [--limit <n>|--no-limit] [--porcelain]
  git-snapshot gui [snapshot_id]
  git-snapshot compare [snapshot_id] [--repo <rel_path>] [--all] [--diff] [--gui] [--porcelain]
  git-snapshot restore <snapshot_id> [--on-conflict <reject|rollback>] [--porcelain]
  git-snapshot delete <snapshot_id>

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
  - snapshot metadata format is `git_snapshot_meta_v4`

reset-all [--snapshot|--no-snapshot] [--porcelain]
  Clears root-most repo + initialized recursive submodules:
    - `git reset --hard`
    - `git clean -fd`
  Snapshot choice policy:
  - `--snapshot`    : create auto snapshot before clear
  - `--no-snapshot` : clear without pre-clear snapshot
  - neither flag    : ask `Create auto snapshot before clear? [Y/n]:`
  - both flags      : usage error
  Notes:
  - no extra destructive confirmation is asked after snapshot decision
  - non-interactive mode requires `--snapshot` or `--no-snapshot`
  - auto snapshots use label prefix `pre-reset-` and origin `auto`
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
  Human output format:
  - one line for snapshot ID
  - one labeled details line (Created/Age/Repos)
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
  - `--gui`       : launch shared snapshot browser UI (incompatible with `--porcelain`)
  GUI behavior:
  - `--gui` ignores `--name-only`, `--stat`, and `--diff`
  Porcelain output:
  - `inspect_target` summary row includes `contract_version=2`
  - `inspect_repo` emits per-repo state/compatibility counters
  - `inspect` emits per-category captured file counts
  - `inspect_file` emits one row per captured file

restore-check
  Compares snapshot default reject-mode restore readiness against current tree (non-mutating):
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

gui [snapshot_id]
  Opens the shared browser UI in compare mode.
  Accepted arguments:
  - no args        : open compare UI for the latest user-created snapshot
  - `snapshot_id`  : open compare UI for the selected snapshot
  Notes:
  - initial mode is compare, but the browser UI can switch between compare and inspect
  - repo/visibility selection happens inside the browser UI
  - for pre-launch compare flags such as `--repo`, `--all`, `--diff`, or `--porcelain`, use `git-snapshot compare --gui`

compare [snapshot_id] [--repo <rel_path>] [--all] [--diff] [--gui] [--porcelain]
  Compares current workspace progress against snapshot-captured work items.
  Default compare scope:
  - files touched by snapshot staged/unstaged/untracked bundles
  Default visibility:
  - unresolved items only (`unresolved_missing`, `unresolved_diverged`)
  Optional `snapshot_id`:
  - when omitted, compare selects latest `origin=user` snapshot from the full
    shared-folder registry (all roots sharing this folder-name registry)
  - selection order:
    1) highest `created_at_epoch`
    2) tie-break: descending lexical snapshot id
  - if no user-created snapshot exists, compare fails with clear error
  Status model per file:
  - `resolved_committed`   : snapshot target matches HEAD and current working tree
  - `resolved_uncommitted` : snapshot target matches working tree but not HEAD
  - `unresolved_missing`   : snapshot target path is missing
  - `unresolved_diverged`  : current content or mode diverges from snapshot target
  Optional flags:
  - `--repo <rel_path>` : compare one snapshot repo path
  - `--all`             : include resolved items in output (default is unresolved only)
  - `--diff`            : include unified diffs for `unresolved_diverged` rows
  - `--gui`             : launch visual compare UI (incompatible with `--porcelain`)
  - `--porcelain`       : machine output (`compare_target` / `compare_file` / `compare_summary`, contract_version=5)
  GUI external diff overrides:
  - `GIT_SNAPSHOT_GUI_EXTERNAL_DIFF_TOOL=<tool>` : force a built-in selector
  - `GIT_SNAPSHOT_GUI_EXTERNAL_DIFF_COMMAND_TEMPLATE='<command> ... $SOURCE ... $TARGET'` : force an explicit launch template
  - `GIT_SNAPSHOT_GUI_EXTERNAL_DIFF_CANDIDATES=<tool1,tool2,...>` : override auto-detect selector order
  - `GIT_SNAPSHOT_GUI_PORT_START=<port>` : first loopback port to try for the shared browser server (default: `34757`)
  - `GIT_SNAPSHOT_GUI_PORT_COUNT=<n>` : number of sequential loopback ports to try before failing (default: `32`)
  - Canonical selectors: `meld`, `kdiff3`, `opendiff`, `bcompare`, `code`
  - command templates are tokenized into argv entries with quote/backslash handling; they are not shell-evaluated
  - use `$SOURCE` / `${SOURCE}` for the snapshot-side file and `$TARGET` / `${TARGET}` for the current working-tree file
  Snapshot integrity:
  - compare requires `git_snapshot_meta_v4` metadata and intact compare-target metadata
  - corrupt or unsupported snapshots fail instead of rebuilding fallback inputs
  Exit codes:
  - 0 : compare completed
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

GIT_SNAPSHOT_COMPARE_CACHE=<0|1>
  Enable/disable persistent compare cache (default: 1).

GIT_SNAPSHOT_COMPARE_JOBS=<n>
  Override compare worker parallelism (default: auto min(cpu, 8)).

GIT_SNAPSHOT_COMPARE_CACHE_MAX_ENTRIES=<n>
  Maximum cache entries per snapshot/repo family (default: 20).

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
  git-snapshot inspect before-rebase --gui
  git-snapshot inspect before-rebase --porcelain
  git-snapshot restore-check before-rebase
  git-snapshot restore-check before-rebase --details
  git-snapshot restore-check before-rebase --files
  git-snapshot restore-check before-rebase --porcelain
  git-snapshot gui before-rebase
  git-snapshot compare before-rebase
  git-snapshot compare before-rebase --all
  git-snapshot compare before-rebase --diff
  git-snapshot compare before-rebase --gui
  git-snapshot compare before-rebase --porcelain

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
- compare shows unresolved rows:
  snapshot work was not fully applied in current tree (missing/diverged).
- compare fails with metadata errors:
  snapshot is corrupt or unsupported; recreate it with current `git-snapshot`.
- restore failed:
  inspect error details, then use safety snapshot id printed by restore flow.
- restore exits 4:
  partial restore in reject mode; resolve `*.rej` and collision files, then run compare.
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

_git_snapshot_repo_config_path() {
  local root_repo="$1"
  printf "%s/.git-snapshot.config\n" "${root_repo}"
}
_git_snapshot_repo_config_get() {
  local root_repo="$1"
  local section="$2"
  local key="$3"
  local subsection="${4:-}"
  local config_path=""
  local config_selector=""

  config_path="$(_git_snapshot_repo_config_path "${root_repo}")"
  if [[ ! -f "${config_path}" ]]; then
    return 1
  fi

  config_selector="${section}"
  if [[ -n "${subsection}" ]]; then
    config_selector="${config_selector}.${subsection}"
  fi
  config_selector="${config_selector}.${key}"

  git config -f "${config_path}" --get "${config_selector}" 2>/dev/null || true
}
_git_snapshot_browse_status_v2_is_submodule_entry() {
  local sub_state="$1"
  shift

  local mode=""
  if [[ "${sub_state:0:1}" == "S" ]]; then
    return 0
  fi

  for mode in "$@"; do
    if [[ "${mode}" == "160000" ]]; then
      return 0
    fi
  done

  return 1
}
_git_snapshot_browse_collect_repo_state_v2() {
  local repo_abs="$1"
  local status_dir=""
  local status_file=""
  local stderr_file=""
  local entry=""
  local line_rest=""
  local xy=""
  local sub_state=""
  local path=""
  local mode1=""
  local mode2=""
  local mode3=""
  local mode4=""
  local current_head="none"
  local current_branch=""
  local staged_file_paths=""
  local staged_file_paths_b64=""
  local unstaged_file_paths=""
  local unstaged_file_paths_b64=""
  local untracked_paths=""
  local untracked_paths_b64=""
  local submodule_paths_raw=""
  local submodule_paths_raw_b64=""
  local details=""
  local submodule_paths=""
  local submodule_paths_b64=""
  local encoded_path=""

  status_dir="$(mktemp -d "${TMPDIR:-/tmp}/git-snapshot-browse-status.XXXXXX" 2>/dev/null || mktemp -d)"
  if [[ -z "${status_dir}" || ! -d "${status_dir}" ]]; then
    _git_snapshot_ui_err "Failed to allocate temporary directory for browse status collection."
    return 1
  fi

  status_file="${status_dir}/status.out"
  stderr_file="${status_dir}/status.err"
  if ! git -C "${repo_abs}" status --porcelain=v2 -z --branch --untracked-files=all --ignore-submodules=none --no-renames >"${status_file}" 2>"${stderr_file}"; then
    details="$(cat "${stderr_file}" 2>/dev/null || true)"
    rm -rf "${status_dir}"
    details="${details//$'\n'/ }"
    if [[ "${details}" == *"porcelain format version 2"* || "${details}" == *"--porcelain=v2"* || "${details}" == *"unknown option"* ]]; then
      _git_snapshot_ui_err "git-snapshot browse requires Git with support for 'git status --porcelain=v2 --branch'."
    else
      _git_snapshot_ui_err "Failed to read live repo state for ${repo_abs}: ${details:-git status exited non-zero}"
    fi
    return 1
  fi

  while IFS= read -r -d '' entry || [[ -n "${entry}" ]]; do
    [[ -z "${entry}" ]] && continue
    case "${entry:0:1}" in
      "#")
        case "${entry}" in
          "# branch.oid "*)
            current_head="${entry#\# branch.oid }"
            if [[ -z "${current_head}" || "${current_head}" == "(initial)" ]]; then
              current_head="none"
            fi
            ;;
          "# branch.head "*)
            current_branch="${entry#\# branch.head }"
            ;;
        esac
        ;;
      "?")
        path="${entry#\? }"
        encoded_path="$(_git_snapshot_store_base64_encode "${path}")"
        untracked_paths+="${path}"$'\n'
        untracked_paths_b64+="${encoded_path}"$'\n'
        ;;
      "1")
        line_rest="${entry#1 }"
        xy="${line_rest%% *}"
        line_rest="${line_rest#* }"
        sub_state="${line_rest%% *}"
        line_rest="${line_rest#* }"
        mode1="${line_rest%% *}"
        line_rest="${line_rest#* }"
        mode2="${line_rest%% *}"
        line_rest="${line_rest#* }"
        mode3="${line_rest%% *}"
        line_rest="${line_rest#* }"
        line_rest="${line_rest#* }"
        line_rest="${line_rest#* }"
        path="${line_rest}"
        encoded_path="$(_git_snapshot_store_base64_encode "${path}")"
        if _git_snapshot_browse_status_v2_is_submodule_entry "${sub_state}" "${mode1}" "${mode2}" "${mode3}"; then
          submodule_paths_raw+="${path}"$'\n'
          submodule_paths_raw_b64+="${encoded_path}"$'\n'
          continue
        fi
        if [[ "${xy:0:1}" != "." ]]; then
          staged_file_paths+="${path}"$'\n'
          staged_file_paths_b64+="${encoded_path}"$'\n'
        fi
        if [[ "${xy:1:1}" != "." ]]; then
          unstaged_file_paths+="${path}"$'\n'
          unstaged_file_paths_b64+="${encoded_path}"$'\n'
        fi
        ;;
      "u")
        line_rest="${entry#u }"
        xy="${line_rest%% *}"
        line_rest="${line_rest#* }"
        sub_state="${line_rest%% *}"
        line_rest="${line_rest#* }"
        mode1="${line_rest%% *}"
        line_rest="${line_rest#* }"
        mode2="${line_rest%% *}"
        line_rest="${line_rest#* }"
        mode3="${line_rest%% *}"
        line_rest="${line_rest#* }"
        mode4="${line_rest%% *}"
        line_rest="${line_rest#* }"
        line_rest="${line_rest#* }"
        line_rest="${line_rest#* }"
        line_rest="${line_rest#* }"
        path="${line_rest}"
        encoded_path="$(_git_snapshot_store_base64_encode "${path}")"
        if _git_snapshot_browse_status_v2_is_submodule_entry "${sub_state}" "${mode1}" "${mode2}" "${mode3}" "${mode4}"; then
          submodule_paths_raw+="${path}"$'\n'
          submodule_paths_raw_b64+="${encoded_path}"$'\n'
          continue
        fi
        staged_file_paths+="${path}"$'\n'
        staged_file_paths_b64+="${encoded_path}"$'\n'
        unstaged_file_paths+="${path}"$'\n'
        unstaged_file_paths_b64+="${encoded_path}"$'\n'
        ;;
    esac
  done < "${status_file}"

  rm -rf "${status_dir}"

  if [[ -n "${submodule_paths_raw}" ]]; then
    submodule_paths="$(printf "%s" "${submodule_paths_raw}" | sed '/^$/d' | sort -u)"
  fi
  if [[ -n "${submodule_paths_raw_b64}" ]]; then
    submodule_paths_b64="$(printf "%s" "${submodule_paths_raw_b64}" | sed '/^$/d' | sort -u)"
  fi

  GSN_BROWSE_CURRENT_HEAD="${current_head}"
  GSN_BROWSE_CURRENT_BRANCH="${current_branch}"
  GSN_BROWSE_STAGED_FILE_PATHS="${staged_file_paths}"
  GSN_BROWSE_STAGED_FILE_PATHS_B64="${staged_file_paths_b64}"
  GSN_BROWSE_UNSTAGED_FILE_PATHS="${unstaged_file_paths}"
  GSN_BROWSE_UNSTAGED_FILE_PATHS_B64="${unstaged_file_paths_b64}"
  GSN_BROWSE_UNTRACKED_PATHS="${untracked_paths}"
  GSN_BROWSE_UNTRACKED_PATHS_B64="${untracked_paths_b64}"
  GSN_BROWSE_SUBMODULE_PATHS="${submodule_paths}"
  GSN_BROWSE_SUBMODULE_PATHS_B64="${submodule_paths_b64}"
}
_git_snapshot_detect_default_jobs() {
  local max_jobs="$1"
  local cpu_count=""

  if command -v sysctl >/dev/null 2>&1; then
    cpu_count="$(sysctl -n hw.logicalcpu 2>/dev/null || true)"
    if [[ -z "${cpu_count}" ]]; then
      cpu_count="$(sysctl -n hw.ncpu 2>/dev/null || true)"
    fi
  fi

  if [[ -z "${cpu_count}" ]] && command -v nproc >/dev/null 2>&1; then
    cpu_count="$(nproc 2>/dev/null || true)"
  fi

  if [[ ! "${cpu_count}" =~ ^[0-9]+$ || "${cpu_count}" -lt 1 ]]; then
    cpu_count=1
  fi
  if [[ "${cpu_count}" -gt "${max_jobs}" ]]; then
    cpu_count="${max_jobs}"
  fi

  printf "%s" "${cpu_count}"
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

    head="$(git -C "${repo_abs}" rev-parse --verify -q HEAD 2>/dev/null || true)"
    if [[ -z "${head}" ]]; then
      head="none"
    fi
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
        tar -cf "${repo_dir}/untracked.tar" -- "${untracked_files[@]}"
      )

      : > "${repo_dir}/untracked.paths.b64"
      for file_path in "${untracked_files[@]}"; do
        printf "%s\n" "$(_git_snapshot_store_base64_encode "${file_path}")" >> "${repo_dir}/untracked.paths.b64"
      done
    fi

    if ! _git_snapshot_compare_capture_repo_target_metadata "${repo_abs}" "${repo_dir}"; then
      return 1
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

    _git_snapshot_inspect_restore_apply_checks "${GSN_REPO_ABS}" "${GSN_REPO_BUNDLE_DIR}"
    GSN_APPLY_CHECK_STAGED="${GSN_INSPECT_APPLY_CHECK_STAGED}"
    GSN_APPLY_CHECK_UNSTAGED="${GSN_INSPECT_APPLY_CHECK_UNSTAGED}"
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
    if _git_snapshot_ui_choose_yes_no_default_yes "Create auto snapshot before clear? [Y/n]: " "Use --snapshot or --no-snapshot."; then
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
    snapshot_id="$(_git_snapshot_create_internal "${root_repo}" "pre-reset" false "" "auto")" || {
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
  _git_snapshot_compare_drop_cache_for_snapshot_id "${root_repo}" "${old_snapshot_id}"
  _git_snapshot_compare_drop_cache_for_snapshot_id "${root_repo}" "${new_snapshot_id}"

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
      _git_snapshot_store_load_snapshot_meta "${snapshot_path}" || return 1
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
    _git_snapshot_store_load_snapshot_meta "${snapshot_path}" || return 1
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
      printf "\n"
      printf "Hint: %s auto-generated snapshot(s) hidden. Run: git-snapshot list --include-auto\n" "${hidden_auto_count}"
    fi
    printf "\n"
    printf "Note: snapshot registry is keyed by root repo folder name. Repositories sharing the same folder name share this registry.\n"
    return 0
  fi

  printf "Snapshots (%s)\n" "${root_repo}"
  printf "ID\n"
  while IFS=$'\t' read -r epoch snapshot_id repo_count snapshot_origin snapshot_root_repo; do
    [[ -z "${snapshot_id}" ]] && continue
    local created age details_line
    created="$(_git_snapshot_inspect_format_epoch_local "${epoch}")"
    age="$(_git_snapshot_inspect_age "${epoch}")"
    printf "%s\n" "${snapshot_id}"
    details_line="  Created: ${created}   Age: ${age}   Repos: ${repo_count}"
    if [[ "${show_root_column}" == "true" ]]; then
      details_line+="   Root: ${snapshot_root_repo}"
    fi
    if [[ "${include_auto}" == "true" && "${snapshot_origin}" == "auto" ]]; then
      details_line+="   Auto: *"
    fi
    printf "%s\n" "${details_line}"
    printf "\n"
  done < <(printf "%s" "${rows}" | sort -t$'\t' -k1,1nr)

  if [[ "${include_auto}" == "true" ]]; then
    printf "* = auto-generated snapshot\n"
    printf "\n"
  elif [[ "${hidden_auto_count}" -gt 0 ]]; then
    printf "Hint: %s auto-generated snapshot(s) hidden. Run: git-snapshot list --include-auto\n" "${hidden_auto_count}"
    printf "\n"
  fi
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
  local show_gui="false"
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
      --gui)
        show_gui="true"
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
  if [[ "${show_gui}" != "true" && ${render_flag_count} -gt 1 ]]; then
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
  _git_snapshot_store_load_snapshot_meta "${snapshot_path}" || return 1

  if [[ -n "${repo_filter}" ]]; then
    _git_snapshot_validate_repo_filter "${snapshot_path}" "${repo_filter}"
  fi

  if [[ "${show_gui}" == "true" && "${porcelain}" == "true" ]]; then
    _git_snapshot_ui_err "inspect --gui is incompatible with --porcelain."
    return 1
  fi

  if [[ "${show_gui}" == "true" && ${render_flag_count} -gt 0 ]]; then
    _git_snapshot_ui_warn "inspect --gui ignores --name-only/--stat/--diff (GUI renders per-file previews internally)."
    render_mode="stat"
  fi

  if [[ "${show_gui}" == "true" ]]; then
    _git_snapshot_launch_inspect_gui \
      "${root_repo}" \
      "${snapshot_id}" \
      "${repo_filter}" \
      "${include_staged}" \
      "${include_unstaged}" \
      "${include_untracked}" \
      "${show_all_repos}"
    return $?
  fi

  local repo_id rel_path snapshot_head status_hash
  if [[ "${porcelain}" == "true" ]]; then
    local repos_in_scope=0
    local repos_with_changes=0
    local total_staged=0
    local total_unstaged=0
    local total_untracked=0
    local repo_rows=""
    local category_rows=""
    local file_rows=""
    local safe_repo=""
    local safe_file=""
    local safe_snapshot_head=""
    local safe_current_head=""
    local safe_current_branch=""
    local safe_relation=""
    local repo_has_changes="false"

    while IFS=$'\t' read -r repo_id rel_path snapshot_head status_hash; do
      [[ -z "${repo_id}" ]] && continue
      if [[ -n "${repo_filter}" && "${rel_path}" != "${repo_filter}" ]]; then
        continue
      fi

      _git_snapshot_calculate_repo_state "${root_repo}" "${snapshot_path}" "${repo_id}" "${rel_path}" "${snapshot_head}" "${status_hash}"
      repos_in_scope=$((repos_in_scope + 1))
      total_staged=$((total_staged + GSN_STAGED_COUNT))
      total_unstaged=$((total_unstaged + GSN_UNSTAGED_COUNT))
      total_untracked=$((total_untracked + GSN_UNTRACKED_COUNT))

      repo_has_changes="false"
      if [[ "${GSN_STAGED_COUNT}" != "0" || "${GSN_UNSTAGED_COUNT}" != "0" || "${GSN_UNTRACKED_COUNT}" != "0" ]]; then
        repo_has_changes="true"
        repos_with_changes=$((repos_with_changes + 1))
      fi

      safe_repo="$(_git_snapshot_compare_sanitize_porcelain_value "${rel_path}")"
      safe_snapshot_head="$(_git_snapshot_compare_sanitize_porcelain_value "${GSN_SNAPSHOT_HEAD}")"
      safe_current_head="$(_git_snapshot_compare_sanitize_porcelain_value "${GSN_CURRENT_HEAD}")"
      safe_current_branch="$(_git_snapshot_compare_sanitize_porcelain_value "${GSN_CURRENT_BRANCH}")"
      safe_relation="$(_git_snapshot_compare_sanitize_porcelain_value "${GSN_RELATION}")"
      repo_rows+="inspect_repo\tsnapshot_id=${snapshot_id}\trepo=${safe_repo}\thas_changes=${repo_has_changes}\tstaged_count=${GSN_STAGED_COUNT}\tunstaged_count=${GSN_UNSTAGED_COUNT}\tuntracked_count=${GSN_UNTRACKED_COUNT}\tsnapshot_head=${safe_snapshot_head}\tcurrent_head=${safe_current_head}\tcurrent_branch=${safe_current_branch}\trelation=${safe_relation}\tahead=${GSN_AHEAD_COUNT}\tbehind=${GSN_BEHIND_COUNT}\tapply_check_staged=${GSN_APPLY_CHECK_STAGED}\tapply_check_unstaged=${GSN_APPLY_CHECK_UNSTAGED}\tuntracked_collision_count=${GSN_UNTRACKED_COLLISION_COUNT}\n"

      if [[ "${include_staged}" == "true" ]]; then
        category_rows+="inspect\tsnapshot_id=${snapshot_id}\trepo=${safe_repo}\tcategory=staged\tfile_count=${GSN_STAGED_COUNT}\n"
        while IFS= read -r file; do
          [[ -z "${file}" ]] && continue
          safe_file="$(_git_snapshot_compare_sanitize_porcelain_value "${file}")"
          file_rows+="inspect_file\tsnapshot_id=${snapshot_id}\trepo=${safe_repo}\tcategory=staged\tfile=${safe_file}\n"
        done <<< "${GSN_STAGED_FILES}"
      fi
      if [[ "${include_unstaged}" == "true" ]]; then
        category_rows+="inspect\tsnapshot_id=${snapshot_id}\trepo=${safe_repo}\tcategory=unstaged\tfile_count=${GSN_UNSTAGED_COUNT}\n"
        while IFS= read -r file; do
          [[ -z "${file}" ]] && continue
          safe_file="$(_git_snapshot_compare_sanitize_porcelain_value "${file}")"
          file_rows+="inspect_file\tsnapshot_id=${snapshot_id}\trepo=${safe_repo}\tcategory=unstaged\tfile=${safe_file}\n"
        done <<< "${GSN_UNSTAGED_FILES}"
      fi
      if [[ "${include_untracked}" == "true" ]]; then
        category_rows+="inspect\tsnapshot_id=${snapshot_id}\trepo=${safe_repo}\tcategory=untracked\tfile_count=${GSN_UNTRACKED_COUNT}\n"
        while IFS= read -r file; do
          [[ -z "${file}" ]] && continue
          safe_file="$(_git_snapshot_compare_sanitize_porcelain_value "${file}")"
          file_rows+="inspect_file\tsnapshot_id=${snapshot_id}\trepo=${safe_repo}\tcategory=untracked\tfile=${safe_file}\n"
        done <<< "${GSN_UNTRACKED_FILES}"
      fi
    done < <(_git_snapshot_store_read_repo_entries "${snapshot_path}")

    printf "inspect_target\tsnapshot_id=%s\trepo_filter=%s\tshow_all_repos=%s\tinclude_staged=%s\tinclude_unstaged=%s\tinclude_untracked=%s\trepos_in_scope=%s\trepos_with_changes=%s\ttotal_staged=%s\ttotal_unstaged=%s\ttotal_untracked=%s\tcontract_version=2\n" \
      "${snapshot_id}" \
      "$(_git_snapshot_compare_sanitize_porcelain_value "${repo_filter}")" \
      "${show_all_repos}" \
      "${include_staged}" \
      "${include_unstaged}" \
      "${include_untracked}" \
      "${repos_in_scope}" \
      "${repos_with_changes}" \
      "${total_staged}" \
      "${total_unstaged}" \
      "${total_untracked}"
    printf "%b" "${repo_rows}"
    printf "%b" "${category_rows}"
    printf "%b" "${file_rows}"
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
  _git_snapshot_store_load_snapshot_meta "${snapshot_path}" || return 1

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

_git_snapshot_resolve_compare_target() {
  local root_repo="$1"
  local provided_snapshot_id="${2:-}"

  local snapshot_id=""
  local selection_mode=""
  local snapshot_path=""
  local selected_created_at_epoch=""
  local selected_snapshot_root=""
  local selected_snapshot_origin=""

  if [[ -n "${provided_snapshot_id}" ]]; then
    _git_snapshot_validate_snapshot_id "${provided_snapshot_id}"
    _git_snapshot_store_assert_snapshot_exists "${root_repo}" "${provided_snapshot_id}"
    snapshot_id="${provided_snapshot_id}"
    selection_mode="explicit"
    snapshot_path="$(_git_snapshot_store_snapshot_path "${root_repo}" "${snapshot_id}")"
    _git_snapshot_store_load_snapshot_meta "${snapshot_path}" || return 1
    selected_created_at_epoch="${CREATED_AT_EPOCH}"
    selected_snapshot_root="${ROOT_REPO}"
    selected_snapshot_origin="${SNAPSHOT_ORIGIN}"
  else
    local candidate_id candidate_path
    local candidate_epoch
    local candidate_root
    local candidate_origin
    local best_id=""
    local best_epoch="-1"
    local best_root=""
    local best_origin=""

    while IFS= read -r candidate_id; do
      [[ -z "${candidate_id}" ]] && continue
      candidate_path="$(_git_snapshot_store_snapshot_path "${root_repo}" "${candidate_id}")"
      _git_snapshot_store_load_snapshot_meta "${candidate_path}" || return 1
      [[ "${SNAPSHOT_ORIGIN}" == "user" ]] || continue

      candidate_epoch="${CREATED_AT_EPOCH}"
      candidate_root="${ROOT_REPO}"
      candidate_origin="${SNAPSHOT_ORIGIN}"

      if [[ "${best_id}" == "" \
            || "${candidate_epoch}" -gt "${best_epoch}" \
            || ( "${candidate_epoch}" -eq "${best_epoch}" && "${candidate_id}" > "${best_id}" ) ]]; then
        best_id="${candidate_id}"
        best_epoch="${candidate_epoch}"
        best_root="${candidate_root}"
        best_origin="${candidate_origin}"
      fi
    done < <(_git_snapshot_store_list_snapshot_ids "${root_repo}")

    if [[ -z "${best_id}" ]]; then
      _git_snapshot_ui_err "No user-created snapshot found to compare against."
      return 1
    fi

    snapshot_id="${best_id}"
    selection_mode="latest-user-default"
    snapshot_path="$(_git_snapshot_store_snapshot_path "${root_repo}" "${snapshot_id}")"
    selected_created_at_epoch="${best_epoch}"
    selected_snapshot_root="${best_root}"
    selected_snapshot_origin="${best_origin}"
  fi

  GSN_COMPARE_SNAPSHOT_ID="${snapshot_id}"
  GSN_COMPARE_SELECTION_MODE="${selection_mode}"
  GSN_COMPARE_SNAPSHOT_PATH="${snapshot_path}"
  GSN_COMPARE_SNAPSHOT_CREATED_AT_EPOCH="${selected_created_at_epoch}"
  GSN_COMPARE_SNAPSHOT_ROOT="${selected_snapshot_root}"
  GSN_COMPARE_SNAPSHOT_ORIGIN="${selected_snapshot_origin}"
}

_git_snapshot_compare_sanitize_porcelain_value() {
  local value="$1"

  value="${value//\\/\\\\}"
  value="${value//$'\t'/\\t}"
  value="${value//$'\n'/\\n}"
  value="${value//$'\r'/\\r}"
  printf "%s" "${value}"
}

_git_snapshot_compare_decode_path() {
  local encoded_path="$1"
  _git_snapshot_store_base64_decode "${encoded_path}"
}

_git_snapshot_compare_emit_encoded_path() {
  local file_path="$1"
  printf "%s\n" "$(_git_snapshot_store_base64_encode "${file_path}")"
}
_git_snapshot_compare_target_paths_file() {
  local repo_bundle_dir="$1"
  printf "%s/compare-target.paths.b64\n" "${repo_bundle_dir}"
}
_git_snapshot_compare_target_signatures_file() {
  local repo_bundle_dir="$1"
  printf "%s/compare-target.signatures.tsv\n" "${repo_bundle_dir}"
}
_git_snapshot_compare_target_meta_file() {
  local repo_bundle_dir="$1"
  printf "%s/compare-target.meta.env\n" "${repo_bundle_dir}"
}
_git_snapshot_compare_has_target_metadata() {
  local repo_bundle_dir="$1"

  [[ -f "$(_git_snapshot_compare_target_paths_file "${repo_bundle_dir}")" ]] \
    && [[ -f "$(_git_snapshot_compare_target_signatures_file "${repo_bundle_dir}")" ]] \
    && [[ -f "$(_git_snapshot_compare_target_meta_file "${repo_bundle_dir}")" ]]
}
_git_snapshot_compare_write_target_meta() {
  local repo_bundle_dir="$1"
  local files_total="$2"
  local manifest_hash="$3"
  local signature_hash="$4"
  local meta_file=""

  meta_file="$(_git_snapshot_compare_target_meta_file "${repo_bundle_dir}")"
  {
    printf "FORMAT=git_snapshot_compare_target_v1\n"
    printf "FILES_TOTAL=%s\n" "${files_total}"
    printf "MANIFEST_HASH=%s\n" "${manifest_hash}"
    printf "SIGNATURE_HASH=%s\n" "${signature_hash}"
  } > "${meta_file}"
}
_git_snapshot_compare_load_target_meta() {
  local repo_bundle_dir="$1"
  local meta_file=""
  local line key value
  local format=""

  GSN_COMPARE_TARGET_META_FORMAT=""
  GSN_COMPARE_TARGET_META_FILES_TOTAL=0
  GSN_COMPARE_TARGET_META_MANIFEST_HASH=""
  GSN_COMPARE_TARGET_META_SIGNATURE_HASH=""

  meta_file="$(_git_snapshot_compare_target_meta_file "${repo_bundle_dir}")"
  if [[ ! -f "${meta_file}" ]]; then
    return 1
  fi

  while IFS= read -r line || [[ -n "${line}" ]]; do
    [[ -z "${line}" ]] && continue
    [[ "${line}" == *"="* ]] || return 1

    key="${line%%=*}"
    value="${line#*=}"
    case "${key}" in
      FORMAT) format="${value}" ;;
      FILES_TOTAL) GSN_COMPARE_TARGET_META_FILES_TOTAL="${value}" ;;
      MANIFEST_HASH) GSN_COMPARE_TARGET_META_MANIFEST_HASH="${value}" ;;
      SIGNATURE_HASH) GSN_COMPARE_TARGET_META_SIGNATURE_HASH="${value}" ;;
      *) return 1 ;;
    esac
  done < "${meta_file}"

  if [[ "${format}" != "git_snapshot_compare_target_v1" ]]; then
    return 1
  fi
  if [[ ! "${GSN_COMPARE_TARGET_META_FILES_TOTAL}" =~ ^[0-9]+$ ]]; then
    return 1
  fi
  if [[ -z "${GSN_COMPARE_TARGET_META_MANIFEST_HASH}" || -z "${GSN_COMPARE_TARGET_META_SIGNATURE_HASH}" ]]; then
    return 1
  fi

  GSN_COMPARE_TARGET_META_FORMAT="${format}"
}
_git_snapshot_compare_verify_target_metadata_integrity() {
  local repo_bundle_dir="$1"
  local paths_file=""
  local signatures_file=""
  local actual_manifest_hash=""
  local actual_signature_hash=""

  paths_file="$(_git_snapshot_compare_target_paths_file "${repo_bundle_dir}")"
  signatures_file="$(_git_snapshot_compare_target_signatures_file "${repo_bundle_dir}")"

  actual_manifest_hash="$(_git_snapshot_compare_hash_file "${paths_file}" 2>/dev/null || true)"
  actual_signature_hash="$(_git_snapshot_compare_hash_file "${signatures_file}" 2>/dev/null || true)"

  if [[ -z "${actual_manifest_hash}" || -z "${actual_signature_hash}" ]]; then
    return 1
  fi

  if [[ "${actual_manifest_hash}" != "${GSN_COMPARE_TARGET_META_MANIFEST_HASH}" ]]; then
    return 1
  fi

  if [[ "${actual_signature_hash}" != "${GSN_COMPARE_TARGET_META_SIGNATURE_HASH}" ]]; then
    return 1
  fi
}
_git_snapshot_compare_record_error() {
  local error_id="$1"
  local stage="$2"
  local message="$3"
  local repo_path="${4:-${GSN_COMPARE_ACTIVE_REPO:-unknown}}"

  GSN_COMPARE_ERROR_ID="${error_id}"
  GSN_COMPARE_ERROR_STAGE="${stage}"
  GSN_COMPARE_ERROR_MESSAGE="${message}"
  GSN_COMPARE_ERROR_REPO="${repo_path}"
}
_git_snapshot_compare_emit_porcelain_error() {
  local snapshot_id="$1"
  local repo_path="${2:-${GSN_COMPARE_ERROR_REPO:-unknown}}"

  local error_id="${GSN_COMPARE_ERROR_ID:-compare_runtime_failed}"
  local stage="${GSN_COMPARE_ERROR_STAGE:-runtime}"
  local message="${GSN_COMPARE_ERROR_MESSAGE:-compare failed}"
  local safe_repo safe_stage safe_message

  safe_repo="$(_git_snapshot_compare_sanitize_porcelain_value "${repo_path}")"
  safe_stage="$(_git_snapshot_compare_sanitize_porcelain_value "${stage}")"
  safe_message="$(_git_snapshot_compare_sanitize_porcelain_value "${message}")"

  printf "compare_error\tsnapshot_id=%s\trepo=%s\terror_id=%s\tstage=%s\tmessage=%s\tcontract_version=1\n" \
    "${snapshot_id}" "${safe_repo}" "${error_id}" "${safe_stage}" "${safe_message}"
}
_git_snapshot_compare_hash_file() {
  local file_path="$1"

  if [[ ! -e "${file_path}" ]]; then
    return 1
  fi

  shasum -a 256 < "${file_path}" | awk '{print $1}'
}
_git_snapshot_compare_hash_stdin() {
  shasum -a 256 | awk '{print $1}'
}
_git_snapshot_compare_capture_fs_signature() {
  local repo_dir="$1"
  local file_path="$2"

  local abs_path="${repo_dir}/${file_path}"
  local symlink_target=""

  GSN_COMPARE_SIG_PRESENT="false"
  GSN_COMPARE_SIG_MODE=""
  GSN_COMPARE_SIG_HASH=""

  if [[ ! -e "${abs_path}" && ! -L "${abs_path}" ]]; then
    return 0
  fi

  GSN_COMPARE_SIG_PRESENT="true"

  if [[ -L "${abs_path}" ]]; then
    if ! symlink_target="$(readlink "${abs_path}")"; then
      GSN_COMPARE_SIG_PRESENT="false"
      return 0
    fi
    GSN_COMPARE_SIG_MODE="120000"
    GSN_COMPARE_SIG_HASH="$(printf "%s" "${symlink_target}" | _git_snapshot_compare_hash_stdin)"
    return 0
  fi

  if [[ -f "${abs_path}" ]]; then
    if [[ -x "${abs_path}" ]]; then
      GSN_COMPARE_SIG_MODE="100755"
    else
      GSN_COMPARE_SIG_MODE="100644"
    fi
    GSN_COMPARE_SIG_HASH="$(_git_snapshot_compare_hash_file "${abs_path}")"
    return 0
  fi

  # Compare currently models file-like paths only; keep a stable fallback for
  # unusual entry kinds so classification can still report divergence.
  GSN_COMPARE_SIG_MODE="other"
  GSN_COMPARE_SIG_HASH="n/a"
}
_git_snapshot_compare_prepare_temp_object_env() {
  local repo_abs="$1"

  local repo_objects=""
  local repo_objects_abs=""
  local temp_object_root=""
  local info_alternates=""
  local alt_line=""
  local resolved_alt=""
  local -a alternates=()

  GSN_COMPARE_TEMP_OBJECT_DIR=""
  GSN_COMPARE_TEMP_OBJECT_ALTERNATES=""

  repo_objects="$(git -C "${repo_abs}" rev-parse --git-path objects 2>/dev/null || true)"
  if [[ -z "${repo_objects}" ]]; then
    return 1
  fi
  if [[ "${repo_objects}" != /* ]]; then
    repo_objects_abs="${repo_abs}/${repo_objects}"
  else
    repo_objects_abs="${repo_objects}"
  fi

  temp_object_root="$(mktemp -d)"
  if [[ -z "${temp_object_root}" ]]; then
    return 1
  fi
  mkdir -p "${temp_object_root}/objects"

  alternates+=("${repo_objects_abs}")
  info_alternates="${repo_objects_abs}/info/alternates"
  if [[ -f "${info_alternates}" ]]; then
    while IFS= read -r alt_line || [[ -n "${alt_line}" ]]; do
      [[ -z "${alt_line}" ]] && continue
      resolved_alt="${alt_line}"
      if [[ "${resolved_alt}" != /* ]]; then
        resolved_alt="$(cd "$(dirname "${repo_objects_abs}")" 2>/dev/null && cd "${resolved_alt}" 2>/dev/null && pwd -P || true)"
      fi
      [[ -n "${resolved_alt}" ]] && alternates+=("${resolved_alt}")
    done < "${info_alternates}"
  fi

  GSN_COMPARE_TEMP_OBJECT_DIR="${temp_object_root}/objects"
  GSN_COMPARE_TEMP_OBJECT_ALTERNATES="$(printf "%s\n" "${alternates[@]}" | sed '/^$/d' | awk '!seen[$0]++' | paste -sd ':' -)"
  return 0
}
_git_snapshot_compare_collect_oriented_numstat() {
  local old_path="$1"
  local new_path="$2"

  local old_exists="false"
  local new_exists="false"
  local old_source="/dev/null"
  local new_source="/dev/null"
  local diff_tmp=""
  local diff_status=0
  local first_line=""
  local added=""
  local removed=""
  local rest=""

  GSN_COMPARE_LINE_STATS_ADDED="-"
  GSN_COMPARE_LINE_STATS_REMOVED="-"

  if [[ -e "${old_path}" || -L "${old_path}" ]]; then
    old_exists="true"
    if [[ ! -f "${old_path}" || -L "${old_path}" ]]; then
      return 0
    fi
    old_source="${old_path}"
  fi

  if [[ -e "${new_path}" || -L "${new_path}" ]]; then
    new_exists="true"
    if [[ ! -f "${new_path}" || -L "${new_path}" ]]; then
      return 0
    fi
    new_source="${new_path}"
  fi

  if [[ "${old_exists}" != "true" && "${new_exists}" != "true" ]]; then
    GSN_COMPARE_LINE_STATS_ADDED="0"
    GSN_COMPARE_LINE_STATS_REMOVED="0"
    return 0
  fi

  diff_tmp="$(mktemp)"
  git diff --no-index --numstat --no-ext-diff -- "${old_source}" "${new_source}" > "${diff_tmp}" 2>/dev/null || diff_status=$?
  if [[ "${diff_status}" -ne 0 && "${diff_status}" -ne 1 ]]; then
    rm -f "${diff_tmp}"
    return 1
  fi

  if ! IFS= read -r first_line < "${diff_tmp}"; then
    rm -f "${diff_tmp}"
    GSN_COMPARE_LINE_STATS_ADDED="0"
    GSN_COMPARE_LINE_STATS_REMOVED="0"
    return 0
  fi
  rm -f "${diff_tmp}"

  added="${first_line%%$'\t'*}"
  rest="${first_line#*$'\t'}"
  removed="${rest%%$'\t'*}"

  if [[ "${added}" =~ ^[0-9]+$ && "${removed}" =~ ^[0-9]+$ ]]; then
    GSN_COMPARE_LINE_STATS_ADDED="${added}"
    GSN_COMPARE_LINE_STATS_REMOVED="${removed}"
  fi
  return 0
}
_git_snapshot_compare_append_blank_line_stats() {
  local in_file="$1"
  local out_file="$2"

  awk -F $'\t' 'BEGIN { OFS = FS } { print $1, $2, $3, $4, $5, $6, $7, "-", "-" }' "${in_file}" > "${out_file}"
}
_git_snapshot_compare_append_zero_line_stats() {
  local in_file="$1"
  local out_file="$2"

  awk -F $'\t' 'BEGIN { OFS = FS } { print $1, $2, $3, $4, $5, $6, $7, "0", "0" }' "${in_file}" > "${out_file}"
}
_git_snapshot_compare_augment_rows_with_line_stats() {
  local snapshot_materialized_repo="$1"
  local current_materialized_repo="$2"
  local rows_in="$3"
  local rows_out="$4"

  local encoded_path=""
  local row_status=""
  local row_reason=""
  local row_scope=""
  local row_baseline_mode=""
  local row_current_mode=""
  local row_head_mode=""
  local row_file=""

  : > "${rows_out}"

  while IFS=$'\t' read -r encoded_path row_status row_reason row_scope row_baseline_mode row_current_mode row_head_mode || [[ -n "${encoded_path}" ]]; do
    [[ -z "${encoded_path}" ]] && continue
    if ! row_file="$(_git_snapshot_compare_decode_path "${encoded_path}")"; then
      return 1
    fi
    if ! _git_snapshot_compare_collect_oriented_numstat \
      "${current_materialized_repo}/${row_file}" \
      "${snapshot_materialized_repo}/${row_file}"; then
      return 1
    fi
    printf "%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n" \
      "${encoded_path}" \
      "${row_status}" \
      "${row_reason}" \
      "${row_scope}" \
      "${row_baseline_mode}" \
      "${row_current_mode}" \
      "${row_head_mode}" \
      "${GSN_COMPARE_LINE_STATS_ADDED}" \
      "${GSN_COMPARE_LINE_STATS_REMOVED}" >> "${rows_out}"
  done < "${rows_in}"
}
_git_snapshot_compare_unquote_patch_path() {
  local raw_path="$1"

  if [[ "${raw_path}" == \"*\" && "${raw_path}" == *\" ]]; then
    raw_path="${raw_path:1:${#raw_path}-2}"
    printf "%b" "${raw_path}"
    return 0
  fi

  printf "%s" "${raw_path}"
}
_git_snapshot_compare_collect_patch_files() {
  local patch_file="$1"
  local row file_path line raw_path

  if [[ ! -s "${patch_file}" ]]; then
    return 0
  fi

  # Use numstat -z so paths are emitted unescaped even when diff headers quote
  # names with spaces/quotes.
  while IFS= read -r -d '' row; do
    file_path="${row#*$'\t'}"
    file_path="${file_path#*$'\t'}"
    [[ -z "${file_path}" ]] && continue
    _git_snapshot_compare_emit_encoded_path "${file_path}"
  done < <(git apply --numstat -z "${patch_file}" 2>/dev/null || true)

  # numstat reports rename destination only; include rename sources explicitly.
  while IFS= read -r line; do
    [[ "${line}" == rename\ from\ * ]] || continue
    raw_path="${line#rename from }"
    file_path="$(_git_snapshot_compare_unquote_patch_path "${raw_path}")"
    [[ -z "${file_path}" ]] && continue
    _git_snapshot_compare_emit_encoded_path "${file_path}"
  done < "${patch_file}"
}
_git_snapshot_compare_collect_untracked_paths() {
  local repo_bundle_dir="$1"
  local manifest_file="${repo_bundle_dir}/untracked.paths.b64"
  local tar_file="${repo_bundle_dir}/untracked.tar"
  local encoded_path raw_path

  if [[ -f "${manifest_file}" ]]; then
    while IFS= read -r encoded_path || [[ -n "${encoded_path}" ]]; do
      [[ -z "${encoded_path}" ]] && continue
      printf "%s\n" "${encoded_path}"
    done < "${manifest_file}"
    return 0
  fi

  if [[ ! -f "${tar_file}" ]]; then
    return 0
  fi

  while IFS= read -r raw_path || [[ -n "${raw_path}" ]]; do
    [[ -z "${raw_path}" ]] && continue
    raw_path="$(printf "%b" "${raw_path}")"
    _git_snapshot_compare_emit_encoded_path "${raw_path}"
  done < <(tar -tf "${tar_file}")
}
_git_snapshot_compare_collect_snapshot_files() {
  local repo_bundle_dir="$1"

  {
    _git_snapshot_compare_collect_patch_files "${repo_bundle_dir}/staged.patch"
    _git_snapshot_compare_collect_patch_files "${repo_bundle_dir}/unstaged.patch"
    _git_snapshot_compare_collect_untracked_paths "${repo_bundle_dir}"
  } | sed '/^$/d' | LC_ALL=C sort -u
}
_git_snapshot_compare_collect_current_dirty_paths() {
  local repo_abs="$1"
  local staged_file_paths=""
  local unstaged_file_paths=""
  local untracked_paths=""
  local submodule_paths=""

  if ! _git_snapshot_browse_collect_repo_state_v2 "${repo_abs}"; then
    return 1
  fi

  staged_file_paths="${GSN_BROWSE_STAGED_FILE_PATHS}"
  unstaged_file_paths="${GSN_BROWSE_UNSTAGED_FILE_PATHS}"
  untracked_paths="${GSN_BROWSE_UNTRACKED_PATHS}"
  submodule_paths="${GSN_BROWSE_SUBMODULE_PATHS}"

  {
    while IFS= read -r file_path; do
      [[ -z "${file_path}" ]] && continue
      _git_snapshot_compare_emit_encoded_path "${file_path}"
    done <<< "${staged_file_paths}"
    while IFS= read -r file_path; do
      [[ -z "${file_path}" ]] && continue
      _git_snapshot_compare_emit_encoded_path "${file_path}"
    done <<< "${unstaged_file_paths}"
    while IFS= read -r file_path; do
      [[ -z "${file_path}" ]] && continue
      _git_snapshot_compare_emit_encoded_path "${file_path}"
    done <<< "${untracked_paths}"
    while IFS= read -r file_path; do
      [[ -z "${file_path}" ]] && continue
      _git_snapshot_compare_emit_encoded_path "${file_path}"
    done <<< "${submodule_paths}"
  } | sed '/^$/d' | LC_ALL=C sort -u
}
_git_snapshot_compare_materialize_snapshot_repo() {
  local repo_abs="$1"
  local snapshot_head="$2"
  local repo_bundle_dir="$3"
  local repo_rel_path="${4:-${GSN_COMPARE_ACTIVE_REPO:-unknown}}"
  local requested_dir="${5:-}"

  local materialized_repo
  if [[ -n "${requested_dir}" ]]; then
    materialized_repo="${requested_dir}"
    rm -rf "${materialized_repo}"
    if ! mkdir -p "${materialized_repo}"; then
      _git_snapshot_compare_record_error \
        "compare_snapshot_workspace_prepare_failed" \
        "snapshot_workspace_prepare" \
        "Failed to prepare snapshot compare workspace." \
        "${repo_rel_path}"
      _git_snapshot_ui_err "Failed to prepare snapshot compare workspace."
      return 1
    fi
  else
    materialized_repo="$(mktemp -d)"
  fi

  if [[ -n "${snapshot_head}" && "${snapshot_head}" != "none" ]] && ! git -C "${repo_abs}" archive "${snapshot_head}" | tar -xf - -C "${materialized_repo}"; then
    _git_snapshot_compare_record_error \
      "compare_snapshot_head_materialize_failed" \
      "snapshot_head_materialize" \
      "Failed to materialize snapshot HEAD for compare." \
      "${repo_rel_path}"
    rm -rf "${materialized_repo}"
    _git_snapshot_ui_err "Failed to materialize snapshot HEAD for compare."
    return 1
  fi

  if ! git -C "${materialized_repo}" init -q >/dev/null 2>&1; then
    _git_snapshot_compare_record_error \
      "compare_snapshot_workspace_init_failed" \
      "snapshot_workspace_init" \
      "Failed to initialize compare workspace." \
      "${repo_rel_path}"
    rm -rf "${materialized_repo}"
    _git_snapshot_ui_err "Failed to initialize compare workspace."
    return 1
  fi

  if [[ -n "${repo_bundle_dir}" && -s "${repo_bundle_dir}/staged.patch" ]]; then
    if ! git -C "${materialized_repo}" apply --binary --whitespace=nowarn "${repo_bundle_dir}/staged.patch"; then
      _git_snapshot_compare_record_error \
        "compare_snapshot_staged_apply_failed" \
        "snapshot_staged_apply" \
        "Failed to materialize staged snapshot bundle for compare." \
        "${repo_rel_path}"
      rm -rf "${materialized_repo}"
      _git_snapshot_ui_err "Failed to materialize staged snapshot bundle for compare."
      return 1
    fi
  fi

  if [[ -n "${repo_bundle_dir}" && -s "${repo_bundle_dir}/unstaged.patch" ]]; then
    if ! git -C "${materialized_repo}" apply --binary --whitespace=nowarn "${repo_bundle_dir}/unstaged.patch"; then
      _git_snapshot_compare_record_error \
        "compare_snapshot_unstaged_apply_failed" \
        "snapshot_unstaged_apply" \
        "Failed to materialize unstaged snapshot bundle for compare." \
        "${repo_rel_path}"
      rm -rf "${materialized_repo}"
      _git_snapshot_ui_err "Failed to materialize unstaged snapshot bundle for compare."
      return 1
    fi
  fi

  if [[ -n "${repo_bundle_dir}" && -f "${repo_bundle_dir}/untracked.tar" ]]; then
    if ! tar -xf "${repo_bundle_dir}/untracked.tar" -C "${materialized_repo}"; then
      _git_snapshot_compare_record_error \
        "compare_snapshot_untracked_extract_failed" \
        "snapshot_untracked_extract" \
        "Failed to materialize untracked snapshot bundle for compare." \
        "${repo_rel_path}"
      rm -rf "${materialized_repo}"
      _git_snapshot_ui_err "Failed to materialize untracked snapshot bundle for compare."
      return 1
    fi
  fi

  GSN_COMPARE_MATERIALIZED_REPO="${materialized_repo}"
}
_git_snapshot_compare_collect_current_untracked_tar() {
  local repo_abs="$1"
  local output_tar="$2"
  local rel_path
  local -a untracked_files=()

  while IFS= read -r -d '' rel_path; do
    [[ -z "${rel_path}" ]] && continue
    untracked_files+=("${rel_path}")
  done < <(git -C "${repo_abs}" ls-files --others --exclude-standard -z)

  if [[ "${#untracked_files[@]}" -eq 0 ]]; then
    rm -f "${output_tar}"
    return 0
  fi

  (
    cd "${repo_abs}"
    tar -cf "${output_tar}" -- "${untracked_files[@]}"
  )
}
_git_snapshot_compare_materialize_current_repo() {
  local repo_abs="$1"
  local repo_rel_path="${2:-${GSN_COMPARE_ACTIVE_REPO:-unknown}}"
  local requested_dir="${3:-}"

  local materialized_repo staged_patch_file unstaged_patch_file untracked_tar_file
  if [[ -n "${requested_dir}" ]]; then
    materialized_repo="${requested_dir}"
    rm -rf "${materialized_repo}"
    if ! mkdir -p "${materialized_repo}"; then
      _git_snapshot_compare_record_error \
        "compare_current_workspace_prepare_failed" \
        "current_workspace_prepare" \
        "Failed to prepare current compare workspace." \
        "${repo_rel_path}"
      _git_snapshot_ui_err "Failed to prepare current compare workspace."
      return 1
    fi
  else
    materialized_repo="$(mktemp -d)"
  fi
  staged_patch_file="$(mktemp)"
  unstaged_patch_file="$(mktemp)"
  untracked_tar_file="$(mktemp)"

  if ! git -C "${repo_abs}" diff --cached --binary > "${staged_patch_file}"; then
    _git_snapshot_compare_record_error \
      "compare_current_staged_collect_failed" \
      "current_staged_collect" \
      "Failed to collect current staged state for compare." \
      "${repo_rel_path}"
    rm -rf "${materialized_repo}"
    rm -f "${staged_patch_file}" "${unstaged_patch_file}" "${untracked_tar_file}"
    _git_snapshot_ui_err "Failed to collect current staged state for compare."
    return 1
  fi

  if ! git -C "${repo_abs}" diff --binary > "${unstaged_patch_file}"; then
    _git_snapshot_compare_record_error \
      "compare_current_unstaged_collect_failed" \
      "current_unstaged_collect" \
      "Failed to collect current unstaged state for compare." \
      "${repo_rel_path}"
    rm -rf "${materialized_repo}"
    rm -f "${staged_patch_file}" "${unstaged_patch_file}" "${untracked_tar_file}"
    _git_snapshot_ui_err "Failed to collect current unstaged state for compare."
    return 1
  fi

  if ! _git_snapshot_compare_collect_current_untracked_tar "${repo_abs}" "${untracked_tar_file}"; then
    _git_snapshot_compare_record_error \
      "compare_current_untracked_collect_failed" \
      "current_untracked_collect" \
      "Failed to collect current untracked state for compare." \
      "${repo_rel_path}"
    rm -rf "${materialized_repo}"
    rm -f "${staged_patch_file}" "${unstaged_patch_file}" "${untracked_tar_file}"
    _git_snapshot_ui_err "Failed to collect current untracked state for compare."
    return 1
  fi

  if git -C "${repo_abs}" rev-parse --verify -q HEAD >/dev/null 2>&1 && ! git -C "${repo_abs}" archive HEAD | tar -xf - -C "${materialized_repo}"; then
    _git_snapshot_compare_record_error \
      "compare_current_head_materialize_failed" \
      "current_head_materialize" \
      "Failed to materialize current HEAD for compare." \
      "${repo_rel_path}"
    rm -rf "${materialized_repo}"
    rm -f "${staged_patch_file}" "${unstaged_patch_file}" "${untracked_tar_file}"
    _git_snapshot_ui_err "Failed to materialize current HEAD for compare."
    return 1
  fi

  if ! git -C "${materialized_repo}" init -q >/dev/null 2>&1; then
    _git_snapshot_compare_record_error \
      "compare_current_workspace_init_failed" \
      "current_workspace_init" \
      "Failed to initialize current compare workspace." \
      "${repo_rel_path}"
    rm -rf "${materialized_repo}"
    rm -f "${staged_patch_file}" "${unstaged_patch_file}" "${untracked_tar_file}"
    _git_snapshot_ui_err "Failed to initialize current compare workspace."
    return 1
  fi

  if [[ -s "${staged_patch_file}" ]] && ! git -C "${materialized_repo}" apply --binary --whitespace=nowarn "${staged_patch_file}"; then
    _git_snapshot_compare_record_error \
      "compare_current_staged_apply_failed" \
      "current_staged_apply" \
      "Failed to materialize current staged state for compare." \
      "${repo_rel_path}"
    rm -rf "${materialized_repo}"
    rm -f "${staged_patch_file}" "${unstaged_patch_file}" "${untracked_tar_file}"
    _git_snapshot_ui_err "Failed to materialize current staged state for compare."
    return 1
  fi

  if [[ -s "${unstaged_patch_file}" ]] && ! git -C "${materialized_repo}" apply --binary --whitespace=nowarn "${unstaged_patch_file}"; then
    _git_snapshot_compare_record_error \
      "compare_current_unstaged_apply_failed" \
      "current_unstaged_apply" \
      "Failed to materialize current unstaged state for compare." \
      "${repo_rel_path}"
    rm -rf "${materialized_repo}"
    rm -f "${staged_patch_file}" "${unstaged_patch_file}" "${untracked_tar_file}"
    _git_snapshot_ui_err "Failed to materialize current unstaged state for compare."
    return 1
  fi

  if [[ -f "${untracked_tar_file}" ]] && ! tar -xf "${untracked_tar_file}" -C "${materialized_repo}"; then
    _git_snapshot_compare_record_error \
      "compare_current_untracked_extract_failed" \
      "current_untracked_extract" \
      "Failed to materialize current untracked state for compare." \
      "${repo_rel_path}"
    rm -rf "${materialized_repo}"
    rm -f "${staged_patch_file}" "${unstaged_patch_file}" "${untracked_tar_file}"
    _git_snapshot_ui_err "Failed to materialize current untracked state for compare."
    return 1
  fi

  rm -f "${staged_patch_file}" "${unstaged_patch_file}" "${untracked_tar_file}"
  GSN_COMPARE_MATERIALIZED_CURRENT_REPO="${materialized_repo}"
}
_git_snapshot_compare_lookup_repo_entry() {
  local snapshot_path="$1"
  local repo_filter="$2"
  local repo_id="" rel_path="" snapshot_head="" status_hash=""

  GSN_COMPARE_LOOKUP_REPO_ID=""
  GSN_COMPARE_LOOKUP_REL_PATH=""
  GSN_COMPARE_LOOKUP_SNAPSHOT_HEAD=""
  GSN_COMPARE_LOOKUP_STATUS_HASH=""

  while IFS=$'\t' read -r repo_id rel_path snapshot_head status_hash; do
    [[ -z "${repo_id}" ]] && continue
    if [[ -z "${status_hash}" ]]; then
      status_hash="${snapshot_head}"
      snapshot_head="none"
    fi
    if [[ "${rel_path}" != "${repo_filter}" ]]; then
      continue
    fi

    GSN_COMPARE_LOOKUP_REPO_ID="${repo_id}"
    GSN_COMPARE_LOOKUP_REL_PATH="${rel_path}"
    GSN_COMPARE_LOOKUP_SNAPSHOT_HEAD="${snapshot_head}"
    GSN_COMPARE_LOOKUP_STATUS_HASH="${status_hash}"
    return 0
  done < <(_git_snapshot_store_read_repo_entries "${snapshot_path}")

  return 1
}
_git_snapshot_compare_render_file_diff() {
  local snapshot_materialized_repo="$1"
  local current_materialized_repo="$2"
  local file_path="$3"
  local out_file="$4"
  local compare_base="${5:-snapshot}"

  local snapshot_abs="${snapshot_materialized_repo}/${file_path}"
  local current_abs="${current_materialized_repo}/${file_path}"
  local display_path=""
  display_path="$(_git_snapshot_compare_sanitize_porcelain_value "${file_path}")"
  local current_label="current:${display_path}"
  local snapshot_label="snapshot:${display_path}"
  local old_label="${current_label}"
  local new_label="${snapshot_label}"

  local snapshot_present="false"
  local snapshot_mode=""
  local snapshot_hash=""
  local current_present="false"
  local current_mode=""
  local current_hash=""
  local diff_tmp=""

  : > "${out_file}"

  if [[ "${compare_base}" == "snapshot" ]]; then
    old_label="${snapshot_label}"
    new_label="${current_label}"
  fi

  _git_snapshot_compare_capture_fs_signature "${snapshot_materialized_repo}" "${file_path}"
  snapshot_present="${GSN_COMPARE_SIG_PRESENT}"
  snapshot_mode="${GSN_COMPARE_SIG_MODE:-missing}"
  snapshot_hash="${GSN_COMPARE_SIG_HASH:-missing}"

  _git_snapshot_compare_capture_fs_signature "${current_materialized_repo}" "${file_path}"
  current_present="${GSN_COMPARE_SIG_PRESENT}"
  current_mode="${GSN_COMPARE_SIG_MODE:-missing}"
  current_hash="${GSN_COMPARE_SIG_HASH:-missing}"

  printf "      signature: current(mode=%s hash=%s) snapshot(mode=%s hash=%s)\n" \
    "${current_mode}" \
    "${current_hash}" \
    "${snapshot_mode}" \
    "${snapshot_hash}" >> "${out_file}"

  diff_tmp="$(mktemp)"

  if [[ "${snapshot_present}" == "true" && "${current_present}" == "true" && -f "${snapshot_abs}" && -f "${current_abs}" ]]; then
    if [[ "${compare_base}" == "snapshot" ]]; then
      diff -u --label "${old_label}" --label "${new_label}" "${snapshot_abs}" "${current_abs}" > "${diff_tmp}" 2>/dev/null || true
    else
      diff -u --label "${old_label}" --label "${new_label}" "${current_abs}" "${snapshot_abs}" > "${diff_tmp}" 2>/dev/null || true
    fi
  elif [[ "${snapshot_present}" != "true" && "${current_present}" == "true" && -f "${current_abs}" ]]; then
    if [[ "${compare_base}" == "snapshot" ]]; then
      diff -u --label "${old_label}" --label "${new_label}" /dev/null "${current_abs}" > "${diff_tmp}" 2>/dev/null || true
    else
      diff -u --label "${old_label}" --label "${new_label}" "${current_abs}" /dev/null > "${diff_tmp}" 2>/dev/null || true
    fi
  elif [[ "${snapshot_present}" == "true" && "${current_present}" != "true" && -f "${snapshot_abs}" ]]; then
    if [[ "${compare_base}" == "snapshot" ]]; then
      diff -u --label "${old_label}" --label "${new_label}" "${snapshot_abs}" /dev/null > "${diff_tmp}" 2>/dev/null || true
    else
      diff -u --label "${old_label}" --label "${new_label}" /dev/null "${snapshot_abs}" > "${diff_tmp}" 2>/dev/null || true
    fi
  else
    printf "      textual diff unavailable for non-regular file types.\n" >> "${out_file}"
  fi

  if [[ -s "${diff_tmp}" ]]; then
    while IFS= read -r diff_line || [[ -n "${diff_line}" ]]; do
      printf "      %s\n" "${diff_line}" >> "${out_file}"
    done < "${diff_tmp}"
  fi

  rm -f "${diff_tmp}"
}
_git_snapshot_compare_restore_effect_for_status() {
  local status="${1:-}"
  case "${status}" in
    unresolved_*) printf "changes" ;;
    *) printf "none" ;;
  esac
}
_git_snapshot_compare_set_display_fields() {
  local status="${1:-}"
  local restore_effect="${2:-}"
  local lines_added="${3:-}"
  local lines_removed="${4:-}"
  local baseline_mode="${5:-}"
  local current_mode="${6:-}"
  local head_mode="${7:-}"

  GSN_COMPARE_DISPLAY_KIND="text_change"
  GSN_COMPARE_DISPLAY_LABEL=""

  if [[ "${restore_effect}" == "none" ]]; then
    GSN_COMPARE_DISPLAY_KIND="no_effect"
    GSN_COMPARE_DISPLAY_LABEL="no restore effect"
    return 0
  fi

  if [[ "${lines_added}" =~ ^[0-9]+$ && "${lines_removed}" =~ ^[0-9]+$ ]]; then
    if [[ "${lines_added}" == "0" && "${lines_removed}" == "0" ]]; then
      GSN_COMPARE_DISPLAY_KIND="mode_change"
      GSN_COMPARE_DISPLAY_LABEL="mode change"
    fi
    return 0
  fi

  if [[ "${status}" == "unresolved_missing" ]]; then
    GSN_COMPARE_DISPLAY_KIND="missing"
    GSN_COMPARE_DISPLAY_LABEL="missing"
    return 0
  fi

  if [[ "${baseline_mode}" == "160000" || "${current_mode}" == "160000" || "${head_mode}" == "160000" ]]; then
    GSN_COMPARE_DISPLAY_KIND="submodule_change"
    GSN_COMPARE_DISPLAY_LABEL="submodule change"
    return 0
  fi

  GSN_COMPARE_DISPLAY_KIND="binary_change"
  GSN_COMPARE_DISPLAY_LABEL="binary change"
}
_git_snapshot_compare_internal_display_label_encode() {
  local display_label="${1-}"
  if [[ -z "${display_label}" ]]; then
    printf "__GSN_EMPTY__"
    return 0
  fi
  printf "%s" "${display_label}"
}
_git_snapshot_compare_internal_optional_encode() {
  local value="${1-}"
  if [[ -z "${value}" ]]; then
    printf "__GSN_EMPTY__"
    return 0
  fi
  printf "%s" "${value}"
}
_git_snapshot_compare_internal_optional_decode() {
  local value="${1-}"
  if [[ "${value}" == "__GSN_EMPTY__" ]]; then
    printf ""
    return 0
  fi
  printf "%s" "${value}"
}
_git_snapshot_compare_internal_display_label_decode() {
  local display_label="${1-}"
  if [[ "${display_label}" == "__GSN_EMPTY__" ]]; then
    printf ""
    return 0
  fi
  printf "%s" "${display_label}"
}
_git_snapshot_compare_print_grouped_rows() {
  local root_repo="$1"
  local rows_file="$2"
  local show_diff="${3:-false}"

  local current_repo=""
  local row_repo row_file_b64 row_file row_status _row_reason _row_scope _row_baseline_mode _row_current_mode _row_head_mode row_lines_added row_lines_removed row_restore_effect row_display_kind row_display_label row_diff_file human_repo_label
  local repo_stats_file=""
  local -A repo_shown_rows=()
  local -A repo_effect_rows=()
  local -A repo_lines_added=()
  local -A repo_lines_removed=()

  repo_stats_file="$(mktemp)"
  awk -F $'\t' '
    {
      repo = $1
      shown[repo]++
      if ($11 == "changes") effect[repo]++
      if ($9 ~ /^[0-9]+$/) add[repo] += $9
      if ($10 ~ /^[0-9]+$/) del[repo] += $10
    }
    END {
      for (repo in shown) {
        printf "%s\t%d\t%d\t%d\t%d\n", repo, shown[repo], effect[repo] + 0, add[repo] + 0, del[repo] + 0
      }
    }
  ' "${rows_file}" > "${repo_stats_file}"

  while IFS=$'\t' read -r row_repo _row_count _row_effect _row_added _row_removed; do
    [[ -z "${row_repo}" ]] && continue
    repo_shown_rows["${row_repo}"]="${_row_count}"
    repo_effect_rows["${row_repo}"]="${_row_effect}"
    repo_lines_added["${row_repo}"]="${_row_added}"
    repo_lines_removed["${row_repo}"]="${_row_removed}"
  done < "${repo_stats_file}"
  rm -f "${repo_stats_file}"

  while IFS=$'\t' read -r row_repo row_file_b64 row_status _row_reason _row_scope _row_baseline_mode _row_current_mode _row_head_mode row_lines_added row_lines_removed row_restore_effect row_display_kind row_display_label row_diff_file; do
    [[ -z "${row_repo}" ]] && continue
    row_lines_added="$(_git_snapshot_compare_internal_optional_decode "${row_lines_added}")"
    row_lines_removed="$(_git_snapshot_compare_internal_optional_decode "${row_lines_removed}")"
    row_display_label="$(_git_snapshot_compare_internal_display_label_decode "${row_display_label}")"
    if [[ "${current_repo}" != "${row_repo}" ]]; then
      current_repo="${row_repo}"
      human_repo_label="$(_git_snapshot_human_repo_label "${root_repo}" "${row_repo}")"
      if [[ "${repo_shown_rows[${row_repo}]:-0}" == "${repo_effect_rows[${row_repo}]:-0}" ]]; then
        printf "\nRepo: %s | effect: %s | lines: +%s/-%s\n" \
          "$(_git_snapshot_compare_sanitize_porcelain_value "${human_repo_label}")" \
          "${repo_effect_rows[${row_repo}]:-0}" \
          "${repo_lines_added[${row_repo}]:-0}" \
          "${repo_lines_removed[${row_repo}]:-0}"
      else
        printf "\nRepo: %s | effect: %s | shown: %s | lines: +%s/-%s\n" \
          "$(_git_snapshot_compare_sanitize_porcelain_value "${human_repo_label}")" \
          "${repo_effect_rows[${row_repo}]:-0}" \
          "${repo_shown_rows[${row_repo}]:-0}" \
          "${repo_lines_added[${row_repo}]:-0}" \
          "${repo_lines_removed[${row_repo}]:-0}"
      fi
    fi
    if ! row_file="$(_git_snapshot_compare_decode_path "${row_file_b64}")"; then
      row_file="<invalid compare path>"
    fi
    if [[ "${row_display_kind}" == "text_change" && "${row_lines_added}" =~ ^[0-9]+$ && "${row_lines_removed}" =~ ^[0-9]+$ ]]; then
      printf "  - %s (+%s/-%s)\n" \
        "$(_git_snapshot_compare_sanitize_porcelain_value "${row_file}")" \
        "${row_lines_added}" \
        "${row_lines_removed}"
    else
      printf "  - %s [%s]\n" \
        "$(_git_snapshot_compare_sanitize_porcelain_value "${row_file}")" \
        "$(_git_snapshot_compare_sanitize_porcelain_value "${row_display_label:-${row_display_kind}}")"
    fi
    if [[ "${show_diff}" == "true" && -n "${row_diff_file}" && -s "${row_diff_file}" ]]; then
      cat "${row_diff_file}"
    fi
  done < "${rows_file}"
}
_git_snapshot_compare_now_ms() {
  local now_ms=""

  if command -v python3 >/dev/null 2>&1; then
    now_ms="$(python3 -c 'import time; print(time.time_ns() // 1000000)' 2>/dev/null || true)"
  fi

  if [[ -z "${now_ms}" ]] && command -v perl >/dev/null 2>&1; then
    now_ms="$(perl -MTime::HiRes=time -e 'printf "%.0f\n", time() * 1000' 2>/dev/null || true)"
  fi

  if [[ ! "${now_ms}" =~ ^[0-9]+$ ]]; then
    now_ms="$(date +%s 2>/dev/null || true)"
    if [[ ! "${now_ms}" =~ ^[0-9]+$ ]]; then
      now_ms=0
    else
      now_ms=$((now_ms * 1000))
    fi
  fi

  printf "%s" "${now_ms}"
}
_git_snapshot_compare_normalize_base() {
  local compare_base="${1:-snapshot}"

  case "${compare_base}" in
    working-tree|snapshot)
      printf "%s\n" "${compare_base}"
      return 0
      ;;
    *)
      _git_snapshot_ui_err "Unsupported compare base: ${compare_base}. Use working-tree or snapshot."
      return 1
      ;;
  esac
}
_git_snapshot_compare_cache_enabled() {
  local raw="${GIT_SNAPSHOT_COMPARE_CACHE:-0}"
  case "${raw}" in
    0|false|FALSE|no|NO)
      return 1
      ;;
  esac
  return 0
}
_git_snapshot_compare_cache_max_entries() {
  local raw="${GIT_SNAPSHOT_COMPARE_CACHE_MAX_ENTRIES:-20}"
  if [[ ! "${raw}" =~ ^[0-9]+$ || "${raw}" -lt 1 ]]; then
    printf "20"
    return 0
  fi
  printf "%s" "${raw}"
}
_git_snapshot_compare_detect_default_jobs() {
  _git_snapshot_detect_default_jobs 8
}
_git_snapshot_compare_resolve_jobs() {
  local root_repo="$1"
  local default_jobs raw
  default_jobs="$(_git_snapshot_compare_detect_default_jobs)"
  raw="${GIT_SNAPSHOT_COMPARE_JOBS:-}"
  if [[ -z "${raw}" ]]; then
    raw="$(_git_snapshot_repo_config_get "${root_repo}" "compare" "jobs")"
  fi

  if [[ -z "${raw}" ]]; then
    printf "%s" "${default_jobs}"
    return 0
  fi
  if [[ ! "${raw}" =~ ^[0-9]+$ || "${raw}" -lt 1 ]]; then
    printf "%s" "${default_jobs}"
    return 0
  fi
  printf "%s" "${raw}"
}
_git_snapshot_open_worker_queue() {
  local queue_dir=""
  local queue_fifo=""

  # Use a private temp directory so compare never relies on shared-path
  # reservation semantics from mktemp -u.
  queue_dir="$(mktemp -d 2>/dev/null || true)"
  if [[ -z "${queue_dir}" || ! -d "${queue_dir}" ]]; then
    return 1
  fi

  queue_fifo="${queue_dir}/workers.fifo"
  if ! mkfifo "${queue_fifo}"; then
    rm -rf "${queue_dir}"
    return 1
  fi

  if ! exec 9<>"${queue_fifo}"; then
    rm -rf "${queue_dir}"
    return 1
  fi

  rm -f "${queue_fifo}"
  rmdir "${queue_dir}" 2>/dev/null || true
}
_git_snapshot_compare_cache_root_for_repo() {
  local root_repo="$1"
  printf "%s/.compare-cache-v2\n" "$(_git_snapshot_store_root_for_repo "${root_repo}")"
}
_git_snapshot_compare_cache_snapshot_dir() {
  local root_repo="$1"
  local snapshot_id="$2"
  printf "%s/%s\n" "$(_git_snapshot_compare_cache_root_for_repo "${root_repo}")" "${snapshot_id}"
}
_git_snapshot_compare_drop_cache_for_snapshot_id() {
  local root_repo="$1"
  local snapshot_id="$2"
  local cache_snapshot_dir=""

  cache_snapshot_dir="$(_git_snapshot_compare_cache_snapshot_dir "${root_repo}" "${snapshot_id}")"
  if [[ -d "${cache_snapshot_dir}" ]]; then
    rm -rf "${cache_snapshot_dir}"
  fi
}
_git_snapshot_compare_prune_cache_family() {
  local family_dir="$1"
  local max_entries="$2"

  if [[ ! -d "${family_dir}" ]]; then
    return 0
  fi

  local cache_dirs=()
  local name
  while IFS= read -r name; do
    [[ -z "${name}" ]] && continue
    [[ -d "${family_dir}/${name}" ]] || continue
    cache_dirs+=("${name}")
  done < <(cd "${family_dir}" && ls -1t 2>/dev/null || true)

  local total="${#cache_dirs[@]}"
  if [[ "${total}" -le "${max_entries}" ]]; then
    return 0
  fi

  local i="${max_entries}"
  while [[ "${i}" -lt "${total}" ]]; do
    rm -rf "${family_dir}/${cache_dirs[${i}]}"
    i=$((i + 1))
  done
}
_git_snapshot_compare_write_counts_file() {
  local counts_file="$1"
  local files_total="$2"
  local resolved_committed="$3"
  local resolved_uncommitted="$4"
  local unresolved_missing="$5"
  local unresolved_diverged="$6"

  {
    printf "files_total=%s\n" "${files_total}"
    printf "resolved_committed=%s\n" "${resolved_committed}"
    printf "resolved_uncommitted=%s\n" "${resolved_uncommitted}"
    printf "unresolved_missing=%s\n" "${unresolved_missing}"
    printf "unresolved_diverged=%s\n" "${unresolved_diverged}"
  } > "${counts_file}"
}
_git_snapshot_compare_read_counts_file() {
  local counts_file="$1"
  local line key value

  GSN_COMPARE_COUNT_FILES_TOTAL=0
  GSN_COMPARE_COUNT_RESOLVED_COMMITTED=0
  GSN_COMPARE_COUNT_RESOLVED_UNCOMMITTED=0
  GSN_COMPARE_COUNT_UNRESOLVED_MISSING=0
  GSN_COMPARE_COUNT_UNRESOLVED_DIVERGED=0

  if [[ ! -f "${counts_file}" ]]; then
    return 0
  fi

  while IFS= read -r line || [[ -n "${line}" ]]; do
    [[ -z "${line}" ]] && continue
    key="${line%%=*}"
    value="${line#*=}"
    case "${key}" in
      files_total) GSN_COMPARE_COUNT_FILES_TOTAL="${value}" ;;
      resolved_committed) GSN_COMPARE_COUNT_RESOLVED_COMMITTED="${value}" ;;
      resolved_uncommitted) GSN_COMPARE_COUNT_RESOLVED_UNCOMMITTED="${value}" ;;
      unresolved_missing) GSN_COMPARE_COUNT_UNRESOLVED_MISSING="${value}" ;;
      unresolved_diverged) GSN_COMPARE_COUNT_UNRESOLVED_DIVERGED="${value}" ;;
    esac
  done < "${counts_file}"

  if [[ ! "${GSN_COMPARE_COUNT_FILES_TOTAL}" =~ ^[0-9]+$ ]]; then GSN_COMPARE_COUNT_FILES_TOTAL=0; fi
  if [[ ! "${GSN_COMPARE_COUNT_RESOLVED_COMMITTED}" =~ ^[0-9]+$ ]]; then GSN_COMPARE_COUNT_RESOLVED_COMMITTED=0; fi
  if [[ ! "${GSN_COMPARE_COUNT_RESOLVED_UNCOMMITTED}" =~ ^[0-9]+$ ]]; then GSN_COMPARE_COUNT_RESOLVED_UNCOMMITTED=0; fi
  if [[ ! "${GSN_COMPARE_COUNT_UNRESOLVED_MISSING}" =~ ^[0-9]+$ ]]; then GSN_COMPARE_COUNT_UNRESOLVED_MISSING=0; fi
  if [[ ! "${GSN_COMPARE_COUNT_UNRESOLVED_DIVERGED}" =~ ^[0-9]+$ ]]; then GSN_COMPARE_COUNT_UNRESOLVED_DIVERGED=0; fi
}
_git_snapshot_compare_targeted_signature_limit() {
  local raw="${GIT_SNAPSHOT_COMPARE_TARGETED_SIGNATURE_LIMIT:-200}"
  if [[ ! "${raw}" =~ ^[0-9]+$ || "${raw}" -lt 1 ]]; then
    printf "200"
    return 0
  fi
  printf "%s" "${raw}"
}
_git_snapshot_compare_collect_temp_index_signatures() {
  local repo_abs="$1"
  local target_files_file="$2"
  local out_file="$3"
  local encoded_path file_path
  local row meta mode oid stage_meta
  local index_file=""
  local index_source=""
  local temp_object_root=""
  local git_known_path=""
  local -a target_paths=()
  local -a add_paths=()

  : > "${out_file}"

  while IFS= read -r encoded_path || [[ -n "${encoded_path}" ]]; do
    [[ -z "${encoded_path}" ]] && continue
    if ! file_path="$(_git_snapshot_compare_decode_path "${encoded_path}")"; then
      return 1
    fi
    target_paths+=("${file_path}")
    git_known_path="$(git -C "${repo_abs}" ls-files --error-unmatch -- "${file_path}" 2>/dev/null || true)"
    if [[ -n "${git_known_path}" ]] \
      || [[ -f "${repo_abs}/${file_path}" || -L "${repo_abs}/${file_path}" ]]; then
      add_paths+=("${file_path}")
    fi
  done < "${target_files_file}"

  if [[ "${#target_paths[@]}" -eq 0 ]]; then
    return 0
  fi

  index_file="$(mktemp)"
  index_source="$(git -C "${repo_abs}" rev-parse --git-path index 2>/dev/null || true)"
  if [[ -n "${index_source}" && "${index_source}" != /* ]]; then
    index_source="${repo_abs}/${index_source}"
  fi
  if [[ -n "${index_source}" && -f "${index_source}" ]]; then
    cp "${index_source}" "${index_file}"
  else
    rm -f "${index_file}"
  fi

  if ! _git_snapshot_compare_prepare_temp_object_env "${repo_abs}"; then
    rm -f "${index_file}"
    return 1
  fi
  temp_object_root="$(dirname "${GSN_COMPARE_TEMP_OBJECT_DIR}")"

  if [[ "${#add_paths[@]}" -gt 0 ]] && ! GIT_INDEX_FILE="${index_file}" \
    GIT_OBJECT_DIRECTORY="${GSN_COMPARE_TEMP_OBJECT_DIR}" \
    GIT_ALTERNATE_OBJECT_DIRECTORIES="${GSN_COMPARE_TEMP_OBJECT_ALTERNATES}" \
    git -C "${repo_abs}" add -A -- "${add_paths[@]}" >/dev/null 2>&1; then
    rm -f "${index_file}"
    rm -rf "${temp_object_root}"
    return 1
  fi

  while IFS= read -r -d '' row; do
    [[ -z "${row}" ]] && continue
    meta="${row%%$'\t'*}"
    file_path="${row#*$'\t'}"
    mode="${meta%% *}"
    stage_meta="${meta#* }"
    oid="${stage_meta%% *}"
    encoded_path="$(_git_snapshot_store_base64_encode "${file_path}")"
    printf "%s\t%s\t%s\n" "${encoded_path}" "${mode}" "${oid}" >> "${out_file}"
  done < <(
    GIT_INDEX_FILE="${index_file}" \
    GIT_OBJECT_DIRECTORY="${GSN_COMPARE_TEMP_OBJECT_DIR}" \
    GIT_ALTERNATE_OBJECT_DIRECTORIES="${GSN_COMPARE_TEMP_OBJECT_ALTERNATES}" \
    git -C "${repo_abs}" ls-files -s -z -- "${target_paths[@]}"
  )

  rm -f "${index_file}"
  rm -rf "${temp_object_root}"
}
_git_snapshot_compare_capture_repo_target_metadata() {
  local repo_abs="$1"
  local repo_bundle_dir="$2"
  local target_files_file=""
  local target_signatures_file=""
  local files_total=0
  local manifest_hash=""
  local signature_hash=""

  target_files_file="$(_git_snapshot_compare_target_paths_file "${repo_bundle_dir}")"
  target_signatures_file="$(_git_snapshot_compare_target_signatures_file "${repo_bundle_dir}")"

  _git_snapshot_compare_collect_snapshot_files "${repo_bundle_dir}" > "${target_files_file}"
  if ! _git_snapshot_compare_collect_temp_index_signatures "${repo_abs}" "${target_files_file}" "${target_signatures_file}"; then
    _git_snapshot_ui_err "Failed to capture compare target signatures for ${repo_abs}."
    return 1
  fi

  files_total="$(wc -l < "${target_files_file}" | tr -d '[:space:]')"
  if [[ ! "${files_total}" =~ ^[0-9]+$ ]]; then
    files_total=0
  fi

  manifest_hash="$(_git_snapshot_compare_hash_file "${target_files_file}" 2>/dev/null || true)"
  signature_hash="$(_git_snapshot_compare_hash_file "${target_signatures_file}" 2>/dev/null || true)"
  if [[ -z "${manifest_hash}" || -z "${signature_hash}" ]]; then
    _git_snapshot_ui_err "Failed to hash compare target metadata for ${repo_abs}."
    return 1
  fi

  _git_snapshot_compare_write_target_meta "${repo_bundle_dir}" "${files_total}" "${manifest_hash}" "${signature_hash}"
}
_git_snapshot_compare_filter_removed_gitlink_rows() {
  local snapshot_sig_file="$1"
  local current_sig_file="$2"
  local filtered_file=""

  filtered_file="$(mktemp)"
  if [[ ! -s "${snapshot_sig_file}" ]]; then
    awk -F $'\t' '$2 != "160000" { print }' "${current_sig_file}" > "${filtered_file}"
  else
    awk -F $'\t' '
      NR == FNR {
        snapshot_modes[$1] = $2
        next
      }
      {
        if ($2 == "160000" && !($1 in snapshot_modes)) {
          next
        }
        print
      }
    ' "${snapshot_sig_file}" "${current_sig_file}" > "${filtered_file}"
  fi

  mv "${filtered_file}" "${current_sig_file}"
}
_git_snapshot_compare_collect_targeted_index_signatures() {
  local repo_dir="$1"
  local target_files_file="$2"
  local out_file="$3"
  local encoded_path file_path abs_path
  local row meta mode oid stage_meta
  local -a present_paths=()

  : > "${out_file}"

  while IFS= read -r encoded_path || [[ -n "${encoded_path}" ]]; do
    [[ -z "${encoded_path}" ]] && continue
    if ! file_path="$(_git_snapshot_compare_decode_path "${encoded_path}")"; then
      return 1
    fi
    abs_path="${repo_dir}/${file_path}"
    if [[ -f "${abs_path}" || -L "${abs_path}" ]]; then
      present_paths+=("${file_path}")
    fi
  done < "${target_files_file}"

  if [[ "${#present_paths[@]}" -eq 0 ]]; then
    return 0
  fi

  if ! git -C "${repo_dir}" add -A -- "${present_paths[@]}" >/dev/null 2>&1; then
    return 1
  fi

  while IFS= read -r -d '' row; do
    [[ -z "${row}" ]] && continue
    meta="${row%%$'\t'*}"
    file_path="${row#*$'\t'}"
    mode="${meta%% *}"
    stage_meta="${meta#* }"
    oid="${stage_meta%% *}"
    encoded_path="$(_git_snapshot_store_base64_encode "${file_path}")"
    printf "%s\t%s\t%s\n" "${encoded_path}" "${mode}" "${oid}" >> "${out_file}"
  done < <(git -C "${repo_dir}" ls-files -s -z -- "${present_paths[@]}")
}
_git_snapshot_compare_collect_targeted_tree_signatures() {
  local repo_abs="$1"
  local tree_ref="$2"
  local target_files_file="$3"
  local out_file="$4"
  local encoded_path file_path row meta mode entry_type object_id rest
  local -a target_paths=()

  : > "${out_file}"

  if ! git -C "${repo_abs}" rev-parse --verify -q "${tree_ref}" >/dev/null 2>&1; then
    return 0
  fi

  while IFS= read -r encoded_path || [[ -n "${encoded_path}" ]]; do
    [[ -z "${encoded_path}" ]] && continue
    if ! file_path="$(_git_snapshot_compare_decode_path "${encoded_path}")"; then
      return 1
    fi
    target_paths+=("${file_path}")
  done < "${target_files_file}"

  if [[ "${#target_paths[@]}" -eq 0 ]]; then
    return 0
  fi

  while IFS= read -r -d '' row; do
    [[ -z "${row}" ]] && continue

    meta="${row%%$'\t'*}"
    file_path="${row#*$'\t'}"
    encoded_path="$(_git_snapshot_store_base64_encode "${file_path}")"

    mode="${meta%% *}"
    rest="${meta#* }"
    entry_type="${rest%% *}"
    object_id="${rest##* }"

    case "${entry_type}" in
      blob|commit|tree)
        printf "%s\t%s\t%s\n" "${encoded_path}" "${mode}" "${object_id}" >> "${out_file}"
        ;;
    esac
  done < <(git -C "${repo_abs}" ls-tree --full-tree -r -z "${tree_ref}" -- "${target_paths[@]}")
}
_git_snapshot_compare_collect_targeted_head_signatures() {
  local repo_abs="$1"
  local target_files_file="$2"
  local out_file="$3"

  _git_snapshot_compare_collect_targeted_tree_signatures "${repo_abs}" "HEAD" "${target_files_file}" "${out_file}"
}
_git_snapshot_compare_collect_index_signatures() {
  local repo_dir="$1"
  local out_file="$2"
  local row meta file_path mode oid stage_meta encoded_path

  : > "${out_file}"

  if ! git -C "${repo_dir}" add -A -- . >/dev/null 2>&1; then
    return 1
  fi

  while IFS= read -r -d '' row; do
    [[ -z "${row}" ]] && continue
    meta="${row%%$'\t'*}"
    file_path="${row#*$'\t'}"
    mode="${meta%% *}"
    stage_meta="${meta#* }"
    oid="${stage_meta%% *}"
    encoded_path="$(_git_snapshot_store_base64_encode "${file_path}")"
    printf "%s\t%s\t%s\n" "${encoded_path}" "${mode}" "${oid}" >> "${out_file}"
  done < <(git -C "${repo_dir}" ls-files -s -z)
}
_git_snapshot_compare_collect_head_signatures() {
  local repo_abs="$1"
  local out_file="$2"
  local row meta file_path mode entry_type object_id rest encoded_path

  : > "${out_file}"

  if ! git -C "${repo_abs}" rev-parse --verify -q HEAD >/dev/null 2>&1; then
    return 0
  fi

  while IFS= read -r -d '' row; do
    [[ -z "${row}" ]] && continue
    meta="${row%%$'\t'*}"
    file_path="${row#*$'\t'}"

    mode="${meta%% *}"
    rest="${meta#* }"
    entry_type="${rest%% *}"
    object_id="${rest##* }"

    case "${entry_type}" in
      blob|commit|tree)
        encoded_path="$(_git_snapshot_store_base64_encode "${file_path}")"
        printf "%s\t%s\t%s\n" "${encoded_path}" "${mode}" "${object_id}" >> "${out_file}"
        ;;
    esac
  done < <(git -C "${repo_abs}" ls-tree --full-tree -r -z HEAD)
}
_git_snapshot_compare_classify_union_batch() {
  local union_files_file="$1"
  local snapshot_scope_file="$2"
  local current_scope_file="$3"
  local snapshot_sig_file="$4"
  local current_sig_file="$5"
  local head_sig_file="$6"
  local out_rows_file="$7"
  local out_counts_file="$8"

  awk \
    -v snapshot_scope="${snapshot_scope_file}" \
    -v current_scope="${current_scope_file}" \
    -v snapshot_sig="${snapshot_sig_file}" \
    -v current_sig="${current_sig_file}" \
    -v head_sig="${head_sig_file}" \
    -v counts_out="${out_counts_file}" \
    '
      BEGIN {
        FS = "\t"
        OFS = "\t"
        files_total = 0
        resolved_committed = 0
        resolved_uncommitted = 0
        unresolved_missing = 0
        unresolved_diverged = 0

        while ((getline line < snapshot_scope) > 0) {
          if (line == "") continue
          snapshot_scope_paths[line] = 1
        }
        close(snapshot_scope)

        while ((getline line < current_scope) > 0) {
          if (line == "") continue
          current_scope_paths[line] = 1
        }
        close(current_scope)

        while ((getline line < snapshot_sig) > 0) {
          if (line == "") continue
          split(line, p, "\t")
          if (length(p) < 3) continue
          sp[p[1]] = 1
          sm[p[1]] = p[2]
          sh[p[1]] = p[3]
        }
        close(snapshot_sig)

        while ((getline line < current_sig) > 0) {
          if (line == "") continue
          split(line, p, "\t")
          if (length(p) < 3) continue
          cp[p[1]] = 1
          cm[p[1]] = p[2]
          ch[p[1]] = p[3]
        }
        close(current_sig)

        while ((getline line < head_sig) > 0) {
          if (line == "") continue
          split(line, p, "\t")
          if (length(p) < 3) continue
          hp[p[1]] = 1
          hm[p[1]] = p[2]
          hh[p[1]] = p[3]
        }
        close(head_sig)
      }
      {
        encoded_path = $0
        if (encoded_path == "") next

        files_total++
        snapshot_scope_match = (encoded_path in snapshot_scope_paths)
        current_scope_match = (encoded_path in current_scope_paths)
        snapshot_present = (encoded_path in sp)
        current_present = (encoded_path in cp)
        head_present = (encoded_path in hp)

        if (snapshot_scope_match && current_scope_match) {
          path_scope = "both"
        } else if (snapshot_scope_match) {
          path_scope = "snapshot_only"
        } else {
          path_scope = "current_only"
        }

        if (path_scope == "current_only") {
          if (snapshot_present) {
            if (!current_present) {
              status = "unresolved_missing"
              reason = "current-only dirty path is missing from working tree"
              unresolved_missing++
            } else if (sm[encoded_path] != cm[encoded_path] || sh[encoded_path] != ch[encoded_path]) {
              status = "unresolved_diverged"
              reason = "current-only dirty path diverges from restore baseline"
              unresolved_diverged++
            } else if (head_present && sm[encoded_path] == hm[encoded_path] && sh[encoded_path] == hh[encoded_path]) {
              status = "resolved_committed"
              reason = "current-only dirty path matches HEAD and restore baseline"
              resolved_committed++
            } else {
              status = "resolved_uncommitted"
              reason = "current-only dirty path matches restore baseline but not HEAD"
              resolved_uncommitted++
            }
          } else if (current_present) {
            status = "unresolved_diverged"
            reason = "current-only dirty path exists while restore baseline removes it"
            unresolved_diverged++
          } else if (head_present) {
            status = "resolved_uncommitted"
            reason = "current-only dirty path is absent and restore baseline removes it"
            resolved_uncommitted++
          } else {
            status = "resolved_committed"
            reason = "current-only dirty path is absent and HEAD matches restore baseline"
            resolved_committed++
          }
        } else if (snapshot_present) {
          if (!current_present) {
            status = "unresolved_missing"
            reason = "snapshot target path is missing from working tree"
            unresolved_missing++
          } else if (sm[encoded_path] != cm[encoded_path] || sh[encoded_path] != ch[encoded_path]) {
            status = "unresolved_diverged"
            reason = "current content or mode diverges from snapshot target"
            unresolved_diverged++
          } else if (head_present && sm[encoded_path] == hm[encoded_path] && sh[encoded_path] == hh[encoded_path]) {
            status = "resolved_committed"
            reason = "snapshot target content and mode match HEAD and working tree"
            resolved_committed++
          } else {
            status = "resolved_uncommitted"
            reason = "snapshot target content and mode match working tree but not HEAD"
            resolved_uncommitted++
          }
        } else if (current_present) {
          status = "unresolved_diverged"
          reason = "path still exists while snapshot target removes it"
          unresolved_diverged++
        } else if (head_present) {
          status = "resolved_uncommitted"
          reason = "snapshot target removes this path and working tree matches"
          resolved_uncommitted++
        } else {
          status = "resolved_committed"
          reason = "snapshot target removes this path and HEAD matches"
          resolved_committed++
        }

        baseline_mode = ((encoded_path in sm) && sm[encoded_path] != "" ? sm[encoded_path] : "missing")
        current_mode = ((encoded_path in cp) && cm[encoded_path] != "" ? cm[encoded_path] : "missing")
        head_mode = ((encoded_path in hp) && hm[encoded_path] != "" ? hm[encoded_path] : "missing")
        print encoded_path, status, reason, path_scope, baseline_mode, current_mode, head_mode
      }
      END {
        printf "files_total=%d\n", files_total > counts_out
        printf "resolved_committed=%d\n", resolved_committed > counts_out
        printf "resolved_uncommitted=%d\n", resolved_uncommitted > counts_out
        printf "unresolved_missing=%d\n", unresolved_missing > counts_out
        printf "unresolved_diverged=%d\n", unresolved_diverged > counts_out
      }
    ' "${union_files_file}" > "${out_rows_file}"
}
_git_snapshot_compare_write_worker_error_meta() {
  local meta_file="$1"
  local error_id="$2"
  local stage="$3"
  local message="$4"
  local repo_rel="$5"

  {
    printf "worker_status=error\n"
    printf "error_id=%s\n" "${error_id}"
    printf "error_stage=%s\n" "${stage}"
    printf "error_message=%s\n" "${message}"
    printf "error_repo=%s\n" "${repo_rel}"
  } > "${meta_file}"
}
_git_snapshot_compare_write_worker_success_meta() {
  local meta_file="$1"
  local cache_hit="$2"
  local engine="$3"
  local files_total="$4"
  local resolved_committed="$5"
  local resolved_uncommitted="$6"
  local unresolved_missing="$7"
  local unresolved_diverged="$8"

  {
    printf "worker_status=ok\n"
    printf "cache_hit=%s\n" "${cache_hit}"
    printf "engine=%s\n" "${engine}"
    printf "files_total=%s\n" "${files_total}"
    printf "resolved_committed=%s\n" "${resolved_committed}"
    printf "resolved_uncommitted=%s\n" "${resolved_uncommitted}"
    printf "unresolved_missing=%s\n" "${unresolved_missing}"
    printf "unresolved_diverged=%s\n" "${unresolved_diverged}"
  } > "${meta_file}"
}
_git_snapshot_compare_read_worker_meta() {
  local meta_file="$1"
  local line key value

  GSN_COMPARE_WORKER_STATUS=""
  GSN_COMPARE_WORKER_CACHE_HIT=0
  GSN_COMPARE_WORKER_ENGINE=""
  GSN_COMPARE_WORKER_FILES_TOTAL=0
  GSN_COMPARE_WORKER_RESOLVED_COMMITTED=0
  GSN_COMPARE_WORKER_RESOLVED_UNCOMMITTED=0
  GSN_COMPARE_WORKER_UNRESOLVED_MISSING=0
  GSN_COMPARE_WORKER_UNRESOLVED_DIVERGED=0
  GSN_COMPARE_WORKER_ERROR_ID=""
  GSN_COMPARE_WORKER_ERROR_STAGE=""
  GSN_COMPARE_WORKER_ERROR_MESSAGE=""
  GSN_COMPARE_WORKER_ERROR_REPO=""

  if [[ ! -f "${meta_file}" ]]; then
    return 1
  fi

  while IFS= read -r line || [[ -n "${line}" ]]; do
    [[ -z "${line}" ]] && continue
    key="${line%%=*}"
    value="${line#*=}"
    case "${key}" in
      worker_status) GSN_COMPARE_WORKER_STATUS="${value}" ;;
      cache_hit) GSN_COMPARE_WORKER_CACHE_HIT="${value}" ;;
      engine) GSN_COMPARE_WORKER_ENGINE="${value}" ;;
      files_total) GSN_COMPARE_WORKER_FILES_TOTAL="${value}" ;;
      resolved_committed) GSN_COMPARE_WORKER_RESOLVED_COMMITTED="${value}" ;;
      resolved_uncommitted) GSN_COMPARE_WORKER_RESOLVED_UNCOMMITTED="${value}" ;;
      unresolved_missing) GSN_COMPARE_WORKER_UNRESOLVED_MISSING="${value}" ;;
      unresolved_diverged) GSN_COMPARE_WORKER_UNRESOLVED_DIVERGED="${value}" ;;
      error_id) GSN_COMPARE_WORKER_ERROR_ID="${value}" ;;
      error_stage) GSN_COMPARE_WORKER_ERROR_STAGE="${value}" ;;
      error_message) GSN_COMPARE_WORKER_ERROR_MESSAGE="${value}" ;;
      error_repo) GSN_COMPARE_WORKER_ERROR_REPO="${value}" ;;
    esac
  done < "${meta_file}"

  if [[ ! "${GSN_COMPARE_WORKER_CACHE_HIT}" =~ ^[0-9]+$ ]]; then GSN_COMPARE_WORKER_CACHE_HIT=0; fi
  if [[ ! "${GSN_COMPARE_WORKER_FILES_TOTAL}" =~ ^[0-9]+$ ]]; then GSN_COMPARE_WORKER_FILES_TOTAL=0; fi
  if [[ ! "${GSN_COMPARE_WORKER_RESOLVED_COMMITTED}" =~ ^[0-9]+$ ]]; then GSN_COMPARE_WORKER_RESOLVED_COMMITTED=0; fi
  if [[ ! "${GSN_COMPARE_WORKER_RESOLVED_UNCOMMITTED}" =~ ^[0-9]+$ ]]; then GSN_COMPARE_WORKER_RESOLVED_UNCOMMITTED=0; fi
  if [[ ! "${GSN_COMPARE_WORKER_UNRESOLVED_MISSING}" =~ ^[0-9]+$ ]]; then GSN_COMPARE_WORKER_UNRESOLVED_MISSING=0; fi
  if [[ ! "${GSN_COMPARE_WORKER_UNRESOLVED_DIVERGED}" =~ ^[0-9]+$ ]]; then GSN_COMPARE_WORKER_UNRESOLVED_DIVERGED=0; fi

  return 0
}
_git_snapshot_compare_process_repo_worker_v3() {
  local root_repo="$1"
  local snapshot_path="$2"
  local snapshot_id="$3"
  local cache_root="$4"
  local cache_enabled="$5"
  local cache_max_entries="$6"
  local repo_id="$7"
  local rel_path="$8"
  local rows_out="${9}"
  local counts_out="${10}"
  local meta_out="${11}"
  local repo_bundle_dir="${12}"
  local repo_abs="${13}"
  local snapshot_head="${14}"
  local repo_scope_kind="${15:-snapshot}"

  local snapshot_scope_file=""
  local snapshot_sig_file=""
  local baseline_sig_file=""
  local current_scope_file=""
  local union_files_file=""
  local current_only_scope_file=""
  local current_sig_file=""
  local head_sig_file=""
  local classified_rows_file=""
  local cache_key_hash=""
  local cache_family_dir="" cache_entry_dir="" cache_rows_file="" cache_counts_file=""
  local cache_tmp_dir=""
  local current_signature_hash=""
  local head_signature_hash=""
  local baseline_signature_hash=""
  local union_manifest_hash=""
  local missing_file
  local files_total=0 resolved_committed=0 resolved_uncommitted=0 unresolved_missing=0 unresolved_diverged=0

  snapshot_scope_file="$(mktemp)"
  snapshot_sig_file="$(mktemp)"
  baseline_sig_file="$(mktemp)"
  current_scope_file="$(mktemp)"
  union_files_file="$(mktemp)"
  current_only_scope_file="$(mktemp)"
  current_sig_file="$(mktemp)"
  head_sig_file="$(mktemp)"
  classified_rows_file="$(mktemp)"

  cleanup_compare_worker_v3() {
    rm -f "${snapshot_scope_file:-}" "${snapshot_sig_file:-}" "${baseline_sig_file:-}" "${current_scope_file:-}" "${union_files_file:-}" "${current_only_scope_file:-}"
    rm -f "${current_sig_file:-}" "${head_sig_file:-}" "${classified_rows_file:-}"
    rm -f "${counts_out:-}"
    if [[ -n "${cache_tmp_dir:-}" ]]; then
      rm -rf "${cache_tmp_dir}"
    fi
  }

  : > "${snapshot_scope_file}"
  : > "${snapshot_sig_file}"
  : > "${baseline_sig_file}"
  : > "${current_scope_file}"
  : > "${union_files_file}"
  : > "${current_only_scope_file}"

  if [[ "${repo_scope_kind}" != "current_only" ]]; then
    if ! _git_snapshot_compare_load_target_meta "${repo_bundle_dir}"; then
      _git_snapshot_compare_write_worker_error_meta \
        "${meta_out}" \
        "compare_target_metadata_invalid" \
        "target_metadata_load" \
        "Snapshot compare target metadata is invalid." \
        "${rel_path}"
      cleanup_compare_worker_v3
      return 1
    fi

    if ! _git_snapshot_compare_verify_target_metadata_integrity "${repo_bundle_dir}"; then
      _git_snapshot_compare_write_worker_error_meta \
        "${meta_out}" \
        "compare_target_metadata_hash_mismatch" \
        "target_metadata_integrity" \
        "Snapshot compare target metadata failed integrity verification." \
        "${rel_path}"
      cleanup_compare_worker_v3
      return 1
    fi

    cp "$(_git_snapshot_compare_target_paths_file "${repo_bundle_dir}")" "${snapshot_scope_file}" 2>/dev/null || true
    cp "$(_git_snapshot_compare_target_signatures_file "${repo_bundle_dir}")" "${snapshot_sig_file}" 2>/dev/null || true
  fi

  if ! git -C "${repo_abs}" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    current_signature_hash="repo_missing"
    head_signature_hash="repo_missing"
  else
    if ! _git_snapshot_compare_collect_current_dirty_paths "${repo_abs}" > "${current_scope_file}"; then
      _git_snapshot_compare_write_worker_error_meta \
        "${meta_out}" \
        "compare_current_scope_collect_failed" \
        "current_scope_collect" \
        "Failed to collect current dirty compare scope." \
        "${rel_path}"
      cleanup_compare_worker_v3
      return 1
    fi
  fi

  # Compare scope files are emitted in C-sorted order, and downstream comm/join
  # style set operations require all operands to stay in that same collation.
  # Normalize both inputs here so locale-sensitive shells do not misclassify
  # snapshot-scope paths as current-only.
  LC_ALL=C sort -u "${snapshot_scope_file}" -o "${snapshot_scope_file}"
  LC_ALL=C sort -u "${current_scope_file}" -o "${current_scope_file}"

  {
    cat "${snapshot_scope_file}"
    cat "${current_scope_file}"
  } | sed '/^$/d' | LC_ALL=C sort -u > "${union_files_file}"

  if [[ -s "${current_scope_file}" && -s "${snapshot_scope_file}" ]]; then
    LC_ALL=C comm -23 "${current_scope_file}" "${snapshot_scope_file}" > "${current_only_scope_file}" 2>/dev/null || true
  else
    cp "${current_scope_file}" "${current_only_scope_file}" 2>/dev/null || true
  fi

  if [[ "${current_signature_hash}" != "repo_missing" ]]; then
    if ! _git_snapshot_compare_collect_temp_index_signatures "${repo_abs}" "${union_files_file}" "${current_sig_file}"; then
      _git_snapshot_compare_write_worker_error_meta \
        "${meta_out}" \
        "compare_current_signature_collect_failed" \
        "current_signature_collect" \
        "Failed to collect current signatures for compare." \
        "${rel_path}"
      cleanup_compare_worker_v3
      return 1
    fi
    if ! _git_snapshot_compare_collect_targeted_head_signatures "${repo_abs}" "${union_files_file}" "${head_sig_file}"; then
      _git_snapshot_compare_write_worker_error_meta \
        "${meta_out}" \
        "compare_head_signature_collect_failed" \
        "head_signature_collect" \
        "Failed to collect HEAD signatures for compare." \
        "${rel_path}"
      cleanup_compare_worker_v3
      return 1
    fi
  fi

  if [[ "${repo_scope_kind}" == "current_only" ]]; then
    if [[ "${current_signature_hash}" != "repo_missing" ]] && ! _git_snapshot_compare_collect_targeted_head_signatures "${repo_abs}" "${union_files_file}" "${baseline_sig_file}"; then
      _git_snapshot_compare_write_worker_error_meta \
        "${meta_out}" \
        "compare_baseline_signature_collect_failed" \
        "baseline_signature_collect" \
        "Failed to collect restore-baseline signatures for compare." \
        "${rel_path}"
      cleanup_compare_worker_v3
      return 1
    fi
  else
    cp "${snapshot_sig_file}" "${baseline_sig_file}" 2>/dev/null || true
    if [[ "${current_signature_hash}" != "repo_missing" && -s "${current_only_scope_file}" && -n "${snapshot_head}" && "${snapshot_head}" != "none" ]]; then
      local snapshot_extra_sig_file=""
      snapshot_extra_sig_file="$(mktemp)"
      if ! _git_snapshot_compare_collect_targeted_tree_signatures "${repo_abs}" "${snapshot_head}" "${current_only_scope_file}" "${snapshot_extra_sig_file}"; then
        rm -f "${snapshot_extra_sig_file}"
        _git_snapshot_compare_write_worker_error_meta \
          "${meta_out}" \
          "compare_snapshot_scope_extend_failed" \
          "snapshot_scope_extend" \
          "Failed to extend snapshot compare scope with current-only paths." \
          "${rel_path}"
        cleanup_compare_worker_v3
        return 1
      fi
      {
        cat "${baseline_sig_file}"
        cat "${snapshot_extra_sig_file}"
      } | sed '/^$/d' | LC_ALL=C sort -u > "${baseline_sig_file}.tmp"
      mv "${baseline_sig_file}.tmp" "${baseline_sig_file}"
      rm -f "${snapshot_extra_sig_file}"
    fi
  fi

  if [[ -z "${current_signature_hash}" ]]; then
    current_signature_hash="$(_git_snapshot_compare_hash_file "${current_sig_file}" 2>/dev/null || true)"
  fi
  if [[ -z "${head_signature_hash}" ]]; then
    head_signature_hash="$(_git_snapshot_compare_hash_file "${head_sig_file}" 2>/dev/null || true)"
  fi
  if [[ -z "${current_signature_hash}" ]]; then
    current_signature_hash="none"
  fi
  if [[ -z "${head_signature_hash}" ]]; then
    head_signature_hash="none"
  fi
  union_manifest_hash="$(_git_snapshot_compare_hash_file "${union_files_file}" 2>/dev/null || true)"
  baseline_signature_hash="$(_git_snapshot_compare_hash_file "${baseline_sig_file}" 2>/dev/null || true)"
  if [[ -z "${union_manifest_hash}" ]]; then
    union_manifest_hash="none"
  fi
  if [[ -z "${baseline_signature_hash}" ]]; then
    baseline_signature_hash="none"
  fi

  cache_key_hash="$(printf "engine=v3\nrow_stats_schema=v2\nrestore_effect_visibility_schema=v3\nsnapshot_id=%s\nrepo_id=%s\nrepo_scope_kind=%s\nmanifest_hash=%s\nbaseline_signature_hash=%s\ncurrent_signature_hash=%s\nhead_signature_hash=%s\n" \
    "${snapshot_id}" \
    "${repo_id}" \
    "${repo_scope_kind}" \
    "${union_manifest_hash}" \
    "${baseline_signature_hash}" \
    "${current_signature_hash}" \
    "${head_signature_hash}" | _git_snapshot_compare_hash_stdin)"

  if [[ "${cache_enabled}" == "true" ]]; then
    cache_family_dir="${cache_root}/${snapshot_id}/${repo_id}"
    cache_entry_dir="${cache_family_dir}/${cache_key_hash}"
    cache_rows_file="${cache_entry_dir}/rows.tsv"
    cache_counts_file="${cache_entry_dir}/counts.env"
    if [[ -f "${cache_rows_file}" && -s "${cache_counts_file}" ]]; then
      cp "${cache_rows_file}" "${rows_out}" 2>/dev/null || true
      _git_snapshot_compare_read_counts_file "${cache_counts_file}"
      _git_snapshot_compare_write_worker_success_meta \
        "${meta_out}" \
        "1" \
        "v3" \
        "${GSN_COMPARE_COUNT_FILES_TOTAL}" \
        "${GSN_COMPARE_COUNT_RESOLVED_COMMITTED}" \
        "${GSN_COMPARE_COUNT_RESOLVED_UNCOMMITTED}" \
        "${GSN_COMPARE_COUNT_UNRESOLVED_MISSING}" \
        "${GSN_COMPARE_COUNT_UNRESOLVED_DIVERGED}"
      cleanup_compare_worker_v3
      return 0
    fi
  fi

  if [[ ! -s "${union_files_file}" ]]; then
    _git_snapshot_compare_write_counts_file "${counts_out}" "${files_total}" "${resolved_committed}" "${resolved_uncommitted}" "${unresolved_missing}" "${unresolved_diverged}"
    : > "${rows_out}"
  elif [[ "${current_signature_hash}" == "repo_missing" ]]; then
    while IFS= read -r missing_file; do
      [[ -z "${missing_file}" ]] && continue
      files_total=$((files_total + 1))
      unresolved_missing=$((unresolved_missing + 1))
      printf "%s\tunresolved_missing\trepo missing at %s\t%s\n" "${missing_file}" "${rel_path}" "$([[ -s "${snapshot_scope_file}" ]] && printf "snapshot_only" || printf "current_only")" >> "${classified_rows_file}"
    done < "${union_files_file}"
    _git_snapshot_compare_write_counts_file "${counts_out}" "${files_total}" "${resolved_committed}" "${resolved_uncommitted}" "${unresolved_missing}" "${unresolved_diverged}"
    _git_snapshot_compare_append_blank_line_stats "${classified_rows_file}" "${rows_out}"
  else
    if ! _git_snapshot_compare_classify_union_batch \
      "${union_files_file}" \
      "${snapshot_scope_file}" \
      "${current_scope_file}" \
      "${baseline_sig_file}" \
      "${current_sig_file}" \
      "${head_sig_file}" \
      "${classified_rows_file}" \
      "${counts_out}"; then
      _git_snapshot_compare_write_worker_error_meta \
        "${meta_out}" \
        "compare_batch_classification_failed" \
        "batch_classification" \
        "Failed to classify compare rows." \
        "${rel_path}"
      cleanup_compare_worker_v3
      return 1
    fi
    if [[ -s "${classified_rows_file}" ]]; then
      if ! awk -F $'\t' '$2 ~ /^unresolved_/ { found = 1; exit 0 } END { exit found ? 0 : 1 }' "${classified_rows_file}"; then
        _git_snapshot_compare_append_zero_line_stats "${classified_rows_file}" "${rows_out}"
      else
      local stats_snapshot_materialized_repo=""
      local stats_current_materialized_repo=""
      local line_stats_ready="false"
      if _git_snapshot_compare_materialize_snapshot_repo "${repo_abs}" "${snapshot_head}" "${repo_bundle_dir}" "${rel_path}"; then
        stats_snapshot_materialized_repo="${GSN_COMPARE_MATERIALIZED_REPO}"
        if _git_snapshot_compare_materialize_current_repo "${repo_abs}" "${rel_path}"; then
          stats_current_materialized_repo="${GSN_COMPARE_MATERIALIZED_CURRENT_REPO}"
          if _git_snapshot_compare_augment_rows_with_line_stats \
            "${stats_snapshot_materialized_repo}" \
            "${stats_current_materialized_repo}" \
            "${classified_rows_file}" \
            "${rows_out}"; then
            line_stats_ready="true"
          fi
        fi
      fi
      rm -rf "${stats_snapshot_materialized_repo}" "${stats_current_materialized_repo}"
      if [[ "${line_stats_ready}" != "true" ]]; then
        _git_snapshot_compare_append_blank_line_stats "${classified_rows_file}" "${rows_out}"
        cleanup_compare_worker_v3
        _git_snapshot_compare_write_worker_success_meta \
          "${meta_out}" \
          "0" \
          "v3" \
          "${files_total}" \
          "${resolved_committed}" \
          "${resolved_uncommitted}" \
          "${unresolved_missing}" \
          "${unresolved_diverged}"
        return 0
      fi
      fi
    else
      : > "${rows_out}"
    fi
  fi

  _git_snapshot_compare_read_counts_file "${counts_out}"
  files_total="${GSN_COMPARE_COUNT_FILES_TOTAL}"
  resolved_committed="${GSN_COMPARE_COUNT_RESOLVED_COMMITTED}"
  resolved_uncommitted="${GSN_COMPARE_COUNT_RESOLVED_UNCOMMITTED}"
  unresolved_missing="${GSN_COMPARE_COUNT_UNRESOLVED_MISSING}"
  unresolved_diverged="${GSN_COMPARE_COUNT_UNRESOLVED_DIVERGED}"

  if [[ "${cache_enabled}" == "true" ]]; then
    cache_family_dir="${cache_root}/${snapshot_id}/${repo_id}"
    cache_entry_dir="${cache_family_dir}/${cache_key_hash}"
    mkdir -p "${cache_family_dir}" 2>/dev/null || true
    cache_tmp_dir="${cache_entry_dir}.tmp.$$"
    rm -rf "${cache_tmp_dir}"
    if mkdir -p "${cache_tmp_dir}" 2>/dev/null; then
      cp "${rows_out}" "${cache_tmp_dir}/rows.tsv" 2>/dev/null || true
      cp "${counts_out}" "${cache_tmp_dir}/counts.env" 2>/dev/null || true
      rm -rf "${cache_entry_dir}"
      if mv "${cache_tmp_dir}" "${cache_entry_dir}" 2>/dev/null; then
        cache_tmp_dir=""
      fi
      _git_snapshot_compare_prune_cache_family "${cache_family_dir}" "${cache_max_entries}"
    fi
  fi

  _git_snapshot_compare_write_worker_success_meta \
    "${meta_out}" \
    "0" \
    "v3" \
    "${files_total}" \
    "${resolved_committed}" \
    "${resolved_uncommitted}" \
    "${unresolved_missing}" \
    "${unresolved_diverged}"
  cleanup_compare_worker_v3
  return 0
}
_git_snapshot_compare_process_repo_worker() {
  local root_repo="$1"
  local snapshot_path="$2"
  local snapshot_id="$3"
  local cache_root="$4"
  local cache_enabled="$5"
  local cache_max_entries="$6"
  local idx="$7"
  local repo_id="$8"
  local rel_path="$9"
  local _snapshot_head="${10}"
  local _snapshot_status_hash="${11}"
  local repo_scope_kind="${12:-snapshot}"
  local results_dir="${13}"

  local rows_out="${results_dir}/${idx}.rows.tsv"
  local counts_out="${results_dir}/${idx}.counts.env"
  local meta_out="${results_dir}/${idx}.meta.env"
  local repo_bundle_dir=""
  local repo_abs=""

  : > "${rows_out}"

  repo_bundle_dir="$(_git_snapshot_store_repo_dir_for_id "${snapshot_path}" "${repo_id}")"
  repo_abs="${root_repo}/${rel_path}"

  if [[ "${repo_scope_kind}" != "current_only" ]] && ! _git_snapshot_compare_has_target_metadata "${repo_bundle_dir}"; then
    _git_snapshot_compare_write_worker_error_meta \
      "${meta_out}" \
      "compare_target_metadata_missing" \
      "target_metadata_validate" \
      "Snapshot compare target metadata is missing." \
      "${rel_path}"
    return 1
  fi

  _git_snapshot_compare_process_repo_worker_v3 \
    "${root_repo}" \
    "${snapshot_path}" \
    "${snapshot_id}" \
    "${cache_root}" \
    "${cache_enabled}" \
    "${cache_max_entries}" \
    "${repo_id}" \
    "${rel_path}" \
    "${rows_out}" \
    "${counts_out}" \
    "${meta_out}" \
    "${repo_bundle_dir}" \
    "${repo_abs}" \
    "${_snapshot_head}" \
    "${repo_scope_kind}"
}
_git_snapshot_compare_engine() {
  local root_repo="$1"
  local snapshot_id="$2"
  local repo_filter="$3"
  local porcelain="$4"
  local selection_mode="$5"
  local snapshot_meta_root="$6"
  local snapshot_meta_origin="$7"
  local include_no_effect="$8"
  local show_diff="${9:-false}"
  local compare_base="${10:-snapshot}"

  local snapshot_path start_ms end_ms elapsed_ms
  snapshot_path="$(_git_snapshot_store_snapshot_path "${root_repo}" "${snapshot_id}")"
  start_ms="$(_git_snapshot_compare_now_ms)"

  if [[ -n "${repo_filter}" ]]; then
    if ! _git_snapshot_validate_repo_filter "${snapshot_path}" "${repo_filter}"; then
      _git_snapshot_validate_live_repo_filter "${root_repo}" "${repo_filter}" || return 1
    fi
  fi

  local rows_file tasks_file results_dir
  rows_file="$(mktemp)"
  tasks_file="$(mktemp)"
  results_dir="$(mktemp -d)"
  : > "${rows_file}"

  local diff_store_dir=""
  if [[ "${show_diff}" == "true" && "${porcelain}" != "true" ]]; then
    diff_store_dir="$(mktemp -d)"
  fi

  local cache_root cache_enabled cache_max_entries jobs
  cache_root="$(_git_snapshot_compare_cache_root_for_repo "${root_repo}")"
  cache_enabled="false"
  if _git_snapshot_compare_cache_enabled; then
    cache_enabled="true"
  fi
  cache_max_entries="$(_git_snapshot_compare_cache_max_entries)"
  jobs="$(_git_snapshot_compare_resolve_jobs "${root_repo}")"

  GSN_COMPARE_ACTIVE_REPO=""
  GSN_COMPARE_ERROR_ID=""
  GSN_COMPARE_ERROR_STAGE=""
  GSN_COMPARE_ERROR_MESSAGE=""
  GSN_COMPARE_ERROR_REPO=""

  local repos_checked=0
  local files_total=0
  local effect_files=0
  local no_effect_files=0
  local shown_files=0
  local resolved_committed=0
  local resolved_uncommitted=0
  local unresolved_missing=0
  local unresolved_diverged=0
  local cache_hit_repos=0
  local cache_miss_repos=0
  local summary_engine="v3"
  local shown_lines_added=0
  local shown_lines_removed=0
  local scope_lines_added=0
  local scope_lines_removed=0
  local hidden_no_effect_files=0
  local -a compare_repo_order=()
  local -A compare_repo_seen=()
  local -A compare_repo_files_total=()
  local -A compare_repo_shown_files=()
  local -A compare_repo_effect_files=()
  local -A compare_repo_hidden_no_effect=()
  local -A compare_repo_resolved_committed=()
  local -A compare_repo_resolved_uncommitted=()
  local -A compare_repo_unresolved_missing=()
  local -A compare_repo_unresolved_diverged=()
  local -A compare_repo_shown_lines_added=()
  local -A compare_repo_shown_lines_removed=()

  if [[ "${porcelain}" == "true" ]]; then
    local safe_snapshot_root safe_current_root safe_selection_mode safe_snapshot_origin
    safe_snapshot_root="$(_git_snapshot_compare_sanitize_porcelain_value "${snapshot_meta_root}")"
    safe_current_root="$(_git_snapshot_compare_sanitize_porcelain_value "${root_repo}")"
    safe_selection_mode="$(_git_snapshot_compare_sanitize_porcelain_value "${selection_mode}")"
    safe_snapshot_origin="$(_git_snapshot_compare_sanitize_porcelain_value "${snapshot_meta_origin}")"
    printf "compare_target\tselected_snapshot_id=%s\tselection_mode=%s\tsnapshot_origin=%s\tsnapshot_root=%s\tcurrent_root=%s\tinclude_no_effect=%s\tshow_diff=%s\tcompare_base=%s\tcontract_version=8\n" \
      "${snapshot_id}" "${safe_selection_mode}" "${safe_snapshot_origin}" "${safe_snapshot_root}" "${safe_current_root}" "${include_no_effect}" "${show_diff}" "${compare_base}"
  fi

  local snapshot_repo_paths_file current_repo_paths_file
  snapshot_repo_paths_file="$(mktemp)"
  current_repo_paths_file="$(mktemp)"
  : > "${snapshot_repo_paths_file}"
  : > "${current_repo_paths_file}"

  local repo_id rel_path snapshot_head status_hash task_idx=0
  while IFS=$'\t' read -r repo_id rel_path snapshot_head status_hash; do
    [[ -z "${repo_id}" ]] && continue
    if [[ -z "${status_hash}" ]]; then
      status_hash="${snapshot_head}"
      snapshot_head="none"
    fi
    if [[ -n "${repo_filter}" && "${rel_path}" != "${repo_filter}" ]]; then
      continue
    fi

    task_idx=$((task_idx + 1))
    repos_checked=$((repos_checked + 1))
    printf "%s\n" "${rel_path}" >> "${snapshot_repo_paths_file}"
    printf "%s\t%s\t%s\t%s\t%s\tsnapshot\n" "${task_idx}" "${repo_id}" "${rel_path}" "${snapshot_head}" "${status_hash}" >> "${tasks_file}"
  done < <(_git_snapshot_store_read_repo_entries "${snapshot_path}")

  while IFS= read -r rel_path; do
    [[ -z "${rel_path}" ]] && continue
    printf "%s\n" "${rel_path}" >> "${current_repo_paths_file}"
    if grep -Fxq -- "${rel_path}" "${snapshot_repo_paths_file}"; then
      continue
    fi
    if [[ -n "${repo_filter}" && "${rel_path}" != "${repo_filter}" ]]; then
      continue
    fi
    if [[ -z "$(git -C "${root_repo}/${rel_path}" status --porcelain=v1 --untracked-files=all 2>/dev/null || true)" ]]; then
      continue
    fi

    task_idx=$((task_idx + 1))
    repos_checked=$((repos_checked + 1))
    snapshot_head="$(git -C "${root_repo}/${rel_path}" rev-parse --verify -q HEAD 2>/dev/null || true)"
    if [[ -z "${snapshot_head}" ]]; then
      snapshot_head="none"
    fi
    printf "%s\t%s\t%s\t%s\t%s\tcurrent_only\n" "${task_idx}" "current-only-${task_idx}" "${rel_path}" "${snapshot_head}" "current_only" >> "${tasks_file}"
  done < <(_git_snapshot_repo_collect_all_relative_paths "${root_repo}")

  if [[ "${repos_checked}" -gt 0 ]]; then
    if [[ "${jobs}" -gt "${repos_checked}" ]]; then
      jobs="${repos_checked}"
    fi

    if ! _git_snapshot_open_worker_queue; then
      _git_snapshot_ui_err "Failed to initialize compare worker queue."
      rm -rf "${diff_store_dir}" "${results_dir}"
      rm -f "${rows_file}" "${tasks_file}"
      return 1
    fi

    local j token worker_idx worker_repo_id worker_rel_path worker_snapshot_head worker_snapshot_status_hash worker_repo_scope_kind
    for (( j=0; j<jobs; j++ )); do
      printf "." >&9
    done

    while IFS=$'\t' read -r worker_idx worker_repo_id worker_rel_path worker_snapshot_head worker_snapshot_status_hash worker_repo_scope_kind; do
      [[ -z "${worker_idx}" ]] && continue
      IFS= read -r -u 9 -n 1 token
      (
        trap 'printf "." >&9' EXIT
        _git_snapshot_compare_process_repo_worker \
          "${root_repo}" \
          "${snapshot_path}" \
          "${snapshot_id}" \
          "${cache_root}" \
          "${cache_enabled}" \
          "${cache_max_entries}" \
          "${worker_idx}" \
          "${worker_repo_id}" \
          "${worker_rel_path}" \
          "${worker_snapshot_head}" \
          "${worker_snapshot_status_hash}" \
          "${worker_repo_scope_kind}" \
          "${results_dir}"
      ) > "${results_dir}/${worker_idx}.log" 2>&1 &
    done < "${tasks_file}"

    wait || true
    exec 9>&-
  fi

  local merge_idx merge_repo_id merge_rel_path merge_snapshot_head merge_snapshot_status_hash merge_repo_scope_kind
  local worker_meta_file worker_rows_file
  local scope_both=0
  local scope_snapshot_only=0
  local scope_current_only=0
  while IFS=$'\t' read -r merge_idx merge_repo_id merge_rel_path merge_snapshot_head merge_snapshot_status_hash merge_repo_scope_kind; do
    [[ -z "${merge_idx}" ]] && continue

    GSN_COMPARE_ACTIVE_REPO="${merge_rel_path}"
    worker_meta_file="${results_dir}/${merge_idx}.meta.env"
    worker_rows_file="${results_dir}/${merge_idx}.rows.tsv"

    if ! _git_snapshot_compare_read_worker_meta "${worker_meta_file}"; then
      GSN_COMPARE_ERROR_ID="compare_worker_meta_missing"
      GSN_COMPARE_ERROR_STAGE="worker_meta"
      GSN_COMPARE_ERROR_MESSAGE="Compare worker did not emit metadata."
      GSN_COMPARE_ERROR_REPO="${merge_rel_path}"
      _git_snapshot_ui_err "Compare worker did not emit metadata."
      if [[ "${porcelain}" == "true" ]]; then
        _git_snapshot_compare_emit_porcelain_error "${snapshot_id}" "${merge_rel_path}"
      fi
      rm -rf "${diff_store_dir}" "${results_dir}"
      rm -f "${rows_file}" "${tasks_file}"
      return 1
    fi

    if [[ "${GSN_COMPARE_WORKER_STATUS}" != "ok" ]]; then
      GSN_COMPARE_ERROR_ID="${GSN_COMPARE_WORKER_ERROR_ID:-compare_worker_failed}"
      GSN_COMPARE_ERROR_STAGE="${GSN_COMPARE_WORKER_ERROR_STAGE:-worker_runtime}"
      GSN_COMPARE_ERROR_MESSAGE="${GSN_COMPARE_WORKER_ERROR_MESSAGE:-Compare worker failed.}"
      GSN_COMPARE_ERROR_REPO="${GSN_COMPARE_WORKER_ERROR_REPO:-${merge_rel_path}}"
      _git_snapshot_ui_err "${GSN_COMPARE_ERROR_MESSAGE}"
      if [[ "${porcelain}" == "true" ]]; then
        _git_snapshot_compare_emit_porcelain_error "${snapshot_id}" "${merge_rel_path}"
      fi
      rm -rf "${diff_store_dir}" "${results_dir}"
      rm -f "${rows_file}" "${tasks_file}"
      return 1
    fi

    if [[ ! -f "${worker_rows_file}" ]]; then
      GSN_COMPARE_ERROR_ID="compare_worker_rows_missing"
      GSN_COMPARE_ERROR_STAGE="worker_rows"
      GSN_COMPARE_ERROR_MESSAGE="Compare worker did not emit rows output."
      GSN_COMPARE_ERROR_REPO="${merge_rel_path}"
      _git_snapshot_ui_err "Compare worker did not emit rows output."
      if [[ "${porcelain}" == "true" ]]; then
        _git_snapshot_compare_emit_porcelain_error "${snapshot_id}" "${merge_rel_path}"
      fi
      rm -rf "${diff_store_dir}" "${results_dir}"
      rm -f "${rows_file}" "${tasks_file}"
      return 1
    fi

    files_total=$((files_total + GSN_COMPARE_WORKER_FILES_TOTAL))
    resolved_committed=$((resolved_committed + GSN_COMPARE_WORKER_RESOLVED_COMMITTED))
    resolved_uncommitted=$((resolved_uncommitted + GSN_COMPARE_WORKER_RESOLVED_UNCOMMITTED))
    unresolved_missing=$((unresolved_missing + GSN_COMPARE_WORKER_UNRESOLVED_MISSING))
    unresolved_diverged=$((unresolved_diverged + GSN_COMPARE_WORKER_UNRESOLVED_DIVERGED))
    if [[ "${GSN_COMPARE_WORKER_CACHE_HIT}" -eq 1 ]]; then
      cache_hit_repos=$((cache_hit_repos + 1))
    else
      cache_miss_repos=$((cache_miss_repos + 1))
    fi
    if [[ "${GSN_COMPARE_WORKER_ENGINE}" != "v3" ]]; then
      GSN_COMPARE_ERROR_ID="compare_worker_engine_invalid"
      GSN_COMPARE_ERROR_STAGE="worker_meta"
      GSN_COMPARE_ERROR_MESSAGE="Compare worker emitted unsupported engine metadata."
      GSN_COMPARE_ERROR_REPO="${merge_rel_path}"
      _git_snapshot_ui_err "Compare worker emitted unsupported engine metadata."
      if [[ "${porcelain}" == "true" ]]; then
        _git_snapshot_compare_emit_porcelain_error "${snapshot_id}" "${merge_rel_path}"
      fi
      rm -rf "${diff_store_dir}" "${results_dir}"
      rm -f "${rows_file}" "${tasks_file}"
      return 1
    fi

    if [[ "${GSN_COMPARE_WORKER_FILES_TOTAL}" -gt 0 && -z "${compare_repo_seen[${merge_rel_path}]+x}" ]]; then
      compare_repo_seen["${merge_rel_path}"]=1
      compare_repo_order+=("${merge_rel_path}")
    fi

    local diff_snapshot_materialized_repo=""
    local diff_current_materialized_repo=""
    local row_file_b64 row_file row_status row_reason row_scope row_baseline_mode row_current_mode row_head_mode row_canonical_lines_added row_canonical_lines_removed row_lines_added row_lines_removed row_restore_effect row_display_kind row_display_label
    while IFS=$'\t' read -r row_file_b64 row_status row_reason row_scope row_baseline_mode row_current_mode row_head_mode row_canonical_lines_added row_canonical_lines_removed; do
      [[ -z "${row_file_b64}" ]] && continue
      if ! row_file="$(_git_snapshot_compare_decode_path "${row_file_b64}")"; then
        GSN_COMPARE_ERROR_ID="compare_path_decode_failed"
        GSN_COMPARE_ERROR_STAGE="row_decode"
        GSN_COMPARE_ERROR_MESSAGE="Failed to decode compare row path."
        GSN_COMPARE_ERROR_REPO="${merge_rel_path}"
        _git_snapshot_ui_err "Failed to decode compare row path."
        if [[ "${porcelain}" == "true" ]]; then
          _git_snapshot_compare_emit_porcelain_error "${snapshot_id}" "${merge_rel_path}"
        fi
        rm -rf "${diff_store_dir}" "${results_dir}" "${diff_snapshot_materialized_repo}" "${diff_current_materialized_repo}"
        rm -f "${rows_file}" "${tasks_file}"
        return 1
      fi

      case "${row_scope}" in
        both) scope_both=$((scope_both + 1)) ;;
        snapshot_only) scope_snapshot_only=$((scope_snapshot_only + 1)) ;;
        current_only) scope_current_only=$((scope_current_only + 1)) ;;
      esac

      compare_repo_files_total["${merge_rel_path}"]=$(( ${compare_repo_files_total[${merge_rel_path}]:-0} + 1 ))
      case "${row_status}" in
        resolved_committed)
          compare_repo_resolved_committed["${merge_rel_path}"]=$(( ${compare_repo_resolved_committed[${merge_rel_path}]:-0} + 1 ))
          ;;
        resolved_uncommitted)
          compare_repo_resolved_uncommitted["${merge_rel_path}"]=$(( ${compare_repo_resolved_uncommitted[${merge_rel_path}]:-0} + 1 ))
          ;;
        unresolved_missing)
          compare_repo_unresolved_missing["${merge_rel_path}"]=$(( ${compare_repo_unresolved_missing[${merge_rel_path}]:-0} + 1 ))
          ;;
        unresolved_diverged)
          compare_repo_unresolved_diverged["${merge_rel_path}"]=$(( ${compare_repo_unresolved_diverged[${merge_rel_path}]:-0} + 1 ))
          ;;
      esac

      row_restore_effect="$(_git_snapshot_compare_restore_effect_for_status "${row_status}")"
      if [[ "${row_restore_effect}" == "changes" ]]; then
        effect_files=$((effect_files + 1))
        compare_repo_effect_files["${merge_rel_path}"]=$(( ${compare_repo_effect_files[${merge_rel_path}]:-0} + 1 ))
      else
        no_effect_files=$((no_effect_files + 1))
      fi

      row_lines_added="${row_canonical_lines_added}"
      row_lines_removed="${row_canonical_lines_removed}"
      if [[ "${row_canonical_lines_added}" =~ ^[0-9]+$ && "${row_canonical_lines_removed}" =~ ^[0-9]+$ ]]; then
        if [[ "${compare_base}" == "snapshot" ]]; then
          row_lines_added="${row_canonical_lines_removed}"
          row_lines_removed="${row_canonical_lines_added}"
        fi
        scope_lines_added=$((scope_lines_added + row_lines_added))
        scope_lines_removed=$((scope_lines_removed + row_lines_removed))
      fi

      if [[ "${include_no_effect}" != "true" && "${row_restore_effect}" != "changes" ]]; then
        hidden_no_effect_files=$((hidden_no_effect_files + 1))
        compare_repo_hidden_no_effect["${merge_rel_path}"]=$(( ${compare_repo_hidden_no_effect[${merge_rel_path}]:-0} + 1 ))
        continue
      fi

      local diff_payload_file=""
      if [[ "${show_diff}" == "true" && "${porcelain}" != "true" && "${row_status}" == "unresolved_diverged" ]]; then
        if [[ -z "${diff_snapshot_materialized_repo}" || -z "${diff_current_materialized_repo}" ]]; then
          local merge_repo_abs merge_repo_bundle_dir
          merge_repo_abs="${root_repo}/${merge_rel_path}"
          merge_repo_bundle_dir="$(_git_snapshot_store_repo_dir_for_id "${snapshot_path}" "${merge_repo_id}")"

          _git_snapshot_compare_materialize_snapshot_repo "${merge_repo_abs}" "${merge_snapshot_head}" "${merge_repo_bundle_dir}" "${merge_rel_path}" || {
            if [[ "${porcelain}" == "true" ]]; then
              _git_snapshot_compare_emit_porcelain_error "${snapshot_id}" "${merge_rel_path}"
            fi
            rm -rf "${diff_store_dir}" "${results_dir}" "${diff_snapshot_materialized_repo}" "${diff_current_materialized_repo}"
            rm -f "${rows_file}" "${tasks_file}"
            return 1
          }
          diff_snapshot_materialized_repo="${GSN_COMPARE_MATERIALIZED_REPO}"

          _git_snapshot_compare_materialize_current_repo "${merge_repo_abs}" "${merge_rel_path}" || {
            if [[ "${porcelain}" == "true" ]]; then
              _git_snapshot_compare_emit_porcelain_error "${snapshot_id}" "${merge_rel_path}"
            fi
            rm -rf "${diff_store_dir}" "${results_dir}" "${diff_snapshot_materialized_repo}" "${diff_current_materialized_repo}"
            rm -f "${rows_file}" "${tasks_file}"
            return 1
          }
          diff_current_materialized_repo="${GSN_COMPARE_MATERIALIZED_CURRENT_REPO}"
        fi

        diff_payload_file="$(mktemp "${diff_store_dir}/diff.XXXXXX")"
        _git_snapshot_compare_render_file_diff "${diff_snapshot_materialized_repo}" "${diff_current_materialized_repo}" "${row_file}" "${diff_payload_file}" "${compare_base}"
        if [[ ! -s "${diff_payload_file}" ]]; then
          rm -f "${diff_payload_file}"
          diff_payload_file=""
        fi
      fi

      if [[ "${row_lines_added}" =~ ^[0-9]+$ && "${row_lines_removed}" =~ ^[0-9]+$ ]]; then
        shown_lines_added=$((shown_lines_added + row_lines_added))
        shown_lines_removed=$((shown_lines_removed + row_lines_removed))
        compare_repo_shown_lines_added["${merge_rel_path}"]=$(( ${compare_repo_shown_lines_added[${merge_rel_path}]:-0} + row_lines_added ))
        compare_repo_shown_lines_removed["${merge_rel_path}"]=$(( ${compare_repo_shown_lines_removed[${merge_rel_path}]:-0} + row_lines_removed ))
      fi

      compare_repo_shown_files["${merge_rel_path}"]=$(( ${compare_repo_shown_files[${merge_rel_path}]:-0} + 1 ))
      _git_snapshot_compare_set_display_fields \
        "${row_status}" \
        "${row_restore_effect}" \
        "${row_lines_added}" \
        "${row_lines_removed}" \
        "${row_baseline_mode}" \
        "${row_current_mode}" \
        "${row_head_mode}"
      row_display_kind="${GSN_COMPARE_DISPLAY_KIND}"
      row_display_label="${GSN_COMPARE_DISPLAY_LABEL}"

      printf "%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n" \
        "${merge_rel_path}" \
        "${row_file_b64}" \
        "${row_status}" \
        "${row_reason}" \
        "${row_scope}" \
        "${row_baseline_mode}" \
        "${row_current_mode}" \
        "${row_head_mode}" \
        "$(_git_snapshot_compare_internal_optional_encode "${row_lines_added}")" \
        "$(_git_snapshot_compare_internal_optional_encode "${row_lines_removed}")" \
        "${row_restore_effect}" \
        "${row_display_kind}" \
        "$(_git_snapshot_compare_internal_display_label_encode "${row_display_label}")" \
        "${diff_payload_file}" >> "${rows_file}"
      shown_files=$((shown_files + 1))
    done < "${worker_rows_file}"

    rm -rf "${diff_snapshot_materialized_repo}" "${diff_current_materialized_repo}"
  done < "${tasks_file}"

  local unresolved_total
  unresolved_total=$((unresolved_missing + unresolved_diverged))

  end_ms="$(_git_snapshot_compare_now_ms)"
  elapsed_ms=$((end_ms - start_ms))
  if [[ "${elapsed_ms}" -lt 0 ]]; then
    elapsed_ms=0
  fi

  if [[ "${porcelain}" == "true" ]]; then
    local repo_rel safe_repo
    for repo_rel in "${compare_repo_order[@]}"; do
      safe_repo="$(_git_snapshot_compare_sanitize_porcelain_value "${repo_rel}")"
      printf "compare_repo\tsnapshot_id=%s\trepo=%s\tfiles_total=%s\tshown_files=%s\teffect_files=%s\thidden_no_effect_files=%s\tresolved_committed=%s\tresolved_uncommitted=%s\tunresolved_missing=%s\tunresolved_diverged=%s\tunresolved_total=%s\tshown_lines_added=%s\tshown_lines_removed=%s\n" \
        "${snapshot_id}" \
        "${safe_repo}" \
        "${compare_repo_files_total[${repo_rel}]:-0}" \
        "${compare_repo_shown_files[${repo_rel}]:-0}" \
        "${compare_repo_effect_files[${repo_rel}]:-0}" \
        "${compare_repo_hidden_no_effect[${repo_rel}]:-0}" \
        "${compare_repo_resolved_committed[${repo_rel}]:-0}" \
        "${compare_repo_resolved_uncommitted[${repo_rel}]:-0}" \
        "${compare_repo_unresolved_missing[${repo_rel}]:-0}" \
        "${compare_repo_unresolved_diverged[${repo_rel}]:-0}" \
        "$(( ${compare_repo_unresolved_missing[${repo_rel}]:-0} + ${compare_repo_unresolved_diverged[${repo_rel}]:-0} ))" \
        "${compare_repo_shown_lines_added[${repo_rel}]:-0}" \
        "${compare_repo_shown_lines_removed[${repo_rel}]:-0}"
    done

    local row_repo row_file_b64 row_file row_status row_reason row_scope _row_baseline_mode _row_current_mode _row_head_mode row_lines_added row_lines_removed row_restore_effect row_display_kind row_display_label row_diff_file safe_reason safe_file safe_scope safe_lines_added safe_lines_removed safe_restore_effect safe_display_kind safe_display_label
    while IFS=$'\t' read -r row_repo row_file_b64 row_status row_reason row_scope _row_baseline_mode _row_current_mode _row_head_mode row_lines_added row_lines_removed row_restore_effect row_display_kind row_display_label row_diff_file; do
      [[ -z "${row_repo}" ]] && continue
      row_lines_added="$(_git_snapshot_compare_internal_optional_decode "${row_lines_added}")"
      row_lines_removed="$(_git_snapshot_compare_internal_optional_decode "${row_lines_removed}")"
      row_display_label="$(_git_snapshot_compare_internal_display_label_decode "${row_display_label}")"
      if ! row_file="$(_git_snapshot_compare_decode_path "${row_file_b64}")"; then
        GSN_COMPARE_ERROR_ID="compare_path_decode_failed"
        GSN_COMPARE_ERROR_STAGE="porcelain_row_decode"
        GSN_COMPARE_ERROR_MESSAGE="Failed to decode compare output path."
        GSN_COMPARE_ERROR_REPO="${row_repo}"
        _git_snapshot_ui_err "Failed to decode compare output path."
        _git_snapshot_compare_emit_porcelain_error "${snapshot_id}" "${row_repo}"
        rm -rf "${diff_store_dir}" "${results_dir}"
        rm -f "${rows_file}" "${tasks_file}"
        return 1
      fi
      safe_repo="$(_git_snapshot_compare_sanitize_porcelain_value "${row_repo}")"
      safe_file="$(_git_snapshot_compare_sanitize_porcelain_value "${row_file}")"
      safe_reason="$(_git_snapshot_compare_sanitize_porcelain_value "${row_reason}")"
      safe_scope="$(_git_snapshot_compare_sanitize_porcelain_value "${row_scope}")"
      safe_lines_added="$(_git_snapshot_compare_sanitize_porcelain_value "${row_lines_added}")"
      safe_lines_removed="$(_git_snapshot_compare_sanitize_porcelain_value "${row_lines_removed}")"
      safe_restore_effect="$(_git_snapshot_compare_sanitize_porcelain_value "${row_restore_effect}")"
      safe_display_kind="$(_git_snapshot_compare_sanitize_porcelain_value "${row_display_kind}")"
      safe_display_label="$(_git_snapshot_compare_sanitize_porcelain_value "${row_display_label}")"
      printf "compare_file\tsnapshot_id=%s\trepo=%s\tfile=%s\tstatus=%s\treason=%s\tpath_scope=%s\trestore_effect=%s\tlines_added=%s\tlines_removed=%s\tdisplay_kind=%s\tdisplay_label=%s\n" \
        "${snapshot_id}" "${safe_repo}" "${safe_file}" "${row_status}" "${safe_reason}" "${safe_scope}" "${safe_restore_effect}" "${safe_lines_added}" "${safe_lines_removed}" "${safe_display_kind}" "${safe_display_label}"
    done < "${rows_file}"

    printf "compare_summary\tsnapshot_id=%s\trepos_checked=%s\tfiles_total=%s\tresolved_committed=%s\tresolved_uncommitted=%s\tunresolved_missing=%s\tunresolved_diverged=%s\tunresolved_total=%s\tshown_files=%s\tscope_both=%s\tscope_snapshot_only=%s\tscope_current_only=%s\tengine=%s\telapsed_ms=%s\tcache_hit_repos=%s\tcache_miss_repos=%s\teffect_files=%s\tno_effect_files=%s\thidden_no_effect_files=%s\tinclude_no_effect=%s\tcompare_base=%s\tcontract_version=8\tshown_lines_added=%s\tshown_lines_removed=%s\tscope_lines_added=%s\tscope_lines_removed=%s\n" \
      "${snapshot_id}" "${repos_checked}" "${files_total}" "${resolved_committed}" "${resolved_uncommitted}" "${unresolved_missing}" "${unresolved_diverged}" "${unresolved_total}" "${shown_files}" "${scope_both}" "${scope_snapshot_only}" "${scope_current_only}" "${summary_engine}" "${elapsed_ms}" "${cache_hit_repos}" "${cache_miss_repos}" "${effect_files}" "${no_effect_files}" "${hidden_no_effect_files}" "${include_no_effect}" "${compare_base}" "${shown_lines_added}" "${shown_lines_removed}" "${scope_lines_added}" "${scope_lines_removed}"

    rm -rf "${diff_store_dir}" "${results_dir}"
    rm -f "${rows_file}" "${tasks_file}"
    return 0
  fi

  printf "Snapshot compare: %s\n" "${snapshot_id}"
  printf "Current root: %s\n" "${root_repo}"
  printf "Selected snapshot mode: %s\n" "${selection_mode}"
  printf "Snapshot origin: %s\n" "${snapshot_meta_origin}"
  printf "Snapshot root: %s\n" "${snapshot_meta_root}"
  printf "Compare base: %s\n" "${compare_base}"
  if [[ "${selection_mode}" == "latest-user-default" ]]; then
    printf "Shared-folder registry note: target selected from all user-created snapshots in this registry.\n"
  fi
  printf "Diff details: %s\n" "$( [[ "${show_diff}" == "true" ]] && printf "on (unresolved_diverged rows include unified diffs)" || printf "off (add --diff to include unified diffs for unresolved_diverged rows)" )"
  if [[ "${shown_files}" == "${effect_files}" ]]; then
    printf "Compare rows: effect=%s | lines=+%s/-%s | repos=%s\n" \
      "${effect_files}" \
      "${shown_lines_added}" \
      "${shown_lines_removed}" \
      "${repos_checked}"
  else
    printf "Compare rows: effect=%s | shown=%s | lines=+%s/-%s | repos=%s\n" \
      "${effect_files}" \
      "${shown_files}" \
      "${shown_lines_added}" \
      "${shown_lines_removed}" \
      "${repos_checked}"
  fi
  printf "Compare telemetry: elapsed_ms=%s | cache_hit_repos=%s | cache_miss_repos=%s\n" \
    "${elapsed_ms}" "${cache_hit_repos}" "${cache_miss_repos}"

  if [[ "${effect_files}" -eq 0 ]]; then
    printf "Compare: restore would not change any compared paths.\n"
  else
    printf "Compare: restore would change paths in the current workspace.\n"
  fi

  if [[ "${shown_files}" -eq 0 ]]; then
    if [[ "${include_no_effect}" != "true" && "${hidden_no_effect_files}" -gt 0 ]]; then
      printf "No restore-effect rows to display. Re-run with --include-no-effect to include no restore effect rows.\n"
    else
      printf "No rows to display for current visibility filter.\n"
    fi
    rm -rf "${diff_store_dir}" "${results_dir}"
    rm -f "${rows_file}" "${tasks_file}"
    return 0
  fi

  printf "\nDetails:\n"
  _git_snapshot_compare_print_grouped_rows "${root_repo}" "${rows_file}" "${show_diff}"

  rm -rf "${diff_store_dir}" "${results_dir}"
  rm -f "${rows_file}" "${tasks_file}"
  return 0
}

_git_snapshot_launch_inspect_gui() {
  local root_repo="$1"
  local snapshot_id="$2"
  local repo_filter="$3"
  local inspect_include_staged="$4"
  local inspect_include_unstaged="$5"
  local inspect_include_untracked="$6"
  local inspect_show_all_repos="$7"

  _git_snapshot_launch_gui \
    "inspect" \
    "${root_repo}" \
    "${snapshot_id}" \
    "${repo_filter}" \
    "false" \
    "snapshot" \
    "false" \
    "${inspect_include_staged}" \
    "${inspect_include_unstaged}" \
    "${inspect_include_untracked}" \
    "${inspect_show_all_repos}"
}

_git_snapshot_launch_compare_gui() {
  local root_repo="$1"
  local snapshot_id="$2"
  local repo_filter="$3"
  local compare_include_no_effect="$4"
  local compare_base="$5"
  local compare_base_explicit="$6"

  _git_snapshot_launch_gui \
    "compare" \
    "${root_repo}" \
    "${snapshot_id}" \
    "${repo_filter}" \
    "${compare_include_no_effect}" \
    "${compare_base}" \
    "${compare_base_explicit}" \
    "true" \
    "true" \
    "true" \
    "false"
}

# Keep command handlers on the mode-specific wrappers above so they do not
# coordinate the raw launcher argument order directly.
_git_snapshot_launch_gui() {
  local mode="$1"
  local root_repo="$2"
  local snapshot_id="$3"
  local repo_filter="$4"
  local compare_include_no_effect="$5"
  local compare_base="$6"
  local compare_base_explicit="$7"
  local inspect_include_staged="$8"
  local inspect_include_unstaged="$9"
  local inspect_include_untracked="${10}"
  local inspect_show_all_repos="${11}"
  local gui_output=""
  local gui_status=0
  local line=""
  local stream_output="${GIT_SNAPSHOT_GUI_STREAM_OUTPUT:-0}"
  local gui_log_file=""
  local node_wrapper_script=""

  local core_dir helpers_root gui_script snapshot_bin
  core_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
  helpers_root="$(cd "${core_dir}/../.." && pwd -P)"
  gui_script="${helpers_root}/tools/git-snapshot-compare-gui.js"
  snapshot_bin="${helpers_root}/bin/git-snapshot"

  if [[ ! -f "${gui_script}" ]]; then
    _git_snapshot_ui_err "GUI script not found: ${gui_script}"
    return 1
  fi

  if ! git_snapshot_node_runtime_use "_git_snapshot_ui_err"; then
    return 1
  fi

  if [[ "${stream_output}" == "1" || "${stream_output}" == "true" ]]; then
    gui_log_file="$(mktemp "${TMPDIR:-/tmp}/git-snapshot-gui.XXXXXX")" || {
      _git_snapshot_ui_err "Failed to allocate ${mode} --gui output log."
      return 1
    }

    node_wrapper_script='const { spawn } = require("child_process"); const { constants } = require("os"); const child = spawn(process.execPath, process.argv.slice(1), { stdio: "inherit" }); child.on("error", (error) => { console.error(error && error.message ? error.message : String(error)); process.exit(1); }); child.on("exit", (code, signal) => { if (signal) { process.exit(128 + (constants.signals[signal] || 0)); return; } process.exit(code || 0); });'

    set +e
    node -e "${node_wrapper_script}" "${gui_script}" \
      --mode "${mode}" \
      --root-repo "${root_repo}" \
      --snapshot-id "${snapshot_id}" \
      --repo-filter "${repo_filter}" \
      --compare-include-no-effect "${compare_include_no_effect}" \
      --compare-base "${compare_base}" \
      --compare-base-explicit "${compare_base_explicit}" \
      --inspect-include-staged "${inspect_include_staged}" \
      --inspect-include-unstaged "${inspect_include_unstaged}" \
      --inspect-include-untracked "${inspect_include_untracked}" \
      --inspect-show-all-repos "${inspect_show_all_repos}" \
      --git-snapshot-bin "${snapshot_bin}" 2>&1 | tee "${gui_log_file}"
    gui_status="${PIPESTATUS[0]}"
    set -e

    gui_output="$(cat "${gui_log_file}")"
    rm -f "${gui_log_file}"

    if [[ "${gui_status}" -eq 0 ]]; then
      return 0
    fi
  fi

  if [[ "${stream_output}" != "1" && "${stream_output}" != "true" ]]; then
    gui_output="$(node "${gui_script}" \
      --mode "${mode}" \
      --root-repo "${root_repo}" \
      --snapshot-id "${snapshot_id}" \
      --repo-filter "${repo_filter}" \
      --compare-include-no-effect "${compare_include_no_effect}" \
      --compare-base "${compare_base}" \
      --compare-base-explicit "${compare_base_explicit}" \
      --inspect-include-staged "${inspect_include_staged}" \
      --inspect-include-unstaged "${inspect_include_unstaged}" \
      --inspect-include-untracked "${inspect_include_untracked}" \
      --inspect-show-all-repos "${inspect_show_all_repos}" \
      --git-snapshot-bin "${snapshot_bin}" 2>&1)" || gui_status=$?
  fi

  if [[ "${gui_status}" -eq 0 ]]; then
    if [[ -n "${gui_output}" ]]; then
      printf "%s\n" "${gui_output}"
    fi
    return 0
  fi

  if [[ "${gui_status}" -ge 128 ]]; then
    _git_snapshot_ui_err "${mode} --gui crashed before opening the UI."
    _git_snapshot_ui_err "node diagnostics:"
    if [[ -n "${gui_output}" ]]; then
      while IFS= read -r line; do
        _git_snapshot_ui_err "  ${line}"
      done <<< "${gui_output}"
    else
      _git_snapshot_ui_err "  (no stderr/stdout output captured)"
    fi
    return 1
  fi

  if [[ -n "${gui_output}" ]]; then
    printf "%s\n" "${gui_output}" >&2
  fi
  return "${gui_status}"
}

_git_snapshot_cmd_compare() {
  local root_repo="$1"
  shift

  local snapshot_id=""
  local repo_filter=""
  local porcelain="false"
  local include_no_effect="false"
  local show_diff="false"
  local show_gui="false"
  local compare_base="snapshot"
  local compare_base_explicit="false"

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
      --include-no-effect|--all)
        include_no_effect="true"
        ;;
      --diff)
        show_diff="true"
        ;;
      --base)
        if [[ -z "${2:-}" ]]; then
          _git_snapshot_ui_err "Missing value for --base"
          return 1
        fi
        compare_base="$2"
        compare_base_explicit="true"
        shift
        ;;
      --gui)
        show_gui="true"
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

  if [[ -n "${repo_filter}" ]]; then
    local root_repo_basename
    root_repo_basename="$(basename "${root_repo}")"
    if [[ "${repo_filter}" == "${root_repo_basename}" ]]; then
      repo_filter="."
    fi
  fi

  compare_base="$(_git_snapshot_compare_normalize_base "${compare_base}")" || return 1

  if [[ "${show_gui}" == "true" && "${porcelain}" == "true" ]]; then
    _git_snapshot_ui_err "compare --gui is incompatible with --porcelain."
    return 1
  fi

  if [[ "${show_gui}" == "true" && "${show_diff}" == "true" ]]; then
    _git_snapshot_ui_warn "compare --gui ignores --diff (GUI renders per-file diffs internally)."
    show_diff="false"
  fi

  _git_snapshot_resolve_compare_target "${root_repo}" "${snapshot_id}" || return 1

  if [[ "${show_gui}" == "true" ]]; then
    _git_snapshot_launch_compare_gui \
      "${root_repo}" \
      "${GSN_COMPARE_SNAPSHOT_ID}" \
      "${repo_filter}" \
      "${include_no_effect}" \
      "${compare_base}" \
      "${compare_base_explicit}"
    return $?
  fi

  _git_snapshot_compare_engine \
    "${root_repo}" \
    "${GSN_COMPARE_SNAPSHOT_ID}" \
    "${repo_filter}" \
    "${porcelain}" \
    "${GSN_COMPARE_SELECTION_MODE}" \
    "${GSN_COMPARE_SNAPSHOT_ROOT}" \
    "${GSN_COMPARE_SNAPSHOT_ORIGIN}" \
    "${include_no_effect}" \
    "${show_diff}" \
    "${compare_base}"
}

_git_snapshot_cmd_gui() {
  local root_repo="$1"
  shift

  local snapshot_id=""

  while [[ $# -gt 0 ]]; do
    case "$1" in
      -*)
        _git_snapshot_ui_err "git-snapshot gui accepts only an optional snapshot_id."
        _git_snapshot_ui_err "Use git-snapshot compare --gui for --repo, --all, --diff, or --porcelain."
        return 1
        ;;
      *)
        if [[ -z "${snapshot_id}" ]]; then
          snapshot_id="$1"
        else
          _git_snapshot_ui_err "Unexpected argument for gui: $1"
          _git_snapshot_ui_err "git-snapshot gui accepts only an optional snapshot_id."
          _git_snapshot_ui_err "Use git-snapshot compare --gui for --repo, --all, --diff, or --porcelain."
          return 1
        fi
        ;;
    esac
    shift
  done

  if [[ -n "${snapshot_id}" ]]; then
    _git_snapshot_cmd_compare "${root_repo}" "${snapshot_id}" --gui
    return $?
  fi

  _git_snapshot_cmd_compare "${root_repo}" --gui
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
  local snapshot_path
  snapshot_path="$(_git_snapshot_store_snapshot_path "${root_repo}" "${snapshot_id}")"
  _git_snapshot_store_load_snapshot_meta "${snapshot_path}" || return 1

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
  _git_snapshot_compare_drop_cache_for_snapshot_id "${root_repo}" "${snapshot_id}"
  _git_snapshot_ui_info "Deleted snapshot ${snapshot_id}"
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
    gui)
      _git_snapshot_cmd_gui "${root_repo}" "$@"
      ;;
    compare)
      _git_snapshot_cmd_compare "${root_repo}" "$@"
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
