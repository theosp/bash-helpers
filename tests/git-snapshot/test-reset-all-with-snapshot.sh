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
printf "root-untracked\n" > "${root_repo}/reset-all-root.txt"

printf "sub1-staged\n" >> "${sub1}/sub1.txt"
git -C "${sub1}" add sub1.txt
printf "sub1-unstaged\n" >> "${sub1}/sub1.txt"
printf "sub1-untracked\n" > "${sub1}/reset-all-sub1.txt"

printf "sub2-staged\n" >> "${sub2}/sub2.txt"
git -C "${sub2}" add sub2.txt
printf "sub2-unstaged\n" >> "${sub2}/sub2.txt"
printf "sub2-untracked\n" > "${sub2}/reset-all-sub2.txt"

user_snapshot_output="$(cd "${root_repo}" && git_snapshot_test_cmd create user-before-reset)"
user_snapshot_id="$(git_snapshot_test_get_snapshot_id_from_create_output "${user_snapshot_output}")"
assert_eq "user-before-reset" "${user_snapshot_id}" "explicit user snapshot should be preserved before reset-all"

reset_output="$(cd "${root_repo}" && git_snapshot_test_cmd reset-all --snapshot 2>&1)"
assert_contains "Created auto snapshot" "${reset_output}" "reset-all --snapshot should create auto snapshot"
assert_contains "Clear completed" "${reset_output}" "reset-all should report clear completion"

auto_snapshot_id="$(printf "%s\n" "${reset_output}" | sed -n 's/.*Created auto snapshot \([^[:space:]]*\) before reset-all\./\1/p' | tail -n 1)"
assert_non_empty "${auto_snapshot_id}" "reset-all --snapshot should print created auto snapshot id"
assert_contains "pre-reset-" "${auto_snapshot_id}" "reset-all auto snapshot id should use pre-reset prefix"

snapshot_root="$(git_snapshot_test_snapshot_root_for_repo "${root_repo}")"
assert_file_exists "${snapshot_root}/${auto_snapshot_id}/meta.env" "auto snapshot metadata should exist"

dirty_output="$(git_snapshot_test_collect_dirty_relative_paths "${root_repo}")"
assert_eq "" "${dirty_output}" "reset-all --snapshot should leave no dirty repos"

assert_file_not_exists "${root_repo}/reset-all-root.txt" "root untracked should be removed by reset-all"
assert_file_not_exists "${sub1}/reset-all-sub1.txt" "sub1 untracked should be removed by reset-all"
assert_file_not_exists "${sub2}/reset-all-sub2.txt" "sub2 untracked should be removed by reset-all"

list_default_output="$(cd "${root_repo}" && git_snapshot_test_cmd list)"
assert_not_contains "${auto_snapshot_id}" "${list_default_output}" "default list should hide reset-all auto snapshot"
assert_contains "Hint: 1 auto-generated snapshot(s) hidden. Run: git-snapshot list --include-auto" "${list_default_output}" "default list should report hidden reset-all auto snapshots"

list_all_output="$(cd "${root_repo}" && git_snapshot_test_cmd list --include-auto)"
assert_contains "${auto_snapshot_id}" "${list_all_output}" "include-auto list should include reset-all auto snapshot"
assert_contains "Auto: *" "${list_all_output}" "include-auto list should show auto marker on details line"
assert_contains "* = auto-generated snapshot" "${list_all_output}" "include-auto list should show auto marker legend"
auto_details="$(printf "%s\n" "${list_all_output}" | awk -v sid="${auto_snapshot_id}" '$0 == sid {getline; print; exit}')"
assert_contains "Auto: *" "${auto_details}" "reset-all auto snapshot details should include marker"

list_porcelain_output="$(cd "${root_repo}" && git_snapshot_test_cmd list --include-auto --porcelain)"
assert_contains $'snapshot\tid='"${auto_snapshot_id}"$'\t' "${list_porcelain_output}" "include-auto porcelain should include reset-all auto snapshot"
assert_contains "origin=auto" "${list_porcelain_output}" "include-auto porcelain should mark reset-all snapshot origin=auto"

default_compare_output="$(cd "${root_repo}" && git_snapshot_test_cmd compare --all --porcelain)"
assert_contains $'compare_target\tselected_snapshot_id='"${user_snapshot_id}"$'\tselection_mode=latest-user-default\tsnapshot_origin=user' "${default_compare_output}" "no-id compare should still prefer the latest user snapshot over newer auto snapshots"

set +e
restore_check_output="$(cd "${root_repo}" && git_snapshot_test_cmd restore-check "${auto_snapshot_id}" --all-repos --porcelain 2>&1)"
restore_check_code=$?
set -e
assert_exit_code 0 "${restore_check_code}" "auto snapshot restore-check should stay clean after reset-all"
assert_not_contains "has_issues=true" "${restore_check_output}" "auto snapshot restore-check should report no blocking issues"

export GIT_SNAPSHOT_CONFIRM_RESTORE="RESTORE"
restore_output="$(cd "${root_repo}" && git_snapshot_test_cmd restore "${auto_snapshot_id}" --on-conflict rollback --porcelain)"
assert_contains $'restore_summary\tsnapshot_id='"${auto_snapshot_id}"$'\tmode=rollback\tresult=success' "${restore_output}" "reset-all auto snapshot should restore successfully"
assert_contains "exit_code=0" "${restore_output}" "reset-all auto snapshot restore should return success exit code"

compare_after_restore_output="$(cd "${root_repo}" && git_snapshot_test_cmd compare "${auto_snapshot_id}" --all --porcelain)"
assert_eq "0" "$(git_snapshot_test_extract_porcelain_field "${compare_after_restore_output}" "compare_summary" "unresolved_total")" "auto snapshot compare should return to zero unresolved items after restore"
