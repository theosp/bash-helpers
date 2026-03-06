#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/../helpers/assertions.bash"
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/../helpers/fixtures.bash"

git_snapshot_test_setup_sandbox

repo="${TEST_REPOS_ROOT}/worker-queue-hardening"
git_snapshot_test_init_repo "${repo}"
git_snapshot_test_commit_file "${repo}" "tracked.txt" "base" "init tracked"
printf "snapshot-state\n" >> "${repo}/tracked.txt"
git -C "${repo}" add tracked.txt

create_output="$(cd "${repo}" && git_snapshot_test_cmd create worker-queue-hardening)"
snapshot_id="$(git_snapshot_test_get_snapshot_id_from_create_output "${create_output}")"
assert_eq "worker-queue-hardening" "${snapshot_id}" "worker queue hardening snapshot id should be preserved"

real_mktemp="$(command -v mktemp)"
assert_non_empty "${real_mktemp}" "mktemp must exist for worker-queue hardening test"

shim_dir="${TEST_SANDBOX}/bin"
shim_path="${shim_dir}/mktemp"
mkdir -p "${shim_dir}"
{
  printf '%s\n' '#!/usr/bin/env bash'
  printf '%s\n' 'set -euo pipefail'
  printf '%s\n' 'if [[ "${1:-}" == "-u" ]]; then'
  printf '%s\n' '  printf "mktemp -u is forbidden in this test\n" >&2'
  printf '%s\n' '  exit 97'
  printf '%s\n' 'fi'
  printf '%s\n' "exec \"${real_mktemp}\" \"\$@\""
} > "${shim_path}"
chmod +x "${shim_path}"

set +e
first_compare="$(cd "${repo}" && PATH="${shim_dir}:$PATH" git_snapshot_test_cmd compare "${snapshot_id}" --repo . --all --porcelain 2>&1)"
first_compare_code=$?
set -e
assert_exit_code 0 "${first_compare_code}" "compare should not rely on mktemp -u for worker queue setup"
assert_not_contains "mktemp -u is forbidden in this test" "${first_compare}" "compare should not invoke mktemp -u"
assert_contains $'\tcache_hit_repos=0\tcache_miss_repos=1\tcontract_version=5' "${first_compare}" "first hardened compare should still populate compare cache telemetry"

set +e
second_compare="$(cd "${repo}" && PATH="${shim_dir}:$PATH" git_snapshot_test_cmd compare "${snapshot_id}" --repo . --all --porcelain 2>&1)"
second_compare_code=$?
set -e
assert_exit_code 0 "${second_compare_code}" "repeat compare should still succeed when mktemp -u is blocked"
assert_not_contains "mktemp -u is forbidden in this test" "${second_compare}" "repeat compare should not invoke mktemp -u"
assert_contains $'\tcache_hit_repos=1\tcache_miss_repos=0\tcontract_version=5' "${second_compare}" "repeat hardened compare should still hit cache"
