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
assert_contains "git-snapshot browse [--repo <rel_path>] [--staged|--unstaged|--untracked|--submodules|--all] [--all-repos] [--gui] [--porcelain]" "${help_output}" "help should document browse command"
assert_contains "Browses current live Git changes across the root-most repo and initialized recursive submodules." "${help_output}" "help should explain browse mode"
assert_contains "browse UI \`Edit File\` opens the real working-tree file via the repo-root \`.git-snapshot.config\`, \`GIT_SNAPSHOT_GUI_EDITOR_COMMAND_TEMPLATE\`, or the OS default opener" "${help_output}" "help should describe browse edit-file behavior"
assert_contains "Running \`git-snapshot\` with no subcommand is equivalent to \`git-snapshot gui\`." "${help_output}" "help should document the new bare-command gui default"
assert_contains "git-snapshot gui [snapshot_id]" "${help_output}" "help should document gui shortcut usage"
assert_contains "Opens the shared browser UI in browse mode." "${help_output}" "help should explain what gui does"
assert_contains "git-snapshot review [--repo <rel_path> ...] [--base <ref>] [--repo-base <rel_path> <ref>] [--gui] [--porcelain]" "${help_output}" "help should document review command"
assert_contains "Reviews committed branch delta for explicitly selected repos against a configurable base ref." "${help_output}" "help should explain review mode"
assert_contains "GUI review may start with no selected repos and let you add them in the browser" "${help_output}" "help should document empty-start review gui behavior"
assert_contains "\`--base <ref>\`                : set the default review base (default: \`master\`)" "${help_output}" "help should document the default review base flag"
assert_contains "\`--repo-base <rel_path> <ref>\`: override the default base for one selected repo (repeatable)" "${help_output}" "help should document per-repo review base overrides"
assert_contains "if a requested base ref is missing in a repo and local \`master\` exists there, review falls back to \`master\` and reports that fallback explicitly" "${help_output}" "help should document visible fallback-to-master review behavior"
assert_contains "for pre-launch compare flags such as \`--repo\`, \`--include-no-effect\`, \`--diff\`, \`--base\`, or \`--porcelain\`, use \`git-snapshot compare --gui\`" "${help_output}" "help should still direct advanced compare gui setup to compare --gui"
assert_contains "for browse-specific pre-launch flags such as \`--staged\`, \`--unstaged\`, \`--untracked\`, \`--submodules\`, or \`--all-repos\`, use \`git-snapshot browse --gui\`" "${help_output}" "help should direct advanced browse gui setup to browse --gui"
assert_contains "git-snapshot compare [snapshot_id] [--repo <rel_path>] [--include-no-effect] [--diff] [--base <snapshot|working-tree>] [--gui] [--porcelain]" "${help_output}" "help should document compare command"
assert_contains "browse  : \`Edit File\` opens the real working-tree file" "${help_output}" "help should document the browse gui primary action"
assert_contains "compare : \`Open External Diff\` uses the selected compare base for built-in left/right ordering" "${help_output}" "help should document the compare gui primary action"
assert_contains "inspect : read-only preview only" "${help_output}" "help should document inspect as read-only"
assert_contains "repo-root \`.git-snapshot.config\` (INI / git-config-style) can set \`[browse]\`, \`[compare]\`, \`[gui \"edit\"]\`, \`[gui \"external-diff\"]\`, \`[gui \"compare\"]\`, \`[gui \"snapshots\"]\`, and \`[gui \"server\"]\`" "${help_output}" "help should document repo-root config sections"
assert_contains "command sections such as \`[browse] jobs\` and \`[compare] jobs\` apply to both CLI and GUI-triggered backend commands" "${help_output}" "help should document shared command config semantics"
assert_contains "flags / URL state and env vars override \`.git-snapshot.config\`" "${help_output}" "help should document gui config precedence"
assert_contains "GIT_SNAPSHOT_GUI_EDITOR_COMMAND_TEMPLATE='<command> ... \$FILE'" "${help_output}" "help should document explicit browse editor command templates"
assert_contains "GIT_SNAPSHOT_GUI_EXTERNAL_DIFF_TOOL=<tool>" "${help_output}" "help should document forced external diff selector override"
assert_contains "GIT_SNAPSHOT_GUI_EXTERNAL_DIFF_COMMAND_TEMPLATE='<command> ... \$SOURCE ... \$TARGET'" "${help_output}" "help should document explicit external diff command templates"
assert_contains "GIT_SNAPSHOT_GUI_EXTERNAL_DIFF_CANDIDATES=<tool1,tool2,...>" "${help_output}" "help should document auto-detect selector override"
assert_contains "GIT_SNAPSHOT_GUI_PORT_START=<port>" "${help_output}" "help should document preferred GUI port start override"
assert_contains "GIT_SNAPSHOT_GUI_PORT_COUNT=<n>" "${help_output}" "help should document preferred GUI port count override"
assert_contains "GIT_SNAPSHOT_BROWSE_JOBS=<n>" "${help_output}" "help should document browse worker override"
assert_contains "Canonical selectors: \`meld\`, \`kdiff3\`, \`opendiff\`, \`bcompare\`, \`code\`" "${help_output}" "help should document canonical external diff selectors"
assert_contains "command templates are tokenized into argv entries with quote/backslash handling; they are not shell-evaluated" "${help_output}" "help should clarify command template tokenization semantics"
assert_contains "use \`\$SOURCE\` / \`\${SOURCE}\` for the snapshot-side file and \`\$TARGET\` / \`\${TARGET}\` for the current working-tree file" "${help_output}" "help should document command template placeholders"
assert_contains "use \`\$BASE\` / \`\${BASE}\` for the active compare-base side and \`\$OTHER\` / \`\${OTHER}\` for the opposite side" "${help_output}" "help should document compare-base-aware command template placeholders"
assert_contains "use \`\$FILE\` / \`\${FILE}\` for the browse-mode working-tree file path" "${help_output}" "help should document browse editor template placeholders"
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
