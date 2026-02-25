#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/../helpers/assertions.bash"
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/../helpers/fixtures.bash"

git_snapshot_test_setup_sandbox
root_repo="$(git_snapshot_test_make_nested_fixture)"
canonical_root="$(cd "${root_repo}" && pwd -P)"
sub1="${root_repo}/modules/sub1"
sub2="${sub1}/modules/sub2"

for pwd_entry in \
  "${root_repo}" \
  "${root_repo}/modules" \
  "${sub1}" \
  "${sub2}" \
  "${sub2}/."; do
  out="$(cd "${pwd_entry}" && git_snapshot_test_cmd create)"
  sid="$(git_snapshot_test_get_snapshot_id_from_create_output "${out}")"
  show_out="$(cd "${pwd_entry}" && git_snapshot_test_cmd show "${sid}" --porcelain)"
  assert_contains "root_repo=${canonical_root}" "${show_out}" "scope should always resolve to root-most superproject"
done
