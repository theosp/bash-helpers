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
  - Snapshots use `git_snapshot_meta_v4` and persist per-repo compare
    target manifests/signatures for metadata-backed compare.

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
  - Porcelain rows:
    - `inspect_target`: selected scope/summary row with `contract_version=2`
    - `inspect_repo`: one row per repo with relation/apply-check/collision counters plus visible `file_count` / `lines_added` / `lines_removed`
    - `inspect`: one row per selected category with captured `file_count` / `lines_added` / `lines_removed`
    - `inspect_file`: one row per captured file, including `lines_added`, `lines_removed`, `display_kind`, and `display_label`

- `git-snapshot restore-check <snapshot_id> [--repo <rel_path>] [--all-repos] [--details] [--files] [--limit <n>|--no-limit] [--porcelain]`
  - Checks default reject-mode restore compatibility against current tree.
  - Human default is summary-first (issues-focused).
  - `--details` prints per-repo detail sections; `--files` implies details.
  - Exit codes:
    - `0`: all compared repos compatible
    - `3`: compatibility issues found
    - `1`: usage/runtime error

- `git-snapshot review --repo <rel_path> ... [--base <ref>] [--repo-base <rel_path> <ref>] [--gui] [--porcelain]`
  - Explicit selected-repo review mode for committed branch delta only.
  - Per selected repo, review compares `merge-base(effective_base, HEAD) .. HEAD`.
  - Default base is `master`.
  - `--base <ref>` sets the default base for all selected repos.
  - `--repo-base <rel_path> <ref>` overrides the default base for one selected repo.
  - Base resolution policy:
    - use the repo override when provided, otherwise the default base
    - if the requested base resolves, use it directly
    - if the requested base is missing and local `master` resolves, fall back to `master`
    - if both are unavailable, emit a repo-level `baseline_missing` result for that repo
  - Dirty working-tree state is reported as repo metadata only (`dirty=true|false`); it is not merged into review file rows.
  - `--gui` launches the shared review browser with explicit repo selection, ordered presets, default-base picker, and per-repo base overrides.
  - Porcelain rows:
    - `review_target`: default base + selected/resolved/failed/fallback repo counts + `contract_version=1`
    - `review_summary`: top-level shown file/line totals + fallback counts
    - `review_repo`: current branch/head, requested/effective base fields, requested base source, base source, base resolution, base note, merge-base, dirty/has_delta, totals, and status/message
    - `review_ref`: ref suggestions per root/selected repo for GUI base pickers
    - `review_file`: one committed file row with line stats and simplified display metadata
  - GUI/share-state behavior:
    - selected repos remain ordered and are encoded in `review_repos`
    - default base is encoded in `review_base`
    - per-repo overrides are encoded in `review_repo_bases`
    - named review presets are user-local and store ordered repos plus base settings

- `git-snapshot compare [snapshot_id] [--repo <rel_path>] [--include-no-effect] [--diff] [--base <working-tree|snapshot>] [--gui] [--porcelain]`
  - Restore-effect compare engine over current dirty root-scope paths plus snapshot-captured paths.
  - Optional `snapshot_id`:
    - when omitted, select latest `origin=user` snapshot from full shared-folder registry
      (all roots sharing the folder-name registry)
    - order: `created_at_epoch` descending, tie-break by snapshot id lexical descending
    - if no user-created snapshot exists: fail clearly
  - Status model per file:
    - `resolved_committed`: restore baseline matches `HEAD` and current working tree
    - `resolved_uncommitted`: restore baseline matches working tree but not `HEAD`
    - `unresolved_missing`: restore baseline path is missing from working tree
    - `unresolved_diverged`: current content or mode diverges from restore baseline
  - Visibility policy:
    - default: show restore-effect rows only (`restore_effect=changes`)
    - `--include-no-effect`: include rows where restore would not change the working tree
    - `--diff`: include unified diffs for diverged textual restore-effect rows (human output)
    - `--base <...>`: orient line stats and diff presentation to `working-tree` or `snapshot`
    - `--gui`: launch visual compare browser (file tree + diff preview + external diff action)
    - `--repo <root-folder-name>` normalizes to `--repo .`
    - `--gui` is incompatible with `--porcelain`
    - passing `--gui` and `--diff` together warns and ignores `--diff`
  - GUI tool behavior:
    - runtime dependency is `node` (no Python/Tk dependency)
    - launches a local browser UI served on `127.0.0.1` by the command process
    - compare rows are cached per GUI session/view state; changing focused files does not rerun compare
    - `Refresh` reloads the current view; `Reload Snapshots` also refreshes snapshot inventory
    - first-time per-file preview fetch shows a loading indicator while diff is prepared
    - external diff tool order: `meld`, then `kdiff3`, then `opendiff`, then `bcompare`, then `code` (`code` launches as `code --diff`)
    - external launch order is fixed as snapshot-left/current-right:
      `meld "<snapshot_tmp_file>" "<current_file>"`
  - Default compare is diagnostic and exits `0` on successful execution.
  - Porcelain rows:
    - `compare_target`: selected snapshot metadata plus actual `include_no_effect`, `show_diff`, and `compare_base`
    - `compare_repo`: per-repo shown/effect totals, shown `+/-` totals, and hidden no-effect count
    - `compare_file`: one shown file row with `restore_effect`,
      base-oriented `lines_added` / `lines_removed`, simplified
      `display_kind` / `display_label`, and richer machine fields
      (`status`, `path_scope`, `reason`);
      `file` uses backslash escapes for `\`, tab, newline, and carriage return
    - `compare_summary`: top-level shown/effect totals, shown `+/-` totals,
      hidden no-effect totals, telemetry (`engine=v3`, `elapsed_ms`
      wall-clock milliseconds, `cache_hit_repos`, `cache_miss_repos`) +
      `contract_version=8`
  - Cache behavior:
    - snapshots use metadata-backed `engine=v3`
    - compare requires intact `git_snapshot_meta_v4` metadata and compare-target
      metadata; corrupt or unsupported snapshots fail instead of rebuilding
      compare inputs
    - persistent compare cache is off by default; enable with `GIT_SNAPSHOT_COMPARE_CACHE=1`
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

- `git-snapshot browse [--repo <rel_path>] [--staged|--unstaged|--untracked|--submodules|--all] [--all-repos] [--gui] [--porcelain]`
  - Live status browser against each repo `HEAD`.
  - Staged rows compare `HEAD -> index`.
  - Unstaged rows compare `index -> working tree`.
  - Untracked rows compare `empty -> working tree`.
  - Submodule rows summarize live gitlink/checkout drift relative to `HEAD`.
  - `--gui` launches the shared browser in browse mode.
  - Porcelain rows:
    - `browse_target`: selected live-scope summary row with `contract_version=1`
    - `browse_repo`: one row per repo with visible `file_count` / `lines_added` / `lines_removed`
    - `browse`: one row per visible browse category with `file_count` / `lines_added` / `lines_removed`
    - `browse_file`: one row per live file or submodule summary, including `lines_added`, `lines_removed`, `display_kind`, and `display_label`

## Shared GUI Viewed State

- Browse/compare/inspect/review file rows expose a GUI-only context menu with:
  - `Mark as viewed`
  - `Unmark as viewed`
  - `Mark current version as viewed` when the row changed after being viewed
- Browse/compare/inspect/review repo rows, and browse/inspect category rows, also expose GUI-only bulk viewed actions:
  - `Mark all as viewed`
  - `Unmark all as viewed`
  - bulk actions apply only to the currently visible child file rows under that selection
- Viewed state is GUI-local only; it is not encoded into CLI flags, URLs, or shared presets.
- Viewed state persists under:
  - `$HOME/git-snapshots/<root-folder>/.viewed-state.json`
  - `$HOME/git-snapshots/<root-folder>/viewed-preview-blobs/`
- The viewed-state document is keyed by the physical root repo path inside the JSON payload so different copies sharing the same folder name do not share marks accidentally.
- GUI `api/data` file rows add these fields in place:
  - `view_token`
  - `view_state` (`unviewed`, `viewed`, `changed`)
  - `view_marked_at`
  - `view_blob_available`
- When `view_state=changed` and `view_blob_available=true`, `api/preview` supports the GUI-only `since_viewed` preview variant:
  - text rows return a unified diff between the stored viewed snapshot and the current preview
  - non-text/submodule rows return a structured before/after summary
- Oversized viewed-preview payloads are skipped instead of being persisted; override the cap for debugging with `GIT_SNAPSHOT_GUI_VIEWED_PREVIEW_MAX_BYTES=<bytes>`.

## Shared GUI Diff Selection Actions

- Selecting non-empty text fully inside approved preview-body content under `#diff` exposes a GUI-only selection menu with:
  - `Copy`
  - `Ask`
- Allowed preview-body selection roots include:
  - plain preview text bodies
  - structured diff code cells
  - aggregate preview body text
  - submodule summary body text
  - since-viewed summary body text
- Headers, metadata, gutter-only selection, and selections crossing outside `#diff` fall back to the browser’s default context menu.
- Structured diff selection may incidentally include gutters during drag selection, but copied/asked text excludes gutter numbers and preserves selected line breaks and diff markers.
- `Ask` builds a GUI-only prompt from:
  - the chosen instruction text
  - the exact selected text in a fenced code block
- Ask history is GUI-local only:
  - stored in browser `localStorage`
  - keyed by physical root repo path
  - stores instruction text only, not selected diff snippets
  - supports in-dropdown removal without confirmation

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
