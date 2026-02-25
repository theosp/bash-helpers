#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/../helpers/assertions.bash"
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/../helpers/fixtures.bash"

git_snapshot_test_setup_sandbox
inside_root="$(git_snapshot_test_make_nested_fixture)"

outside_repo="${TEST_SANDBOX}/outside-repo"
git_snapshot_test_init_repo "${outside_repo}"
git_snapshot_test_commit_file "${outside_repo}" "outside.txt" "outside" "outside init"

set +e
outside_output="$(cd "${outside_repo}" && git_snapshot_test_cmd create 2>&1)"
outside_code=$?
set -e

assert_exit_code 1 "${outside_code}" "outside repo should be rejected by enforce prefix guard"
assert_contains "Refusing to operate outside enforced prefix" "${outside_output}"

inside_output="$(cd "${inside_root}" && git_snapshot_test_cmd create)"
inside_sid="$(git_snapshot_test_get_snapshot_id_from_create_output "${inside_output}")"
assert_non_empty "${inside_sid}" "inside repo should succeed"
