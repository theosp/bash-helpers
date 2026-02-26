#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/../helpers/assertions.bash"

BASH_HELPERS_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd -P)"
SKILL_ROOT="${BASH_HELPERS_ROOT}/skills/git-snapshot-workflow"

assert_file_exists "${SKILL_ROOT}/SKILL.md" "skill must exist"
assert_file_exists "${SKILL_ROOT}/references/command-contract.md" "reference file must exist"

skill_content="$(cat "${SKILL_ROOT}/SKILL.md")"
assert_contains "name: git-snapshot-workflow" "${skill_content}" "frontmatter name required"
assert_contains "description:" "${skill_content}" "frontmatter description required"
assert_contains "references/command-contract.md" "${skill_content}" "skill should link reference"
