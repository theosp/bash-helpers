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
assert_contains "Root (snapshot source root path; shown when visible snapshots are not all from current root)" "${help_output}" "help should document root column visibility rule"
assert_contains "snapshot registry is keyed by root repo folder name" "${help_output}" "help should document shared registry note"
assert_contains "Create auto snapshot before clear? [Y/n]:" "${help_output}" "help should document reset-all snapshot-choice prompt"
assert_contains "Default list view hides auto-generated internal snapshots." "${help_output}" "help should explain default list filtering"
assert_contains "git-snapshot inspect <snapshot_id>" "${help_output}" "help should document inspect command"
assert_contains "[--gui] [--porcelain]" "${help_output}" "help should document inspect gui flag"
assert_contains "--name-only|--stat|--diff" "${help_output}" "help should document inspect render flags"
assert_contains "\`--stat\`      : git apply --stat summary (default: on)" "${help_output}" "help should label inspect default render mode"
assert_contains "\`--gui\`       : launch shared snapshot browser UI" "${help_output}" "help should describe inspect gui mode"
assert_contains "git-snapshot restore-check <snapshot_id>" "${help_output}" "help should document restore-check command"
assert_contains "git-snapshot gui [snapshot_id]" "${help_output}" "help should document gui shortcut usage"
assert_contains "Opens the shared browser UI in compare mode." "${help_output}" "help should explain what gui does"
assert_contains "for pre-launch compare flags such as \`--repo\`, \`--all\`, \`--diff\`, or \`--porcelain\`, use \`git-snapshot compare --gui\`" "${help_output}" "help should direct advanced gui setup to compare --gui"
assert_contains "git-snapshot compare [snapshot_id] [--repo <rel_path>] [--all] [--diff] [--gui] [--porcelain]" "${help_output}" "help should document compare command"
assert_contains "GIT_SNAPSHOT_GUI_EXTERNAL_DIFF_TOOL=<tool>" "${help_output}" "help should document forced external diff selector override"
assert_contains "GIT_SNAPSHOT_GUI_EXTERNAL_DIFF_COMMAND_TEMPLATE='<command> ... \$SOURCE ... \$TARGET'" "${help_output}" "help should document explicit external diff command templates"
assert_contains "GIT_SNAPSHOT_GUI_EXTERNAL_DIFF_CANDIDATES=<tool1,tool2,...>" "${help_output}" "help should document auto-detect selector override"
assert_contains "GIT_SNAPSHOT_GUI_PORT_START=<port>" "${help_output}" "help should document preferred GUI port start override"
assert_contains "GIT_SNAPSHOT_GUI_PORT_COUNT=<n>" "${help_output}" "help should document preferred GUI port count override"
assert_contains "Canonical selectors: \`meld\`, \`kdiff3\`, \`opendiff\`, \`bcompare\`, \`code\`" "${help_output}" "help should document canonical external diff selectors"
assert_contains "command templates are tokenized into argv entries with quote/backslash handling; they are not shell-evaluated" "${help_output}" "help should clarify command template tokenization semantics"
assert_contains "use \`\$SOURCE\` / \`\${SOURCE}\` for the snapshot-side file and \`\$TARGET\` / \`\${TARGET}\` for the current working-tree file" "${help_output}" "help should document command template placeholders"
assert_not_contains "accepted as a compatibility alias" "${help_output}" "help should not describe selector aliases"
assert_not_contains "git-snapshot verify" "${help_output}" "help should not document removed verify command"
assert_not_contains "debug-dirty" "${help_output}" "help should not document removed debug-dirty command"
assert_not_contains "--assert-equal" "${help_output}" "help should not mention removed compare assert mode"
assert_not_contains "--strict-head" "${help_output}" "help should not mention removed strict-head compatibility"
assert_contains "Troubleshooting" "${help_output}" "help should include troubleshooting guidance"

set +e
old_diff_output="$(cd "${root_repo}" && git_snapshot_test_cmd diff legacy-id 2>&1)"
old_diff_code=$?
old_show_output="$(cd "${root_repo}" && git_snapshot_test_cmd show legacy-id 2>&1)"
old_show_code=$?
old_verify_output="$(cd "${root_repo}" && git_snapshot_test_cmd verify legacy-id 2>&1)"
old_verify_code=$?
set -e

assert_exit_code 1 "${old_diff_code}" "old diff command should fail after hard rename"
assert_contains "Unknown command: diff" "${old_diff_output}" "old diff command should be unknown"
assert_exit_code 1 "${old_show_code}" "show command should fail after hard removal"
assert_contains "Unknown command: show" "${old_show_output}" "show command should be unknown"
assert_exit_code 1 "${old_verify_code}" "verify command should fail after hard removal"
assert_contains "Unknown command: verify" "${old_verify_output}" "verify command should be unknown"
