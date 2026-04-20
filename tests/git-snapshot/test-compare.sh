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
assert_contains "Compare base: snapshot" "${compare_clean_output}" "compare should disclose the default snapshot base"
assert_contains "Diff details: off (add --diff to include unified diffs for unresolved_diverged rows)" "${compare_clean_output}" "default compare should disclose how to enable unified diffs"
assert_contains "Compare telemetry: elapsed_ms=" "${compare_clean_output}" "compare should disclose human telemetry"
assert_contains "cache_hit_repos=0 | cache_miss_repos=1" "${compare_clean_output}" "first human compare should disclose cold-cache telemetry"
assert_contains "Compare rows: effect=0 | lines=+0/-0 | repos=1" "${compare_clean_output}" "compare should summarize restore-effect rows directly"
assert_contains "Compare: restore would not change any compared paths." "${compare_clean_output}" "snapshot-aligned state should have no restore effect"
assert_contains "No restore-effect rows to display. Re-run with --include-no-effect to include no restore effect rows." "${compare_clean_output}" "default compare should explain how to reveal no-effect rows"

root_repo_basename="$(basename "${root_repo}")"
compare_root_alias_output="$(cd "${root_repo}" && git_snapshot_test_cmd compare "${progress_snapshot_id}" --repo "${root_repo_basename}")"
assert_contains "Compare: restore would not change any compared paths." "${compare_root_alias_output}" "root folder-name alias should normalize to --repo ."
assert_contains "cache_hit_repos=0 | cache_miss_repos=1" "${compare_root_alias_output}" "default compare should not reuse persistent cache across standalone invocations"

compare_all_output="$(cd "${root_repo}" && git_snapshot_test_cmd compare "${progress_snapshot_id}" --repo . --include-no-effect)"
assert_contains "Compare rows: effect=0 | shown=1 | lines=+0/-0 | repos=1" "${compare_all_output}" "--include-no-effect should make shown rows exceed effect rows"
assert_contains "root.txt [no restore effect]" "${compare_all_output}" "--include-no-effect should label snapshot-aligned uncommitted work as no-effect"

compare_all_porcelain_output="$(cd "${root_repo}" && git_snapshot_test_cmd compare "${progress_snapshot_id}" --repo . --include-no-effect --porcelain)"
assert_contains $'compare_target\tselected_snapshot_id='"${progress_snapshot_id}"$'\tselection_mode=explicit\tsnapshot_origin=user\tsnapshot_root=' "${compare_all_porcelain_output}" "compare porcelain should include target row"
assert_contains $'\tcompare_base=snapshot' "${compare_all_porcelain_output}" "compare porcelain should expose the default compare base"
assert_contains $'\tcontract_version=8' "${compare_all_porcelain_output}" "compare target contract should expose v8 marker"
assert_contains $'compare_repo\tsnapshot_id='"${progress_snapshot_id}"$'\trepo=.\tfiles_total=1\tshown_files=1\teffect_files=0\thidden_no_effect_files=0' "${compare_all_porcelain_output}" "compare porcelain should expose per-repo compare totals"
assert_contains $'compare_file\tsnapshot_id='"${progress_snapshot_id}"$'\trepo=.\tfile=root.txt\tstatus=resolved_uncommitted\treason=snapshot target content and mode match working tree but not HEAD\tpath_scope=both\trestore_effect=none\tlines_added=0\tlines_removed=0\tdisplay_kind=no_effect\tdisplay_label=no restore effect' "${compare_all_porcelain_output}" "compare porcelain should expose simplified display metadata for no-effect rows"
assert_contains $'compare_summary\tsnapshot_id='"${progress_snapshot_id}"$'\trepos_checked=1\tfiles_total=1\tresolved_committed=0\tresolved_uncommitted=1\tunresolved_missing=0\tunresolved_diverged=0\tunresolved_total=0\tshown_files=1' "${compare_all_porcelain_output}" "compare porcelain summary should expose top-level compare totals"
assert_contains $'\tcache_hit_repos=' "${compare_all_porcelain_output}" "compare porcelain summary should expose cache hit telemetry"
assert_contains $'\tcache_miss_repos=' "${compare_all_porcelain_output}" "compare porcelain summary should expose cache miss telemetry"
assert_contains $'\teffect_files=0\tno_effect_files=1\thidden_no_effect_files=0\tinclude_no_effect=true\tcompare_base=snapshot\tcontract_version=8' "${compare_all_porcelain_output}" "compare porcelain summary should expose visibility and contract metadata"
assert_contains $'\tshown_lines_added=0\tshown_lines_removed=0\tscope_lines_added=0\tscope_lines_removed=0' "${compare_all_porcelain_output}" "compare porcelain summary should expose line-stat totals"

compare_all_porcelain_snapshot_base_output="$(cd "${root_repo}" && git_snapshot_test_cmd compare "${progress_snapshot_id}" --repo . --include-no-effect --base snapshot --porcelain)"
assert_contains $'\tcompare_base=snapshot' "${compare_all_porcelain_snapshot_base_output}" "compare porcelain should expose the snapshot base when requested"
assert_contains $'compare_file\tsnapshot_id='"${progress_snapshot_id}"$'\trepo=.\tfile=root.txt\tstatus=resolved_uncommitted\treason=snapshot target content and mode match working tree but not HEAD' "${compare_all_porcelain_snapshot_base_output}" "compare status semantics should stay unchanged across compare bases"

# Commit snapshot-aligned state and verify status transition to resolved_committed.
git -C "${root_repo}" add root.txt
git -C "${root_repo}" commit -m "commit compare progress" >/dev/null

compare_committed_output="$(cd "${root_repo}" && git_snapshot_test_cmd compare "${progress_snapshot_id}" --repo . --include-no-effect)"
assert_contains "root.txt [no restore effect]" "${compare_committed_output}" "compare should classify committed resolution as no-effect"

# Diverge from snapshot target in HEAD.
printf "post-commit-divergence\n" >> "${root_repo}/root.txt"
git -C "${root_repo}" add root.txt
git -C "${root_repo}" commit -m "diverge from snapshot target" >/dev/null

compare_diverged_output="$(cd "${root_repo}" && git_snapshot_test_cmd compare "${progress_snapshot_id}" --repo .)"
assert_contains "Compare: restore would change paths in the current workspace." "${compare_diverged_output}" "diverged work should be unresolved"
assert_contains "root.txt (+1/-0)" "${compare_diverged_output}" "compare should classify diverged content via line stats"

compare_diverged_diff_output="$(cd "${root_repo}" && git_snapshot_test_cmd compare "${progress_snapshot_id}" --repo . --diff)"
assert_contains "Diff details: on (unresolved_diverged rows include unified diffs)" "${compare_diverged_diff_output}" "compare --diff should disclose enabled unified diffs"
assert_contains "--- snapshot:root.txt" "${compare_diverged_diff_output}" "compare --diff should include snapshot label as diff base"
assert_contains "+++ current:root.txt" "${compare_diverged_diff_output}" "compare --diff should include current label as diff target"

compare_diverged_snapshot_base_output="$(cd "${root_repo}" && git_snapshot_test_cmd compare "${progress_snapshot_id}" --repo . --diff --base snapshot)"
assert_contains "Compare base: snapshot" "${compare_diverged_snapshot_base_output}" "compare should disclose the snapshot base when requested"
assert_contains "--- snapshot:root.txt" "${compare_diverged_snapshot_base_output}" "compare --base snapshot should flip the diff base label"
assert_contains "+++ current:root.txt" "${compare_diverged_snapshot_base_output}" "compare --base snapshot should flip the diff target label"

# Missing-path detection via untracked snapshot payload.
printf "missing-target\n" > "${root_repo}/missing-target.txt"
missing_create_output="$(cd "${root_repo}" && git_snapshot_test_cmd create compare-missing)"
missing_snapshot_id="$(git_snapshot_test_get_snapshot_id_from_create_output "${missing_create_output}")"
assert_eq "compare-missing" "${missing_snapshot_id}" "missing snapshot id should be preserved"
rm -f "${root_repo}/missing-target.txt"

compare_missing_output="$(cd "${root_repo}" && git_snapshot_test_cmd compare "${missing_snapshot_id}" --repo .)"
assert_contains "missing-target.txt (+0/-1)" "${compare_missing_output}" "compare should render missing snapshot paths as textual restore-effect rows"

# Default target selection must pick latest user-created snapshot.
default_compare_output="$(cd "${root_repo}" && git_snapshot_test_cmd compare)"
assert_contains "Snapshot compare: ${missing_snapshot_id}" "${default_compare_output}" "compare without id should select latest user-created snapshot"
assert_contains "Selected snapshot mode: latest-user-default" "${default_compare_output}" "compare without id should disclose selection mode"
assert_contains "Snapshot origin: user" "${default_compare_output}" "compare without id should keep user origin"
assert_contains "Shared-folder registry note: target selected from all user-created snapshots in this registry." "${default_compare_output}" "compare without id should disclose shared registry scope"

# Current-only dirty paths inside a snapshotted repo must now participate in compare.
printf "late-current-only\n" > "${root_repo}/late-current-only.txt"
compare_current_only_output="$(cd "${root_repo}" && git_snapshot_test_cmd compare "${missing_snapshot_id}" --repo . --include-no-effect --porcelain)"
assert_contains $'compare_file\tsnapshot_id='"${missing_snapshot_id}"$'\trepo=.\tfile=late-current-only.txt\tstatus=unresolved_diverged\treason=current-only dirty path exists while restore baseline removes it\tpath_scope=current_only\trestore_effect=changes\tlines_added=1\tlines_removed=0\tdisplay_kind=text_change\tdisplay_label=' "${compare_current_only_output}" "compare should surface dirty paths created after the snapshot with oriented line stats and display metadata"
assert_contains $'\tscope_current_only=1\t' "${compare_current_only_output}" "compare summary should count current-only scope rows"
