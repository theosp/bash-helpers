#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/../helpers/assertions.bash"
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/../helpers/fixtures.bash"

git_snapshot_test_setup_sandbox
root_repo="$(git_snapshot_test_make_nested_fixture)"

create_output="$(cd "${root_repo}" && git_snapshot_test_cmd create)"
snapshot_id="$(git_snapshot_test_get_snapshot_id_from_create_output "${create_output}")"

snapshot_root="$(git_snapshot_test_snapshot_root_for_repo "${root_repo}")"
snapshot_path="${snapshot_root}/${snapshot_id}"
meta_file="${snapshot_path}/meta.env"

sentinel_file="${TEST_SANDBOX}/meta-injection-sentinel.txt"

# Force legacy-style metadata with command-substitution-like content.
{
  printf "SNAPSHOT_ID=%s\n" "${snapshot_id}"
  printf "CREATED_AT_EPOCH=%s\n" "$(date +%s)"
  printf 'ROOT_REPO=$(touch %s)\n' "${sentinel_file}"
  printf "REPO_COUNT=1\n"
} > "${meta_file}"

list_porcelain_output="$(cd "${root_repo}" && git_snapshot_test_cmd list --porcelain)"
row_for_snapshot="$(printf "%s\n" "${list_porcelain_output}" | awk -F'\t' -v sid="${snapshot_id}" '
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
assert_contains $'snapshot\tid='"${snapshot_id}" "${row_for_snapshot}" "list should still work with legacy metadata fallback"
assert_contains "root_repo=\$(touch ${sentinel_file})" "${row_for_snapshot}" "legacy metadata should be treated as inert text"
assert_file_not_exists "${sentinel_file}" "metadata loading must not execute command substitutions"
