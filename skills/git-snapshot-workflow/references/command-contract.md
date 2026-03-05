# git-snapshot Command Contract

## Commands

- `git-snapshot create [snapshot_id] [--clear] [--yes]`
  - Creates a snapshot for root-most superproject + initialized recursive submodules.
  - Snapshot id is printed as the last output line.
  - Skill default is explicit id (`git-snapshot create <snapshot_id>`), derived from user intent/context.
  - Auto-id mode (`git-snapshot create`) is fallback-only unless user explicitly asks for it.
  - Auto-id format (when no id is provided): `YYYY-MM-DD--HH-MM-SS` with
    collision suffixes (`-02`, `-03`, ...).
  - `--clear` runs post-capture clean (`reset --hard` + `clean -fd`) across snapshotted repos.
  - `--yes` bypasses clear confirmation (only valid with `--clear`).
  - `--clear` is best-effort: reports failures per repo and exits non-zero if any clear failed.
  - Submodule checkout/update alignment is not performed during clear.

- `git-snapshot reset-all [--snapshot|--no-snapshot] [--porcelain]`
  - Clears root-most superproject + initialized recursive submodules in place:
    - `git reset --hard`
    - `git clean -fd`
  - Snapshot choice:
    - `--snapshot`: create pre-clear auto snapshot (`origin=auto`, `pre-reset-...` id prefix)
    - `--no-snapshot`: skip snapshot creation
    - neither flag: ask `Create auto snapshot before clear? [Y/n]:`
    - both flags: usage error
  - No second destructive confirmation after snapshot decision.
  - Non-interactive mode requires `--snapshot` or `--no-snapshot`.
  - Porcelain output:
    - `reset_all_snapshot\tcreated=<true|false>\tsnapshot_id=<id-or-empty>`
    - `reset_all_summary\tresult=<success|failed>\tsnapshot_created=<true|false>\tsnapshot_id=<id-or-empty>\trepos_total=<n>\trepos_cleared=<n>\trepos_failed=<n>\texit_code=<0|1>`
  - Exit codes:
    - `0`: clear completed for all repos
    - `1`: usage/runtime error, snapshot-create failure, or any repo clear failure

- `git-snapshot rename <old_snapshot_id> <new_snapshot_id> [--porcelain]`
  - Renames an existing snapshot id while preserving snapshot contents and creation time.
  - Fails when old id does not exist or new id already exists.
  - Porcelain output: `renamed\told_id=...\tnew_id=...`

- `git-snapshot list [--include-auto] [--porcelain]`
  - Default output hides auto-generated internal snapshots (for example restore safety snapshots).
  - Human output: multiline rows (id line + labeled details line with created/age/repos).
  - Human details include `Root: <path>` when visible snapshots are not all from current root path.
  - Default human list prints a hint with hidden auto-snapshot count when any are filtered.
  - `--include-auto` shows both user-created and auto-generated snapshots.
  - When `--include-auto` is used in human mode, auto snapshots include `Auto: *` in details.
  - Human list prints a registry note: snapshot registry is keyed by root repo folder name.
    Different repos sharing the same folder name share one registry namespace.
  - Human list order is newest-first by `created_at_epoch`, independent of root path.
  - Porcelain output: tab-delimited `snapshot` rows with key/value fields including `origin=<user|auto>`.

- `git-snapshot inspect <snapshot_id> [--repo <rel_path>] [--staged|--unstaged|--untracked|--all] [--all-repos] [--name-only|--stat|--diff] [--porcelain]`
  - Human default includes summary plus per-repo `--stat` detail.
  - Use `--name-only` for file-path focused output.
  - Use `--diff` for full tracked patch bodies.
  - Non-mutating.

- `git-snapshot restore-check <snapshot_id> [--repo <rel_path>] [--all-repos] [--details] [--files] [--limit <n>|--no-limit] [--porcelain]`
  - Checks restore compatibility against current tree.
  - Human default is summary-first (issues-focused).
  - `--details` prints per-repo detail sections; `--files` implies details.
  - Exit codes:
    - `0`: all compared repos compatible
    - `3`: compatibility issues found
    - `1`: usage/runtime error

- `git-snapshot compare [snapshot_id] [--repo <rel_path>] [--all] [--porcelain]`
  - Snapshot progress engine over snapshot-captured files only.
  - Optional `snapshot_id`:
    - when omitted, select latest `origin=user` snapshot from full shared-folder registry
      (all roots sharing the folder-name registry)
    - order: `created_at_epoch` descending, tie-break by snapshot id lexical descending
    - if no user-created snapshot exists: fail clearly
  - Status model per file:
    - `resolved_committed`: snapshot target matches `HEAD` and current working tree
    - `resolved_uncommitted`: snapshot target matches working tree but not `HEAD`
    - `unresolved_missing`: snapshot target path is missing from working tree
    - `unresolved_diverged`: current content or mode diverges from snapshot target
  - Visibility policy:
    - default: show unresolved rows only
    - `--all`: show resolved and unresolved rows
  - Default compare is diagnostic and exits `0` on successful execution.
  - Porcelain rows:
    - `compare_target`: selected snapshot metadata (`selected_snapshot_id`,
      `selection_mode`, `snapshot_origin`, `snapshot_root`, `current_root`, `show_all`)
    - `compare_file`: file-level status (`status`, `reason`)
    - `compare_summary`: totals (`repos_checked`, `files_total`,
      `resolved_committed`, `resolved_uncommitted`, `unresolved_missing`,
      `unresolved_diverged`, `unresolved_total`, `shown_files`) + `contract_version=3`
  - Exit codes:
    - `0`: compare completed
    - `1`: usage/runtime error

- `git-snapshot restore <snapshot_id> [--on-conflict <reject|rollback>] [--porcelain]`
  - Restores snapshot target state.
  - Conflict mode defaults to `--on-conflict reject`:
    - compatible hunks apply
    - rejected hunks are written to `*.rej`
    - untracked path collisions are reported and skipped
    - command exits `4` for partial restore requiring manual resolution
  - `--on-conflict rollback` preserves atomic behavior and auto-rollback on restore failure.
  - `--porcelain` emits stable `restore_*` rows for automation.
  - Requires typed confirmation unless `GIT_SNAPSHOT_CONFIRM_RESTORE=RESTORE` is provided.

- `git-snapshot delete <snapshot_id>`
  - Deletes snapshot data for the given id.

## Exactness semantics

Restore exactness targets:
- tracked files state
- untracked non-ignored files state

Ignored files are out of scope by default.

## Scope semantics

Root scope is the root-most superproject resolved from current working directory.

## Safety guard

If `GIT_SNAPSHOT_ENFORCE_ROOT_PREFIX` is set, execution is refused when resolved root repo is outside that prefix.

`create --clear` confirmation can be bypassed in non-interactive contexts with:
- `--yes`
- `GIT_SNAPSHOT_CONFIRM_CLEAR=YES`

`restore` exit codes:
- `0`: restore fully successful
- `4`: partial restore (reject/collision) in reject mode
- `1`: usage/runtime error or failed restore (with rollback attempt when safety snapshot exists)
