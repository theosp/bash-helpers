#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/../helpers/assertions.bash"
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/../helpers/fixtures.bash"

git_snapshot_test_setup_sandbox
root_repo="$(git_snapshot_test_make_nested_fixture)"

printf "changed\n" >> "${root_repo}/root.txt"
create_output="$(cd "${root_repo}" && git_snapshot_test_cmd create)"
snapshot_id="$(git_snapshot_test_get_snapshot_id_from_create_output "${create_output}")"
assert_non_empty "${snapshot_id}"

list_output="$(cd "${root_repo}" && git_snapshot_test_cmd list)"
assert_contains "${snapshot_id}" "${list_output}" "list should include snapshot id"
assert_contains "Snapshots (" "${list_output}" "list should include human header"
assert_contains "Repos" "${list_output}" "list should include repo count column"

show_output="$(cd "${root_repo}" && git_snapshot_test_cmd show "${snapshot_id}")"
assert_contains "Snapshot: ${snapshot_id}" "${show_output}" "show should include human snapshot header"
assert_contains "Repos: " "${show_output}" "show should include repo count"
assert_contains "Repo: ." "${show_output}" "show should include per-repo sections"
assert_contains "Staged (" "${show_output}" "show should include staged file group"
assert_contains "Restore readiness:" "${show_output}" "show should include restore readiness summary"

list_porcelain_output="$(cd "${root_repo}" && git_snapshot_test_cmd list --porcelain)"
assert_contains $'snapshot\tid='"${snapshot_id}" "${list_porcelain_output}" "list porcelain should include snapshot row"

show_porcelain_output="$(cd "${root_repo}" && git_snapshot_test_cmd show "${snapshot_id}" --porcelain)"
assert_contains "snapshot_id=${snapshot_id}" "${show_porcelain_output}" "show porcelain should include snapshot id"
assert_contains "repo_count=" "${show_porcelain_output}" "show porcelain should include repo count"
assert_contains $'repo\tid=' "${show_porcelain_output}" "show porcelain should include repo rows"
