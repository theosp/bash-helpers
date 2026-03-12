#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/../helpers/assertions.bash"
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/../helpers/fixtures.bash"

git_snapshot_test_setup_sandbox
root_repo="$(git_snapshot_test_make_nested_fixture)"

printf "inspect-gui-staged\n" >> "${root_repo}/root.txt"
git -C "${root_repo}" add root.txt
printf "inspect-gui-unstaged\n" >> "${root_repo}/modules/sub1/sub1.txt"
printf "inspect-gui-untracked\n" > "${root_repo}/inspect-gui-untracked.txt"

create_output="$(cd "${root_repo}" && git_snapshot_test_cmd create gui-inspect-progress)"
snapshot_id="$(git_snapshot_test_get_snapshot_id_from_create_output "${create_output}")"
assert_eq "gui-inspect-progress" "${snapshot_id}" "gui inspect snapshot id should be preserved"

set +e
incompatible_output="$(cd "${root_repo}" && GIT_SNAPSHOT_GUI_TEST_MODE=1 git_snapshot_test_cmd inspect "${snapshot_id}" --gui --porcelain 2>&1)"
incompatible_code=$?
set -e
assert_exit_code 1 "${incompatible_code}" "inspect --gui should reject --porcelain"
assert_contains "inspect --gui is incompatible with --porcelain." "${incompatible_output}" "inspect --gui should explain porcelain incompatibility"

gui_default_output="$(cd "${root_repo}" && GIT_SNAPSHOT_GUI_TEST_MODE=1 git_snapshot_test_cmd inspect "${snapshot_id}" --gui)"
assert_contains "GUI_TEST mode=inspect" "${gui_default_output}" "inspect gui test mode should expose inspect mode"
assert_contains "snapshot_id=${snapshot_id}" "${gui_default_output}" "inspect gui test mode should expose selected snapshot id"
assert_contains "rows=4" "${gui_default_output}" "default inspect gui should include all captured inspect rows"
assert_contains "inspect_staged=true" "${gui_default_output}" "default inspect gui should include staged rows"
assert_contains "inspect_unstaged=true" "${gui_default_output}" "default inspect gui should include unstaged rows"
assert_contains "inspect_untracked=true" "${gui_default_output}" "default inspect gui should include untracked rows"

gui_filtered_output="$(cd "${root_repo}" && GIT_SNAPSHOT_GUI_TEST_MODE=1 git_snapshot_test_cmd inspect "${snapshot_id}" --repo . --staged --all-repos --gui)"
assert_contains "GUI_TEST mode=inspect" "${gui_filtered_output}" "filtered inspect gui should stay in inspect mode"
assert_contains "repo_filter=." "${gui_filtered_output}" "inspect gui should preserve repo filter"
assert_contains "rows=1" "${gui_filtered_output}" "staged-only inspect gui should limit row count"
assert_contains "inspect_staged=true" "${gui_filtered_output}" "staged-only inspect gui should include staged rows"
assert_contains "inspect_unstaged=false" "${gui_filtered_output}" "staged-only inspect gui should exclude unstaged rows"
assert_contains "inspect_untracked=false" "${gui_filtered_output}" "staged-only inspect gui should exclude untracked rows"
assert_contains "inspect_all_repos=true" "${gui_filtered_output}" "inspect gui should preserve all-repos visibility"

gui_name_only_output="$(cd "${root_repo}" && GIT_SNAPSHOT_GUI_TEST_MODE=1 git_snapshot_test_cmd inspect "${snapshot_id}" --name-only --gui 2>&1)"
assert_contains "inspect --gui ignores --name-only/--stat/--diff" "${gui_name_only_output}" "inspect gui should warn that terminal render flags are ignored"
assert_contains "GUI_TEST mode=inspect" "${gui_name_only_output}" "inspect gui should still execute when --name-only is also passed"
