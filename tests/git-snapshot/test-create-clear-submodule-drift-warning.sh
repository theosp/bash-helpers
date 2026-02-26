#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/../helpers/assertions.bash"
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/../helpers/fixtures.bash"

git_snapshot_test_setup_sandbox
root_repo="$(git_snapshot_test_make_nested_fixture)"
sub1="${root_repo}/modules/sub1"

# Move submodule HEAD forward so root repo has submodule commit drift.
git -C "${sub1}" config user.email "tests@example.com"
git -C "${sub1}" config user.name "git-snapshot-tests"
printf "submodule-drift\n" >> "${sub1}/sub1.txt"
git -C "${sub1}" add sub1.txt
git -C "${sub1}" commit -m "drift submodule head" >/dev/null

set +e
create_output="$(cd "${root_repo}" && git_snapshot_test_cmd create drift-case --clear --yes 2>&1)"
create_code=$?
set -e

assert_exit_code 0 "${create_code}" "create --clear should succeed when only submodule drift remains"
snapshot_id="$(git_snapshot_test_get_snapshot_id_from_create_output "${create_output}")"
assert_eq "drift-case" "${snapshot_id}" "snapshot id should still be reported as final output line"
assert_contains "Submodule HEAD drift remains by design" "${create_output}" "clear should warn on submodule drift"
assert_contains "modules/sub1" "${create_output}" "drift warning should include submodule path"

dirty_output="$(cd "${root_repo}" && git_snapshot_test_cmd debug-dirty)"
assert_contains "." "${dirty_output}" "root should remain dirty due submodule HEAD drift warning mode"
