#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/../helpers/assertions.bash"
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/../helpers/fixtures.bash"

git_snapshot_test_setup_sandbox
root_repo="$(git_snapshot_test_make_nested_fixture)"

printf "status-hash-mismatch-target\n" >> "${root_repo}/root.txt"
create_output="$(cd "${root_repo}" && git_snapshot_test_cmd create)"
snapshot_id="$(git_snapshot_test_get_snapshot_id_from_create_output "${create_output}")"

snapshot_root="$(git_snapshot_test_snapshot_root_for_repo "${root_repo}")"
snapshot_dir="${snapshot_root}/${snapshot_id}"
repos_tsv="${snapshot_dir}/repos.tsv"
tmp_repos_tsv="${snapshot_dir}/repos.tsv.tmp"

# Force the status-hash mismatch branch to exercise hard-failure row emission.
if ! awk -F $'\t' -v OFS=$'\t' '
  BEGIN { updated = 0 }
  $2 == "." && updated == 0 { $4 = "forced-status-hash-mismatch"; updated = 1 }
  { print }
  END { if (updated == 0) exit 3 }
' "${repos_tsv}" > "${tmp_repos_tsv}"; then
  fail "failed to mutate root repo status hash in snapshot metadata"
fi
mv "${tmp_repos_tsv}" "${repos_tsv}"

export GIT_SNAPSHOT_CONFIRM_RESTORE="RESTORE"
set +e
restore_output="$(cd "${root_repo}" && git_snapshot_test_cmd restore "${snapshot_id}" --porcelain 2>&1)"
restore_code=$?
set -e

assert_exit_code 1 "${restore_code}" "status-hash mismatch should produce hard failure in reject mode"
assert_contains $'restore_summary\tsnapshot_id='"${snapshot_id}"$'\tmode=reject\tresult=failed' "${restore_output}" "reject mode porcelain should emit failed summary for hard failure"
assert_contains "hard_failures=1" "${restore_output}" "failed summary should include hard failure count"
assert_contains "exit_code=1" "${restore_output}" "failed summary should include exit code"

hard_failure_row="$(printf "%s\n" "${restore_output}" | grep $'^restore_hard_failure\t' | head -n 1 || true)"
assert_non_empty "${hard_failure_row}" "porcelain output should include restore_hard_failure row"

repo_field="$(printf "%s\n" "${hard_failure_row}" | tr $'\t' '\n' | grep '^repo=' || true)"
reason_field="$(printf "%s\n" "${hard_failure_row}" | tr $'\t' '\n' | grep '^reason=' || true)"

assert_non_empty "${repo_field}" "restore_hard_failure row should include repo field"
assert_non_empty "${reason_field}" "restore_hard_failure row should include reason field"

repo_value="${repo_field#repo=}"
reason_value="${reason_field#reason=}"
assert_non_empty "${repo_value}" "restore_hard_failure repo value should not be empty"
assert_non_empty "${reason_value}" "restore_hard_failure reason value should not be empty"
assert_contains "status_hash_mismatch" "${reason_value}" "status-hash mismatch hard failure should include structured reason"
