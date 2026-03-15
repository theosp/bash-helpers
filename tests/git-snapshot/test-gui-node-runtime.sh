#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/../helpers/assertions.bash"
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/../helpers/fixtures.bash"

write_fake_node() {
  local fake_bin_dir="$1"
  local log_file="$2"
  local fake_node_path="${fake_bin_dir}/node"

  {
    printf '#!/usr/bin/env bash\n'
    printf '\n'
    printf 'set -euo pipefail\n'
    printf 'LOG_FILE=%q\n' "${log_file}"
    printf 'printf "fake node invoked: %%s\\n" "$*" >> "${LOG_FILE}"\n'
    printf 'if [[ "${1:-}" == "--version" || "${1:-}" == "-v" ]]; then\n'
    printf '  printf "v0.0.0-fake\\n"\n'
    printf '  exit 0\n'
    printf 'fi\n'
    printf 'exit 42\n'
  } > "${fake_node_path}"

  chmod +x "${fake_node_path}"
}

write_matching_fake_node() {
  local fake_bin_dir="$1"
  local log_file="$2"
  local real_node_path="$3"
  local pinned_version="$4"
  local fake_node_path="${fake_bin_dir}/node"

  {
    printf '#!/usr/bin/env bash\n'
    printf '\n'
    printf 'set -euo pipefail\n'
    printf 'LOG_FILE=%q\n' "${log_file}"
    printf 'REAL_NODE=%q\n' "${real_node_path}"
    printf 'PINNED_VERSION=%q\n' "${pinned_version}"
    printf 'printf "matching fake node invoked: %%s\\n" "$*" >> "${LOG_FILE}"\n'
    printf 'if [[ "${1:-}" == "--version" || "${1:-}" == "-v" ]]; then\n'
    printf '  printf "v%%s\\n" "${PINNED_VERSION}"\n'
    printf '  exit 0\n'
    printf 'fi\n'
    printf 'exec "${REAL_NODE}" "$@"\n'
  } > "${fake_node_path}"

  chmod +x "${fake_node_path}"
}

write_fake_nvm_dir() {
  local fake_nvm_dir="$1"
  local pinned_version="$2"
  local nvm_sh="${fake_nvm_dir}/nvm.sh"

  mkdir -p "${fake_nvm_dir}"
  {
    printf 'nvm() {\n'
    printf '  if [[ "${1:-}" == "use" && "${2:-}" == %q ]]; then\n' "${pinned_version}"
    printf '    return 1\n'
    printf '  fi\n'
    printf '  return 1\n'
    printf '}\n'
  } > "${nvm_sh}"
}

git_snapshot_test_setup_sandbox
root_repo="$(git_snapshot_test_make_nested_fixture)"

printf "gui-runtime-stage\n" >> "${root_repo}/root.txt"
git -C "${root_repo}" add root.txt
printf "gui-runtime-untracked\n" > "${root_repo}/inspect-runtime-untracked.txt"

create_output="$(cd "${root_repo}" && git_snapshot_test_cmd create gui-node-runtime)"
snapshot_id="$(git_snapshot_test_get_snapshot_id_from_create_output "${create_output}")"
assert_eq "gui-node-runtime" "${snapshot_id}" "gui runtime snapshot id should be preserved"

pinned_version="$(< "${BASH_HELPERS_ROOT}/.nvmrc")"
real_node_path="$(command -v node)"
assert_non_empty "${real_node_path}" "runtime coverage requires a host node binary to wrap"
fake_bin_dir="${TEST_SANDBOX}/fake-bin"
fake_node_log="${TEST_SANDBOX}/fake-node.log"
mkdir -p "${fake_bin_dir}"
write_fake_node "${fake_bin_dir}" "${fake_node_log}"

compare_runtime_output="$(cd "${root_repo}" && PATH="${fake_bin_dir}:${PATH}" GIT_SNAPSHOT_GUI_TEST_MODE=1 git_snapshot_test_cmd compare "${snapshot_id}" --gui)"
assert_contains "GUI_TEST mode=compare snapshot_id=${snapshot_id}" "${compare_runtime_output}" "compare --gui should still launch through the pinned Node runtime"
fake_node_usage="$(cat "${fake_node_log}")"
assert_contains "fake node invoked: -v" "${fake_node_usage}" "compare --gui should inspect the ambient node before selecting the pinned runtime via nvm"
assert_not_contains "git-snapshot-compare-gui.js" "${fake_node_usage}" "compare --gui should not launch the GUI through the ambient fake node once nvm selects the pinned runtime"

inspect_runtime_output="$(cd "${root_repo}" && PATH="${fake_bin_dir}:${PATH}" GIT_SNAPSHOT_GUI_TEST_MODE=1 git_snapshot_test_cmd inspect "${snapshot_id}" --gui)"
assert_contains "GUI_TEST mode=inspect" "${inspect_runtime_output}" "inspect --gui should still launch through the pinned Node runtime"
fake_node_usage="$(cat "${fake_node_log}")"
assert_not_contains "git-snapshot-compare-gui.js" "${fake_node_usage}" "inspect --gui should not launch the GUI through the ambient fake node once nvm selects the pinned runtime"

matching_bin_dir="${TEST_SANDBOX}/matching-bin"
matching_node_log="${TEST_SANDBOX}/matching-node.log"
missing_nvm_dir="${TEST_SANDBOX}/missing-nvm"
mkdir -p "${matching_bin_dir}"
write_matching_fake_node "${matching_bin_dir}" "${matching_node_log}" "${real_node_path}" "${pinned_version}"

path_only_compare_output="$(cd "${root_repo}" && PATH="${matching_bin_dir}:${PATH}" NVM_DIR="${missing_nvm_dir}" GIT_SNAPSHOT_GUI_TEST_MODE=1 git_snapshot_test_cmd compare "${snapshot_id}" --gui)"
assert_contains "GUI_TEST mode=compare snapshot_id=${snapshot_id}" "${path_only_compare_output}" "compare --gui should accept the pinned Node version already on PATH when nvm is unavailable"
assert_file_exists "${matching_node_log}" "compare --gui should use the matching node already on PATH when nvm is unavailable"
matching_node_usage="$(cat "${matching_node_log}")"
assert_contains "git-snapshot-compare-gui.js" "${matching_node_usage}" "compare --gui should launch through the matching node already on PATH when nvm is unavailable"

path_only_inspect_output="$(cd "${root_repo}" && PATH="${matching_bin_dir}:${PATH}" NVM_DIR="${missing_nvm_dir}" GIT_SNAPSHOT_GUI_TEST_MODE=1 git_snapshot_test_cmd inspect "${snapshot_id}" --gui)"
assert_contains "GUI_TEST mode=inspect" "${path_only_inspect_output}" "inspect --gui should accept the pinned Node version already on PATH when nvm is unavailable"
assert_file_exists "${matching_node_log}" "inspect --gui should use the matching node already on PATH when nvm is unavailable"

missing_nvm_dir="${TEST_SANDBOX}/missing-nvm"
set +e
missing_nvm_output="$(cd "${root_repo}" && PATH="${fake_bin_dir}:${PATH}" NVM_DIR="${missing_nvm_dir}" GIT_SNAPSHOT_GUI_TEST_MODE=1 git_snapshot_test_cmd compare "${snapshot_id}" --gui 2>&1)"
missing_nvm_code=$?
set -e
assert_exit_code 1 "${missing_nvm_code}" "compare --gui should fail clearly when node on PATH is not the pinned version and nvm is unavailable"
assert_contains "Missing ${missing_nvm_dir}/nvm.sh. Set NVM_DIR, install nvm and Node ${pinned_version}, or ensure node -v resolves to ${pinned_version} first." "${missing_nvm_output}" "missing nvm guidance should explain both the nvm path and matching PATH-node fallback"

fake_nvm_dir="${TEST_SANDBOX}/fake-nvm"
write_fake_nvm_dir "${fake_nvm_dir}" "${pinned_version}"

set +e
missing_version_output="$(cd "${root_repo}" && PATH="${fake_bin_dir}:${PATH}" NVM_DIR="${fake_nvm_dir}" GIT_SNAPSHOT_GUI_TEST_MODE=1 git_snapshot_test_cmd inspect "${snapshot_id}" --gui 2>&1)"
missing_version_code=$?
set -e
assert_exit_code 1 "${missing_version_code}" "inspect --gui should fail clearly when the pinned Node version is unavailable"
assert_contains "Unable to select Node ${pinned_version} via nvm. Install it with: nvm install ${pinned_version}" "${missing_version_output}" "missing pinned Node guidance should include the exact install command"
