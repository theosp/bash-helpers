#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/../helpers/assertions.bash"
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/../helpers/fixtures.bash"

git_snapshot_test_setup_sandbox
root_repo="$(git_snapshot_test_make_nested_fixture)"

git -C "${root_repo}/modules/sub1" config user.email "tests@example.com"
git -C "${root_repo}/modules/sub1" config user.name "git-snapshot-tests"

git -C "${root_repo}" branch master >/dev/null
git -C "${root_repo}/modules/sub1" branch master >/dev/null

printf "review gui delta\n" >> "${root_repo}/modules/sub1/sub1.txt"
git -C "${root_repo}/modules/sub1" add sub1.txt
git -C "${root_repo}/modules/sub1" commit -m "review gui delta" >/dev/null

set +e
incompatible_output="$(cd "${root_repo}" && GIT_SNAPSHOT_GUI_TEST_MODE=1 git_snapshot_test_cmd review --repo modules/sub1 --gui --porcelain 2>&1)"
incompatible_code=$?
set -e
assert_exit_code 1 "${incompatible_code}" "review --gui should reject --porcelain"
assert_contains "review --gui is incompatible with --porcelain." "${incompatible_output}" "review --gui should explain porcelain incompatibility"

gui_empty_output="$(cd "${root_repo}" && GIT_SNAPSHOT_GUI_TEST_MODE=1 git_snapshot_test_cmd review --gui)"
assert_contains "GUI_TEST mode=review snapshot_id=" "${gui_empty_output}" "review --gui should launch review mode"
assert_contains "rows=0" "${gui_empty_output}" "review --gui should allow an empty selected-repo set"
assert_contains "review_selected_repos=(none)" "${gui_empty_output}" "review --gui should expose empty selected repo state"
assert_contains "review_base=master" "${gui_empty_output}" "review --gui should default the review base to master"
assert_contains "review_repo_bases=(none)" "${gui_empty_output}" "review --gui should start with no per-repo base overrides"

gui_selected_output="$(cd "${root_repo}" && GIT_SNAPSHOT_GUI_TEST_MODE=1 git_snapshot_test_cmd review --repo modules/sub1 --gui)"
assert_contains "GUI_TEST mode=review snapshot_id=" "${gui_selected_output}" "review --gui should preserve review mode for selected repos"
assert_contains "rows=1" "${gui_selected_output}" "review --gui should surface committed file rows for selected repos"
assert_contains "review_selected_repos=modules/sub1" "${gui_selected_output}" "review --gui should preserve selected review repos"
assert_contains "review_base=master" "${gui_selected_output}" "review --gui should preserve the default review base for selected repos"

gui_missing_baseline_output="$(cd "${root_repo}" && GIT_SNAPSHOT_GUI_TEST_MODE=1 git_snapshot_test_cmd review --repo modules/sub1/modules/sub2 --gui)"
assert_contains "GUI_TEST mode=review snapshot_id=" "${gui_missing_baseline_output}" "review --gui should still launch when a selected repo has no master baseline"
assert_contains "rows=0" "${gui_missing_baseline_output}" "review --gui should show no file rows for repos that cannot resolve master"
assert_contains "review_selected_repos=modules/sub1/modules/sub2" "${gui_missing_baseline_output}" "review --gui should preserve repo selections even on baseline failure"

git -C "${root_repo}/modules/sub1" tag -f review-gui-base-tag >/dev/null
gui_custom_base_output="$(
  cd "${root_repo}" \
    && GIT_SNAPSHOT_GUI_TEST_MODE=1 git_snapshot_test_cmd review --repo modules/sub1 --base main --repo-base modules/sub1 review-gui-base-tag --gui
)"
assert_contains "review_selected_repos=modules/sub1" "${gui_custom_base_output}" "review --gui should preserve selected repos when custom base settings are provided"
assert_contains "review_base=main" "${gui_custom_base_output}" "review --gui should carry the configured default review base into GUI state"
assert_contains 'review_repo_bases={"modules/sub1":"review-gui-base-tag"}' "${gui_custom_base_output}" "review --gui should carry per-repo base overrides into GUI state"
