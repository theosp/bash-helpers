# git-snapshot Command Contract

## Commands

- `git-snapshot create [snapshot_id]`
  - Creates a snapshot for root-most superproject + initialized recursive submodules.
  - Snapshot id is printed as the last output line.
  - Skill default is explicit id (`git-snapshot create <snapshot_id>`), derived from user intent/context.
  - Auto-id mode (`git-snapshot create`) is fallback-only unless user explicitly asks for it.

- `git-snapshot list [--porcelain]`
  - Human output: table (id, created, age, repo count).
  - Porcelain output: tab-delimited `snapshot` rows with key/value fields.

- `git-snapshot show <snapshot_id> [--repo <rel_path>] [--verbose] [--porcelain]`
  - Human output: detailed metadata, relation, captured files, restore readiness.
  - Porcelain output: `snapshot_id=...` header lines + `repo\t...` rows.

- `git-snapshot diff <snapshot_id> [--repo <rel_path>] [--staged|--unstaged|--untracked|--all] [--name-only|--stat|--patch] [--porcelain]`
  - Shows captured snapshot bundle content by category.
  - Non-mutating.

- `git-snapshot compare <snapshot_id> [--repo <rel_path>] [--files] [--porcelain]`
  - Checks restore compatibility against current tree.
  - Exit codes:
    - `0`: all compared repos compatible
    - `3`: compatibility issues found
    - `1`: usage/runtime error

- `git-snapshot restore <snapshot_id>`
  - Restores snapshot target state.
  - Requires typed confirmation unless `GIT_SNAPSHOT_CONFIRM_RESTORE=RESTORE` is provided.
  - Creates safety snapshot and attempts rollback on restore failure.

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
