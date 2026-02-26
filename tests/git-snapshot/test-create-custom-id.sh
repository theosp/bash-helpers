#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/../helpers/assertions.bash"
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/../helpers/fixtures.bash"

git_snapshot_test_setup_sandbox
root_repo="$(git_snapshot_test_make_nested_fixture)"
snapshot_root="$(git_snapshot_test_snapshot_root_for_repo "${root_repo}")"

custom_snapshot_id="xyz"
create_output="$(cd "${root_repo}" && git_snapshot_test_cmd create "${custom_snapshot_id}")"
created_id="$(git_snapshot_test_get_snapshot_id_from_create_output "${create_output}")"

assert_eq "${custom_snapshot_id}" "${created_id}" "explicit snapshot id should be preserved"
assert_file_exists "${snapshot_root}/${custom_snapshot_id}/meta.env" "snapshot should be created under explicit id"

inspect_output="$(cd "${root_repo}" && git_snapshot_test_cmd inspect "${custom_snapshot_id}")"
assert_contains "Snapshot inspect: ${custom_snapshot_id}" "${inspect_output}" "inspect should resolve explicit snapshot id (human)"

inspect_porcelain_output="$(cd "${root_repo}" && git_snapshot_test_cmd inspect "${custom_snapshot_id}" --porcelain)"
assert_contains $'inspect\tsnapshot_id='"${custom_snapshot_id}" "${inspect_porcelain_output}" "inspect porcelain should resolve explicit snapshot id"

set +e
dup_output="$(cd "${root_repo}" && git_snapshot_test_cmd create "${custom_snapshot_id}" 2>&1)"
dup_code=$?
set -e
assert_exit_code 1 "${dup_code}" "duplicate explicit snapshot id should fail"
assert_contains "Snapshot already exists" "${dup_output}" "duplicate id error should be explicit"

set +e
invalid_output="$(cd "${root_repo}" && git_snapshot_test_cmd create "bad/id" 2>&1)"
invalid_code=$?
set -e
assert_exit_code 1 "${invalid_code}" "invalid snapshot id should fail"
assert_contains "Invalid snapshot_id" "${invalid_output}" "invalid id error should be explicit"
