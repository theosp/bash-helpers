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
assert_contains "repos=" "${list_output}" "list should include repo count"

show_output="$(cd "${root_repo}" && git_snapshot_test_cmd show "${snapshot_id}")"
assert_contains "snapshot_id=${snapshot_id}" "${show_output}"
assert_contains "repo_count=" "${show_output}"
assert_contains $'repo\tid=' "${show_output}" "show should include repo rows"
assert_contains "status_hash=" "${show_output}" "show should include status hash"
