#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/../helpers/assertions.bash"
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/../helpers/fixtures.bash"

git_snapshot_test_setup_sandbox
root_repo="$(git_snapshot_test_make_nested_fixture)"

printf "progress-staged\n" >> "${root_repo}/root.txt"
git -C "${root_repo}" add root.txt

create_output="$(cd "${root_repo}" && git_snapshot_test_cmd create gui-compare-progress)"
snapshot_id="$(git_snapshot_test_get_snapshot_id_from_create_output "${create_output}")"
assert_eq "gui-compare-progress" "${snapshot_id}" "gui compare snapshot id should be preserved"

set +e
incompatible_output="$(cd "${root_repo}" && GIT_SNAPSHOT_GUI_TEST_MODE=1 git_snapshot_test_cmd compare "${snapshot_id}" --gui --porcelain 2>&1)"
incompatible_code=$?
set -e
assert_exit_code 1 "${incompatible_code}" "compare --gui should reject --porcelain"
assert_contains "compare --gui is incompatible with --porcelain." "${incompatible_output}" "compare --gui should explain porcelain incompatibility"

gui_default_output="$(cd "${root_repo}" && GIT_SNAPSHOT_GUI_TEST_MODE=1 git_snapshot_test_cmd compare "${snapshot_id}" --gui)"
assert_contains "GUI_TEST mode=compare snapshot_id=${snapshot_id}" "${gui_default_output}" "gui test mode should expose selected snapshot id"
assert_contains "include_no_effect=false" "${gui_default_output}" "default gui compare should keep restore-effect-only visibility"
assert_contains "compare_base=snapshot" "${gui_default_output}" "default gui compare should boot with the snapshot base"
assert_contains "rows=0" "${gui_default_output}" "default gui compare should hide resolved rows"

set +e
gui_abort_output="$(cd "${root_repo}" && GIT_SNAPSHOT_GUI_FORCE_ABORT=1 git_snapshot_test_cmd compare "${snapshot_id}" --gui 2>&1)"
gui_abort_code=$?
set -e
assert_exit_code 1 "${gui_abort_code}" "compare --gui should convert launcher aborts into a clean failure"
assert_contains "compare --gui crashed before opening the UI." "${gui_abort_output}" "compare --gui should report launcher crash in plain language"
assert_contains "node diagnostics:" "${gui_abort_output}" "compare --gui should include node diagnostics for launcher aborts"
assert_not_contains "Abort trap: 6" "${gui_abort_output}" "compare --gui should suppress raw shell abort output"

set +e
gui_stream_abort_output="$(cd "${root_repo}" && GIT_SNAPSHOT_GUI_STREAM_OUTPUT=1 GIT_SNAPSHOT_GUI_FORCE_ABORT=1 git_snapshot_test_cmd compare "${snapshot_id}" --gui 2>&1)"
gui_stream_abort_code=$?
set -e
assert_exit_code 1 "${gui_stream_abort_code}" "streamed compare --gui should still convert launcher aborts into a clean failure"
assert_contains "compare --gui crashed before opening the UI." "${gui_stream_abort_output}" "streamed compare --gui should report launcher crash in plain language"
assert_contains "node diagnostics:" "${gui_stream_abort_output}" "streamed compare --gui should still include node diagnostics"
assert_not_contains "Abort trap: 6" "${gui_stream_abort_output}" "streamed compare --gui should suppress raw shell abort output"

gui_diff_output="$(cd "${root_repo}" && GIT_SNAPSHOT_GUI_TEST_MODE=1 git_snapshot_test_cmd compare "${snapshot_id}" --diff --gui 2>&1)"
assert_contains "compare --gui ignores --diff" "${gui_diff_output}" "gui compare should warn that --diff is ignored"
assert_contains "GUI_TEST mode=compare snapshot_id=${snapshot_id}" "${gui_diff_output}" "gui compare should still execute when --diff is also passed"

gui_all_output="$(cd "${root_repo}" && GIT_SNAPSHOT_GUI_TEST_MODE=1 git_snapshot_test_cmd compare "${snapshot_id}" --repo . --include-no-effect --gui)"
assert_contains "GUI_TEST mode=compare snapshot_id=${snapshot_id}" "${gui_all_output}" "gui --include-no-effect test mode should expose selected snapshot id"
assert_contains "include_no_effect=true" "${gui_all_output}" "gui --include-no-effect should propagate no-effect visibility"
assert_contains "rows=1" "${gui_all_output}" "gui --include-no-effect should surface no-effect rows"

gui_snapshot_base_output="$(cd "${root_repo}" && GIT_SNAPSHOT_GUI_TEST_MODE=1 git_snapshot_test_cmd compare "${snapshot_id}" --repo . --include-no-effect --base snapshot --gui)"
assert_contains "compare_base=snapshot" "${gui_snapshot_base_output}" "compare --gui should propagate an explicit snapshot base into the GUI bootstrap state"

gui_working_tree_base_output="$(cd "${root_repo}" && GIT_SNAPSHOT_GUI_TEST_MODE=1 git_snapshot_test_cmd compare "${snapshot_id}" --repo . --include-no-effect --base working-tree --gui)"
assert_contains "compare_base=working-tree" "${gui_working_tree_base_output}" "compare --gui should propagate the working-tree compare base into the GUI bootstrap state"

root_repo_basename="$(basename "${root_repo}")"
gui_alias_output="$(cd "${root_repo}" && GIT_SNAPSHOT_GUI_TEST_MODE=1 git_snapshot_test_cmd compare "${snapshot_id}" --repo "${root_repo_basename}" --include-no-effect --gui)"
assert_contains "include_no_effect=true" "${gui_alias_output}" "gui mode should preserve --include-no-effect with root repo alias"
assert_contains "rows=1" "${gui_alias_output}" "root repo alias should normalize to --repo . in gui mode"
