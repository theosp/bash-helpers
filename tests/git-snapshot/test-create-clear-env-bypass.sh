#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/../helpers/assertions.bash"
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/../helpers/fixtures.bash"

git_snapshot_test_setup_sandbox
root_repo="$(git_snapshot_test_make_nested_fixture)"

printf "root-change\n" >> "${root_repo}/root.txt"
git -C "${root_repo}" add root.txt
printf "root-untracked\n" > "${root_repo}/tmp-root.txt"

create_output="$(cd "${root_repo}" && GIT_SNAPSHOT_CONFIRM_CLEAR=YES git_snapshot_test_cmd create --clear)"
snapshot_id="$(git_snapshot_test_get_snapshot_id_from_create_output "${create_output}")"
assert_non_empty "${snapshot_id}" "create --clear should return snapshot id with env bypass"
assert_contains "Created snapshot" "${create_output}" "create --clear should still report snapshot creation"

dirty_output="$(cd "${root_repo}" && git_snapshot_test_cmd debug-dirty)"
assert_eq "" "${dirty_output}" "env-bypassed create --clear should leave clean repos"
