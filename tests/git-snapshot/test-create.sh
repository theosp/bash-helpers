#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/../helpers/assertions.bash"
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/../helpers/fixtures.bash"

git_snapshot_test_setup_sandbox
root_repo="$(git_snapshot_test_make_nested_fixture)"

# Introduce mixed changes across root and nested submodules.
printf "root-staged\n" >> "${root_repo}/root.txt"
git -C "${root_repo}" add root.txt
printf "root-unstaged\n" >> "${root_repo}/root.txt"
printf "root-untracked\n" > "${root_repo}/new-root.txt"

sub1="${root_repo}/modules/sub1"
printf "sub1-unstaged\n" >> "${sub1}/sub1.txt"
printf "sub1-untracked\n" > "${sub1}/new-sub1.txt"

sub2="${sub1}/modules/sub2"
printf "sub2-staged\n" >> "${sub2}/sub2.txt"
git -C "${sub2}" add sub2.txt

dirty_output="$(cd "${sub2}" && git_snapshot_test_cmd debug-dirty)"
assert_contains "." "${dirty_output}" "dirty list should include root repo"
assert_contains "modules/sub1" "${dirty_output}" "dirty list should include first-level submodule"
assert_contains "modules/sub1/modules/sub2" "${dirty_output}" "dirty list should include nested submodule"

(
  cd "${sub2}"
  create_output="$(git_snapshot_test_cmd create)"
  snapshot_id="$(git_snapshot_test_get_snapshot_id_from_create_output "${create_output}")"
  assert_non_empty "${snapshot_id}" "snapshot id should be returned"
)

snapshot_root="$(git_snapshot_test_snapshot_root_for_repo "${root_repo}")"
assert_file_exists "${snapshot_root}/snapshots" "snapshot directory should exist"

snapshot_count="$(find "${snapshot_root}/snapshots" -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d ' ')"
assert_eq "1" "${snapshot_count}" "one snapshot should be created"
