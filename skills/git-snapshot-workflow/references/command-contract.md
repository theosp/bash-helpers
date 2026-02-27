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
  - Human output: table (id, created, age, repo count).
  - Human output includes `Root` column when visible snapshots are not all from current root path.
  - Default human list prints a hint with hidden auto-snapshot count when any are filtered.
  - `--include-auto` shows both user-created and auto-generated snapshots.
  - When `--include-auto` is used in human mode, table includes `Auto` column (`*` means auto-generated).
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

- `git-snapshot verify <snapshot_id> [--repo <rel_path>] [--strict-head] [--porcelain]`
  - Verifies snapshot-captured working-set parity against current state:
    - staged patch bytes
    - unstaged patch bytes
    - untracked non-ignored set+content
  - Default head policy: HEAD mismatch is warning-only.
  - `--strict-head`: HEAD mismatch becomes mismatch/failure.
  - Why default is non-strict: supports long-running workflows where new commits
    are expected after snapshot creation but working-set parity remains the main
    recoverability target.
  - When to use strict: commit identity itself is a requirement (for example,
    rebase-sensitive checkpoints).
  - Exit codes:
    - `0`: verified (or warnings only in default mode)
    - `3`: mismatches found
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

- `git-snapshot debug-dirty`
  - Lists dirty repos in scope (root and submodules).

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
