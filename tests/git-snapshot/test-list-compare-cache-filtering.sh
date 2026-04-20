#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/../helpers/assertions.bash"
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/../helpers/fixtures.bash"

git_snapshot_test_setup_sandbox
export GIT_SNAPSHOT_COMPARE_CACHE=1

repo="${TEST_REPOS_ROOT}/list-cache-filtering"
git_snapshot_test_init_repo "${repo}"
git_snapshot_test_commit_file "${repo}" "tracked.txt" "tracked-base" "init tracked"

printf "snapshot-progress\n" >> "${repo}/tracked.txt"
git -C "${repo}" add tracked.txt

create_output="$(cd "${repo}" && git_snapshot_test_cmd create list-cache-filtering)"
snapshot_id="$(git_snapshot_test_get_snapshot_id_from_create_output "${create_output}")"
assert_eq "list-cache-filtering" "${snapshot_id}" "explicit snapshot id should be preserved"

snapshot_root="$(git_snapshot_test_snapshot_root_for_repo "${repo}")"
cache_snapshot_dir="${snapshot_root}/.compare-cache-v2/${snapshot_id}"
assert_file_not_exists "${cache_snapshot_dir}" "compare cache should not exist before first compare"

warm_compare_output="$(cd "${repo}" && git_snapshot_test_cmd compare "${snapshot_id}" --repo . --include-no-effect --porcelain)"
assert_contains $'compare_target\tselected_snapshot_id='"${snapshot_id}"$'\tselection_mode=explicit' "${warm_compare_output}" "explicit compare should target the created snapshot"
assert_contains $'\tcache_hit_repos=0\tcache_miss_repos=1\t' "${warm_compare_output}" "first explicit compare should warm the cache"
assert_contains $'\tcontract_version=8\t' "${warm_compare_output}" "first explicit compare should expose the v8 compare contract"
assert_file_exists "${cache_snapshot_dir}" "compare cache should exist after warming compare"

list_output="$(cd "${repo}" && git_snapshot_test_cmd list)"
assert_contains "${snapshot_id}" "${list_output}" "list should still include the real snapshot id after cache warmup"
assert_not_contains ".compare-cache-v2" "${list_output}" "list should not surface compare cache directories"

list_porcelain_output="$(cd "${repo}" && git_snapshot_test_cmd list --porcelain)"
assert_contains $'snapshot\tid='"${snapshot_id}"$'\t' "${list_porcelain_output}" "porcelain list should still include the real snapshot id after cache warmup"
assert_not_contains ".compare-cache-v2" "${list_porcelain_output}" "porcelain list should not surface compare cache directories"

default_compare_output="$(cd "${repo}" && git_snapshot_test_cmd compare --repo . --include-no-effect --porcelain)"
assert_contains $'compare_target\tselected_snapshot_id='"${snapshot_id}"$'\tselection_mode=latest-user-default\tsnapshot_origin=user' "${default_compare_output}" "default compare should still resolve the latest user snapshot after cache warmup"
assert_contains $'\tcache_hit_repos=1\tcache_miss_repos=0\t' "${default_compare_output}" "default compare should reuse the warmed cache entry"
assert_contains $'\tcontract_version=8\t' "${default_compare_output}" "default compare should expose the v8 compare contract"
assert_not_contains "compare_error" "${default_compare_output}" "default compare should not fail on the compare cache directory"
