#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/../helpers/assertions.bash"
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/../helpers/fixtures.bash"

write_wrong_fake_node() {
  local fake_bin_dir="$1"
  local log_file="$2"
  local fake_node_path="${fake_bin_dir}/node"

  {
    printf '#!/usr/bin/env bash\n'
    printf '\n'
    printf 'set -euo pipefail\n'
    printf 'LOG_FILE=%q\n' "${log_file}"
    printf 'printf "wrong fake node: %%s\\n" "$*" >> "${LOG_FILE}"\n'
    printf 'if [[ "${1:-}" == "--version" || "${1:-}" == "-v" ]]; then\n'
    printf '  printf "v0.0.0-fake\\n"\n'
    printf '  exit 0\n'
    printf 'fi\n'
    printf 'exit 42\n'
  } > "${fake_node_path}"

  chmod +x "${fake_node_path}"
}

git_snapshot_test_setup_sandbox

fake_bin_dir="${TEST_SANDBOX}/fake-bin"
fake_node_log="${TEST_SANDBOX}/fake-node.log"
missing_nvm_dir="${TEST_SANDBOX}/missing-nvm"
pinned_version="$(< "${BASH_HELPERS_ROOT}/.nvmrc")"

mkdir -p "${fake_bin_dir}"
write_wrong_fake_node "${fake_bin_dir}" "${fake_node_log}"

set +e
runner_output="$(cd "${BASH_HELPERS_ROOT}" && PATH="${fake_bin_dir}:${PATH}" NVM_DIR="${missing_nvm_dir}" ./lib/git-snapshot/ui-tests/run-tests.sh general-ui 00 2>&1)"
runner_code=$?
set -e

assert_exit_code 1 "${runner_code}" "ui runner should fail clearly when node on PATH is not the pinned version and nvm is unavailable"
assert_contains "Missing ${missing_nvm_dir}/nvm.sh. Set NVM_DIR, install nvm and Node ${pinned_version}, or ensure node -v resolves to ${pinned_version} first." "${runner_output}" "ui runner should explain how to satisfy the pinned Node runtime"
assert_file_exists "${fake_node_log}" "ui runner should inspect the ambient node version before falling back to nvm"
