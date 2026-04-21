#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/../helpers/assertions.bash"
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/../helpers/fixtures.bash"

run_gui_expect_error() {
  local label="$1"
  shift
  local output=""
  local code=0

  set +e
  output="$(cd "${root_repo}" && git_snapshot_test_cmd gui "$@" 2>&1)"
  code=$?
  set -e

  assert_exit_code 1 "${code}" "${label} should fail"
  printf "%s\n" "${output}"
}

git_snapshot_test_setup_sandbox
root_repo="$(git_snapshot_test_make_nested_fixture)"

printf "gui-first-stage\n" >> "${root_repo}/root.txt"
git -C "${root_repo}" add root.txt
first_create_output="$(cd "${root_repo}" && git_snapshot_test_cmd create gui-first)"
first_snapshot_id="$(git_snapshot_test_get_snapshot_id_from_create_output "${first_create_output}")"
assert_eq "gui-first" "${first_snapshot_id}" "first gui snapshot id should be preserved"

printf "gui-second-stage\n" >> "${root_repo}/root.txt"
git -C "${root_repo}" add root.txt
second_create_output="$(cd "${root_repo}" && git_snapshot_test_cmd create gui-second)"
second_snapshot_id="$(git_snapshot_test_get_snapshot_id_from_create_output "${second_create_output}")"
assert_eq "gui-second" "${second_snapshot_id}" "second gui snapshot id should be preserved"

gui_explicit_output="$(cd "${root_repo}" && GIT_SNAPSHOT_GUI_TEST_MODE=1 git_snapshot_test_cmd gui "${first_snapshot_id}")"
assert_contains "GUI_TEST mode=browse snapshot_id=${first_snapshot_id}" "${gui_explicit_output}" "gui should open the browse UI for an explicit snapshot id"
assert_contains "browse_staged=true" "${gui_explicit_output}" "gui should enable browse staged rows by default"
assert_contains "browse_submodules=true" "${gui_explicit_output}" "gui should enable browse submodule rows by default"

gui_default_output="$(cd "${root_repo}" && GIT_SNAPSHOT_GUI_TEST_MODE=1 git_snapshot_test_cmd gui)"
assert_contains "GUI_TEST mode=browse snapshot_id=${second_snapshot_id}" "${gui_default_output}" "gui without args should select the latest user-created snapshot for browse"

bare_default_output="$(cd "${root_repo}" && GIT_SNAPSHOT_GUI_TEST_MODE=1 git_snapshot_test_cmd)"
assert_contains "GUI_TEST mode=browse snapshot_id=${second_snapshot_id}" "${bare_default_output}" "bare git-snapshot should open the browse UI with the latest user-created snapshot"
assert_contains "browse_staged=true" "${bare_default_output}" "bare git-snapshot should preserve the default browse staged filter"

repo_output="$(run_gui_expect_error "gui --repo" --repo .)"
assert_contains "git-snapshot gui accepts only an optional snapshot_id." "${repo_output}" "gui --repo should explain the narrow gui contract"
assert_contains "Use git-snapshot browse --gui for browse filters, or git-snapshot compare --gui for compare-specific flags." "${repo_output}" "gui --repo should redirect advanced usage to browse --gui or compare --gui"

all_output="$(run_gui_expect_error "gui --all" --all)"
assert_contains "git-snapshot gui accepts only an optional snapshot_id." "${all_output}" "gui --all should explain the narrow gui contract"

diff_output="$(run_gui_expect_error "gui --diff" --diff)"
assert_contains "Use git-snapshot browse --gui for browse filters, or git-snapshot compare --gui for compare-specific flags." "${diff_output}" "gui --diff should redirect advanced usage to browse --gui or compare --gui"

porcelain_output="$(run_gui_expect_error "gui --porcelain" --porcelain)"
assert_contains "Use git-snapshot browse --gui for browse filters, or git-snapshot compare --gui for compare-specific flags." "${porcelain_output}" "gui --porcelain should redirect advanced usage to browse --gui or compare --gui"

help_output="$(run_gui_expect_error "gui --help" --help)"
assert_contains "git-snapshot gui accepts only an optional snapshot_id." "${help_output}" "gui --help should be rejected as a subcommand-local option"

extra_arg_output="$(run_gui_expect_error "gui with extra positional arg" "${first_snapshot_id}" extra)"
assert_contains "Unexpected argument for gui: extra" "${extra_arg_output}" "gui should reject extra positional arguments"
assert_contains "git-snapshot gui accepts only an optional snapshot_id." "${extra_arg_output}" "gui extra-arg failure should restate the accepted gui contract"
