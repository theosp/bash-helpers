#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/../helpers/assertions.bash"
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/../helpers/fixtures.bash"

git_snapshot_test_setup_sandbox

BASH_HELPERS_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd -P)"
LINK_SCRIPT="${BASH_HELPERS_ROOT}/skills/git-snapshot-workflow/scripts/link-into-repo.bash"

consumer_repo="${TEST_REPOS_ROOT}/consumer"
git_snapshot_test_init_repo "${consumer_repo}"
git_snapshot_test_commit_file "${consumer_repo}" "README.md" "consumer" "init consumer"

"${LINK_SCRIPT}" "${consumer_repo}"
link_path="${consumer_repo}/.cursor/skills/git-snapshot-workflow"
assert_file_exists "${link_path}/SKILL.md" "link should expose skill"

# idempotent when link already valid
"${LINK_SCRIPT}" "${consumer_repo}" >/dev/null
assert_file_exists "${link_path}/SKILL.md" "existing valid link should remain usable"

# broken symlink should fail without --force
broken_repo="${TEST_REPOS_ROOT}/broken"
git_snapshot_test_init_repo "${broken_repo}"
git_snapshot_test_commit_file "${broken_repo}" "README.md" "broken" "init broken"
mkdir -p "${broken_repo}/.cursor/skills"
ln -s "../missing-skill-target" "${broken_repo}/.cursor/skills/git-snapshot-workflow"

set +e
broken_output="$(${LINK_SCRIPT} "${broken_repo}" 2>&1)"
broken_code=$?
set -e

assert_exit_code 1 "${broken_code}" "broken symlink should fail without --force"
assert_contains "Broken symlink" "${broken_output}" "error should explain broken symlink"

# --force should replace broken link
"${LINK_SCRIPT}" "${broken_repo}" --force >/dev/null
assert_file_exists "${broken_repo}/.cursor/skills/git-snapshot-workflow/SKILL.md" "force should repair broken link"
