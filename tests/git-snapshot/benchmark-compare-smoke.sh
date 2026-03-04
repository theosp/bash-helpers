#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/../helpers/assertions.bash"
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/../helpers/fixtures.bash"

git_snapshot_test_setup_sandbox
repo="${TEST_REPOS_ROOT}/perf-compare"

git_snapshot_test_init_repo "${repo}"

tracked_file_count=80
untracked_file_count=40
for i in $(seq 1 "${tracked_file_count}"); do
  file_name="$(printf "tracked-%03d.txt" "${i}")"
  printf "base-%03d\n" "${i}" > "${repo}/${file_name}"
done
git -C "${repo}" add .
git -C "${repo}" commit -m "seed tracked files" >/dev/null

base_create_output="$(cd "${repo}" && git_snapshot_test_cmd create benchmark-base)"
base_snapshot_id="$(git_snapshot_test_get_snapshot_id_from_create_output "${base_create_output}")"
assert_eq "benchmark-base" "${base_snapshot_id}" "benchmark snapshot id should be preserved"

for i in $(seq 1 "${tracked_file_count}"); do
  file_name="$(printf "tracked-%03d.txt" "${i}")"
  printf "delta-%03d\n" "${i}" >> "${repo}/${file_name}"
  if (( i % 2 == 0 )); then
    git -C "${repo}" add "${file_name}"
  fi
done

for i in $(seq 1 "${untracked_file_count}"); do
  file_name="$(printf "untracked-%03d.txt" "${i}")"
  printf "new-%03d\n" "${i}" > "${repo}/${file_name}"
done

SECONDS=0
set +e
compare_output="$(cd "${repo}" && git_snapshot_test_cmd compare "${base_snapshot_id}" --repo . 2>&1)"
compare_code=$?
set -e
elapsed_seconds="${SECONDS}"

assert_exit_code 0 "${compare_code}" "benchmark compare run should execute in diagnostic mode"
assert_contains "Repos checked: 1 | repos with file differences: 1 | repos with head differences: 0" "${compare_output}" "benchmark compare should detect file differences"
assert_contains "Compare: differences detected." "${compare_output}" "benchmark compare should report differences"

max_seconds="${GIT_SNAPSHOT_PERF_MAX_SECONDS:-20}"
if (( elapsed_seconds > max_seconds )); then
  fail "Benchmark compare took ${elapsed_seconds}s, above threshold ${max_seconds}s."
fi

printf "benchmark compare_elapsed_seconds=%s max_seconds=%s tracked_files=%s untracked_files=%s\n" \
  "${elapsed_seconds}" \
  "${max_seconds}" \
  "${tracked_file_count}" \
  "${untracked_file_count}"
