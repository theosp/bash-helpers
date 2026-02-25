# bash-helpers

This submodule includes reusable shell utilities and CLIs.

## `git-snapshot`

`bin/git-snapshot` captures and restores git working-tree snapshots for a root-most superproject and its initialized recursive submodules.

### Commands
- `git-snapshot create`
- `git-snapshot list`
- `git-snapshot show <snapshot_id>`
- `git-snapshot restore <snapshot_id>`
- `git-snapshot delete <snapshot_id>`

### Snapshot Scope
- Scope is always resolved to the root-most superproject from the current PWD.
- Snapshot exactness targets tracked + untracked non-ignored files.

### Storage
- Default storage path: `~/git-snapshots/<root-most-repo-name>/snapshots/<snapshot_id>`

### Safety
- Optional hard safety guard: `GIT_SNAPSHOT_ENFORCE_ROOT_PREFIX=<path>`
  - If set, `git-snapshot` aborts unless resolved root-most repo is inside this prefix.
- Restore requires typed confirmation (`RESTORE`) unless
  `GIT_SNAPSHOT_CONFIRM_RESTORE=RESTORE` is provided.
- Restore creates an automatic safety snapshot and attempts rollback if restore fails.

## Tests
Run:

```bash
./tests/run-tests.sh
```

Tests are dependency-free shell scripts and use temporary sandboxes only.
