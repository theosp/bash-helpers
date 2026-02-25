# AGENTS Guide: bash-helpers

## Scope
`bash-helpers` is CLI-first:
- executable entrypoints under `bin/`
- core logic under `lib/`
- compatibility wrappers (if needed) under `functions/`

## Testing Safety (Mandatory)
1. Use only disposable repositories under `/tmp` (or `mktemp` sandbox paths).
2. Never run snapshot/restore tests against real working repositories.
3. In tests, always set sandbox-local `HOME`.
4. In tests, always set `GIT_SNAPSHOT_ENFORCE_ROOT_PREFIX` to sandbox repo root.
5. Test scripts must clean up sandboxes via trap.

## Destructive Command Policy
For commands that can rewrite working trees (restore/delete):
1. Print explicit warning.
2. Require typed confirmation (or explicit non-interactive env confirmation).
3. Create automatic safety snapshot before restore.
4. Attempt automatic rollback on restore failure.

## Add-New-Test Checklist
1. Create repositories only via fixture helpers.
2. Do not reference absolute user-specific paths.
3. Verify both success and failure exit codes.
4. Cover nested submodule and non-root PWD invocations when relevant.
5. Ensure tests assert that safety guard blocks out-of-scope repos.
