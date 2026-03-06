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

### Compare semantics

`git-snapshot compare` evaluates progress of snapshot-captured work items.

Compare tracks only files touched by the snapshot bundles (staged/unstaged/untracked at capture time), and classifies each touched file as:
- `resolved_committed`
- `resolved_uncommitted`
- `unresolved_missing`
- `unresolved_diverged`

Default compare output shows unresolved rows only. Use `--all` to include resolved rows.
Use `--diff` to include unified diffs for `unresolved_diverged` rows.

When `snapshot_id` is omitted for compare:
- the tool selects the latest `origin=user` snapshot from the entire shared-folder registry
- selection order:
  1. highest `created_at_epoch`
  2. tie-break by descending lexical snapshot id
- if no user-created snapshot exists, the command fails clearly

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
- `--snapshot`: create an auto snapshot first (origin=`auto`, id prefix `pre-reset-`).
- `--no-snapshot`: clear directly without creating a snapshot.
- `--porcelain`: emit stable automation rows.

Behavior:
- `--snapshot` and `--no-snapshot` are mutually exclusive.
- If neither flag is provided, prompt: `Create auto snapshot before clear? [Y/n]:`
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

- Default output: human multiline rows for user-created snapshots only.
  - first line: snapshot `ID`
  - second line: labeled details (`Created`, `Age`, `Repos`)
- Auto-generated internal snapshots are hidden by default (for example restore safety snapshots).
- Default human mode prints a hint with hidden auto-snapshot count when any are filtered.
- `--include-auto`: include both user-created and auto-generated snapshots.
- When `--include-auto` is used in human mode, auto snapshots include `Auto: *` in the details line.
- Human mode adds `Root: <path>` in details when visible snapshots are not all from the current root path.
- `--porcelain`: stable tab-delimited rows with key/value fields including `origin=<user|auto>`.
- Human mode prints a note that snapshot registry is keyed by root repo folder name.
  Repositories with the same folder name share one snapshot registry namespace.
- Human list ordering is newest snapshot first (`created_at_epoch` descending), regardless of root path.

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

### `git-snapshot compare [snapshot_id] [--repo <rel_path>] [--all] [--diff] [--gui] [--porcelain]`

Compares current progress against snapshot-captured work items.

Default behavior:
- compare evaluates files touched by the snapshot bundles
- output shows unresolved rows only
- exits `0` on successful completion

`--repo` convenience:
- passing the current root folder name is treated as `.` (for example from `/path/justdo-devops`, `--repo justdo-devops` == `--repo .`)

Use `--all` to include resolved rows.
Use `--diff` to include inline unified diffs for `unresolved_diverged` rows.
Use `--gui` to launch a visual compare browser (Node-based local web UI) with per-file diff preview and external patching via Meld/FileMerge/VS Code.
`--gui` cannot be combined with `--porcelain`.
If `--gui` and `--diff` are both passed, compare warns and ignores `--diff` (GUI renders per-file diffs internally).

GUI notes:
- Compare rows are loaded once and cached until you click Refresh.
- Refresh reruns compare and resets the diff cache.
- Snapshot-side file is materialized on demand per selected file (no full snapshot tree reconstruction).
- Runtime dependency is `node` (no Python/Tk dependency).
- GUI opens in your default browser and runs from a local `127.0.0.1` server started by the command.
- First-time diff fetch for a file shows a loading indicator while preview is prepared.
- External diff launch order is snapshot-left/current-right (Meld contract):
  - `meld "<snapshot_tmp_file>" "<current_file>"`
- Tool fallback order for "Open in Meld":
  1. `meld`
  2. `opendiff`
  3. `code --diff`

Status model:
- `resolved_committed`: snapshot target matches `HEAD` and current working tree
- `resolved_uncommitted`: snapshot target matches working tree but not `HEAD`
- `unresolved_missing`: snapshot target path is missing
- `unresolved_diverged`: current content or mode diverges from snapshot target

Target selection:
- explicit id: compare that snapshot
- omitted id: latest user-created snapshot from shared-folder registry scope

Human output discloses selected snapshot metadata and status totals.

Persistent compare cache:
- compare stores per-snapshot/per-repo results under `$HOME/git-snapshots/<root>/.compare-cache-v2` by default
- disable with `GIT_SNAPSHOT_COMPARE_CACHE=0`
- override worker parallelism with `GIT_SNAPSHOT_COMPARE_JOBS=<n>`
- cap retained cache entries per snapshot/repo family with `GIT_SNAPSHOT_COMPARE_CACHE_MAX_ENTRIES=<n>`

Porcelain rows:
- `compare_target`: selected snapshot metadata + visibility mode
- `compare_file`: one row per shown file with escaped `file`, `status`, and `reason` (`\`, tab, newline, and carriage return are backslash-escaped)
- `compare_summary`: totals, telemetry (`engine=v2`, `elapsed_ms`, `cache_hit_repos`, `cache_miss_repos`), and `contract_version=5`

Exit codes:
- `0`: compare completed
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

Run all git-snapshot tests (CI entrypoint):

```bash
./tests/run-tests.sh
```

Equivalent direct runner:

```bash
./tests/git-snapshot/run-all.sh
```

Optional performance smoke benchmark:

```bash
GIT_SNAPSHOT_INCLUDE_PERF_SMOKE=true ./tests/run-tests.sh
```

Optional threshold override for benchmark mode:

```bash
GIT_SNAPSHOT_INCLUDE_PERF_SMOKE=true GIT_SNAPSHOT_PERF_MAX_SECONDS=30 ./tests/run-tests.sh
```

Test suite guarantees:
- temporary sandbox-only repositories (`mktemp -d`)
- sandbox-local `HOME`
- enforced prefix guard during test invocations
- no mutations against real repositories
