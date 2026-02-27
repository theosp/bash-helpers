#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/../helpers/assertions.bash"
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/../helpers/fixtures.bash"

git_snapshot_test_setup_sandbox
root_repo="$(git_snapshot_test_make_nested_fixture)"

create_output="$(cd "${root_repo}" && git_snapshot_test_cmd create user-checkpoint)"
snapshot_id="$(git_snapshot_test_get_snapshot_id_from_create_output "${create_output}")"
assert_eq "user-checkpoint" "${snapshot_id}" "explicit user snapshot id should be preserved"

export GIT_SNAPSHOT_CONFIRM_RESTORE="RESTORE"
restore_output="$(cd "${root_repo}" && git_snapshot_test_cmd restore "${snapshot_id}" 2>&1)"
auto_snapshot_id="$(printf "%s\n" "${restore_output}" | sed -n 's/.*Created safety snapshot: \([^[:space:]]*\).*/\1/p' | tail -n 1)"
assert_non_empty "${auto_snapshot_id}" "restore should create an auto safety snapshot"

list_default_output="$(cd "${root_repo}" && git_snapshot_test_cmd list)"
assert_contains "${snapshot_id}" "${list_default_output}" "default list should include user-created snapshots"
assert_not_contains "${auto_snapshot_id}" "${list_default_output}" "default list should hide auto-generated snapshots"
assert_contains "Hint: 1 auto-generated snapshot(s) hidden. Run: git-snapshot list --include-auto" "${list_default_output}" "default list should report hidden auto snapshot count and include flag hint"
assert_not_contains "Repos Root" "${list_default_output}" "single-root default list should not include root column"
assert_contains "Note: snapshot registry is keyed by root repo folder name." "${list_default_output}" "default list should include shared registry note"

list_all_output="$(cd "${root_repo}" && git_snapshot_test_cmd list --include-auto)"
assert_contains "${snapshot_id}" "${list_all_output}" "include-auto list should include user snapshot"
assert_contains "${auto_snapshot_id}" "${list_all_output}" "include-auto list should include auto snapshot"
assert_contains "Auto" "${list_all_output}" "include-auto list should show auto marker column"
assert_not_contains "Repos Root" "${list_all_output}" "single-root include-auto list should not include root column"
assert_contains "* = auto-generated snapshot" "${list_all_output}" "include-auto list should show auto marker legend"

auto_row="$(printf "%s\n" "${list_all_output}" | awk -v sid="${auto_snapshot_id}" '$1 == sid {print; exit}')"
assert_contains "*" "${auto_row}" "auto snapshot row should include marker"
user_row="$(printf "%s\n" "${list_all_output}" | awk -v sid="${snapshot_id}" '$1 == sid {print; exit}')"
assert_not_contains "*" "${user_row}" "user snapshot row should not include auto marker"

list_porcelain_default="$(cd "${root_repo}" && git_snapshot_test_cmd list --porcelain)"
assert_contains $'snapshot\tid='"${snapshot_id}"$'\t' "${list_porcelain_default}" "default porcelain list should include user snapshot"
assert_contains "origin=user" "${list_porcelain_default}" "default porcelain list should label user snapshot origin"
assert_not_contains "${auto_snapshot_id}" "${list_porcelain_default}" "default porcelain list should hide auto snapshots"

list_porcelain_all="$(cd "${root_repo}" && git_snapshot_test_cmd list --include-auto --porcelain)"
assert_contains $'snapshot\tid='"${snapshot_id}"$'\t' "${list_porcelain_all}" "include-auto porcelain list should include user snapshot"
assert_contains $'snapshot\tid='"${auto_snapshot_id}"$'\t' "${list_porcelain_all}" "include-auto porcelain list should include auto snapshot"
assert_contains "origin=auto" "${list_porcelain_all}" "include-auto porcelain list should label auto snapshot origin"
