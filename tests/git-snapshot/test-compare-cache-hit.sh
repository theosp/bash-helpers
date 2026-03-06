#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/../helpers/assertions.bash"
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/../helpers/fixtures.bash"

git_snapshot_test_setup_sandbox

# 1) Cache hit/miss behavior with status-hash and head invalidation.
repo="${TEST_REPOS_ROOT}/cache-hit"
git_snapshot_test_init_repo "${repo}"
git_snapshot_test_commit_file "${repo}" "tracked.txt" "base" "init tracked"
printf "snapshot-state\n" >> "${repo}/tracked.txt"
git -C "${repo}" add tracked.txt

create_output="$(cd "${repo}" && git_snapshot_test_cmd create cache-hit-main)"
snapshot_id="$(git_snapshot_test_get_snapshot_id_from_create_output "${create_output}")"
assert_eq "cache-hit-main" "${snapshot_id}" "cache-hit snapshot id should be preserved"

first_compare="$(cd "${repo}" && git_snapshot_test_cmd compare "${snapshot_id}" --repo . --all --porcelain)"
assert_contains $'compare_summary\tsnapshot_id='"${snapshot_id}"$'\trepos_checked=1\tfiles_total=1\tresolved_committed=0\tresolved_uncommitted=1\tunresolved_missing=0\tunresolved_diverged=0\tunresolved_total=0\tshown_files=1\tengine=v2\telapsed_ms=' "${first_compare}" "first compare should emit v5 summary"
assert_contains $'\tcache_hit_repos=0\tcache_miss_repos=1\tcontract_version=5' "${first_compare}" "first compare should populate cache miss telemetry"

second_compare="$(cd "${repo}" && git_snapshot_test_cmd compare "${snapshot_id}" --repo . --all --porcelain)"
assert_contains $'\tcache_hit_repos=1\tcache_miss_repos=0\tcontract_version=5' "${second_compare}" "second compare should reuse persistent cache"

first_compare_human="$(cd "${repo}" && git_snapshot_test_cmd compare "${snapshot_id}" --repo . --all)"
assert_contains "Compare telemetry: elapsed_ms=" "${first_compare_human}" "human compare should expose telemetry"
assert_contains "cache_hit_repos=1 | cache_miss_repos=0" "${first_compare_human}" "human compare should disclose warmed cache reuse after porcelain compare"

status_invalidation_human="$(cd "${repo}" && printf "status-invalidation-human\n" >> tracked.txt && git_snapshot_test_cmd compare "${snapshot_id}" --repo . --all)"
assert_contains "Compare telemetry: elapsed_ms=" "${status_invalidation_human}" "human compare should keep telemetry after invalidation"
assert_contains "cache_hit_repos=0 | cache_miss_repos=1" "${status_invalidation_human}" "human compare should disclose cache invalidation"

rows_first="$(printf "%s\n" "${first_compare}" | grep '^compare_file' || true)"
rows_second="$(printf "%s\n" "${second_compare}" | grep '^compare_file' || true)"
assert_eq "${rows_first}" "${rows_second}" "cache hit should preserve identical compare_file rows"

printf "status-invalidation\n" >> "${repo}/tracked.txt"
status_invalidation_compare="$(cd "${repo}" && git_snapshot_test_cmd compare "${snapshot_id}" --repo . --all --porcelain)"
assert_contains $'\tcache_hit_repos=0\tcache_miss_repos=1\tcontract_version=5' "${status_invalidation_compare}" "status-hash changes should invalidate cache"

status_warm_compare="$(cd "${repo}" && git_snapshot_test_cmd compare "${snapshot_id}" --repo . --all --porcelain)"
assert_contains $'\tcache_hit_repos=1\tcache_miss_repos=0\tcontract_version=5' "${status_warm_compare}" "unchanged status after invalidation should warm cache again"

# 1b) Content-only edits that keep the same porcelain shape must still invalidate cache.
same_shape_repo="${TEST_REPOS_ROOT}/cache-hit-same-shape"
git_snapshot_test_init_repo "${same_shape_repo}"
git_snapshot_test_commit_file "${same_shape_repo}" "tracked.txt" "base" "init same-shape tracked"
printf "snapshot-one\n" > "${same_shape_repo}/tracked.txt"

same_shape_create_output="$(cd "${same_shape_repo}" && git_snapshot_test_cmd create cache-hit-same-shape)"
same_shape_snapshot_id="$(git_snapshot_test_get_snapshot_id_from_create_output "${same_shape_create_output}")"
assert_eq "cache-hit-same-shape" "${same_shape_snapshot_id}" "same-shape snapshot id should be preserved"

same_shape_first="$(cd "${same_shape_repo}" && git_snapshot_test_cmd compare "${same_shape_snapshot_id}" --repo . --all --porcelain)"
assert_contains $'\tcache_hit_repos=0\tcache_miss_repos=1\tcontract_version=5' "${same_shape_first}" "first same-shape compare should miss cache"
assert_contains $'compare_file\tsnapshot_id='"${same_shape_snapshot_id}"$'\trepo=.\tfile=tracked.txt\tstatus=resolved_uncommitted' "${same_shape_first}" "first same-shape compare should start resolved"

printf "snapshot-two\n" > "${same_shape_repo}/tracked.txt"
same_shape_second="$(cd "${same_shape_repo}" && git_snapshot_test_cmd compare "${same_shape_snapshot_id}" --repo . --all --porcelain)"
assert_contains $'\tcache_hit_repos=0\tcache_miss_repos=1\tcontract_version=5' "${same_shape_second}" "content-only tracked edits should invalidate cache even when status shape stays stable"
assert_contains $'compare_file\tsnapshot_id='"${same_shape_snapshot_id}"$'\trepo=.\tfile=tracked.txt\tstatus=unresolved_diverged\treason=current content or mode diverges from snapshot target' "${same_shape_second}" "content-only tracked edits should recalculate compare rows"

# 1c) Untracked content changes that stay ?? must also invalidate cache.
same_untracked_repo="${TEST_REPOS_ROOT}/cache-hit-untracked"
git_snapshot_test_init_repo "${same_untracked_repo}"
git_snapshot_test_commit_file "${same_untracked_repo}" "tracked.txt" "base" "init untracked cache repo"
printf "snapshot-untracked-one\n" > "${same_untracked_repo}/note.txt"

same_untracked_create_output="$(cd "${same_untracked_repo}" && git_snapshot_test_cmd create cache-hit-untracked)"
same_untracked_snapshot_id="$(git_snapshot_test_get_snapshot_id_from_create_output "${same_untracked_create_output}")"
assert_eq "cache-hit-untracked" "${same_untracked_snapshot_id}" "untracked cache snapshot id should be preserved"

same_untracked_first="$(cd "${same_untracked_repo}" && git_snapshot_test_cmd compare "${same_untracked_snapshot_id}" --repo . --all --porcelain)"
assert_contains $'\tcache_hit_repos=0\tcache_miss_repos=1\tcontract_version=5' "${same_untracked_first}" "first untracked compare should miss cache"
assert_contains $'compare_file\tsnapshot_id='"${same_untracked_snapshot_id}"$'\trepo=.\tfile=note.txt\tstatus=resolved_uncommitted' "${same_untracked_first}" "first untracked compare should start resolved"

printf "snapshot-untracked-two\n" > "${same_untracked_repo}/note.txt"
same_untracked_second="$(cd "${same_untracked_repo}" && git_snapshot_test_cmd compare "${same_untracked_snapshot_id}" --repo . --all --porcelain)"
assert_contains $'\tcache_hit_repos=0\tcache_miss_repos=1\tcontract_version=5' "${same_untracked_second}" "content-only untracked edits should invalidate cache"
assert_contains $'compare_file\tsnapshot_id='"${same_untracked_snapshot_id}"$'\trepo=.\tfile=note.txt\tstatus=unresolved_diverged\treason=current content or mode diverges from snapshot target' "${same_untracked_second}" "content-only untracked edits should recalculate compare rows"

# 1d) Special-path files must preserve stable escaped compare rows across cache hits and misses.
special_path_repo="${TEST_REPOS_ROOT}/cache-hit-special-paths"
git_snapshot_test_init_repo "${special_path_repo}"
git_snapshot_test_commit_file "${special_path_repo}" "tracked.txt" "base" "init special-path cache repo"
special_tracked_path=$'tracked\tcache.txt'
special_untracked_path=$'note\ncache.txt'

printf "tracked-snapshot\n" > "${special_path_repo}/${special_tracked_path}"
git -C "${special_path_repo}" add "${special_tracked_path}"
printf "untracked-snapshot\n" > "${special_path_repo}/${special_untracked_path}"

special_create_output="$(cd "${special_path_repo}" && git_snapshot_test_cmd create cache-hit-special-paths)"
special_snapshot_id="$(git_snapshot_test_get_snapshot_id_from_create_output "${special_create_output}")"
assert_eq "cache-hit-special-paths" "${special_snapshot_id}" "special-path cache snapshot id should be preserved"

special_first="$(cd "${special_path_repo}" && git_snapshot_test_cmd compare "${special_snapshot_id}" --repo . --all --porcelain)"
assert_contains $'\tcache_hit_repos=0\tcache_miss_repos=1\tcontract_version=5' "${special_first}" "first special-path compare should miss cache"
assert_contains $'compare_file\tsnapshot_id='"${special_snapshot_id}"$'\trepo=.\tfile=tracked\\tcache.txt\tstatus=resolved_uncommitted\treason=snapshot target content and mode match working tree but not HEAD' "${special_first}" "tracked tab path should stay intact on cold compare"
assert_contains $'compare_file\tsnapshot_id='"${special_snapshot_id}"$'\trepo=.\tfile=note\\ncache.txt\tstatus=resolved_uncommitted\treason=snapshot target content and mode match working tree but not HEAD' "${special_first}" "untracked newline path should stay intact on cold compare"

special_second="$(cd "${special_path_repo}" && git_snapshot_test_cmd compare "${special_snapshot_id}" --repo . --all --porcelain)"
assert_contains $'\tcache_hit_repos=1\tcache_miss_repos=0\tcontract_version=5' "${special_second}" "second special-path compare should hit cache"
special_rows_first="$(printf "%s\n" "${special_first}" | grep '^compare_file' || true)"
special_rows_second="$(printf "%s\n" "${special_second}" | grep '^compare_file' || true)"
assert_eq "${special_rows_first}" "${special_rows_second}" "special-path cache hits should preserve identical escaped compare_file rows"

printf "tracked-diverged\n" > "${special_path_repo}/${special_tracked_path}"
printf "untracked-diverged\n" > "${special_path_repo}/${special_untracked_path}"
special_third="$(cd "${special_path_repo}" && git_snapshot_test_cmd compare "${special_snapshot_id}" --repo . --all --porcelain)"
assert_contains $'\tcache_hit_repos=0\tcache_miss_repos=1\tcontract_version=5' "${special_third}" "special-path content changes should invalidate cache"
assert_contains $'compare_file\tsnapshot_id='"${special_snapshot_id}"$'\trepo=.\tfile=tracked\\tcache.txt\tstatus=unresolved_diverged\treason=current content or mode diverges from snapshot target' "${special_third}" "tracked tab path should recalculate on cache miss"
assert_contains $'compare_file\tsnapshot_id='"${special_snapshot_id}"$'\trepo=.\tfile=note\\ncache.txt\tstatus=unresolved_diverged\treason=current content or mode diverges from snapshot target' "${special_third}" "untracked newline path should recalculate on cache miss"

git -C "${repo}" add tracked.txt
git -C "${repo}" commit -m "head invalidation" >/dev/null
head_invalidation_compare="$(cd "${repo}" && git_snapshot_test_cmd compare "${snapshot_id}" --repo . --all --porcelain)"
assert_contains $'\tcache_hit_repos=0\tcache_miss_repos=1\tcontract_version=5' "${head_invalidation_compare}" "HEAD changes should invalidate cache"

# 2) Missing-repo classification should be cacheable and deterministic.
nested_root="$(git_snapshot_test_make_nested_fixture)"
printf "sub1-progress\n" >> "${nested_root}/modules/sub1/sub1.txt"
missing_create_output="$(cd "${nested_root}" && git_snapshot_test_cmd create cache-hit-missing-repo)"
missing_snapshot_id="$(git_snapshot_test_get_snapshot_id_from_create_output "${missing_create_output}")"
assert_eq "cache-hit-missing-repo" "${missing_snapshot_id}" "missing-repo cache snapshot id should be preserved"

rm -rf "${nested_root}/modules/sub1"
missing_first="$(cd "${nested_root}" && git_snapshot_test_cmd compare "${missing_snapshot_id}" --repo modules/sub1 --porcelain)"
assert_contains $'compare_file\tsnapshot_id='"${missing_snapshot_id}"$'\trepo=modules/sub1\tfile=sub1.txt\tstatus=unresolved_missing\treason=repo missing at modules/sub1' "${missing_first}" "missing repo should report unresolved_missing with repo-missing reason"
assert_contains $'\tcache_hit_repos=0\tcache_miss_repos=1\tcontract_version=5' "${missing_first}" "first missing-repo compare should miss cache"

missing_second="$(cd "${nested_root}" && git_snapshot_test_cmd compare "${missing_snapshot_id}" --repo modules/sub1 --porcelain)"
assert_contains $'\tcache_hit_repos=1\tcache_miss_repos=0\tcontract_version=5' "${missing_second}" "second missing-repo compare should hit cache"

# 3) Parallel execution should keep deterministic compare_file ordering.
order_root_repo="${TEST_REPOS_ROOT}/order-super"
order_sub1_repo="${TEST_REPOS_ROOT}/order-sub1"
order_sub2_repo="${TEST_REPOS_ROOT}/order-sub2"

git_snapshot_test_init_repo "${order_sub2_repo}"
git_snapshot_test_commit_file "${order_sub2_repo}" "sub2.txt" "sub2-base" "init order sub2"

git_snapshot_test_init_repo "${order_sub1_repo}"
git_snapshot_test_commit_file "${order_sub1_repo}" "sub1.txt" "sub1-base" "init order sub1"
git -C "${order_sub1_repo}" -c protocol.file.allow=always submodule add "${order_sub2_repo}" "modules/sub2" >/dev/null
git -C "${order_sub1_repo}" commit -am "add order sub2" >/dev/null

git_snapshot_test_init_repo "${order_root_repo}"
git_snapshot_test_commit_file "${order_root_repo}" "root.txt" "root-base" "init order root"
git -C "${order_root_repo}" -c protocol.file.allow=always submodule add "${order_sub1_repo}" "modules/sub1" >/dev/null
git -C "${order_root_repo}" commit -am "add order sub1" >/dev/null
git -C "${order_root_repo}" -c protocol.file.allow=always submodule update --init --recursive >/dev/null

order_root="$(cd "${order_root_repo}" && pwd -P)"
printf "root-snapshot\n" >> "${order_root}/root.txt"
git -C "${order_root}" add root.txt
printf "sub1-snapshot\n" >> "${order_root}/modules/sub1/sub1.txt"
git -C "${order_root}/modules/sub1" add sub1.txt
printf "sub2-snapshot\n" >> "${order_root}/modules/sub1/modules/sub2/sub2.txt"
git -C "${order_root}/modules/sub1/modules/sub2" add sub2.txt

order_create_output="$(cd "${order_root}" && git_snapshot_test_cmd create cache-hit-ordering)"
order_snapshot_id="$(git_snapshot_test_get_snapshot_id_from_create_output "${order_create_output}")"
assert_eq "cache-hit-ordering" "${order_snapshot_id}" "ordering snapshot id should be preserved"

printf "root-diverge\n" >> "${order_root}/root.txt"
printf "sub1-diverge\n" >> "${order_root}/modules/sub1/sub1.txt"
printf "sub2-diverge\n" >> "${order_root}/modules/sub1/modules/sub2/sub2.txt"

order_first="$(cd "${order_root}" && GIT_SNAPSHOT_COMPARE_JOBS=8 git_snapshot_test_cmd compare "${order_snapshot_id}" --all --porcelain)"
order_second="$(cd "${order_root}" && GIT_SNAPSHOT_COMPARE_JOBS=8 git_snapshot_test_cmd compare "${order_snapshot_id}" --all --porcelain)"

assert_contains $'compare_summary\tsnapshot_id='"${order_snapshot_id}"$'\trepos_checked=3' "${order_first}" "ordering compare should process all repos"
assert_contains $'\tcontract_version=5' "${order_first}" "ordering compare should emit v5 contract summary"

order_rows_first="$(printf "%s\n" "${order_first}" | grep '^compare_file' || true)"
order_rows_second="$(printf "%s\n" "${order_second}" | grep '^compare_file' || true)"
assert_eq "${order_rows_first}" "${order_rows_second}" "parallel compare should keep deterministic compare_file row ordering"
