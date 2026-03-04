#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/../helpers/assertions.bash"
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/../helpers/fixtures.bash"

git_snapshot_test_setup_sandbox

root_repo="$(git_snapshot_test_make_nested_fixture)"

baseline_create_output="$(cd "${root_repo}" && git_snapshot_test_cmd create compare-baseline)"
baseline_snapshot_id="$(git_snapshot_test_get_snapshot_id_from_create_output "${baseline_create_output}")"
assert_eq "compare-baseline" "${baseline_snapshot_id}" "compare baseline snapshot id should be preserved"

compare_clean_output="$(cd "${root_repo}" && git_snapshot_test_cmd compare "${baseline_snapshot_id}")"
assert_contains "Snapshot compare: ${baseline_snapshot_id}" "${compare_clean_output}" "compare should include heading"
assert_contains "Selected snapshot mode: explicit" "${compare_clean_output}" "explicit compare should disclose target mode"
assert_contains "Snapshot origin: user" "${compare_clean_output}" "compare should disclose target origin"
assert_contains "Compare: no differences within snapshot scope." "${compare_clean_output}" "clean compare should report no differences"

printf "compare-mismatch\n" >> "${root_repo}/root.txt"
git -C "${root_repo}" add root.txt

set +e
compare_mismatch_output="$(cd "${root_repo}" && git_snapshot_test_cmd compare "${baseline_snapshot_id}" --repo . 2>&1)"
compare_mismatch_code=$?
set -e
assert_exit_code 0 "${compare_mismatch_code}" "diagnostic compare should not fail when differences exist"
assert_contains "Differences:" "${compare_mismatch_output}" "compare should report differences section"
assert_contains "staged patch differs" "${compare_mismatch_output}" "compare should include staged mismatch detail"
assert_contains "git-snapshot compare ${baseline_snapshot_id} --repo . --assert-equal" "${compare_mismatch_output}" "compare follow-up should suggest assert mode"

set +e
compare_assert_output="$(cd "${root_repo}" && git_snapshot_test_cmd compare "${baseline_snapshot_id}" --repo . --assert-equal 2>&1)"
compare_assert_code=$?
set -e
assert_exit_code 3 "${compare_assert_code}" "assert-equal compare should fail on differences"
assert_contains "Differences:" "${compare_assert_output}" "assert compare should still report differences"
assert_contains "staged patch differs" "${compare_assert_output}" "assert compare should include mismatch detail"

git -C "${root_repo}" reset --hard >/dev/null

compare_porcelain_output="$(cd "${root_repo}" && git_snapshot_test_cmd compare "${baseline_snapshot_id}" --repo . --porcelain)"
assert_contains $'compare_target\tselected_snapshot_id='"${baseline_snapshot_id}"$'\tselection_mode=explicit\tsnapshot_origin=user' "${compare_porcelain_output}" "compare porcelain should include target row"
assert_contains $'compare\tsnapshot_id='"${baseline_snapshot_id}"$'\trepo=.\thead=same\tstaged=match\tunstaged=match\tuntracked=match\tstrict_head=false' "${compare_porcelain_output}" "compare porcelain should include per-repo row"
assert_contains $'compare_summary\tsnapshot_id='"${baseline_snapshot_id}"$'\trepos_checked=1\tmismatches=0\twarnings=0\tstrict_head=false' "${compare_porcelain_output}" "compare porcelain should include summary row"

old_user_output="$(cd "${root_repo}" && git_snapshot_test_cmd create user-old)"
old_user_snapshot_id="$(git_snapshot_test_get_snapshot_id_from_create_output "${old_user_output}")"
assert_eq "user-old" "${old_user_snapshot_id}" "user-old snapshot id should be preserved"

sleep 1
new_user_output="$(cd "${root_repo}" && git_snapshot_test_cmd create user-new)"
new_user_snapshot_id="$(git_snapshot_test_get_snapshot_id_from_create_output "${new_user_output}")"
assert_eq "user-new" "${new_user_snapshot_id}" "user-new snapshot id should be preserved"

sleep 1
auto_reset_output="$(cd "${root_repo}" && git_snapshot_test_cmd reset-all --snapshot --porcelain)"
assert_contains $'reset_all_snapshot\tcreated=true\tsnapshot_id=pre-reset-' "${auto_reset_output}" "reset-all snapshot should create auto snapshot"

compare_default_output="$(cd "${root_repo}" && git_snapshot_test_cmd compare)"
assert_contains "Snapshot compare: ${new_user_snapshot_id}" "${compare_default_output}" "compare without id should select latest user-created snapshot"
assert_contains "Selected snapshot mode: latest-user-default" "${compare_default_output}" "compare without id should disclose default target mode"
assert_contains "Snapshot origin: user" "${compare_default_output}" "compare without id should keep user origin"
assert_contains "Shared-folder registry note: target selected from all user-created snapshots in this registry." "${compare_default_output}" "compare without id should disclose shared-registry selection scope"

repo_only_auto="${TEST_REPOS_ROOT}/auto-only"
git_snapshot_test_init_repo "${repo_only_auto}"
git_snapshot_test_commit_file "${repo_only_auto}" "auto.txt" "auto-base" "init auto-only"
auto_only_reset_output="$(cd "${repo_only_auto}" && git_snapshot_test_cmd reset-all --snapshot --porcelain)"
assert_contains $'reset_all_snapshot\tcreated=true\tsnapshot_id=pre-reset-' "${auto_only_reset_output}" "auto-only repo should create auto snapshot"

set +e
compare_no_user_output="$(cd "${repo_only_auto}" && git_snapshot_test_cmd compare 2>&1)"
compare_no_user_code=$?
set -e
assert_exit_code 1 "${compare_no_user_code}" "compare without any user snapshot should fail"
assert_contains "No user-created snapshot found to compare against." "${compare_no_user_output}" "compare should explain missing user snapshot"

repo_a="${TEST_REPOS_ROOT}/tenant-a/shared-name"
repo_b="${TEST_REPOS_ROOT}/tenant-b/shared-name"

git_snapshot_test_init_repo "${repo_a}"
git_snapshot_test_commit_file "${repo_a}" "a.txt" "a-base" "init a"
git_snapshot_test_init_repo "${repo_b}"
git_snapshot_test_commit_file "${repo_b}" "b.txt" "b-base" "init b"
repo_a_real="$(cd "${repo_a}" && pwd -P)"
repo_b_real="$(cd "${repo_b}" && pwd -P)"

shared_a_output="$(cd "${repo_a}" && git_snapshot_test_cmd create shared-user-a)"
shared_a_id="$(git_snapshot_test_get_snapshot_id_from_create_output "${shared_a_output}")"
assert_eq "shared-user-a" "${shared_a_id}" "shared repo A snapshot id should be preserved"

sleep 1
shared_b_output="$(cd "${repo_b}" && git_snapshot_test_cmd create shared-user-b)"
shared_b_id="$(git_snapshot_test_get_snapshot_id_from_create_output "${shared_b_output}")"
assert_eq "shared-user-b" "${shared_b_id}" "shared repo B snapshot id should be preserved"

shared_compare_output="$(cd "${repo_a}" && git_snapshot_test_cmd compare)"
assert_contains "Snapshot compare: ${shared_b_id}" "${shared_compare_output}" "shared-folder compare without id should select latest user snapshot across roots"
assert_contains "Selected snapshot mode: latest-user-default" "${shared_compare_output}" "shared-folder compare should disclose default mode"
assert_contains "Snapshot root: ${repo_b_real}" "${shared_compare_output}" "shared-folder compare should disclose selected snapshot root"
assert_contains "Current root: ${repo_a_real}" "${shared_compare_output}" "shared-folder compare should disclose current root"
