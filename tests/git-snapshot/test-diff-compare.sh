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

# Create mixed changes so diff output contains all categories.
printf "root-staged\n" >> "${root_repo}/root.txt"
git -C "${root_repo}" add root.txt
printf "root-unstaged\n" >> "${root_repo}/root.txt"
for idx in 1 2 3 4 5; do
  printf "root-untracked-%s\n" "${idx}" > "${root_repo}/root-untracked-${idx}.txt"
done

create_output="$(cd "${root_repo}" && git_snapshot_test_cmd create)"
snapshot_id="$(git_snapshot_test_get_snapshot_id_from_create_output "${create_output}")"
assert_non_empty "${snapshot_id}" "snapshot id should be returned"

diff_output="$(cd "${root_repo}" && git_snapshot_test_cmd diff "${snapshot_id}")"
assert_contains "Snapshot diff: ${snapshot_id}" "${diff_output}" "diff should include snapshot heading"
assert_contains "Repo summary (changed captures only):" "${diff_output}" "diff default should be summary-first"
assert_contains "staged=1" "${diff_output}" "diff summary should include staged count"
assert_contains "unstaged=1" "${diff_output}" "diff summary should include unstaged count"
assert_contains "untracked=5" "${diff_output}" "diff summary should include untracked count"
assert_not_contains "root-untracked-1.txt" "${diff_output}" "diff summary should not include file lists by default"

diff_details_output="$(cd "${root_repo}" && git_snapshot_test_cmd diff "${snapshot_id}" --files)"
assert_contains "Details (name-only mode):" "${diff_details_output}" "diff --files should print detail sections"
assert_contains "Repo: ." "${diff_details_output}" "diff --files should include root repo section"
assert_contains "root-untracked-1.txt" "${diff_details_output}" "diff --files should include file names"

diff_limited_output="$(cd "${root_repo}" && git_snapshot_test_cmd diff "${snapshot_id}" --files --limit 2)"
assert_contains "root-untracked-1.txt" "${diff_limited_output}" "limited output should include some file names"
assert_contains "... +3 more" "${diff_limited_output}" "limited output should include truncation summary for untracked files"

diff_unlimited_output="$(cd "${root_repo}" && git_snapshot_test_cmd diff "${snapshot_id}" --files --no-limit)"
assert_contains "root-untracked-5.txt" "${diff_unlimited_output}" "unlimited output should include all untracked files"
assert_not_contains "... +" "${diff_unlimited_output}" "unlimited output should not include truncation summary"

diff_porcelain_output="$(cd "${root_repo}" && git_snapshot_test_cmd diff "${snapshot_id}" --repo . --all --porcelain)"
assert_contains $'diff\tsnapshot_id='"${snapshot_id}"$'\trepo=.\tcategory=staged' "${diff_porcelain_output}" "diff porcelain should include staged record"
assert_contains $'diff\tsnapshot_id='"${snapshot_id}"$'\trepo=.\tcategory=unstaged' "${diff_porcelain_output}" "diff porcelain should include unstaged record"
assert_contains $'diff\tsnapshot_id='"${snapshot_id}"$'\trepo=.\tcategory=untracked' "${diff_porcelain_output}" "diff porcelain should include untracked record"
assert_contains $'diff_file\trepo=.\tcategory=untracked\tfile=root-untracked-1.txt' "${diff_porcelain_output}" "diff porcelain should include untracked file entry"

# Build a clean snapshot for compare readiness checks.
git -C "${root_repo}" reset --hard >/dev/null
git -C "${root_repo}" clean -fd >/dev/null
git -C "${sub1}" reset --hard >/dev/null
git -C "${sub1}" clean -fd >/dev/null
git -C "${sub2}" reset --hard >/dev/null
git -C "${sub2}" clean -fd >/dev/null

clean_create_output="$(cd "${root_repo}" && git_snapshot_test_cmd create)"
clean_snapshot_id="$(git_snapshot_test_get_snapshot_id_from_create_output "${clean_create_output}")"
assert_non_empty "${clean_snapshot_id}" "clean snapshot id should be returned"

compare_output="$(cd "${root_repo}" && git_snapshot_test_cmd compare "${clean_snapshot_id}")"
assert_contains "Snapshot compare: ${clean_snapshot_id}" "${compare_output}" "compare should include heading"
assert_contains "Compatibility: clean" "${compare_output}" "compare should report clean compatibility for clean snapshot"
assert_contains "No issue repos to list." "${compare_output}" "compare default listing should omit clean repos"
assert_contains "Hint: use --details" "${compare_output}" "compare should provide detail hint in summary mode"

compare_details_output="$(cd "${root_repo}" && git_snapshot_test_cmd compare "${clean_snapshot_id}" --details --all-repos)"
assert_contains "Repo summary (full matrix):" "${compare_details_output}" "compare --all-repos should include full matrix"
assert_contains "status=clean" "${compare_details_output}" "compare --all-repos should include clean status rows"
assert_contains "Details:" "${compare_details_output}" "compare --details should include detail sections"
assert_contains "Repo: ." "${compare_details_output}" "compare details should include repo section"
assert_not_contains $'\t' "${compare_details_output}" "compare details should not include tab-corrupted relation counters"

# Validate compare detail limiting for captured/collision files.
printf "collision-a\n" > "${root_repo}/collision-a.txt"
printf "collision-b\n" > "${root_repo}/collision-b.txt"
printf "collision-c\n" > "${root_repo}/collision-c.txt"

collision_create_output="$(cd "${root_repo}" && git_snapshot_test_cmd create)"
collision_snapshot_id="$(git_snapshot_test_get_snapshot_id_from_create_output "${collision_create_output}")"

set +e
compare_collision_limited="$(cd "${root_repo}" && git_snapshot_test_cmd compare "${collision_snapshot_id}" --details --files --limit 1 2>&1)"
compare_collision_limited_code=$?
set -e
assert_exit_code 3 "${compare_collision_limited_code}" "compare with collisions should return 3"
assert_contains "Collision files (3):" "${compare_collision_limited}" "collision details should include total collision count"
assert_contains "... +2 more" "${compare_collision_limited}" "collision details should be truncated when limit is set"

# Simulate missing nested repo and ensure compare reports issues with exit code 3.
rm -rf "${root_repo}/modules/sub1/modules/sub2"

set +e
compare_fail_output="$(cd "${root_repo}" && git_snapshot_test_cmd compare "${clean_snapshot_id}" 2>&1)"
compare_fail_code=$?
set -e
assert_exit_code 3 "${compare_fail_code}" "compare should return 3 when compatibility issues are found"
assert_contains "Compatibility: issues detected." "${compare_fail_output}" "compare should report issues when a snapshot repo is missing"
assert_contains "status=issues" "${compare_fail_output}" "compare summary should list issue repos"

set +e
compare_fail_porcelain_output="$(cd "${root_repo}" && git_snapshot_test_cmd compare "${clean_snapshot_id}" --files --porcelain 2>&1)"
compare_fail_porcelain_code=$?
set -e
assert_exit_code 3 "${compare_fail_porcelain_code}" "porcelain compare should return 3 on issues"
assert_contains $'compare\tsnapshot_id='"${clean_snapshot_id}"$'\trepo=modules/sub1/modules/sub2' "${compare_fail_porcelain_output}" "porcelain compare should include missing repo row"
assert_contains "has_issues=true" "${compare_fail_porcelain_output}" "porcelain compare should include has_issues marker"
