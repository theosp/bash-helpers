#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
HELPERS_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd -P)"

usage() {
  cat <<'EOF'
Usage: run-staged-export-tests.sh <test-name-or-path> [more tests...]

Exports the current git index into a temporary tree and runs the requested
git-snapshot shell tests from that exported tree. This is useful when staged
content differs from the worktree on hot files.

Examples:
  run-staged-export-tests.sh test-compare-gui.sh
  run-staged-export-tests.sh tests/git-snapshot/test-compare.sh test-gui-command.sh
EOF
}

if [[ $# -eq 0 ]]; then
  usage >&2
  exit 1
fi

staged_root="$(mktemp -d "${TMPDIR:-/tmp}/git-snapshot-staged-tests.XXXXXX")"
cleanup() {
  rm -rf "${staged_root}"
}
trap cleanup EXIT

git -C "${HELPERS_ROOT}" checkout-index -a -f --prefix="${staged_root}/"

if [[ -z "${PLAYWRIGHT_BROWSERS_PATH:-}" ]]; then
  playwright_cache_dir="${HELPERS_ROOT}/lib/git-snapshot/ui-tests/.ms-playwright"
  if [[ -d "${playwright_cache_dir}" ]]; then
    export PLAYWRIGHT_BROWSERS_PATH="${playwright_cache_dir}"
  fi
fi

resolve_test_path() {
  local raw_path="$1"
  if [[ "${raw_path}" == */* ]]; then
    printf "%s/%s\n" "${staged_root}" "${raw_path}"
    return 0
  fi
  printf "%s/tests/git-snapshot/%s\n" "${staged_root}" "${raw_path}"
}

for requested_test in "$@"; do
  test_path="$(resolve_test_path "${requested_test}")"
  if [[ ! -f "${test_path}" ]]; then
    printf "Missing staged-export test: %s\n" "${requested_test}" >&2
    exit 1
  fi
  printf "\n==> RUN %s\n" "${requested_test}"
  bash "${test_path}"
done
