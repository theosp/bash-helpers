#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"

status=0

for test_file in "${SCRIPT_DIR}"/git-snapshot/test-*.sh; do
  printf "\n==> RUN %s\n" "$(basename "${test_file}")"
  if ! "${test_file}"; then
    status=1
    printf "==> FAIL %s\n" "$(basename "${test_file}")"
  else
    printf "==> PASS %s\n" "$(basename "${test_file}")"
  fi
done

exit "${status}"
