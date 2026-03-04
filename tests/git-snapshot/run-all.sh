#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"

status=0

for test_file in "${SCRIPT_DIR}"/test-*.sh; do
  printf "\n==> RUN %s\n" "$(basename "${test_file}")"
  if ! "${test_file}"; then
    status=1
    printf "==> FAIL %s\n" "$(basename "${test_file}")"
  else
    printf "==> PASS %s\n" "$(basename "${test_file}")"
  fi
done

if [[ "${GIT_SNAPSHOT_INCLUDE_PERF_SMOKE:-false}" == "true" ]]; then
  printf "\n==> RUN %s\n" "benchmark-compare-smoke.sh"
  if ! "${SCRIPT_DIR}/benchmark-compare-smoke.sh"; then
    status=1
    printf "==> FAIL %s\n" "benchmark-compare-smoke.sh"
  else
    printf "==> PASS %s\n" "benchmark-compare-smoke.sh"
  fi
fi

exit "${status}"
