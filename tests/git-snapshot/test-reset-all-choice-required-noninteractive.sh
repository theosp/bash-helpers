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
reset_output="$(cd "${root_repo}" && git_snapshot_test_cmd reset-all 2>&1)"
reset_code=$?
set -e

assert_exit_code 1 "${reset_code}" "reset-all should fail in non-interactive mode when snapshot choice is omitted"
assert_contains "Choice required ([y/N]) but stdin is not interactive." "${reset_output}" "error should explain non-interactive snapshot choice requirement"
assert_contains "Use --snapshot or --no-snapshot." "${reset_output}" "error should guide automation-friendly flags"

snapshot_root="$(git_snapshot_test_snapshot_root_for_repo "${root_repo}")"
if [[ -d "${snapshot_root}" ]]; then
  snapshot_count="$(find "${snapshot_root}" -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d ' ')"
  assert_eq "0" "${snapshot_count}" "reset-all should not create snapshot when prompt cannot be answered"
fi

dirty_output="$(cd "${root_repo}" && git_snapshot_test_cmd debug-dirty)"
assert_contains "." "${dirty_output}" "reset-all should not mutate tree when prompt cannot be answered"
