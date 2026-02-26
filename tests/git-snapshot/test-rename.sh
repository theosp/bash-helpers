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

printf "rename-base\n" >> "${root_repo}/root.txt"
create_output="$(cd "${root_repo}" && git_snapshot_test_cmd create)"
old_snapshot_id="$(git_snapshot_test_get_snapshot_id_from_create_output "${create_output}")"
assert_non_empty "${old_snapshot_id}" "create should return snapshot id"

created_before="$(cd "${root_repo}" && git_snapshot_test_cmd show "${old_snapshot_id}" --porcelain | grep '^created_at_epoch=' | cut -d= -f2-)"
assert_non_empty "${created_before}" "show porcelain should include created_at_epoch"

new_snapshot_id="renamed-snapshot"
rename_output="$(cd "${root_repo}" && git_snapshot_test_cmd rename "${old_snapshot_id}" "${new_snapshot_id}")"
assert_contains "Renamed snapshot ${old_snapshot_id} -> ${new_snapshot_id}" "${rename_output}" "rename should report success"

assert_file_not_exists "${snapshot_root}/${old_snapshot_id}" "old snapshot path should be removed"
assert_file_exists "${snapshot_root}/${new_snapshot_id}" "new snapshot path should exist"

list_output="$(cd "${root_repo}" && git_snapshot_test_cmd list)"
assert_contains "${new_snapshot_id}" "${list_output}" "list should include renamed id"
assert_not_contains "${old_snapshot_id}" "${list_output}" "list should exclude old id after rename"

show_after="$(cd "${root_repo}" && git_snapshot_test_cmd show "${new_snapshot_id}" --porcelain)"
assert_contains "snapshot_id=${new_snapshot_id}" "${show_after}" "show should resolve new snapshot id"
created_after="$(printf "%s\n" "${show_after}" | grep '^created_at_epoch=' | cut -d= -f2-)"
assert_eq "${created_before}" "${created_after}" "rename should preserve creation epoch"

set +e
show_old_output="$(cd "${root_repo}" && git_snapshot_test_cmd show "${old_snapshot_id}" 2>&1)"
show_old_code=$?
set -e
assert_exit_code 1 "${show_old_code}" "old snapshot id should stop resolving after rename"
assert_contains "Snapshot not found" "${show_old_output}" "old id show should fail clearly"

porcelain_new_id="renamed-snapshot-porcelain"
rename_porcelain_output="$(cd "${root_repo}" && git_snapshot_test_cmd rename "${new_snapshot_id}" "${porcelain_new_id}" --porcelain)"
assert_contains $'renamed\told_id=renamed-snapshot\tnew_id=renamed-snapshot-porcelain' "${rename_porcelain_output}" "rename porcelain output should be stable"

subdir_new_id="renamed-from-subdir"
subdir_output="$(cd "${root_repo}/modules/sub1" && git_snapshot_test_cmd rename "${porcelain_new_id}" "${subdir_new_id}")"
assert_contains "Renamed snapshot ${porcelain_new_id} -> ${subdir_new_id}" "${subdir_output}" "rename should work from nested subdirectory scope"
assert_file_exists "${snapshot_root}/${subdir_new_id}" "subdir rename should resolve root-most snapshot store"

cd "${root_repo}" && git_snapshot_test_cmd create taken-target >/dev/null

set +e
exists_output="$(cd "${root_repo}" && git_snapshot_test_cmd rename "${subdir_new_id}" "taken-target" 2>&1)"
exists_code=$?
set -e
assert_exit_code 1 "${exists_code}" "rename should fail if target id exists"
assert_contains "Snapshot already exists" "${exists_output}" "existing target error should be explicit"

set +e
missing_output="$(cd "${root_repo}" && git_snapshot_test_cmd rename missing-source "new-id" 2>&1)"
missing_code=$?
set -e
assert_exit_code 1 "${missing_code}" "rename should fail if source id is missing"
assert_contains "Snapshot not found" "${missing_output}" "missing source error should be explicit"

set +e
same_output="$(cd "${root_repo}" && git_snapshot_test_cmd rename "${subdir_new_id}" "${subdir_new_id}" 2>&1)"
same_code=$?
set -e
assert_exit_code 1 "${same_code}" "rename should fail when old and new ids are the same"
assert_contains "must differ" "${same_output}" "same id error should be explicit"

set +e
invalid_output="$(cd "${root_repo}" && git_snapshot_test_cmd rename "${subdir_new_id}" "bad/id" 2>&1)"
invalid_code=$?
set -e
assert_exit_code 1 "${invalid_code}" "rename should validate destination id format"
assert_contains "Invalid snapshot_id" "${invalid_output}" "invalid id error should be explicit"
