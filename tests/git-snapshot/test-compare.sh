#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/../helpers/assertions.bash"
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/../helpers/fixtures.bash"

git_snapshot_test_setup_sandbox
root_repo="$(git_snapshot_test_make_nested_fixture)"

# Build a snapshot of in-progress (uncommitted) work.
printf "progress-staged\n" >> "${root_repo}/root.txt"
git -C "${root_repo}" add root.txt
printf "progress-unstaged\n" >> "${root_repo}/root.txt"

progress_create_output="$(cd "${root_repo}" && git_snapshot_test_cmd create compare-progress)"
progress_snapshot_id="$(git_snapshot_test_get_snapshot_id_from_create_output "${progress_create_output}")"
assert_eq "compare-progress" "${progress_snapshot_id}" "compare progress snapshot id should be preserved"

compare_clean_output="$(cd "${root_repo}" && git_snapshot_test_cmd compare "${progress_snapshot_id}" --repo .)"
assert_contains "Snapshot compare: ${progress_snapshot_id}" "${compare_clean_output}" "compare should include heading"
assert_contains "Selected snapshot mode: explicit" "${compare_clean_output}" "explicit compare should disclose target mode"
assert_contains "Rows shown: unresolved only" "${compare_clean_output}" "default compare visibility should be unresolved only"
assert_contains "Diff details: off (add --diff to include unified diffs for unresolved_diverged rows)" "${compare_clean_output}" "default compare should disclose how to enable unified diffs"
assert_contains "Compare telemetry: elapsed_ms=" "${compare_clean_output}" "compare should disclose human telemetry"
assert_contains "cache_hit_repos=0 | cache_miss_repos=1" "${compare_clean_output}" "first human compare should disclose cold-cache telemetry"
assert_contains "Compare: no unresolved snapshot work." "${compare_clean_output}" "snapshot-aligned state should have no unresolved rows"
assert_contains "No rows to display for current visibility filter." "${compare_clean_output}" "default compare should hide resolved rows"

root_repo_basename="$(basename "${root_repo}")"
compare_root_alias_output="$(cd "${root_repo}" && git_snapshot_test_cmd compare "${progress_snapshot_id}" --repo "${root_repo_basename}")"
assert_contains "Compare: no unresolved snapshot work." "${compare_root_alias_output}" "root folder-name alias should normalize to --repo ."
assert_contains "cache_hit_repos=1 | cache_miss_repos=0" "${compare_root_alias_output}" "repeat human compare should disclose warm-cache telemetry"

compare_all_output="$(cd "${root_repo}" && git_snapshot_test_cmd compare "${progress_snapshot_id}" --repo . --all)"
assert_contains "Rows shown: all statuses" "${compare_all_output}" "--all should include resolved rows"
assert_contains "root.txt [resolved_uncommitted]" "${compare_all_output}" "--all should classify snapshot-aligned uncommitted work"

compare_all_porcelain_output="$(cd "${root_repo}" && git_snapshot_test_cmd compare "${progress_snapshot_id}" --repo . --all --porcelain)"
assert_contains $'compare_target\tselected_snapshot_id='"${progress_snapshot_id}"$'\tselection_mode=explicit\tsnapshot_origin=user\tsnapshot_root=' "${compare_all_porcelain_output}" "compare porcelain should include target row"
assert_contains $'compare_file\tsnapshot_id='"${progress_snapshot_id}"$'\trepo=.\tfile=root.txt\tstatus=resolved_uncommitted\treason=snapshot target content and mode match working tree but not HEAD' "${compare_all_porcelain_output}" "compare porcelain should expose resolved_uncommitted status and reason"
assert_contains $'compare_summary\tsnapshot_id='"${progress_snapshot_id}"$'\trepos_checked=1\tfiles_total=1\tresolved_committed=0\tresolved_uncommitted=1\tunresolved_missing=0\tunresolved_diverged=0\tunresolved_total=0\tshown_files=1\tengine=v2\telapsed_ms=' "${compare_all_porcelain_output}" "compare porcelain summary should expose v5 status counters with v2 telemetry"
assert_contains $'\tcache_hit_repos=' "${compare_all_porcelain_output}" "compare porcelain summary should expose cache hit telemetry"
assert_contains $'\tcache_miss_repos=' "${compare_all_porcelain_output}" "compare porcelain summary should expose cache miss telemetry"
assert_contains $'\tcontract_version=5' "${compare_all_porcelain_output}" "compare porcelain summary should expose v5 contract version"

# Commit snapshot-aligned state and verify status transition to resolved_committed.
git -C "${root_repo}" add root.txt
git -C "${root_repo}" commit -m "commit compare progress" >/dev/null

compare_committed_output="$(cd "${root_repo}" && git_snapshot_test_cmd compare "${progress_snapshot_id}" --repo . --all)"
assert_contains "root.txt [resolved_committed]" "${compare_committed_output}" "compare should classify committed resolution"

# Diverge from snapshot target in HEAD.
printf "post-commit-divergence\n" >> "${root_repo}/root.txt"
git -C "${root_repo}" add root.txt
git -C "${root_repo}" commit -m "diverge from snapshot target" >/dev/null

compare_diverged_output="$(cd "${root_repo}" && git_snapshot_test_cmd compare "${progress_snapshot_id}" --repo .)"
assert_contains "Compare: unresolved snapshot work remains." "${compare_diverged_output}" "diverged work should be unresolved"
assert_contains "root.txt [unresolved_diverged]" "${compare_diverged_output}" "compare should classify diverged content"

compare_diverged_diff_output="$(cd "${root_repo}" && git_snapshot_test_cmd compare "${progress_snapshot_id}" --repo . --diff)"
assert_contains "Diff details: on (unresolved_diverged rows include unified diffs)" "${compare_diverged_diff_output}" "compare --diff should disclose enabled unified diffs"
assert_contains "--- current:root.txt" "${compare_diverged_diff_output}" "compare --diff should include current label as diff base"
assert_contains "+++ snapshot:root.txt" "${compare_diverged_diff_output}" "compare --diff should include snapshot label as diff target"

# Missing-path detection via untracked snapshot payload.
printf "missing-target\n" > "${root_repo}/missing-target.txt"
missing_create_output="$(cd "${root_repo}" && git_snapshot_test_cmd create compare-missing)"
missing_snapshot_id="$(git_snapshot_test_get_snapshot_id_from_create_output "${missing_create_output}")"
assert_eq "compare-missing" "${missing_snapshot_id}" "missing snapshot id should be preserved"
rm -f "${root_repo}/missing-target.txt"

compare_missing_output="$(cd "${root_repo}" && git_snapshot_test_cmd compare "${missing_snapshot_id}" --repo .)"
assert_contains "missing-target.txt [unresolved_missing]" "${compare_missing_output}" "compare should classify missing snapshot paths"

# Default target selection must pick latest user-created snapshot.
default_compare_output="$(cd "${root_repo}" && git_snapshot_test_cmd compare)"
assert_contains "Snapshot compare: ${missing_snapshot_id}" "${default_compare_output}" "compare without id should select latest user-created snapshot"
assert_contains "Selected snapshot mode: latest-user-default" "${default_compare_output}" "compare without id should disclose selection mode"
assert_contains "Snapshot origin: user" "${default_compare_output}" "compare without id should keep user origin"
assert_contains "Shared-folder registry note: target selected from all user-created snapshots in this registry." "${default_compare_output}" "compare without id should disclose shared registry scope"
