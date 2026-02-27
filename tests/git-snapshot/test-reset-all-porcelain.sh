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

printf "root-change\n" >> "${root_repo}/root.txt"
git -C "${root_repo}" add root.txt
printf "sub1-change\n" >> "${sub1}/sub1.txt"
git -C "${sub1}" add sub1.txt
printf "sub2-change\n" >> "${sub2}/sub2.txt"
git -C "${sub2}" add sub2.txt

porcelain_snapshot_output="$(cd "${root_repo}" && git_snapshot_test_cmd reset-all --snapshot --porcelain)"
assert_not_contains "[git-snapshot]" "${porcelain_snapshot_output}" "reset-all porcelain output should not include human-prefixed lines"
assert_contains $'reset_all_snapshot\tcreated=true\tsnapshot_id=pre-reset-' "${porcelain_snapshot_output}" "snapshot porcelain row should report created=true and generated id"
assert_contains $'reset_all_summary\tresult=success\tsnapshot_created=true\tsnapshot_id=pre-reset-' "${porcelain_snapshot_output}" "summary row should report successful clear with snapshot"
assert_contains "repos_total=3" "${porcelain_snapshot_output}" "summary should include repo totals"
assert_contains "repos_cleared=3" "${porcelain_snapshot_output}" "summary should include cleared repo totals"
assert_contains "repos_failed=0" "${porcelain_snapshot_output}" "summary should include zero failures on success"
assert_contains "exit_code=0" "${porcelain_snapshot_output}" "summary should include successful exit code"

snapshot_id="$(printf "%s\n" "${porcelain_snapshot_output}" | awk -F'\t' '
  $1 == "reset_all_snapshot" {
    for (i = 2; i <= NF; i++) {
      if ($i ~ /^snapshot_id=/) {
        print substr($i, 13)
      }
    }
  }
')"
assert_non_empty "${snapshot_id}" "snapshot porcelain row should include snapshot id value"

printf "root-change-2\n" >> "${root_repo}/root.txt"
git -C "${root_repo}" add root.txt
printf "sub1-change-2\n" >> "${sub1}/sub1.txt"
git -C "${sub1}" add sub1.txt
printf "sub2-change-2\n" >> "${sub2}/sub2.txt"
git -C "${sub2}" add sub2.txt

porcelain_no_snapshot_output="$(cd "${root_repo}" && git_snapshot_test_cmd reset-all --no-snapshot --porcelain)"
assert_not_contains "[git-snapshot]" "${porcelain_no_snapshot_output}" "reset-all porcelain output should not include human-prefixed lines"
assert_contains $'reset_all_snapshot\tcreated=false\tsnapshot_id=' "${porcelain_no_snapshot_output}" "snapshot porcelain row should report created=false for --no-snapshot"
assert_not_contains "pre-reset-" "${porcelain_no_snapshot_output}" "no-snapshot porcelain output should not include generated snapshot id"
assert_contains $'reset_all_summary\tresult=success\tsnapshot_created=false\tsnapshot_id=' "${porcelain_no_snapshot_output}" "summary row should report successful clear without snapshot"
assert_contains "repos_total=3" "${porcelain_no_snapshot_output}" "summary should include repo totals"
assert_contains "repos_cleared=3" "${porcelain_no_snapshot_output}" "summary should include cleared repo totals"
assert_contains "repos_failed=0" "${porcelain_no_snapshot_output}" "summary should include zero failures on success"
assert_contains "exit_code=0" "${porcelain_no_snapshot_output}" "summary should include successful exit code"
