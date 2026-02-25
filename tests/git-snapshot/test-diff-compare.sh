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
printf "root-untracked\n" > "${root_repo}/root-untracked.txt"

create_output="$(cd "${root_repo}" && git_snapshot_test_cmd create)"
snapshot_id="$(git_snapshot_test_get_snapshot_id_from_create_output "${create_output}")"
assert_non_empty "${snapshot_id}" "snapshot id should be returned"

diff_output="$(cd "${root_repo}" && git_snapshot_test_cmd diff "${snapshot_id}")"
assert_contains "Snapshot diff: ${snapshot_id}" "${diff_output}" "diff should include snapshot heading"
assert_contains "Repo: ." "${diff_output}" "diff should include root repo section"
assert_contains "Staged (" "${diff_output}" "diff should include staged category"
assert_contains "Unstaged (" "${diff_output}" "diff should include unstaged category"
assert_contains "Untracked (" "${diff_output}" "diff should include untracked category"
assert_contains "root-untracked.txt" "${diff_output}" "diff should list captured untracked files"

diff_porcelain_output="$(cd "${root_repo}" && git_snapshot_test_cmd diff "${snapshot_id}" --repo . --all --porcelain)"
assert_contains $'diff\tsnapshot_id='"${snapshot_id}"$'\trepo=.\tcategory=staged' "${diff_porcelain_output}" "diff porcelain should include staged record"
assert_contains $'diff\tsnapshot_id='"${snapshot_id}"$'\trepo=.\tcategory=unstaged' "${diff_porcelain_output}" "diff porcelain should include unstaged record"
assert_contains $'diff\tsnapshot_id='"${snapshot_id}"$'\trepo=.\tcategory=untracked' "${diff_porcelain_output}" "diff porcelain should include untracked record"
assert_contains $'diff_file\trepo=.\tcategory=untracked\tfile=root-untracked.txt' "${diff_porcelain_output}" "diff porcelain should include untracked file entry"

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

compare_output="$(cd "${root_repo}" && git_snapshot_test_cmd compare "${clean_snapshot_id}" --files)"
assert_contains "Snapshot compare: ${clean_snapshot_id}" "${compare_output}" "compare should include heading"
assert_contains "Compatibility: clean" "${compare_output}" "compare should report clean compatibility for clean snapshot"

# Simulate missing nested repo and ensure compare reports issues with exit code 3.
rm -rf "${root_repo}/modules/sub1/modules/sub2"

set +e
compare_fail_output="$(cd "${root_repo}" && git_snapshot_test_cmd compare "${clean_snapshot_id}" --files 2>&1)"
compare_fail_code=$?
set -e
assert_exit_code 3 "${compare_fail_code}" "compare should return 3 when compatibility issues are found"
assert_contains "Compatibility: issues" "${compare_fail_output}" "compare should report issues when a snapshot repo is missing"

set +e
compare_fail_porcelain_output="$(cd "${root_repo}" && git_snapshot_test_cmd compare "${clean_snapshot_id}" --files --porcelain 2>&1)"
compare_fail_porcelain_code=$?
set -e
assert_exit_code 3 "${compare_fail_porcelain_code}" "porcelain compare should return 3 on issues"
assert_contains $'compare\tsnapshot_id='"${clean_snapshot_id}"$'\trepo=modules/sub1/modules/sub2' "${compare_fail_porcelain_output}" "porcelain compare should include missing repo row"
assert_contains "has_issues=true" "${compare_fail_porcelain_output}" "porcelain compare should include has_issues marker"
