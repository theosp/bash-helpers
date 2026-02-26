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

# Create mixed changes so inspect output contains all categories.
printf "root-staged\n" >> "${root_repo}/root.txt"
git -C "${root_repo}" add root.txt
printf "root-unstaged\n" >> "${root_repo}/root.txt"
for idx in 1 2 3 4 5; do
  printf "root-untracked-%s\n" "${idx}" > "${root_repo}/root-untracked-${idx}.txt"
done

create_output="$(cd "${root_repo}" && git_snapshot_test_cmd create)"
snapshot_id="$(git_snapshot_test_get_snapshot_id_from_create_output "${create_output}")"
assert_non_empty "${snapshot_id}" "snapshot id should be returned"

inspect_output="$(cd "${root_repo}" && git_snapshot_test_cmd inspect "${snapshot_id}")"
assert_contains "Snapshot inspect: ${snapshot_id}" "${inspect_output}" "inspect should include snapshot heading"
assert_contains "Repo summary (changed captures only):" "${inspect_output}" "inspect default should be summary-first"
assert_contains "  - super [changed]" "${inspect_output}" "inspect summary should display root repo by folder name"
assert_contains "staged=1" "${inspect_output}" "inspect summary should include staged count"
assert_contains "unstaged=1" "${inspect_output}" "inspect summary should include unstaged count"
assert_contains "untracked=5" "${inspect_output}" "inspect summary should include untracked count"
assert_not_contains "root-untracked-1.txt" "${inspect_output}" "inspect summary should not include file lists by default"

inspect_details_output="$(cd "${root_repo}" && git_snapshot_test_cmd inspect "${snapshot_id}" --files)"
assert_contains "Details (name-only mode):" "${inspect_details_output}" "inspect --files should print detail sections"
assert_contains "Repo: super" "${inspect_details_output}" "inspect --files should include root repo section"
assert_contains "root-untracked-1.txt" "${inspect_details_output}" "inspect --files should include file names"

inspect_limited_output="$(cd "${root_repo}" && git_snapshot_test_cmd inspect "${snapshot_id}" --files --limit 2)"
assert_contains "root-untracked-1.txt" "${inspect_limited_output}" "limited output should include some file names"
assert_contains "... +3 more" "${inspect_limited_output}" "limited output should include truncation summary for untracked files"

inspect_unlimited_output="$(cd "${root_repo}" && git_snapshot_test_cmd inspect "${snapshot_id}" --files --no-limit)"
assert_contains "root-untracked-5.txt" "${inspect_unlimited_output}" "unlimited output should include all untracked files"
assert_not_contains "... +" "${inspect_unlimited_output}" "unlimited output should not include truncation summary"

inspect_porcelain_output="$(cd "${root_repo}" && git_snapshot_test_cmd inspect "${snapshot_id}" --repo . --all --porcelain)"
assert_contains $'inspect\tsnapshot_id='"${snapshot_id}"$'\trepo=.\tcategory=staged' "${inspect_porcelain_output}" "inspect porcelain should include staged record"
assert_contains $'inspect\tsnapshot_id='"${snapshot_id}"$'\trepo=.\tcategory=unstaged' "${inspect_porcelain_output}" "inspect porcelain should include unstaged record"
assert_contains $'inspect\tsnapshot_id='"${snapshot_id}"$'\trepo=.\tcategory=untracked' "${inspect_porcelain_output}" "inspect porcelain should include untracked record"
assert_contains $'inspect_file\trepo=.\tcategory=untracked\tfile=root-untracked-1.txt' "${inspect_porcelain_output}" "inspect porcelain should include untracked file entry"

# Build a clean snapshot for restore-check readiness checks.
git -C "${root_repo}" reset --hard >/dev/null
git -C "${root_repo}" clean -fd >/dev/null
git -C "${sub1}" reset --hard >/dev/null
git -C "${sub1}" clean -fd >/dev/null
git -C "${sub2}" reset --hard >/dev/null
git -C "${sub2}" clean -fd >/dev/null

clean_create_output="$(cd "${root_repo}" && git_snapshot_test_cmd create)"
clean_snapshot_id="$(git_snapshot_test_get_snapshot_id_from_create_output "${clean_create_output}")"
assert_non_empty "${clean_snapshot_id}" "clean snapshot id should be returned"

restore_check_output="$(cd "${root_repo}" && git_snapshot_test_cmd restore-check "${clean_snapshot_id}")"
assert_contains "Snapshot restore-check: ${clean_snapshot_id}" "${restore_check_output}" "restore-check should include heading"
assert_contains "Compatibility: clean" "${restore_check_output}" "restore-check should report clean compatibility for clean snapshot"
assert_contains "No issue repos to list." "${restore_check_output}" "restore-check default listing should omit clean repos"
assert_contains "Hint: use --details" "${restore_check_output}" "restore-check should provide detail hint in summary mode"

restore_check_details_output="$(cd "${root_repo}" && git_snapshot_test_cmd restore-check "${clean_snapshot_id}" --details --all-repos)"
assert_contains "Repo summary (full matrix):" "${restore_check_details_output}" "restore-check --all-repos should include full matrix"
assert_contains "status=clean" "${restore_check_details_output}" "restore-check --all-repos should include clean status rows"
assert_contains "Details:" "${restore_check_details_output}" "restore-check --details should include detail sections"
assert_contains "  - super status=clean" "${restore_check_details_output}" "restore-check summary should display root repo by folder name"
assert_contains "Repo: super" "${restore_check_details_output}" "restore-check details should include root repo section"
assert_not_contains $'\t' "${restore_check_details_output}" "restore-check details should not include tab-corrupted relation counters"

# Validate restore-check detail limiting for captured/collision files.
printf "collision-a\n" > "${root_repo}/collision-a.txt"
printf "collision-b\n" > "${root_repo}/collision-b.txt"
printf "collision-c\n" > "${root_repo}/collision-c.txt"

collision_create_output="$(cd "${root_repo}" && git_snapshot_test_cmd create)"
collision_snapshot_id="$(git_snapshot_test_get_snapshot_id_from_create_output "${collision_create_output}")"

set +e
restore_check_collision_limited="$(cd "${root_repo}" && git_snapshot_test_cmd restore-check "${collision_snapshot_id}" --details --files --limit 1 2>&1)"
restore_check_collision_limited_code=$?
set -e
assert_exit_code 3 "${restore_check_collision_limited_code}" "restore-check with collisions should return 3"
assert_contains "Collision files (3):" "${restore_check_collision_limited}" "collision details should include total collision count"
assert_contains "... +2 more" "${restore_check_collision_limited}" "collision details should be truncated when limit is set"

# Simulate missing nested repo and ensure restore-check reports issues with exit code 3.
rm -rf "${root_repo}/modules/sub1/modules/sub2"

set +e
restore_check_fail_output="$(cd "${root_repo}" && git_snapshot_test_cmd restore-check "${clean_snapshot_id}" 2>&1)"
restore_check_fail_code=$?
set -e
assert_exit_code 3 "${restore_check_fail_code}" "restore-check should return 3 when compatibility issues are found"
assert_contains "Compatibility: issues detected." "${restore_check_fail_output}" "restore-check should report issues when a snapshot repo is missing"
assert_contains "status=issues" "${restore_check_fail_output}" "restore-check summary should list issue repos"

set +e
restore_check_fail_porcelain_output="$(cd "${root_repo}" && git_snapshot_test_cmd restore-check "${clean_snapshot_id}" --files --porcelain 2>&1)"
restore_check_fail_porcelain_code=$?
set -e
assert_exit_code 3 "${restore_check_fail_porcelain_code}" "porcelain restore-check should return 3 on issues"
assert_contains $'restore_check\tsnapshot_id='"${clean_snapshot_id}"$'\trepo=modules/sub1/modules/sub2' "${restore_check_fail_porcelain_output}" "porcelain restore-check should include missing repo row"
assert_contains "has_issues=true" "${restore_check_fail_porcelain_output}" "porcelain restore-check should include has_issues marker"
