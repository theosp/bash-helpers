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
reset_output="$(cd "${root_repo}" && git_snapshot_test_cmd reset-all --snapshot --no-snapshot 2>&1)"
reset_code=$?
set -e

assert_exit_code 1 "${reset_code}" "reset-all should fail when both snapshot flags are provided"
assert_contains "--snapshot and --no-snapshot cannot be used together" "${reset_output}" "reset-all should explain conflicting flags"

dirty_output="$(cd "${root_repo}" && git_snapshot_test_cmd debug-dirty)"
assert_contains "." "${dirty_output}" "reset-all should not mutate tree on conflicting flags"
