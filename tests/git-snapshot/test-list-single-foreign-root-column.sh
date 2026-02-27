#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/../helpers/assertions.bash"
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/../helpers/fixtures.bash"

git_snapshot_test_setup_sandbox

repo_a="${TEST_REPOS_ROOT}/tenant-a/shared-name"
repo_b="${TEST_REPOS_ROOT}/tenant-b/shared-name"

git_snapshot_test_init_repo "${repo_a}"
git_snapshot_test_commit_file "${repo_a}" "a.txt" "a-base" "init a"
git_snapshot_test_init_repo "${repo_b}"
git_snapshot_test_commit_file "${repo_b}" "b.txt" "b-base" "init b"
repo_b_real="$(cd "${repo_b}" && pwd -P)"

# Create only one snapshot from repo_b; list from repo_a should show Root
# because the only visible snapshot is foreign to current root.
printf "b-change\n" >> "${repo_b}/b.txt"
create_output="$(cd "${repo_b}" && git_snapshot_test_cmd create foreign-only)"
snapshot_id="$(git_snapshot_test_get_snapshot_id_from_create_output "${create_output}")"
assert_eq "foreign-only" "${snapshot_id}" "foreign snapshot id should be preserved"

list_output="$(cd "${repo_a}" && git_snapshot_test_cmd list)"
assert_contains "${snapshot_id}" "${list_output}" "list should include foreign snapshot id"
assert_contains "Root:" "${list_output}" "list should include root field when only visible snapshot is foreign"
assert_contains "${repo_b_real}" "${list_output}" "list should show foreign root path"
assert_contains "Note: snapshot registry is keyed by root repo folder name." "${list_output}" "list should include shared registry note"
