#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/../helpers/assertions.bash"
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/../helpers/fixtures.bash"

git_snapshot_test_setup_sandbox
root_repo="$(git_snapshot_test_make_nested_fixture)"

# Case A: HEAD mismatch but patch still applies, restore should pass with warning.
printf "compatible-change\n" >> "${root_repo}/root.txt"
create_ok_output="$(cd "${root_repo}" && git_snapshot_test_cmd create)"
snapshot_id_ok="$(git_snapshot_test_get_snapshot_id_from_create_output "${create_ok_output}")"

printf "move-head-unrelated\n" > "${root_repo}/head-unrelated.txt"
git -C "${root_repo}" add head-unrelated.txt
git -C "${root_repo}" commit -m "move head unrelated" >/dev/null

export GIT_SNAPSHOT_CONFIRM_RESTORE="RESTORE"
restore_ok_output="$(cd "${root_repo}" && git_snapshot_test_cmd restore "${snapshot_id_ok}" 2>&1)"
assert_contains "HEAD mismatch" "${restore_ok_output}" "warning should mention head mismatch"
assert_contains "HEAD mismatch for super" "${restore_ok_output}" "root repo should be rendered with human label"
assert_contains "Restore completed successfully" "${restore_ok_output}" "compatible mismatch should restore"

# Case B: default reject mode should keep partial restore artifacts instead of auto-rollback.
git -C "${root_repo}" reset --hard >/dev/null
printf "conflict-target\n" >> "${root_repo}/root.txt"
create_fail_output="$(cd "${root_repo}" && git_snapshot_test_cmd create)"
snapshot_id_fail="$(git_snapshot_test_get_snapshot_id_from_create_output "${create_fail_output}")"

printf "rewrite-for-conflict\n" > "${root_repo}/root.txt"
git -C "${root_repo}" add root.txt
git -C "${root_repo}" commit -m "conflicting head move" >/dev/null

set +e
restore_fail_output="$(cd "${root_repo}" && git_snapshot_test_cmd restore "${snapshot_id_fail}" 2>&1)"
restore_fail_code=$?
set -e

assert_exit_code 4 "${restore_fail_code}" "default reject mode should report partial restore on conflict"
assert_contains "HEAD mismatch" "${restore_fail_output}" "warning should mention head mismatch"
assert_contains "HEAD mismatch for super" "${restore_fail_output}" "root repo should be rendered with human label"
assert_contains "Restore completed with unresolved conflicts (reject mode)." "${restore_fail_output}" "reject mode should report partial restore outcome"
assert_contains "Rejected hunks:" "${restore_fail_output}" "reject mode should report rejected hunks"
assert_file_exists "${root_repo}/root.txt.rej" "reject mode should persist reject artifact for manual resolution"
assert_not_contains "Rollback completed." "${restore_fail_output}" "reject mode should not auto-rollback merge rejects"
assert_contains "rewrite-for-conflict" "$(cat "${root_repo}/root.txt")" "conflicting tracked file should remain unchanged pending manual resolution"

# Case C: explicit rollback mode keeps legacy atomic behavior.
git -C "${root_repo}" reset --hard >/dev/null
git -C "${root_repo}" clean -fd >/dev/null
printf "rollback-conflict-target\n" >> "${root_repo}/root.txt"
create_rollback_output="$(cd "${root_repo}" && git_snapshot_test_cmd create)"
snapshot_id_rollback="$(git_snapshot_test_get_snapshot_id_from_create_output "${create_rollback_output}")"

printf "rewrite-for-rollback-conflict\n" > "${root_repo}/root.txt"
git -C "${root_repo}" add root.txt
git -C "${root_repo}" commit -m "conflicting head move for rollback mode" >/dev/null

set +e
restore_rollback_output="$(cd "${root_repo}" && git_snapshot_test_cmd restore "${snapshot_id_rollback}" --on-conflict rollback 2>&1)"
restore_rollback_code=$?
set -e

assert_exit_code 1 "${restore_rollback_code}" "rollback mode should fail and rollback on conflict"
assert_contains "Attempting automatic rollback" "${restore_rollback_output}" "rollback mode should attempt rollback"
assert_contains "Rollback completed." "${restore_rollback_output}" "rollback mode should complete rollback"
