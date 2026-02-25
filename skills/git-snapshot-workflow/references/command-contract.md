# git-snapshot Command Contract

## Commands

- `git-snapshot create`
  - Creates a snapshot for root-most superproject + initialized recursive submodules.
  - Snapshot id is printed as the last output line.

- `git-snapshot list`
  - Lists snapshot ids with basic metadata.

- `git-snapshot show <snapshot_id>`
  - Prints snapshot metadata and per-repo records.

- `git-snapshot restore <snapshot_id>`
  - Restores snapshot target state.
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
