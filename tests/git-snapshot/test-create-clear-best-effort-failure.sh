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
sub2="${sub1}/modules/sub2"

printf "root-staged\n" >> "${root_repo}/root.txt"
git -C "${root_repo}" add root.txt
printf "sub1-staged\n" >> "${sub1}/sub1.txt"
git -C "${sub1}" add sub1.txt
printf "sub2-staged\n" >> "${sub2}/sub2.txt"
git -C "${sub2}" add sub2.txt

fake_bin="${TEST_SANDBOX}/fake-bin"
mkdir -p "${fake_bin}"
real_git="$(command -v git)"

cat > "${fake_bin}/git" <<'WRAPPER'
#!/usr/bin/env bash
set -euo pipefail

if [[ "${1:-}" == "-C" && "${2:-}" == "${GIT_SNAPSHOT_FAIL_CLEAR_REPO:-}" && "${3:-}" == "clean" && "${4:-}" == "-fd" ]]; then
  echo "simulated clean failure" >&2
  exit 17
fi

exec "${GIT_SNAPSHOT_REAL_GIT}" "$@"
WRAPPER
chmod +x "${fake_bin}/git"

set +e
create_output="$(
  cd "${root_repo}" && \
  PATH="${fake_bin}:${PATH}" \
  GIT_SNAPSHOT_REAL_GIT="${real_git}" \
  GIT_SNAPSHOT_FAIL_CLEAR_REPO="${sub1}" \
  git_snapshot_test_cmd create clear-failure-case --clear --yes 2>&1
)"
create_code=$?
set -e

assert_exit_code 1 "${create_code}" "create --clear should fail when one repo clear step fails"
assert_contains "Clear completed with failures" "${create_output}" "failure summary should be printed"
assert_contains "modules/sub1" "${create_output}" "failure summary should include failing repo path"

snapshot_id="$(git_snapshot_test_get_snapshot_id_from_create_output "${create_output}")"
assert_eq "clear-failure-case" "${snapshot_id}" "snapshot id must still be final output line on clear failure"

snapshot_root="$(git_snapshot_test_snapshot_root_for_repo "${root_repo}")"
assert_file_exists "${snapshot_root}/${snapshot_id}/meta.env" "snapshot should still exist for rollback after clear failure"
