---
name: git-snapshot-workflow
description: Use when user asks to create/verify/restore git-snapshot checkpoints or reason about recoverability.
---

# Git Snapshot Workflow

Use this skill only when the user asks about snapshot/backup/restore/checkpoint behavior.

## When to use

Trigger on requests like:
- "create a snapshot"
- "backup workspace before I continue"
- "restore snapshot <id>"
- "checkpoint before changes"
- "roll back workspace"

Do not trigger on generic coding tasks that do not ask for snapshot/restore flow.

## Command contract

Read `references/command-contract.md` for command semantics and output expectations.

## Lifecycle semantics

Follow this sequence and report each step.

1. Create snapshot
- Always choose an explicit, intent-derived snapshot id first.
- Build id from task context, for example:
  - `<phase>-<topic>-<yyyymmdd-hhmm>`
  - `<operation>-<component>-<ticket-or-branch-slug>-<yyyymmdd-hhmm>`
- Sanitize to `[A-Za-z0-9._-]+` and keep it concise.
- Run: `git-snapshot create <snapshot_id>`
- If id already exists, generate one deterministic retry id (for example append `-v2`), then retry once.
- Capture and report the actual final `snapshot_id` from command output.
- If user later wants to keep the snapshot but improve naming, use:
  - `git-snapshot rename <old_snapshot_id> <new_snapshot_id>`

2. Verify snapshot
- Run: `git-snapshot show <snapshot_id>`
- Confirm metadata is present: snapshot id, root repo path, repo count, per-repo entries.

3. Restore snapshot (only on explicit user restore intent)
- Explain restore is destructive for tracked changes and untracked non-ignored files.
- Run: `git-snapshot restore <snapshot_id>`.
- If confirmation is needed in non-interactive mode, use:
  - `GIT_SNAPSHOT_CONFIRM_RESTORE=RESTORE git-snapshot restore <snapshot_id>`

4. Post-restore verification
- Re-run: `git-snapshot show <snapshot_id>`.
- Check repo status or helper output and summarize whether restore matched expected state.

## Safety notes

- If `GIT_SNAPSHOT_ENFORCE_ROOT_PREFIX` is set, command failure means resolved root repo is outside the allowed prefix.
- Restore may create a safety snapshot automatically and can rollback on failure.

## Snapshot id policy

Snapshot ids are part of recoverability UX. Prefer human-meaningful ids over auto-generated ids.

Required rules:
- Do not default to `git-snapshot create` without an id unless user explicitly asks for auto-id.
- ID should communicate purpose of the checkpoint (what change/risk it protects).
- Avoid sensitive values or user-private tokens in id text.
- Keep ids shell-safe and readable in `git-snapshot list`.

Good examples:
- `pre-rebase-capability-gating-20260226-1430`
- `before-zim-ppm-migration-20260226-1430`
- `rollback-point-db-index-refactor-20260226-1430`

## Required response fields

When using this skill, include:
- Root repo path
- Snapshot id
- Commands executed
- Restore command for that snapshot id
- Verification result summary

## Failure handling

1. Missing command
- If `git-snapshot` is unavailable, report it clearly.
- Provide minimal setup guidance:
  - Ensure `modules/bash-helpers/bin` is in `PATH`
  - Or run by path: `<repo>/modules/bash-helpers/bin/git-snapshot ...`

2. Restore mismatch/failure
- Report non-zero outcome.
- Include key error lines.
- Offer next recovery action (retry with safety snapshot id if present).
