#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/../helpers/assertions.bash"
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/../helpers/fixtures.bash"

git_snapshot_test_setup_sandbox
root_repo="$(git_snapshot_test_make_nested_fixture)"

sub1="${root_repo}/modules/sub1"
sub2="${sub1}/modules/sub2"

printf "root-staged\n" >> "${root_repo}/root.txt"
git -C "${root_repo}" add root.txt
printf "root-unstaged\n" >> "${root_repo}/root.txt"
printf "root-untracked\n" > "${root_repo}/root-untracked.txt"

printf "sub1-unstaged\n" >> "${sub1}/sub1.txt"
printf "sub1-untracked\n" > "${sub1}/sub1-untracked.txt"

printf "sub2-staged\n" >> "${sub2}/sub2.txt"
git -C "${sub2}" add sub2.txt

pre_hash_root="$(git -C "${root_repo}" status --porcelain=v1 --untracked-files=all --ignored=no | shasum -a 256 | awk '{print $1}')"
pre_hash_sub1="$(git -C "${sub1}" status --porcelain=v1 --untracked-files=all --ignored=no | shasum -a 256 | awk '{print $1}')"
pre_hash_sub2="$(git -C "${sub2}" status --porcelain=v1 --untracked-files=all --ignored=no | shasum -a 256 | awk '{print $1}')"

create_output="$(cd "${root_repo}" && git_snapshot_test_cmd create)"
snapshot_id="$(git_snapshot_test_get_snapshot_id_from_create_output "${create_output}")"

# Drift away from snapshot state.
git -C "${root_repo}" reset --hard >/dev/null
git -C "${root_repo}" clean -fd >/dev/null
git -C "${sub1}" reset --hard >/dev/null
git -C "${sub1}" clean -fd >/dev/null
git -C "${sub2}" reset --hard >/dev/null
git -C "${sub2}" clean -fd >/dev/null
printf "drift\n" > "${root_repo}/drift.txt"

export GIT_SNAPSHOT_CONFIRM_RESTORE="RESTORE"
restore_output="$(cd "${root_repo}" && git_snapshot_test_cmd restore "${snapshot_id}")"
assert_contains "Restore completed successfully" "${restore_output}" "restore should complete"

post_hash_root="$(git -C "${root_repo}" status --porcelain=v1 --untracked-files=all --ignored=no | shasum -a 256 | awk '{print $1}')"
post_hash_sub1="$(git -C "${sub1}" status --porcelain=v1 --untracked-files=all --ignored=no | shasum -a 256 | awk '{print $1}')"
post_hash_sub2="$(git -C "${sub2}" status --porcelain=v1 --untracked-files=all --ignored=no | shasum -a 256 | awk '{print $1}')"

assert_eq "${pre_hash_root}" "${post_hash_root}" "root status hash must match snapshot"
assert_eq "${pre_hash_sub1}" "${post_hash_sub1}" "sub1 status hash must match snapshot"
assert_eq "${pre_hash_sub2}" "${post_hash_sub2}" "sub2 status hash must match snapshot"
assert_file_not_exists "${root_repo}/drift.txt" "untracked file added after snapshot should be removed"
assert_file_exists "${root_repo}/root-untracked.txt" "snapshot untracked file should be restored"
