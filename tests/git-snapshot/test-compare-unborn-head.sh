#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/../helpers/assertions.bash"
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/../helpers/fixtures.bash"

git_snapshot_test_setup_sandbox
repo="${TEST_REPOS_ROOT}/unborn-compare"

git_snapshot_test_init_repo "${repo}"
printf "unborn-staged\n" > "${repo}/unborn.txt"
git -C "${repo}" add unborn.txt

create_output="$(cd "${repo}" && git_snapshot_test_cmd create compare-unborn)"
snapshot_id="$(git_snapshot_test_get_snapshot_id_from_create_output "${create_output}")"
assert_eq "compare-unborn" "${snapshot_id}" "unborn snapshot id should be preserved"

set +e
compare_default_output="$(cd "${repo}" && git_snapshot_test_cmd compare "${snapshot_id}" --repo . 2>&1)"
compare_default_code=$?
set -e

assert_exit_code 0 "${compare_default_code}" "compare should succeed for snapshot captured from unborn HEAD"
assert_contains "Compare: no unresolved snapshot work." "${compare_default_output}" "unborn compare should complete successfully"
assert_contains "No rows to display for current visibility filter." "${compare_default_output}" "default compare should hide resolved rows for unborn snapshot"

compare_all_output="$(cd "${repo}" && git_snapshot_test_cmd compare "${snapshot_id}" --repo . --all)"
assert_contains "unborn.txt [resolved_uncommitted]" "${compare_all_output}" "unborn snapshot target should classify as resolved_uncommitted before first commit"

git -C "${repo}" commit -m "commit unborn snapshot target" >/dev/null

compare_committed_output="$(cd "${repo}" && git_snapshot_test_cmd compare "${snapshot_id}" --repo . --all)"
assert_contains "unborn.txt [resolved_committed]" "${compare_committed_output}" "unborn snapshot target should classify as resolved_committed after first commit"
