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
  list_out="$(cd "${pwd_entry}" && git_snapshot_test_cmd list --porcelain)"
  snapshot_row="$(printf "%s\n" "${list_out}" | awk -F'\t' -v sid="${sid}" '
    $1 == "snapshot" {
      id = ""
      for (i = 2; i <= NF; i++) {
        split($i, kv, "=")
        if (kv[1] == "id") {
          id = kv[2]
          break
        }
      }
      if (id == sid) {
        print $0
        exit
      }
    }
  ')"
  assert_contains "root_repo=${canonical_root}" "${snapshot_row}" "scope should always resolve to root-most superproject"
done
