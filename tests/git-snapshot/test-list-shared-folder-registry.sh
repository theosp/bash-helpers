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
repo_a_real="$(cd "${repo_a}" && pwd -P)"
repo_b_real="$(cd "${repo_b}" && pwd -P)"

printf "a-change\n" >> "${repo_a}/a.txt"
snapshot_a_output="$(cd "${repo_a}" && git_snapshot_test_cmd create copy-a)"
snapshot_a_id="$(git_snapshot_test_get_snapshot_id_from_create_output "${snapshot_a_output}")"
assert_eq "copy-a" "${snapshot_a_id}" "snapshot id from first repo should be preserved"

sleep 1
printf "b-change\n" >> "${repo_b}/b.txt"
snapshot_b_output="$(cd "${repo_b}" && git_snapshot_test_cmd create copy-b)"
snapshot_b_id="$(git_snapshot_test_get_snapshot_id_from_create_output "${snapshot_b_output}")"
assert_eq "copy-b" "${snapshot_b_id}" "snapshot id from second repo should be preserved"

snapshot_root_a="$(git_snapshot_test_snapshot_root_for_repo "${repo_a}")"
snapshot_root_b="$(git_snapshot_test_snapshot_root_for_repo "${repo_b}")"
assert_eq "${snapshot_root_a}" "${snapshot_root_b}" "repos sharing the same folder name should share the same snapshot root"

list_output="$(cd "${repo_a}" && git_snapshot_test_cmd list)"
assert_contains "${snapshot_a_id}" "${list_output}" "list should include snapshot from first repo copy"
assert_contains "${snapshot_b_id}" "${list_output}" "list should include snapshot from second repo copy"
assert_contains "${repo_a_real}" "${list_output}" "list should show root path for first repo snapshot"
assert_contains "${repo_b_real}" "${list_output}" "list should show root path for second repo snapshot"
assert_contains "Root" "${list_output}" "list should include root column"
assert_contains "Note: snapshot registry is keyed by root repo folder name." "${list_output}" "list should include shared registry note"
first_snapshot_id="$(printf "%s\n" "${list_output}" | awk '
  /^ID[[:space:]]+Created[[:space:]]+Age[[:space:]]+Repos/ {in_table=1; next}
  in_table && $1 != "" {print $1; exit}
')"
assert_eq "${snapshot_b_id}" "${first_snapshot_id}" "list should sort snapshots newest-first regardless of root path"

list_porcelain_output="$(cd "${repo_a}" && git_snapshot_test_cmd list --porcelain)"
assert_contains $'snapshot\tid=copy-a\t' "${list_porcelain_output}" "porcelain list should include snapshot from first repo copy"
assert_contains $'snapshot\tid=copy-b\t' "${list_porcelain_output}" "porcelain list should include snapshot from second repo copy"
assert_contains "root_repo=${repo_a_real}" "${list_porcelain_output}" "porcelain list should include first snapshot root path"
assert_contains "root_repo=${repo_b_real}" "${list_porcelain_output}" "porcelain list should include second snapshot root path"
