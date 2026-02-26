#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/../helpers/assertions.bash"
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/../helpers/fixtures.bash"

git_snapshot_test_setup_sandbox
root_repo="$(git_snapshot_test_make_nested_fixture)"

create_output="$(cd "${root_repo}" && git_snapshot_test_cmd create verify-baseline)"
snapshot_id="$(git_snapshot_test_get_snapshot_id_from_create_output "${create_output}")"
assert_eq "verify-baseline" "${snapshot_id}" "create should preserve explicit verify id"

verify_clean_output="$(cd "${root_repo}" && git_snapshot_test_cmd verify "${snapshot_id}")"
assert_contains "Snapshot verify: ${snapshot_id}" "${verify_clean_output}" "verify should include heading"
assert_contains "Strict head: false" "${verify_clean_output}" "verify default mode should be non-strict head"
assert_contains "mismatches: 0" "${verify_clean_output}" "clean snapshot should report no mismatches"
assert_contains "warnings: 0" "${verify_clean_output}" "clean snapshot should report no warnings"

# Move only HEAD: working-set stays clean, so default verify should warn but pass.
printf "head-shift\n" >> "${root_repo}/root.txt"
git -C "${root_repo}" add root.txt
git -C "${root_repo}" commit -m "head shift for verify tests" >/dev/null

set +e
verify_head_warning_output="$(cd "${root_repo}" && git_snapshot_test_cmd verify "${snapshot_id}" 2>&1)"
verify_head_warning_code=$?
set -e
assert_exit_code 0 "${verify_head_warning_code}" "default verify should not fail on head mismatch"
assert_contains "warnings: 1" "${verify_head_warning_output}" "head mismatch should be warning in default mode"
assert_contains "mismatches: 0" "${verify_head_warning_output}" "head mismatch should not count as mismatch in default mode"
assert_contains "head mismatch" "${verify_head_warning_output}" "default verify should explain head mismatch warning"

set +e
verify_head_strict_output="$(cd "${root_repo}" && git_snapshot_test_cmd verify "${snapshot_id}" --strict-head 2>&1)"
verify_head_strict_code=$?
set -e
assert_exit_code 3 "${verify_head_strict_code}" "strict-head verify should fail on head mismatch"
assert_contains "Strict head: true" "${verify_head_strict_output}" "strict mode should be printed"
assert_contains "mismatches: 1" "${verify_head_strict_output}" "head mismatch should become mismatch in strict mode"
assert_contains "head mismatch" "${verify_head_strict_output}" "strict mode should explain head mismatch reason"

# Capture new clean baseline on current HEAD for staged/unstaged/untracked mismatch checks.
second_create_output="$(cd "${root_repo}" && git_snapshot_test_cmd create verify-working-set)"
second_snapshot_id="$(git_snapshot_test_get_snapshot_id_from_create_output "${second_create_output}")"
assert_eq "verify-working-set" "${second_snapshot_id}" "second snapshot should preserve explicit id"

printf "staged-delta\n" >> "${root_repo}/root.txt"
git -C "${root_repo}" add root.txt
set +e
verify_staged_output="$(cd "${root_repo}" && git_snapshot_test_cmd verify "${second_snapshot_id}" --repo . 2>&1)"
verify_staged_code=$?
set -e
assert_exit_code 3 "${verify_staged_code}" "verify should fail when staged patch differs"
assert_contains "staged patch differs" "${verify_staged_output}" "verify should report staged mismatch"
git -C "${root_repo}" reset --hard >/dev/null

printf "unstaged-delta\n" >> "${root_repo}/root.txt"
set +e
verify_unstaged_output="$(cd "${root_repo}" && git_snapshot_test_cmd verify "${second_snapshot_id}" --repo . 2>&1)"
verify_unstaged_code=$?
set -e
assert_exit_code 3 "${verify_unstaged_code}" "verify should fail when unstaged patch differs"
assert_contains "unstaged patch differs" "${verify_unstaged_output}" "verify should report unstaged mismatch"
git -C "${root_repo}" reset --hard >/dev/null

printf "untracked-delta\n" > "${root_repo}/verify-untracked.txt"
set +e
verify_untracked_output="$(cd "${root_repo}" && git_snapshot_test_cmd verify "${second_snapshot_id}" --repo . 2>&1)"
verify_untracked_code=$?
set -e
assert_exit_code 3 "${verify_untracked_code}" "verify should fail when untracked set/content differs"
assert_contains "untracked set/content differs" "${verify_untracked_output}" "verify should report untracked mismatch"
git -C "${root_repo}" clean -fd >/dev/null

verify_porcelain_output="$(cd "${root_repo}" && git_snapshot_test_cmd verify "${second_snapshot_id}" --repo . --porcelain)"
assert_contains $'verify\tsnapshot_id='"${second_snapshot_id}"$'\trepo=.\thead=same\tstaged=match\tunstaged=match\tuntracked=match\tstrict_head=false' "${verify_porcelain_output}" "porcelain verify should include per-repo row"
assert_contains $'verify_summary\tsnapshot_id='"${second_snapshot_id}"$'\trepos_checked=1\tmismatches=0\twarnings=0\tstrict_head=false' "${verify_porcelain_output}" "porcelain verify should include summary row"
