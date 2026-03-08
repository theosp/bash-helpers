#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/../helpers/assertions.bash"
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/../helpers/fixtures.bash"

git_snapshot_test_setup_sandbox
root_repo="$(git_snapshot_test_make_nested_fixture)"

create_output="$(cd "${root_repo}" && git_snapshot_test_cmd create)"
snapshot_id="$(git_snapshot_test_get_snapshot_id_from_create_output "${create_output}")"

snapshot_root="$(git_snapshot_test_snapshot_root_for_repo "${root_repo}")"
snapshot_path="${snapshot_root}/${snapshot_id}"
meta_file="${snapshot_path}/meta.env"
renamed_snapshot_path="${snapshot_root}/renamed-snapshot"

meta_b64() {
  local value="$1"
  printf "%s" "${value}" | base64 | tr -d '\n'
}

write_v3_meta() {
  {
    printf "FORMAT=git_snapshot_meta_v3\n"
    printf "SNAPSHOT_ID_B64=%s\n" "$(meta_b64 "${snapshot_id}")"
    printf "CREATED_AT_EPOCH=%s\n" "$(date +%s)"
    printf "ROOT_REPO_B64=%s\n" "$(meta_b64 "${root_repo}")"
    printf "REPO_COUNT=3\n"
    printf "SNAPSHOT_ORIGIN=user\n"
  } > "${meta_file}"
}

write_formatless_meta() {
  {
    printf "SNAPSHOT_ID_B64=%s\n" "$(meta_b64 "${snapshot_id}")"
    printf "CREATED_AT_EPOCH=%s\n" "$(date +%s)"
    printf "ROOT_REPO_B64=%s\n" "$(meta_b64 "${root_repo}")"
    printf "REPO_COUNT=3\n"
    printf "SNAPSHOT_ORIGIN=user\n"
  } > "${meta_file}"
}

assert_command_fails() {
  local expected="$1"
  local description="$2"
  shift 2

  local output=""
  local code=0
  set +e
  output="$(cd "${root_repo}" && git_snapshot_test_cmd "$@" 2>&1)"
  code=$?
  set -e

  assert_exit_code 1 "${code}" "${description}"
  assert_contains "${expected}" "${output}" "${description}"
}

write_v3_meta
assert_command_fails "Unsupported snapshot metadata format in ${meta_file}: git_snapshot_meta_v3" "list should reject v3 snapshot metadata" list --porcelain

write_formatless_meta
assert_command_fails "Snapshot metadata format is missing in ${meta_file}" "list should reject formatless snapshot metadata" list --porcelain
assert_command_fails "Snapshot metadata format is missing in ${meta_file}" "explicit compare should reject formatless snapshot metadata" compare "${snapshot_id}" --repo .
assert_command_fails "Snapshot metadata format is missing in ${meta_file}" "implicit compare should reject formatless snapshot metadata" compare
assert_command_fails "Snapshot metadata format is missing in ${meta_file}" "inspect should reject formatless snapshot metadata" inspect "${snapshot_id}"
assert_command_fails "Snapshot metadata format is missing in ${meta_file}" "restore-check should reject formatless snapshot metadata" restore-check "${snapshot_id}"

export GIT_SNAPSHOT_CONFIRM_RESTORE="RESTORE"
assert_command_fails "Snapshot metadata format is missing in ${meta_file}" "restore should reject formatless snapshot metadata before running" restore "${snapshot_id}"
assert_command_fails "Snapshot metadata format is missing in ${meta_file}" "rename should reject formatless snapshot metadata" rename "${snapshot_id}" renamed-snapshot

assert_file_exists "${snapshot_path}" "rename should preserve the original snapshot when metadata is invalid"
assert_file_not_exists "${renamed_snapshot_path}" "rename should not create a new snapshot path on metadata failure"

delete_output="$(cd "${root_repo}" && git_snapshot_test_cmd delete "${snapshot_id}")"
assert_contains "Deleted snapshot ${snapshot_id}" "${delete_output}" "delete should still remove invalid snapshot directories"
assert_file_not_exists "${snapshot_path}" "delete should not require readable snapshot metadata"
