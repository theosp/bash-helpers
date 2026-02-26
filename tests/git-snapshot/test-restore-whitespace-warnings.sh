#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/../helpers/assertions.bash"
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/../helpers/fixtures.bash"

git_snapshot_test_setup_sandbox
root_repo="$(git_snapshot_test_make_nested_fixture)"

# Create staged + unstaged changes with trailing whitespace in the patch body.
printf "stage-trailing-whitespace   \n" >> "${root_repo}/root.txt"
git -C "${root_repo}" add root.txt
printf "unstaged-trailing-whitespace   \n" >> "${root_repo}/root.txt"

create_output="$(cd "${root_repo}" && git_snapshot_test_cmd create)"
snapshot_id="$(git_snapshot_test_get_snapshot_id_from_create_output "${create_output}")"
assert_non_empty "${snapshot_id}" "snapshot id should be returned"

# Drift away from snapshot state.
git -C "${root_repo}" reset --hard >/dev/null
git -C "${root_repo}" clean -fd >/dev/null
printf "post-snapshot-drift\n" > "${root_repo}/drift.txt"

export GIT_SNAPSHOT_CONFIRM_RESTORE="RESTORE"
restore_output="$(cd "${root_repo}" && git_snapshot_test_cmd restore "${snapshot_id}" 2>&1)"

assert_contains "Restore completed successfully" "${restore_output}" "restore should complete"
assert_not_contains "trailing whitespace" "${restore_output}" "restore should not print patch whitespace warnings"
assert_not_contains "whitespace errors" "${restore_output}" "restore should not print aggregated whitespace warning summary"
