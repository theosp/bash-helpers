#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
BASH_HELPERS_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd -P)"

# shellcheck source=/dev/null
source "${SCRIPT_DIR}/helpers/assertions.bash"
# shellcheck source=/dev/null
source "${BASH_HELPERS_ROOT}/functions/command-exists.bash"
# shellcheck source=/dev/null
source "${BASH_HELPERS_ROOT}/functions/arrays.bash"
# shellcheck source=/dev/null
source "${BASH_HELPERS_ROOT}/functions/csv.bash"
# shellcheck source=/dev/null
source "${BASH_HELPERS_ROOT}/functions/cross-platform-commands.bash"
# shellcheck source=/dev/null
source "${BASH_HELPERS_ROOT}/functions/paths.bash"

TEST_SANDBOX="$(mktemp -d "${TMPDIR:-/tmp}/bash-helpers-paths-test.XXXXXX")"
trap 'rm -rf "${TEST_SANDBOX}"' EXIT

assert_true() {
  if ! "$@"; then
    fail "Expected command to succeed: $*"
  fi
}

assert_false() {
  if "$@"; then
    fail "Expected command to fail: $*"
  fi
}

assert_eq "${HOME}" "$(expandUserPath "~")" "expandUserPath should expand bare home"
assert_eq "${HOME}/example" "$(expandUserPath "~/example")" "expandUserPath should expand home-prefixed child path"
assert_eq "/tmp/example" "$(expandUserPath "/tmp/example")" "expandUserPath should preserve non-home paths"

assert_true pathBasenameHasDelimitedToken "/tmp/build" "build"
assert_true pathBasenameHasDelimitedToken "/tmp/cache-build" "build"
assert_true pathBasenameHasDelimitedToken "/tmp/build-cache" "build"
assert_true pathBasenameHasDelimitedToken "/tmp/cache_build_tmp" "build"
assert_false pathBasenameHasDelimitedToken "/tmp/rebuild" "build"
assert_false pathBasenameHasDelimitedToken "/tmp/building" "build"
assert_false pathBasenameHasDelimitedToken "/tmp/cache-output" ""

assert_true pathBasenameHasAnyDelimitedToken "/tmp/cache-output" "build" "output"
assert_false pathBasenameHasAnyDelimitedToken "/tmp/cache" "build" "output"

mkdir -p "${TEST_SANDBOX}/real-root/inside/deeper"
mkdir -p "${TEST_SANDBOX}/outside"
ln -s "${TEST_SANDBOX}/real-root" "${TEST_SANDBOX}/linked-root"
printf 'file root fixture\n' > "${TEST_SANDBOX}/real-file"
ln -s "${TEST_SANDBOX}/real-file" "${TEST_SANDBOX}/linked-file"
REAL_ROOT_PHYSICAL_PATH="$(cd "${TEST_SANDBOX}/real-root" && pwd -P)"
REAL_FILE_PHYSICAL_PATH="$(cd "$(dirname "${TEST_SANDBOX}/real-file")" && pwd -P)/$(basename "${TEST_SANDBOX}/real-file")"

assert_eq "${REAL_ROOT_PHYSICAL_PATH}" "$(resolvePathAgainstPhysicalBaseDir "." "${TEST_SANDBOX}/linked-root")" "resolvePathAgainstPhysicalBaseDir should use a physical base dir"
assert_eq "${REAL_ROOT_PHYSICAL_PATH}/inside/future-child" "$(resolvePathAgainstPhysicalBaseDir "inside/future-child" "${TEST_SANDBOX}/linked-root")" "resolvePathAgainstPhysicalBaseDir should preserve unresolved descendants under the physical base dir"
assert_eq "${REAL_FILE_PHYSICAL_PATH}" "$(resolvePathAgainstPhysicalBaseDir "${TEST_SANDBOX}/linked-file" "${TEST_SANDBOX}")" "resolvePathAgainstPhysicalBaseDir should resolve symlinked file targets"

assert_true pathIsWithinRoot "${TEST_SANDBOX}/real-root/inside" "${TEST_SANDBOX}/real-root"
assert_true pathIsWithinRoot "${TEST_SANDBOX}/real-root" "${TEST_SANDBOX}/real-root"
assert_false pathIsWithinRoot "${TEST_SANDBOX}/outside" "${TEST_SANDBOX}/real-root"
assert_true pathIsWithinRoot "${TEST_SANDBOX}/real-root/nonexistent/child" "${TEST_SANDBOX}/real-root"
assert_true pathIsWithinRoot "${TEST_SANDBOX}/real-file" "${TEST_SANDBOX}/real-file"
assert_false pathIsWithinRoot "${TEST_SANDBOX}/real-file/child" "${TEST_SANDBOX}/real-file"
assert_true pathIsWithinRoot "${TEST_SANDBOX}/linked-file" "${TEST_SANDBOX}/linked-file"
assert_false pathIsWithinRoot "${TEST_SANDBOX}/linked-file/child" "${TEST_SANDBOX}/linked-file"

(
  cd "${TEST_SANDBOX}/linked-root"
  assert_true pathIsWithinRoot "./inside/deeper" "."
  assert_true pathIsWithinRoot "./inside/future-child" "."
  assert_false pathIsWithinRoot "../outside" "."
)

assert_true pathIsWithinRoot "real-root/inside/deeper" "real-root" "${TEST_SANDBOX}"
assert_false pathIsWithinRoot "outside" "real-root" "${TEST_SANDBOX}"
