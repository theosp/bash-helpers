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
assert_not_contains "Repos Root" "${list_output}" "single-root list should not include root column"
assert_contains "Note: snapshot registry is keyed by root repo folder name." "${list_output}" "list should include shared registry note"

inspect_output="$(cd "${root_repo}" && git_snapshot_test_cmd inspect "${snapshot_id}")"
assert_contains "Snapshot inspect: ${snapshot_id}" "${inspect_output}" "inspect should include human snapshot header"
assert_contains "Repos in scope: " "${inspect_output}" "inspect should include repo count summary"
assert_contains "Repo: super" "${inspect_output}" "inspect should display root repo by folder name"
assert_contains "Details (stat mode):" "${inspect_output}" "inspect default should render stat details"
assert_contains "Hint: use --name-only for file paths or --diff for full patch output." "${inspect_output}" "inspect should include hint for alternate render modes"

list_porcelain_output="$(cd "${root_repo}" && git_snapshot_test_cmd list --porcelain)"
assert_contains $'snapshot\tid='"${snapshot_id}" "${list_porcelain_output}" "list porcelain should include snapshot row"
assert_contains "origin=user" "${list_porcelain_output}" "list porcelain should include snapshot origin metadata"

inspect_porcelain_output="$(cd "${root_repo}" && git_snapshot_test_cmd inspect "${snapshot_id}" --porcelain)"
assert_contains $'inspect\tsnapshot_id='"${snapshot_id}" "${inspect_porcelain_output}" "inspect porcelain should include snapshot id"
assert_contains $'inspect_file\trepo=' "${inspect_porcelain_output}" "inspect porcelain should include file rows"
