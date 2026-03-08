#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/../helpers/assertions.bash"
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/../helpers/fixtures.bash"

git_snapshot_test_setup_sandbox
root_repo="$(git_snapshot_test_make_nested_fixture)"
sub1="${root_repo}/modules/sub1"
sub2="${sub1}/modules/sub2"

# Add mixed changes in all levels.
printf "root-staged\n" >> "${root_repo}/root.txt"
git -C "${root_repo}" add root.txt
printf "root-unstaged\n" >> "${root_repo}/root.txt"
printf "root-untracked\n" > "${root_repo}/new-root.txt"

printf "sub1-staged\n" >> "${sub1}/sub1.txt"
git -C "${sub1}" add sub1.txt
printf "sub1-unstaged\n" >> "${sub1}/sub1.txt"
printf "sub1-untracked\n" > "${sub1}/new-sub1.txt"

printf "sub2-staged\n" >> "${sub2}/sub2.txt"
git -C "${sub2}" add sub2.txt
printf "sub2-unstaged\n" >> "${sub2}/sub2.txt"
printf "sub2-untracked\n" > "${sub2}/new-sub2.txt"

create_output="$(cd "${sub2}" && git_snapshot_test_cmd create pause-work --clear --yes)"
snapshot_id="$(git_snapshot_test_get_snapshot_id_from_create_output "${create_output}")"
assert_eq "pause-work" "${snapshot_id}" "create --clear should preserve explicit snapshot id"
assert_contains "Clear completed" "${create_output}" "create --clear should report clear completion"

snapshot_root="$(git_snapshot_test_snapshot_root_for_repo "${root_repo}")"
assert_file_exists "${snapshot_root}/${snapshot_id}/meta.env" "snapshot metadata should exist after clear flow"

dirty_output="$(git_snapshot_test_collect_dirty_relative_paths "${root_repo}")"
assert_eq "" "${dirty_output}" "create --clear should leave no dirty repos in normal cases"

assert_file_not_exists "${root_repo}/new-root.txt" "root untracked should be removed by clear"
assert_file_not_exists "${sub1}/new-sub1.txt" "sub1 untracked should be removed by clear"
assert_file_not_exists "${sub2}/new-sub2.txt" "sub2 untracked should be removed by clear"

compare_after_clear_output="$(cd "${root_repo}" && git_snapshot_test_cmd compare "${snapshot_id}" --all --porcelain)"
assert_eq "v3" "$(git_snapshot_test_extract_porcelain_field "${compare_after_clear_output}" "compare_summary" "engine")" "create --clear compare should use v3 engine"
assert_ne "0" "$(git_snapshot_test_extract_porcelain_field "${compare_after_clear_output}" "compare_summary" "unresolved_total")" "create --clear compare should expose unresolved snapshot work"

set +e
restore_check_output="$(cd "${root_repo}" && git_snapshot_test_cmd restore-check "${snapshot_id}" --all-repos --porcelain 2>&1)"
restore_check_code=$?
set -e
assert_exit_code 0 "${restore_check_code}" "create --clear restore-check should stay clean"
assert_not_contains "has_issues=true" "${restore_check_output}" "create --clear restore-check should report no blocking issues"

export GIT_SNAPSHOT_CONFIRM_RESTORE="RESTORE"
restore_output="$(cd "${root_repo}" && git_snapshot_test_cmd restore "${snapshot_id}" --on-conflict rollback --porcelain)"
assert_contains $'restore_summary\tsnapshot_id='"${snapshot_id}"$'\tmode=rollback\tresult=success' "${restore_output}" "create --clear snapshot should restore successfully"
assert_contains "exit_code=0" "${restore_output}" "create --clear restore should return success exit code"

compare_after_restore_output="$(cd "${root_repo}" && git_snapshot_test_cmd compare "${snapshot_id}" --all --porcelain)"
assert_eq "0" "$(git_snapshot_test_extract_porcelain_field "${compare_after_restore_output}" "compare_summary" "unresolved_total")" "create --clear compare should return to zero unresolved items after restore"
