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
assert_contains "git-snapshot rename <old_snapshot_id> <new_snapshot_id>" "${help_output}" "help should document rename command"
assert_contains "git-snapshot diff <snapshot_id>" "${help_output}" "help should document diff command"
assert_contains "git-snapshot compare <snapshot_id>" "${help_output}" "help should document compare command"
assert_contains "Troubleshooting" "${help_output}" "help should include troubleshooting guidance"
