#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
BASH_HELPERS_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd -P)"

exec "${BASH_HELPERS_ROOT}/lib/git-snapshot/ui-tests/run-tests.sh" general-ui 13 "$@"
