#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/../helpers/assertions.bash"
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/../helpers/fixtures.bash"

git_snapshot_test_setup_sandbox
root_repo="$(git_snapshot_test_make_nested_fixture)"

printf "pending-change\n" >> "${root_repo}/root.txt"
git -C "${root_repo}" add root.txt

set +e
clear_without_confirmation_output="$(cd "${root_repo}" && git_snapshot_test_cmd create --clear 2>&1)"
clear_without_confirmation_code=$?
set -e

assert_exit_code 1 "${clear_without_confirmation_code}" "non-interactive create --clear should fail without bypass"
assert_contains "Confirmation required ([y/N])" "${clear_without_confirmation_output}" "error should explain confirmation requirement"
assert_contains "GIT_SNAPSHOT_CONFIRM_CLEAR=YES or use --yes" "${clear_without_confirmation_output}" "error should include bypass options"

snapshot_root="$(git_snapshot_test_snapshot_root_for_repo "${root_repo}")"
if [[ -d "${snapshot_root}" ]]; then
  snapshot_count="$(find "${snapshot_root}" -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d ' ')"
  assert_eq "0" "${snapshot_count}" "snapshot should not be created when clear confirmation is missing"
fi

dirty_output="$(cd "${root_repo}" && git_snapshot_test_cmd debug-dirty)"
assert_contains "." "${dirty_output}" "dirty state should remain when clear is cancelled"

set +e
yes_without_clear_output="$(cd "${root_repo}" && git_snapshot_test_cmd create --yes 2>&1)"
yes_without_clear_code=$?
set -e
assert_exit_code 1 "${yes_without_clear_code}" "--yes without --clear should fail"
assert_contains "--yes is only valid with --clear" "${yes_without_clear_output}" "error should enforce --yes usage scope"
