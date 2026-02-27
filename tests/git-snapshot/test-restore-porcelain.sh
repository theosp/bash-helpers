#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/../helpers/assertions.bash"
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/../helpers/fixtures.bash"

git_snapshot_test_setup_sandbox
root_repo="$(git_snapshot_test_make_nested_fixture)"

export GIT_SNAPSHOT_CONFIRM_RESTORE="RESTORE"

# Case A: porcelain success path in default reject mode.
printf "porcelain-ok\n" >> "${root_repo}/root.txt"
create_ok_output="$(cd "${root_repo}" && git_snapshot_test_cmd create)"
snapshot_id_ok="$(git_snapshot_test_get_snapshot_id_from_create_output "${create_ok_output}")"

git -C "${root_repo}" reset --hard >/dev/null
git -C "${root_repo}" clean -fd >/dev/null
printf "drift\n" > "${root_repo}/drift.txt"

restore_ok_output="$(cd "${root_repo}" && git_snapshot_test_cmd restore "${snapshot_id_ok}" --porcelain)"
assert_contains $'restore_safety\tsnapshot_id='"${snapshot_id_ok}"$'\tsafety_snapshot_id=' "${restore_ok_output}" "porcelain restore should emit safety snapshot row"
assert_contains $'restore_repo\tsnapshot_id='"${snapshot_id_ok}"$'\trepo=.\tstatus=restored' "${restore_ok_output}" "porcelain restore should emit per-repo restored row"
assert_contains $'restore_summary\tsnapshot_id='"${snapshot_id_ok}"$'\tmode=reject\tresult=success' "${restore_ok_output}" "porcelain restore should emit success summary"
assert_contains "exit_code=0" "${restore_ok_output}" "porcelain success summary should include exit code"

# Case B: porcelain partial path in default reject mode.
git -C "${root_repo}" reset --hard >/dev/null
git -C "${root_repo}" clean -fd >/dev/null
printf "partial-target\n" >> "${root_repo}/root.txt"
create_partial_output="$(cd "${root_repo}" && git_snapshot_test_cmd create)"
snapshot_id_partial="$(git_snapshot_test_get_snapshot_id_from_create_output "${create_partial_output}")"

printf "partial-conflict\n" > "${root_repo}/root.txt"
git -C "${root_repo}" add root.txt
git -C "${root_repo}" commit -m "partial conflict for porcelain test" >/dev/null

set +e
restore_partial_output="$(cd "${root_repo}" && git_snapshot_test_cmd restore "${snapshot_id_partial}" --porcelain 2>&1)"
restore_partial_code=$?
set -e

assert_exit_code 4 "${restore_partial_code}" "default reject mode porcelain should return 4 on partial restore"
assert_contains $'restore_reject\tsnapshot_id='"${snapshot_id_partial}"$'\trepo=.\tfile=root.txt.rej' "${restore_partial_output}" "porcelain partial restore should emit reject rows"
assert_contains $'restore_summary\tsnapshot_id='"${snapshot_id_partial}"$'\tmode=reject\tresult=partial' "${restore_partial_output}" "porcelain partial restore should emit partial summary"
assert_contains "exit_code=4" "${restore_partial_output}" "porcelain partial summary should include exit code"

# Case C: porcelain partial rows include untracked collision details.
git -C "${root_repo}" reset --hard >/dev/null
git -C "${root_repo}" clean -fd >/dev/null
printf "snapshot-untracked-collision\n" > "${root_repo}/collision.txt"
create_collision_output="$(cd "${root_repo}" && git_snapshot_test_cmd create)"
snapshot_id_collision="$(git_snapshot_test_get_snapshot_id_from_create_output "${create_collision_output}")"

git -C "${root_repo}" clean -fd >/dev/null
printf "tracked-collision\n" > "${root_repo}/collision.txt"
git -C "${root_repo}" add collision.txt
git -C "${root_repo}" commit -m "tracked collision for porcelain test" >/dev/null

set +e
restore_collision_output="$(cd "${root_repo}" && git_snapshot_test_cmd restore "${snapshot_id_collision}" --porcelain 2>&1)"
restore_collision_code=$?
set -e

assert_exit_code 4 "${restore_collision_code}" "default reject mode porcelain should return 4 on untracked collisions"
assert_contains $'restore_collision\tsnapshot_id='"${snapshot_id_collision}"$'\trepo=.\tfile=collision.txt' "${restore_collision_output}" "porcelain partial restore should emit collision rows"
assert_contains $'restore_summary\tsnapshot_id='"${snapshot_id_collision}"$'\tmode=reject\tresult=partial' "${restore_collision_output}" "porcelain collision restore should emit partial summary"
assert_contains "rejects=0" "${restore_collision_output}" "collision-only partial restore should report zero rejects"
assert_contains "collisions=1" "${restore_collision_output}" "collision-only partial restore should report collision count"
assert_contains "exit_code=4" "${restore_collision_output}" "collision partial summary should include exit code"

# Case D: porcelain rollback mode keeps legacy atomic semantics.
git -C "${root_repo}" reset --hard >/dev/null
git -C "${root_repo}" clean -fd >/dev/null
printf "rollback-target\n" >> "${root_repo}/root.txt"
create_rollback_output="$(cd "${root_repo}" && git_snapshot_test_cmd create)"
snapshot_id_rollback="$(git_snapshot_test_get_snapshot_id_from_create_output "${create_rollback_output}")"

printf "rollback-conflict\n" > "${root_repo}/root.txt"
git -C "${root_repo}" add root.txt
git -C "${root_repo}" commit -m "rollback conflict for porcelain test" >/dev/null

set +e
restore_rollback_output="$(cd "${root_repo}" && git_snapshot_test_cmd restore "${snapshot_id_rollback}" --on-conflict rollback --porcelain 2>&1)"
restore_rollback_code=$?
set -e

assert_exit_code 1 "${restore_rollback_code}" "rollback mode porcelain should fail on conflict"
assert_contains $'restore_rollback\tsnapshot_id='"${snapshot_id_rollback}"$'\tsafety_snapshot_id=' "${restore_rollback_output}" "rollback mode porcelain should emit rollback rows"
assert_contains $'restore_summary\tsnapshot_id='"${snapshot_id_rollback}"$'\tmode=rollback\tresult=failed' "${restore_rollback_output}" "rollback mode porcelain should emit failure summary"
assert_contains "exit_code=1" "${restore_rollback_output}" "rollback summary should include exit code"
