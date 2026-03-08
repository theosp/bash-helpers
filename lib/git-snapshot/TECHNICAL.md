# git-snapshot Technical Notes

This document explains the three version markers that appear in `git-snapshot`.

## Current Policy

- `git_snapshot_meta_v4` is the only supported snapshot metadata format.
- `engine=v3` is the current compare implementation label.
- `contract_version=5` is the current `compare --porcelain` schema version.
- Older snapshot metadata formats are unsupported by design.

## The Three Version Markers

### `git_snapshot_meta_v4`

This is the on-disk snapshot metadata format written to `meta.env`.

Use it to answer:
- Can this snapshot be read by the current tool?
- Does the snapshot store have the metadata shape the current code expects?

Change this only when the persisted snapshot format changes in a way that affects compatibility.

### `engine=v3`

This is the label for the current compare implementation.

Use it to answer:
- Which compare algorithm produced this result?
- Which compare path should diagnostics and benchmarks attribute this output to?

This is not a compatibility promise for older snapshots and not a legacy-support switch.

Change this only when compare internals change enough that results, caching behavior, or diagnostics should be attributed to a new compare implementation generation.

### `contract_version=5`

This is the machine-readable schema version for `compare --porcelain`.

Use it to answer:
- Can an automation safely parse the emitted `compare_target`, `compare_file`, and `compare_summary` rows?
- Has the stable output contract changed?

Change this only when the porcelain row schema changes in a way that affects consumers.

## Why These Markers Are Separate

They track different concerns:

- Storage compatibility: `git_snapshot_meta_v4`
- Runtime implementation generation: `engine=v3`
- Machine-readable output contract: `contract_version=5`

Keeping them separate avoids overloading one number to mean:
- on-disk format compatibility
- compare internals
- automation-facing output stability

Those concerns evolve independently.

## What Should Change, and When

- If snapshot files on disk change incompatibly, bump `git_snapshot_meta_v4`.
- If compare internals materially change, bump `engine=v3`.
- If porcelain output changes for consumers, bump `contract_version=5`.

Do not infer one bump from another. A compare-engine change does not imply a metadata-format change, and a metadata-format change does not imply a porcelain-contract change.

## Unsupported Older Formats

Older snapshot metadata formats are intentionally unsupported in the current tool.

That policy means:
- no fallback compare path for old snapshot formats
- no migration behavior implied by the compare engine label
- no compatibility guarantee based on older internal version names
