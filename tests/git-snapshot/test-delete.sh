#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/../helpers/assertions.bash"
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/../helpers/fixtures.bash"

git_snapshot_test_setup_sandbox
root_repo="$(git_snapshot_test_make_nested_fixture)"

printf "to-delete\n" >> "${root_repo}/root.txt"
create_output="$(cd "${root_repo}" && git_snapshot_test_cmd create)"
snapshot_id="$(git_snapshot_test_get_snapshot_id_from_create_output "${create_output}")"

snapshot_root="$(git_snapshot_test_snapshot_root_for_repo "${root_repo}")"
snapshot_path="${snapshot_root}/${snapshot_id}"
assert_file_exists "${snapshot_path}" "snapshot should exist before delete"

cd "${root_repo}" && git_snapshot_test_cmd delete "${snapshot_id}" >/dev/null
assert_file_not_exists "${snapshot_path}" "snapshot dir should be removed"

list_output="$(cd "${root_repo}" && git_snapshot_test_cmd list)"
assert_not_contains "${snapshot_id}" "${list_output}" "deleted snapshot should not appear in list"
