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

work_create_output="$(cd "${repo}" && git_snapshot_test_cmd create benchmark-work)"
work_snapshot_id="$(git_snapshot_test_get_snapshot_id_from_create_output "${work_create_output}")"
assert_eq "benchmark-work" "${work_snapshot_id}" "benchmark snapshot id should be preserved"

SECONDS=0
set +e
compare_output="$(cd "${repo}" && git_snapshot_test_cmd compare "${work_snapshot_id}" --repo . --all 2>&1)"
compare_code=$?
set -e
compare_elapsed_seconds="${SECONDS}"

assert_exit_code 0 "${compare_code}" "benchmark compare run should execute successfully"
assert_contains "Rows shown: all statuses" "${compare_output}" "benchmark compare should include all rows"
assert_contains "Repos checked: 1 | snapshot files tracked: 120 | unresolved: 0 | resolved: 120" "${compare_output}" "benchmark compare should process all benchmark files"
assert_contains "Compare: no unresolved snapshot work." "${compare_output}" "benchmark compare should report resolved state"

SECONDS=0
set +e
compare_warm_output="$(cd "${repo}" && git_snapshot_test_cmd compare "${work_snapshot_id}" --repo . --all 2>&1)"
compare_warm_code=$?
set -e
compare_warm_elapsed_seconds="${SECONDS}"

assert_exit_code 0 "${compare_warm_code}" "benchmark warm compare run should execute successfully"
assert_contains "Rows shown: all statuses" "${compare_warm_output}" "warm benchmark compare should include all rows"
assert_contains "Repos checked: 1 | snapshot files tracked: 120 | unresolved: 0 | resolved: 120" "${compare_warm_output}" "warm benchmark compare should process all benchmark files"

max_seconds="${GIT_SNAPSHOT_PERF_MAX_SECONDS:-20}"
if (( compare_elapsed_seconds > max_seconds )); then
  fail "Benchmark compare (all rows, cold) took ${compare_elapsed_seconds}s, above threshold ${max_seconds}s."
fi

warm_slack_seconds="${GIT_SNAPSHOT_PERF_WARM_SLACK_SECONDS:-1}"
if (( compare_warm_elapsed_seconds > compare_elapsed_seconds + warm_slack_seconds )); then
  fail "Benchmark compare warm run (${compare_warm_elapsed_seconds}s) exceeded cold run (${compare_elapsed_seconds}s) + slack (${warm_slack_seconds}s)."
fi

for i in $(seq 1 "${tracked_file_count}"); do
  file_name="$(printf "tracked-%03d.txt" "${i}")"
  printf "post-%03d\n" "${i}" >> "${repo}/${file_name}"
done
for i in $(seq 1 "${untracked_file_count}"); do
  file_name="$(printf "untracked-%03d.txt" "${i}")"
  rm -f "${repo}/${file_name}"
done

SECONDS=0
set +e
compare_unresolved_output="$(cd "${repo}" && git_snapshot_test_cmd compare "${work_snapshot_id}" --repo . 2>&1)"
compare_unresolved_code=$?
set -e
compare_unresolved_elapsed_seconds="${SECONDS}"

assert_exit_code 0 "${compare_unresolved_code}" "benchmark compare unresolved run should execute successfully"
assert_contains "Rows shown: unresolved only" "${compare_unresolved_output}" "benchmark unresolved compare should keep default visibility"
assert_contains "Repos checked: 1 | snapshot files tracked: 120 | unresolved: 120 | resolved: 0" "${compare_unresolved_output}" "benchmark unresolved compare should classify all files as unresolved"
assert_contains "Compare: unresolved snapshot work remains." "${compare_unresolved_output}" "benchmark unresolved compare should report unresolved state"

SECONDS=0
set +e
compare_unresolved_warm_output="$(cd "${repo}" && git_snapshot_test_cmd compare "${work_snapshot_id}" --repo . 2>&1)"
compare_unresolved_warm_code=$?
set -e
compare_unresolved_warm_elapsed_seconds="${SECONDS}"

assert_exit_code 0 "${compare_unresolved_warm_code}" "benchmark unresolved warm compare run should execute successfully"
assert_contains "Rows shown: unresolved only" "${compare_unresolved_warm_output}" "benchmark unresolved warm compare should keep default visibility"
assert_contains "Repos checked: 1 | snapshot files tracked: 120 | unresolved: 120 | resolved: 0" "${compare_unresolved_warm_output}" "benchmark unresolved warm compare should classify all files as unresolved"

max_seconds_unresolved="${GIT_SNAPSHOT_PERF_MAX_SECONDS_UNRESOLVED:-${max_seconds}}"
if (( compare_unresolved_elapsed_seconds > max_seconds_unresolved )); then
  fail "Benchmark compare (unresolved rows, cold) took ${compare_unresolved_elapsed_seconds}s, above threshold ${max_seconds_unresolved}s."
fi

if (( compare_unresolved_warm_elapsed_seconds > compare_unresolved_elapsed_seconds + warm_slack_seconds )); then
  fail "Benchmark compare unresolved warm run (${compare_unresolved_warm_elapsed_seconds}s) exceeded cold run (${compare_unresolved_elapsed_seconds}s) + slack (${warm_slack_seconds}s)."
fi

printf "benchmark compare_elapsed_seconds=%s compare_warm_elapsed_seconds=%s compare_unresolved_elapsed_seconds=%s compare_unresolved_warm_elapsed_seconds=%s max_seconds=%s max_seconds_unresolved=%s warm_slack_seconds=%s tracked_files=%s untracked_files=%s\n" \
  "${compare_elapsed_seconds}" \
  "${compare_warm_elapsed_seconds}" \
  "${compare_unresolved_elapsed_seconds}" \
  "${compare_unresolved_warm_elapsed_seconds}" \
  "${max_seconds}" \
  "${max_seconds_unresolved}" \
  "${warm_slack_seconds}" \
  "${tracked_file_count}" \
  "${untracked_file_count}"
