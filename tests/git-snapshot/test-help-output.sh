#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/../helpers/assertions.bash"
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/../helpers/fixtures.bash"

git_snapshot_test_setup_sandbox
root_repo="$(git_snapshot_test_make_nested_fixture)"

help_output="$(cd "${root_repo}" && git_snapshot_test_cmd --help)"

assert_contains "Git Snapshot CLI" "${help_output}" "help should include header"
assert_contains "State model (what is captured)" "${help_output}" "help should document capture model"
assert_contains "git-snapshot create [snapshot_id] [--clear] [--yes]" "${help_output}" "help should document create --clear workflow"
assert_contains "git-snapshot reset-all [--snapshot|--no-snapshot] [--porcelain]" "${help_output}" "help should document reset-all command"
assert_contains "git-snapshot rename <old_snapshot_id> <new_snapshot_id>" "${help_output}" "help should document rename command"
assert_contains "git-snapshot list [--include-auto] [--porcelain]" "${help_output}" "help should document list include-auto flag"
assert_contains "Create auto snapshot before clear? [y/N]:" "${help_output}" "help should document reset-all snapshot-choice prompt"
assert_contains "Default list view hides auto-generated internal snapshots." "${help_output}" "help should explain default list filtering"
assert_contains "git-snapshot inspect <snapshot_id>" "${help_output}" "help should document inspect command"
assert_contains "--name-only|--stat|--diff" "${help_output}" "help should document inspect render flags"
assert_contains "\`--stat\`      : git apply --stat summary (default: on)" "${help_output}" "help should label inspect default render mode"
assert_not_contains "inspect <snapshot_id> [--repo <rel_path>] [--staged|--unstaged|--untracked|--all] [--all-repos] [--name-only|--stat|--diff] [--limit <n>|--no-limit]" "${help_output}" "inspect usage should not advertise removed limit flags"
assert_contains "git-snapshot restore-check <snapshot_id>" "${help_output}" "help should document restore-check command"
assert_contains "git-snapshot verify <snapshot_id>" "${help_output}" "help should document verify command"
assert_contains "git-snapshot restore <snapshot_id> [--on-conflict <reject|rollback>] [--porcelain]" "${help_output}" "help should document restore conflict/porcelain flags"
assert_contains "default (\`--on-conflict reject\`)" "${help_output}" "help should explain default reject restore mode"
assert_contains "HEAD mismatch is warning-only" "${help_output}" "help should explain default verify head policy"
assert_contains "Troubleshooting" "${help_output}" "help should include troubleshooting guidance"

set +e
old_diff_output="$(cd "${root_repo}" && git_snapshot_test_cmd diff legacy-id 2>&1)"
old_diff_code=$?
old_compare_output="$(cd "${root_repo}" && git_snapshot_test_cmd compare legacy-id 2>&1)"
old_compare_code=$?
old_show_output="$(cd "${root_repo}" && git_snapshot_test_cmd show legacy-id 2>&1)"
old_show_code=$?
set -e

assert_exit_code 1 "${old_diff_code}" "old diff command should fail after hard rename"
assert_contains "Unknown command: diff" "${old_diff_output}" "old diff command should be unknown"
assert_exit_code 1 "${old_compare_code}" "old compare command should fail after hard rename"
assert_contains "Unknown command: compare" "${old_compare_output}" "old compare command should be unknown"
assert_exit_code 1 "${old_show_code}" "show command should fail after hard removal"
assert_contains "Unknown command: show" "${old_show_output}" "show command should be unknown"
