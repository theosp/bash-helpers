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

# Add mixed changes in all levels.
printf "root-staged\n" >> "${root_repo}/root.txt"
git -C "${root_repo}" add root.txt
printf "root-unstaged\n" >> "${root_repo}/root.txt"
printf "root-untracked\n" > "${root_repo}/reset-all-root.txt"

printf "sub1-staged\n" >> "${sub1}/sub1.txt"
git -C "${sub1}" add sub1.txt
printf "sub1-unstaged\n" >> "${sub1}/sub1.txt"
printf "sub1-untracked\n" > "${sub1}/reset-all-sub1.txt"

printf "sub2-staged\n" >> "${sub2}/sub2.txt"
git -C "${sub2}" add sub2.txt
printf "sub2-unstaged\n" >> "${sub2}/sub2.txt"
printf "sub2-untracked\n" > "${sub2}/reset-all-sub2.txt"

reset_output="$(cd "${root_repo}" && git_snapshot_test_cmd reset-all --snapshot 2>&1)"
assert_contains "Created auto snapshot" "${reset_output}" "reset-all --snapshot should create auto snapshot"
assert_contains "Clear completed" "${reset_output}" "reset-all should report clear completion"

auto_snapshot_id="$(printf "%s\n" "${reset_output}" | sed -n 's/.*Created auto snapshot \([^[:space:]]*\) before reset-all\./\1/p' | tail -n 1)"
assert_non_empty "${auto_snapshot_id}" "reset-all --snapshot should print created auto snapshot id"
assert_contains "before-reset-all-" "${auto_snapshot_id}" "reset-all auto snapshot id should use before-reset-all prefix"

snapshot_root="$(git_snapshot_test_snapshot_root_for_repo "${root_repo}")"
assert_file_exists "${snapshot_root}/${auto_snapshot_id}/meta.env" "auto snapshot metadata should exist"

dirty_output="$(cd "${root_repo}" && git_snapshot_test_cmd debug-dirty)"
assert_eq "" "${dirty_output}" "reset-all --snapshot should leave no dirty repos"

assert_file_not_exists "${root_repo}/reset-all-root.txt" "root untracked should be removed by reset-all"
assert_file_not_exists "${sub1}/reset-all-sub1.txt" "sub1 untracked should be removed by reset-all"
assert_file_not_exists "${sub2}/reset-all-sub2.txt" "sub2 untracked should be removed by reset-all"

list_default_output="$(cd "${root_repo}" && git_snapshot_test_cmd list)"
assert_not_contains "${auto_snapshot_id}" "${list_default_output}" "default list should hide reset-all auto snapshot"
assert_contains "Hint: 1 auto-generated snapshot(s) hidden. Run: git-snapshot list --include-auto" "${list_default_output}" "default list should report hidden reset-all auto snapshots"

list_all_output="$(cd "${root_repo}" && git_snapshot_test_cmd list --include-auto)"
assert_contains "${auto_snapshot_id}" "${list_all_output}" "include-auto list should include reset-all auto snapshot"
assert_contains "Auto" "${list_all_output}" "include-auto list should show auto marker column"
assert_contains "* = auto-generated snapshot" "${list_all_output}" "include-auto list should show auto marker legend"
auto_row="$(printf "%s\n" "${list_all_output}" | awk -v sid="${auto_snapshot_id}" '$1 == sid {print; exit}')"
assert_contains "*" "${auto_row}" "reset-all auto snapshot row should include marker"

list_porcelain_output="$(cd "${root_repo}" && git_snapshot_test_cmd list --include-auto --porcelain)"
assert_contains $'snapshot\tid='"${auto_snapshot_id}"$'\t' "${list_porcelain_output}" "include-auto porcelain should include reset-all auto snapshot"
assert_contains "origin=auto" "${list_porcelain_output}" "include-auto porcelain should mark reset-all snapshot origin=auto"
