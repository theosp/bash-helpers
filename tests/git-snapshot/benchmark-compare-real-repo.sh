#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
BASH_HELPERS_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd -P)"
GIT_SNAPSHOT_BIN="${BASH_HELPERS_ROOT}/bin/git-snapshot"

benchmark_usage() {
  cat <<'USAGE'
Usage:
  benchmark-compare-real-repo.sh <root_repo> <snapshot_id>

Environment:
  GIT_SNAPSHOT_BENCHMARK_ROOT_REPO=<path>     Optional root repo override.
  GIT_SNAPSHOT_BENCHMARK_SNAPSHOT_ID=<id>     Optional snapshot id override.
  GIT_SNAPSHOT_BENCHMARK_JOBS="1 2 4 8"       Space-separated worker counts.
  GIT_SNAPSHOT_BENCHMARK_INCLUDE_WARM=<0|1>   Whether to rerun each case warm.

Output:
  One `benchmark_result` line per run, including jobs, temperature, and the
  original compare summary fields.
USAGE
}

root_repo="${1:-${GIT_SNAPSHOT_BENCHMARK_ROOT_REPO:-}}"
snapshot_id="${2:-${GIT_SNAPSHOT_BENCHMARK_SNAPSHOT_ID:-}}"

if [[ -z "${root_repo}" || -z "${snapshot_id}" ]]; then
  benchmark_usage >&2
  exit 1
fi

root_repo="$(cd "${root_repo}" && pwd -P)"
jobs_raw="${GIT_SNAPSHOT_BENCHMARK_JOBS:-1 2 4 8 12 16}"
include_warm="${GIT_SNAPSHOT_BENCHMARK_INCLUDE_WARM:-1}"

snapshot_store_root="${HOME}/git-snapshots/$(basename "${root_repo}")"
snapshot_path="${snapshot_store_root}/${snapshot_id}"
cache_snapshot_dir="${snapshot_store_root}/.compare-cache-v2/${snapshot_id}"

if [[ ! -x "${GIT_SNAPSHOT_BIN}" ]]; then
  printf "benchmark error: git-snapshot binary not found: %s\n" "${GIT_SNAPSHOT_BIN}" >&2
  exit 1
fi

if [[ ! -d "${root_repo}" ]]; then
  printf "benchmark error: root repo not found: %s\n" "${root_repo}" >&2
  exit 1
fi

if [[ ! -d "${snapshot_path}" ]]; then
  printf "benchmark error: snapshot not found: %s\n" "${snapshot_id}" >&2
  exit 1
fi

drop_compare_cache() {
  rm -rf "${cache_snapshot_dir}"
}

emit_benchmark_result() {
  local jobs="$1"
  local temperature="$2"
  local summary_line="$3"

  if [[ "${summary_line}" != compare_summary$'\t'* ]]; then
    printf "benchmark error: missing compare_summary line for jobs=%s temperature=%s\n" \
      "${jobs}" \
      "${temperature}" >&2
    return 1
  fi

  printf "benchmark_result\tjobs=%s\ttemperature=%s\t%s\n" \
    "${jobs}" \
    "${temperature}" \
    "${summary_line#compare_summary$'\t'}"
}

run_compare_once() {
  local jobs="$1"
  local temperature="$2"
  local compare_output=""
  local summary_line=""

  compare_output="$(cd "${root_repo}" && \
    GIT_SNAPSHOT_COMPARE_CACHE=1 \
    GIT_SNAPSHOT_COMPARE_JOBS="${jobs}" \
    "${GIT_SNAPSHOT_BIN}" compare "${snapshot_id}" --porcelain)"
  summary_line="$(printf "%s\n" "${compare_output}" | grep '^compare_summary' || true)"
  emit_benchmark_result "${jobs}" "${temperature}" "${summary_line}"
}

for jobs in ${jobs_raw}; do
  drop_compare_cache
  run_compare_once "${jobs}" "cold"
  if [[ "${include_warm}" == "1" || "${include_warm}" == "true" ]]; then
    run_compare_once "${jobs}" "warm"
  fi
done
