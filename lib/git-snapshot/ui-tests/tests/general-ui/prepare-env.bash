#!/usr/bin/env bash

set -euo pipefail

if [[ "$#" -lt 1 ]]; then
  printf "usage: %s <runtime-dir> [test-num] [mode]\n" "$0" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
RUNTIME_DIR="$1"
TEST_NUM="${2:-}"
RUN_MODE="${3:-automated}"

# shellcheck source=/dev/null
source "${SCRIPT_DIR}/../helpers/common.bash"

git_snapshot_ui_prepare_general_ui_suite "${RUNTIME_DIR}" "${TEST_NUM}" "${RUN_MODE}"
