#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
status=0

for test_file in "${SCRIPT_DIR}"/test-*.sh; do
  [[ -e "${test_file}" ]] || continue
  printf "\n==> RUN %s\n" "$(basename "${test_file}")"
  if ! "${test_file}"; then
    status=1
    printf "==> FAIL %s\n" "$(basename "${test_file}")"
  else
    printf "==> PASS %s\n" "$(basename "${test_file}")"
  fi
done

if ! "${SCRIPT_DIR}/git-snapshot/run-all.sh"; then
  status=1
fi

exit "${status}"
