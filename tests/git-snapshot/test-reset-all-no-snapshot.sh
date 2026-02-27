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

reset_output="$(cd "${root_repo}" && git_snapshot_test_cmd reset-all --no-snapshot)"
assert_contains "Proceeding without pre-clear snapshot." "${reset_output}" "reset-all should report no-snapshot mode"
assert_contains "Clear completed" "${reset_output}" "reset-all should report clear completion"

dirty_output="$(cd "${root_repo}" && git_snapshot_test_cmd debug-dirty)"
assert_eq "" "${dirty_output}" "reset-all --no-snapshot should leave no dirty repos"

assert_file_not_exists "${root_repo}/reset-all-root.txt" "root untracked should be removed by reset-all"
assert_file_not_exists "${sub1}/reset-all-sub1.txt" "sub1 untracked should be removed by reset-all"
assert_file_not_exists "${sub2}/reset-all-sub2.txt" "sub2 untracked should be removed by reset-all"

snapshot_root="$(git_snapshot_test_snapshot_root_for_repo "${root_repo}")"
if [[ -d "${snapshot_root}" ]]; then
  snapshot_count="$(find "${snapshot_root}" -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d ' ')"
  assert_eq "0" "${snapshot_count}" "reset-all --no-snapshot should not create snapshots"
fi
