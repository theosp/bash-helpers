#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/../helpers/assertions.bash"
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/../helpers/fixtures.bash"

git_snapshot_test_setup_sandbox
root_repo="$(git_snapshot_test_make_nested_fixture)"

printf "rollback-target\n" >> "${root_repo}/root.txt"
create_output="$(cd "${root_repo}" && git_snapshot_test_cmd create)"
snapshot_id="$(git_snapshot_test_get_snapshot_id_from_create_output "${create_output}")"

# Build a distinct pre-restore state that rollback should preserve.
printf "safety-state\n" > "${root_repo}/safety.txt"
pre_restore_hash="$(git -C "${root_repo}" status --porcelain=v1 --untracked-files=all --ignored=no | shasum -a 256 | awk '{print $1}')"

snapshot_root="$(git_snapshot_test_snapshot_root_for_repo "${root_repo}")"
snapshot_dir="${snapshot_root}/${snapshot_id}"
first_bundle_dir="$(find "${snapshot_dir}/repos" -mindepth 1 -maxdepth 1 -type d | head -n 1)"

# Corrupt bundle to force restore failure.
printf "not-a-valid-patch\n" > "${first_bundle_dir}/staged.patch"

export GIT_SNAPSHOT_CONFIRM_RESTORE="RESTORE"
set +e
restore_output="$(cd "${root_repo}" && git_snapshot_test_cmd restore "${snapshot_id}" 2>&1)"
restore_code=$?
set -e

assert_exit_code 1 "${restore_code}" "restore should fail due to corrupted patch"
assert_contains "Attempting automatic rollback" "${restore_output}" "rollback should be attempted"
assert_contains "Rollback completed" "${restore_output}" "rollback should complete"

post_restore_hash="$(git -C "${root_repo}" status --porcelain=v1 --untracked-files=all --ignored=no | shasum -a 256 | awk '{print $1}')"
assert_eq "${pre_restore_hash}" "${post_restore_hash}" "rollback should restore pre-restore state"
