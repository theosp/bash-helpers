# bash-helpers

Reusable shell CLIs and helper libraries.

## `git-snapshot`

`bin/git-snapshot` captures and restores Git working-tree state for a root-most
superproject and all initialized recursive submodules.

This tool is designed for fast local safety checkpoints before risky work
(rebase, migration, large refactors, bulk file operations).

## Primary Workflows

### Scenario A: Blast-radius safety checkpoint

Use when you are about to run a broad/high-risk change and want a fast rollback
point without creating temporary commits.

Typical flow:
1. `git-snapshot create <intent-id>`
2. perform risky work
3. if needed, recover with `git-snapshot restore <intent-id>`

### Scenario B: Interrupt and switch tasks

Use when you must pause current work and move immediately to something else on
a clean tree.

Typical flow:
1. `git-snapshot create <intent-id> --clear` (or `--yes` / env bypass)
2. handle urgent task on clean trees
3. later resume with `git-snapshot restore <intent-id>`

### Scenario C: Clear now with optional auto snapshot

Use when you want a clean tree immediately and do not want to pick a snapshot
id manually.

Typical flow:
1. `git-snapshot reset-all` (interactive snapshot choice)
2. or `git-snapshot reset-all --snapshot` / `git-snapshot reset-all --no-snapshot`

### Quick Start

```bash
# 1) Create a snapshot (prints snapshot id on last output line)
git-snapshot create before-rebase

# Optional: rename to a clearer id later
git-snapshot rename before-rebase before-rebase-capability-gating

# 2) Inspect what was captured
git-snapshot inspect before-rebase-capability-gating

# 3) Check restore readiness vs current tree
git-snapshot restore-check before-rebase-capability-gating --files

# 4) Restore when needed (interactive confirmation)
git-snapshot restore before-rebase-capability-gating
```

## Scope and Exactness

### Root scope

The tool always resolves scope to the **root-most superproject** from your
current working directory.

Examples:
- From repo root: scope is that repo.
- From `modules/sub1`: scope is still root superproject.
- From `modules/sub1/modules/sub2`: scope is still root superproject.

### Captured state model

Per repository in scope (`.` and each initialized submodule), snapshot data
includes:
- `HEAD` commit hash at capture time
- staged patch (`git diff --cached --binary`)
- unstaged patch (`git diff --binary`)
- untracked non-ignored files archive

### Restore exactness target

Restore aims to re-create:
- tracked file state
- untracked non-ignored file set and content

Ignored files are intentionally out of scope.

### Verify semantics and caveat

`git-snapshot verify` checks snapshot-captured working-set equivalence:
- staged patch bytes
- unstaged patch bytes
- untracked non-ignored file set+content

By default, HEAD mismatch is warning-only. This is intentional for long-running
workflows where you snapshot, continue unrelated work (including new commits),
then later restore/check parity of the captured working set.

Use `--strict-head` when commit identity itself is part of the requirement
(for example rebase-sensitive checkpoints or when you must ensure the exact same
commit baseline before proceeding).

## Command Reference

### `git-snapshot create [snapshot_id] [--clear] [--yes]`

Creates a snapshot.

- If `snapshot_id` is omitted, an id is generated:
  `YYYY-MM-DD--HH-MM-SS`
- If a generated timestamp id already exists, suffixes are added:
  `YYYY-MM-DD--HH-MM-SS-02`, `...-03`, etc.
- If provided, `snapshot_id` must match `[A-Za-z0-9._-]+` and must not exist.
- `--clear` clears each snapshotted repo after capture:
  - `git reset --hard`
  - `git clean -fd`
- `--yes` bypasses interactive clear confirmation (`--yes` is valid only with `--clear`).
- `--clear` prompt: `Proceed with clear? [y/N]:`
- `--clear` is best-effort:
  - clear attempts continue across repos
  - failures are reported per repo
  - command exits non-zero if any clear failed
- Snapshot id is still printed as final output line even on clear failure (for recovery).
- `--clear` does **not** run submodule checkout/update alignment; submodule HEAD drift is warning-only.
- Last output line is always the snapshot id.

### `git-snapshot reset-all [--snapshot|--no-snapshot] [--porcelain]`

Clears the current root-most repo scope in place:
- `git reset --hard`
- `git clean -fd`

Flags:
- `--snapshot`: create an auto snapshot first (origin=`auto`, id prefix `before-reset-all-`).
- `--no-snapshot`: clear directly without creating a snapshot.
- `--porcelain`: emit stable automation rows.

Behavior:
- `--snapshot` and `--no-snapshot` are mutually exclusive.
- If neither flag is provided, prompt: `Create auto snapshot before clear? [y/N]:`
- No second destructive confirmation is asked after this snapshot decision.
- In non-interactive mode, pass `--snapshot` or `--no-snapshot`.
- Clear remains best-effort and exits non-zero if any repo clear fails.

Porcelain output:
- `reset_all_snapshot\tcreated=<true|false>\tsnapshot_id=<id-or-empty>`
- `reset_all_summary\tresult=<success|failed>\tsnapshot_created=<true|false>\tsnapshot_id=<id-or-empty>\trepos_total=<n>\trepos_cleared=<n>\trepos_failed=<n>\texit_code=<0|1>`

### `git-snapshot rename <old_snapshot_id> <new_snapshot_id> [--porcelain]`

Renames an existing snapshot id.

- Fails if `<old_snapshot_id>` does not exist.
- Fails if `<new_snapshot_id>` already exists.
- Preserves all snapshot contents and creation timestamp.
- Updates metadata so `inspect`/`list` report the new id.
- `--porcelain` prints stable machine output:
  `renamed\told_id=<old>\tnew_id=<new>`

### `git-snapshot list [--include-auto] [--porcelain]`

Lists snapshots for the resolved root-most repo.

- Default output: human table (`ID`, `Created`, `Age`, `Repos`) for user-created snapshots only.
- Auto-generated internal snapshots are hidden by default (for example restore safety snapshots).
- Default human mode prints a hint with hidden auto-snapshot count when any are filtered.
- `--include-auto`: include both user-created and auto-generated snapshots.
- When `--include-auto` is used in human mode, table adds `Auto` column (`*` means auto-generated).
- `--porcelain`: stable tab-delimited rows with key/value fields including `origin=<user|auto>`.

### `git-snapshot inspect <snapshot_id> [options]`

Shows captured bundle contents without mutating current repos.
Default behavior includes:
- summary totals and changed-repo matrix
- detailed `--stat` sections for changed repos

Category flags:
- `--staged`: include staged category
- `--unstaged`: include unstaged category
- `--untracked`: include untracked category
- `--all`: include staged + unstaged + untracked
- default: all categories enabled when no category flags are passed

Render mode flags (mutually exclusive):
- `--name-only` (default: off)
- `--stat` (default: on)
- `--diff` (default: off)

Other flags:
- `--repo <rel_path>`
- `--all-repos` (default: off; include clean repos in summary)
- `--porcelain`

### `git-snapshot restore-check <snapshot_id> [--repo <rel_path>] [--all-repos] [--details] [--files] [--limit <n>|--no-limit] [--porcelain]`

Checks restore compatibility against the current workspace state.
Default behavior is summary-first:
- show checked/issue/clean totals
- list issue repos only

Per-repo checks:
- commit relation vs snapshot
- apply-check for staged patch
- apply-check for unstaged patch
- untracked collisions

Exit codes:
- `0`: all compared repos are restore-compatible
- `3`: compatibility issues found
- `1`: usage/runtime error

`--details` prints detailed per-repo sections.
`--files` includes captured file inventories and collision file details (implies `--details`).
`--all-repos` includes clean repos in summary output.

### `git-snapshot verify <snapshot_id> [--repo <rel_path>] [--strict-head] [--porcelain]`

Verifies whether the current working-set state matches what the snapshot
captured.

Default checks:
- staged patch bytes match
- unstaged patch bytes match
- untracked non-ignored set+content match

Head policy:
- default: HEAD mismatch is warning-only (exit remains success if no other mismatches)
- `--strict-head`: HEAD mismatch is treated as mismatch (exit code `3`)

Why default is non-strict:
- lets you continue normal development after snapshot creation (including commits)
  and still verify/restore against captured working-set data later.

Use `--strict-head` when:
- the exact commit baseline is part of safety requirements, not only file-state parity.

Exit codes:
- `0`: verified (or warnings only in default mode)
- `3`: mismatches detected
- `1`: usage/runtime error

### `git-snapshot restore <snapshot_id>`

Restores a snapshot with guardrails:

1. Warn about destructive implications
2. Require typed confirmation (`RESTORE`) unless env override is set
3. Create automatic safety snapshot
4. Attempt restore
5. Verify status-hash parity
6. Attempt automatic rollback to safety snapshot on failure

Non-interactive confirmation:

```bash
GIT_SNAPSHOT_CONFIRM_RESTORE=RESTORE git-snapshot restore <snapshot_id>
```

### `git-snapshot delete <snapshot_id>`

Deletes snapshot directory data.

### `git-snapshot debug-dirty`

Prints dirty repo relative paths discovered in root scope and initialized submodules.

## Output Modes

### Human mode (default)

Readable diagnostics intended for interactive terminal use.

### Porcelain mode (`--porcelain`)

Stable tab-delimited key/value lines for scripts.

Examples:

```bash
git-snapshot reset-all --snapshot --porcelain
git-snapshot list --porcelain
git-snapshot list --include-auto --porcelain
git-snapshot inspect before-rebase --porcelain
git-snapshot restore-check before-rebase --porcelain
```

## Storage Layout

Default storage root:

```text
~/git-snapshots/<root-most-repo-name>/
```

Per snapshot:

```text
<snapshot_id>/
  meta.env
  repos.tsv
  repos/
    repo-0001/
      staged.patch
      unstaged.patch
      untracked.tar
```

## Safety Controls

### Enforce-root-prefix guard

Set:

```bash
export GIT_SNAPSHOT_ENFORCE_ROOT_PREFIX=/path/to/allowed/repos
```

If set, commands abort when resolved root-most repo is outside this prefix.
This is heavily used by tests to prevent accidental writes to real repositories.

### Restore confirmation override

Set:

```bash
export GIT_SNAPSHOT_CONFIRM_RESTORE=RESTORE
```

Useful for controlled non-interactive automation.

### Clear confirmation override

Set:

```bash
export GIT_SNAPSHOT_CONFIRM_CLEAR=YES
```

This bypasses interactive confirmation for `git-snapshot create --clear`.
`git-snapshot reset-all` uses explicit `--snapshot` / `--no-snapshot` flags in non-interactive contexts.

## Troubleshooting

- `Refusing to operate outside enforced prefix`
  - Command scope root is outside `GIT_SNAPSHOT_ENFORCE_ROOT_PREFIX`.
- `Snapshot does not exist`
  - Wrong snapshot id or wrong root-scope repo context.
- `restore-check` exits with code `3`
  - One or more repos are not restore-compatible in current state.
  - Run `git-snapshot restore-check <id> --details` for detail.
- Restore failure with rollback message
  - Restore failed mid-flow and rollback attempted automatically to safety snapshot.

## Tests

Run all bash-helpers tests:

```bash
./tests/run-tests.sh
```

Test suite guarantees:
- temporary sandbox-only repositories (`mktemp -d`)
- sandbox-local `HOME`
- enforced prefix guard during test invocations
- no mutations against real repositories
