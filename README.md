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

# Optional: open the shared compare UI
git-snapshot gui before-rebase-capability-gating

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

`git-snapshot compare` evaluates the restore effect of a snapshot against the
current workspace.

Compare scope unions:
- dirty paths in the current root-most repo scope
- paths captured by the snapshot staged/unstaged/untracked bundles

Default compare output shows only rows where `restore` would change the working
tree now (`restore_effect=changes`). Use `--include-no-effect` to also include
rows that already match the restore baseline (`restore_effect=none`).
Use `--diff` to include unified diffs for textual restore-effect rows that still
diverge from the restore baseline.

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
- Snapshots write `git_snapshot_meta_v4` metadata and persist per-repo
  compare target manifests/signatures so `compare` can use the metadata-backed
  fast path without rebuilding full temp repos.
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
- `--gui` launches the shared browser UI

Other flags:
- `--repo <rel_path>`
- `--all-repos` (default: off; include clean repos in summary)
- `--porcelain`

Porcelain rows:
- `inspect_target`: selected scope/summary row with `contract_version=2`
- `inspect_repo`: one row per repo with relation/apply-check/collision counters plus visible `file_count` / `lines_added` / `lines_removed`
- `inspect`: one row per selected category with captured `file_count` / `lines_added` / `lines_removed`
- `inspect_file`: one row per captured file, including `lines_added`, `lines_removed`, `display_kind`, and `display_label`

GUI notes:
- `inspect --gui` cannot be combined with `--porcelain`
- `inspect --gui` ignores `--name-only`, `--stat`, and `--diff`
- inspect mode is read-only: it previews captured staged/unstaged patch blocks and captured untracked file contents
- the browser shell keeps mode, snapshot, refresh, create, and primary-action controls in the top bar
- compare/inspect use a custom snapshot picker instead of the browser-native select: snapshots are listed newest first, the newest snapshot is the default selection, and each entry shows exact local creation time with inline rename/delete actions
- compare mode keeps the base toggle beside `Snapshot`, while advanced compare controls such as repo filtering and `show no-effect rows` live behind the `Filters` button and surface non-default state as `Filters (N)`

### `git-snapshot restore-check <snapshot_id> [--repo <rel_path>] [--all-repos] [--details] [--files] [--limit <n>|--no-limit] [--porcelain]`

Checks default reject-mode restore compatibility against the current workspace state.
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

### `git-snapshot gui [snapshot_id]`

Opens the shared browser UI in browse mode.

- Running `git-snapshot` with no subcommand is equivalent to `git-snapshot gui`.
- No args: open the browse UI and preselect the latest user-created snapshot when one exists.
- `<snapshot_id>`: open the browse UI and preselect that snapshot for later compare/inspect switching.
- `git-snapshot gui` accepts only an optional `snapshot_id`.
- Use `git-snapshot browse --gui` when you need pre-launch browse filters such as `--staged`, `--unstaged`, `--untracked`, `--submodules`, or `--all-repos`.
- Use `git-snapshot compare --gui` when you need pre-launch compare flags such as `--repo`, `--include-no-effect`, `--diff`, `--base`, or `--porcelain`.
- Use `git-snapshot review --gui` when you need pre-launch review repo/base selection such as `--repo`, `--base`, or `--repo-base`.
- Once open, the browser UI can switch between browse, compare, inspect, and review modes.

### `git-snapshot review [--repo <rel_path> ...] [--base <ref>] [--repo-base <rel_path> <ref>] [--gui] [--porcelain]`

Reviews committed branch delta for explicitly selected repos against a configurable base ref.

Default behavior:
- review compares `merge-base(effective_base, HEAD) .. HEAD` per selected repo
- default base is `master`
- per-repo overrides can replace the default base with a branch, tag, commit SHA, or other resolvable ref
- if the requested base is missing in a repo and local `master` exists there, review falls back to `master` and reports that fallback explicitly
- working-tree dirt is shown only as repo metadata (`dirty=true|false`); it is not folded into review file rows

Use `--base <ref>` to set the default review base for all selected repos.
Use `--repo-base <rel_path> <ref>` to override that base for one selected repo.
Use `--gui` to launch the shared browser shell directly into review mode.
Use `--porcelain` to emit `review_target`, `review_summary`, `review_repo`, `review_ref`, and `review_file` rows (`contract_version=1`).

Review GUI notes:
- review selection is explicit: only selected repos are shown
- review stores ordered named presets per root repo under the local git-snapshot home, not in git
- presets capture ordered repos, the default base, and per-repo base overrides
- the shareable URL keeps the expanded review state via `review_repos`, `review_base`, and `review_repo_bases`
- the toolbar exposes a default-base picker, and each review repo header exposes a per-repo base picker with `Use default (...)` to clear overrides
- when a requested base is missing, the repo header and per-repo picker call out whether review fell back to local `master` or could not resolve any usable base there

### `git-snapshot browse [--repo <rel_path>] [--staged|--unstaged|--untracked|--submodules|--all] [--all-repos] [--gui] [--porcelain]`

Browses live Git changes across the root-most repo and initialized recursive submodules.

Default behavior:
- browse compares against each repo `HEAD`
- staged rows show `HEAD -> index`
- unstaged rows show `index -> working tree`
- untracked rows show `empty -> working tree`
- submodule rows summarize live gitlink/checkout drift relative to `HEAD`

Use `--all` to include all browse categories when you want to be explicit.
Use `--all-repos` to keep clean repos in the navigator and repo filter.
Use `--gui` to launch the shared browser shell directly into browse mode.
In the shared GUI, browse mode exposes `Edit File` for real working-tree files only.
Use `--porcelain` to emit:
- `browse_target`: selected live-scope summary row with `contract_version=1`
- `browse_repo`: one row per repo with visible `file_count` / `lines_added` / `lines_removed`
- `browse`: one row per visible browse category with `file_count` / `lines_added` / `lines_removed`
- `browse_file`: one row per live file or submodule summary, including `lines_added`, `lines_removed`, `display_kind`, and `display_label`

### `git-snapshot compare [snapshot_id] [--repo <rel_path>] [--include-no-effect] [--diff] [--base <working-tree|snapshot>] [--gui] [--porcelain]`

Compares the current workspace against the restore state implied by the
snapshot.

Default behavior:
- compare evaluates dirty paths in the current root scope plus paths captured by the snapshot bundles
- output shows restore-effect rows only
- exits `0` on successful completion

`--repo` convenience:
- passing the current root folder name is treated as `.` (for example from `/path/justdo-devops`, `--repo justdo-devops` == `--repo .`)

Use `--include-no-effect` to include rows where restore would not change the working tree.
Use `--diff` to include inline unified diffs for diverged textual restore-effect rows.
Use `--base working-tree` for restore-oriented diffs, or `--base snapshot` to see post-snapshot working-tree changes as additions.
Use `git-snapshot` or `git-snapshot gui [snapshot_id]` as the shortcut to open the shared browser shell in browse mode with an optional compare/inspect snapshot preselected.
Use `--gui` to launch the shared browser shell in compare mode (Node-based local web UI) with per-file diff preview and external diff launching when you need compare-specific pre-launch flags.
`--gui` cannot be combined with `--porcelain`.
If `--gui` and `--diff` are both passed, compare warns and ignores `--diff` (GUI renders per-file diffs internally).

GUI notes:
- Browse/compare/inspect/review state is controlled inside the browser UI via mode, snapshot, repo, and mode-specific toggles.
- Control changes auto-refresh the active view.
- `Refresh` reloads the current view.
- `Reload Snapshots` also refreshes snapshot inventory for snapshot-backed views.
- Browse mode `Create Snapshot...` suggests a fresh timestamp-based id and includes an optional clear-after-capture checkbox (`--clear`), off by default.
- After browse mode creates a snapshot, the browser automatically switches into compare mode with that new snapshot selected.
- Browse/compare/review rows are cached per serialized view state.
- Snapshot-side file is materialized on demand per selected file (no full snapshot tree reconstruction).
- Runtime is pinned to Node `22.22.0` via the repo `.nvmrc`.
- If `node -v` already resolves to `22.22.0`, `browse --gui`, `compare --gui`, `inspect --gui`, and the Playwright UI suite use it directly.
- Otherwise the commands auto-select the pinned runtime via `nvm` (override `nvm` location with `NVM_DIR` when needed).
- Install the pinned runtime with `nvm install 22.22.0` if your active `node` does not already match the pin.
- GUI opens in your default browser and runs from a local `127.0.0.1` server started by the command.
- The GUI server prefers `127.0.0.1:34757` and then tries the next ports in order when that port is occupied.
- First-time diff fetch for a file shows a loading indicator while preview is prepared.
- Browse mode exposes `Edit File` for real working-tree files; compare mode exposes external diff launch; inspect mode is read-only; review mode previews committed branch diff only.
- Repo/category header selection opens stacked aggregate previews in the right pane; previews page in chunks of `25` rows via `Show more`.
- Reloading the page in live modes (`browse` and `compare`) revalidates live data instead of blindly reusing the last cached row set.
- Aggregate previews surface partial failures inline: the preview stays usable, but the summary warns when one or more blocks could not be rendered cleanly.
- Set `GIT_SNAPSHOT_GUI_PREVIEW_TELEMETRY=1` while stress-testing large aggregate previews to log capped and aborted preview requests with per-page timings.
- Set `GIT_SNAPSHOT_ROW_STATS_TELEMETRY=1` to log browse/inspect row-stat collection timings. The GUI server emits `ROW_STATS_VIEW ...` lines for whole-view loads, while the bash collectors emit `ROW_STATS ...` lines per category. Lower `GIT_SNAPSHOT_ROW_STATS_SLOW_MS` to flag smaller runs as `slow=1` while profiling bulk untracked fixtures.
- File rows expose a context menu with `Mark as viewed`, `Unmark as viewed`, and `Mark current version as viewed` when the row changed after it was marked.
- Repo and category rows expose the same context menu through right-click, `Shift+F10`, and an explicit `⋯` trigger. Their `Mark all as viewed` / `Unmark all as viewed` actions apply only to the currently visible child file rows in that selection.
- Viewed state is GUI-local and root-path-local. It is stored under `$HOME/git-snapshots/<root-folder>/.viewed-state.json`, keyed by the physical root repo path so different copies of the same folder name do not share marks accidentally.
- When a viewed row changes, the preview offers `Current` and `Since viewed`. `Since viewed` compares the stored viewed preview snapshot to the current preview.
- Stored viewed previews live under `$HOME/git-snapshots/<root-folder>/viewed-preview-blobs/`. Oversized preview snapshots are skipped instead of being persisted; override the cap with `GIT_SNAPSHOT_GUI_VIEWED_PREVIEW_MAX_BYTES=<bytes>` if needed while debugging.
- The top-bar `Viewed` menu clears either the current mode’s viewed rows or all viewed rows for the current physical root repo without forcing a full data reload.
- Selecting text inside allowed diff/preview bodies opens a selection context menu with `Copy` and `Ask`. The selection must stay inside preview body content; headers, metadata, and outside-`#diff` selections fall back to the browser menu.
- Structured diff selections tolerate incidental gutter co-selection, but copied/asked text excludes gutter numbers and preserves the selected `+` / `-` markers and line breaks.
- `Ask` opens a local prompt composer that copies a prompt built from the selected text only. Recent instructions are stored per physical root repo in browser `localStorage`, and saved instructions can be removed directly from the dropdown without confirmation.
- When text is selected inside the diff pane, the selection menu is available from the selected-text context menu and the standard keyboard context-menu shortcut (`Shift+F10` / `ContextMenu`).
- Repo-root `.git-snapshot.config` (INI / git-config-style) can set GUI defaults for `[gui "edit"]`, `[gui "external-diff"]`, `[gui "compare"]`, `[gui "snapshots"]`, and `[gui "server"]`.
- Flags / URL state and env vars override `.git-snapshot.config`.
- Browse `Edit File` opens the working-tree file via `.git-snapshot.config`, `GIT_SNAPSHOT_GUI_EDITOR_COMMAND_TEMPLATE`, or the OS default opener.
- Compare mode exposes an always-visible base toggle (`working tree` / `snapshot`) and remembers your last choice in local storage unless the URL or CLI explicitly sets it.
- Compare mode keeps `show no-effect rows` behind `Filters`; the main list focuses on restore-effect rows and simplified per-file labels such as `no restore effect`, `mode change`, `binary change`, or `submodule change`.
- Built-in external diff launch order follows the selected compare base.
- For a custom browse editor/opener launch shape, set `GIT_SNAPSHOT_GUI_EDITOR_COMMAND_TEMPLATE='<command> ... $FILE'`.
- Force a built-in selector with `GIT_SNAPSHOT_GUI_EXTERNAL_DIFF_TOOL=<tool>`.
- For a custom launch shape, set `GIT_SNAPSHOT_GUI_EXTERNAL_DIFF_COMMAND_TEMPLATE='<command> ... $SOURCE ... $TARGET'`.
- Override the auto-detect order with `GIT_SNAPSHOT_GUI_EXTERNAL_DIFF_CANDIDATES=<tool1,tool2,...>`.

Manual stress checklist for aggregate previews:
- Compare: click a large repo header, use `Show more` repeatedly, then switch to another repo before the previous expansion settles; the preview should stay on the latest selection.
- Compare: while a repo aggregate preview is open, force one `Show more` request to fail and confirm the already loaded preview blocks stay visible with an inline error instead of dropping back to a blank pane.
- Browse/inspect: click repo headers and category headers and confirm the right pane stacks only the visible rows for that selection.
- Browse/inspect: verify special-path rows, including tab-containing filenames, can be selected, restored from URL state, and survive reload without jumping to the wrong row.
- Browse: use a partially staged path and confirm the repo aggregate preview shows that same file once in staged and once in unstaged rows.
- Browse live refresh: change a tracked file outside the GUI, wait for the live-refresh hint, refresh, and confirm the category delta pills update with the new browse totals instead of keeping stale category stats.
- Browse/inspect: enable `GIT_SNAPSHOT_ROW_STATS_TELEMETRY=1`, then exercise a repo with many untracked files and watch for slow row-stat logs before widening rollout.
- Viewed state: mark a file in browse, switch to compare/inspect/review and back, then reload; the `Viewed` counts and row chips should stay aligned without requiring a full data reload.
- Viewed state: mark a tab-containing filename as viewed, reload, and confirm the same row stays marked instead of drifting to another path-shaped row.
- Review: use a custom default base or per-repo override, click a repo header, and confirm the preview metadata shows the effective review base instead of assuming `master`.
- Narrow viewport: repeat the repo/category selection flow around `390px` width and confirm row focus, stacked preview scrolling, and `Show more` remain usable.
- Override the preferred server port policy with `GIT_SNAPSHOT_GUI_PORT_START=<port>` and `GIT_SNAPSHOT_GUI_PORT_COUNT=<n>`.
- Candidate entries are selectors, not shell snippets. Canonical selectors are `meld`, `kdiff3`, `opendiff`, `bcompare`, and `code`.
- Command templates are tokenized into argv entries with quote/backslash handling and placeholder substitution; they are not executed through a shell.
- Use `$SOURCE` / `${SOURCE}` for the snapshot-side file and `$TARGET` / `${TARGET}` for the current working-tree file.
- Use `$BASE` / `${BASE}` for the active compare-base side and `$OTHER` / `${OTHER}` for the opposite side.
- Use `$FILE` / `${FILE}` for the browse-mode working-tree file path.
- Example repo-root `.git-snapshot.config`:

```ini
[gui "edit"]
tool = code

[gui "external-diff"]
tool = code
candidates = code,opendiff,kdiff3,meld,bcompare

[gui "compare"]
base = working-tree

[gui "snapshots"]
show-auto = false

[gui "server"]
port-start = 34757
port-count = 32
```

- Default auto-detect order is:
  1. `meld`
  2. `kdiff3`
  3. `opendiff`
  4. `bcompare`
  5. `code` (launched as `code --diff`)

Porcelain/backend status model:
- `resolved_committed`: restore baseline matches `HEAD` and current working tree
- `resolved_uncommitted`: restore baseline matches working tree but not `HEAD`
- `unresolved_missing`: restore baseline path is missing
- `unresolved_diverged`: current content or mode diverges from restore baseline

Target selection:
- explicit id: compare that snapshot
- omitted id: latest user-created snapshot from shared-folder registry scope

Human output discloses selected snapshot metadata, compare base, restore-effect
totals, and optional `shown` totals when `--include-no-effect` is enabled.

Persistent compare cache:
- compare stores per-snapshot/per-repo results under `$HOME/git-snapshots/<root>/.compare-cache-v2` only when `GIT_SNAPSHOT_COMPARE_CACHE=1`
- default is off (`GIT_SNAPSHOT_COMPARE_CACHE=0`)
- override worker parallelism with `GIT_SNAPSHOT_COMPARE_JOBS=<n>`
- cap retained cache entries per snapshot/repo family with `GIT_SNAPSHOT_COMPARE_CACHE_MAX_ENTRIES=<n>`
- compare uses the metadata-backed `engine=v3`
- compare requires intact `git_snapshot_meta_v4` metadata and compare-target manifests/signatures; corrupt or unsupported snapshots fail instead of rebuilding fallback state
- For the distinction between snapshot storage format, compare engine label, and porcelain contract version, see [`lib/git-snapshot/TECHNICAL.md`](lib/git-snapshot/TECHNICAL.md).

Porcelain rows:
- `compare_target`: selected snapshot metadata plus the actual requested `include_no_effect` and `compare_base` values
- `compare_repo`: one row per repo with shown/effect counts, shown `+/-` totals, and hidden no-effect count
- `compare_file`: one row per shown file with escaped `file`, `restore_effect`, base-oriented `lines_added` / `lines_removed`, simplified `display_kind` / `display_label`, and richer machine fields such as `status`, `path_scope`, and `reason`
- `compare_summary`: top-level shown/effect counts, shown `+/-` totals, hidden no-effect totals, telemetry (`engine=v3`, `elapsed_ms`, `cache_hit_repos`, `cache_miss_repos`), and `contract_version=8`

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
git-snapshot inspect before-rebase --gui
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

Run the full `bash-helpers` test entrypoint:

```bash
./tests/run-tests.sh
```

This runs any top-level `tests/test-*.sh` scripts first, then the git-snapshot suite.

Run only the git-snapshot suite directly:

```bash
./tests/git-snapshot/run-all.sh
```

Optional performance smoke benchmark for the git-snapshot portion of the suite:

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
