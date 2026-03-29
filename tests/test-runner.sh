#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"

# shellcheck source=/dev/null
source "${SCRIPT_DIR}/helpers/assertions.bash"

TEST_SANDBOX="$(mktemp -d "${TMPDIR:-/tmp}/bash-helpers-test-runner.XXXXXX")"
trap 'rm -rf "${TEST_SANDBOX}"' EXIT

write_executable_script() {
  local path="$1"

  cat > "${path}"
  chmod +x "${path}"
}

create_runner_fixture() {
  local fixture_dir="$1"
  local git_snapshot_exit_code="$2"
  local include_local_failure="${3:-false}"

  mkdir -p "${fixture_dir}/git-snapshot"
  cp "${SCRIPT_DIR}/run-tests.sh" "${fixture_dir}/run-tests.sh"
  chmod +x "${fixture_dir}/run-tests.sh"

  write_executable_script "${fixture_dir}/test-10-pass.sh" <<'EOF'
#!/usr/bin/env bash
printf 'local pass ran\n'
exit 0
EOF

  if [[ "${include_local_failure}" == "true" ]]; then
    write_executable_script "${fixture_dir}/test-20-fail.sh" <<'EOF'
#!/usr/bin/env bash
printf 'local fail ran\n' >&2
exit 1
EOF
  fi

  write_executable_script "${fixture_dir}/git-snapshot/run-all.sh" <<EOF
#!/usr/bin/env bash
printf 'git-snapshot suite exit ${git_snapshot_exit_code}\n'
exit ${git_snapshot_exit_code}
EOF
}

run_runner_fixture() {
  local fixture_dir="$1"
  local output_var_name="$2"
  local status_var_name="$3"
  local fixture_output=""
  local fixture_status=0

  if fixture_output="$("${fixture_dir}/run-tests.sh" 2>&1)"; then
    fixture_status=0
  else
    fixture_status=$?
  fi

  printf -v "${output_var_name}" '%s' "${fixture_output}"
  printf -v "${status_var_name}" '%s' "${fixture_status}"
}

all_pass_fixture="${TEST_SANDBOX}/all-pass"
local_fail_fixture="${TEST_SANDBOX}/local-fail"
git_snapshot_fail_fixture="${TEST_SANDBOX}/git-snapshot-fail"

create_runner_fixture "${all_pass_fixture}" 0
create_runner_fixture "${local_fail_fixture}" 0 true
create_runner_fixture "${git_snapshot_fail_fixture}" 1

all_pass_output=""
all_pass_status=0
run_runner_fixture "${all_pass_fixture}" all_pass_output all_pass_status
assert_exit_code 0 "${all_pass_status}" "run-tests.sh should exit 0 when all discovered suites pass"
assert_contains "==> RUN test-10-pass.sh" "${all_pass_output}" "run-tests.sh should discover top-level test scripts"
assert_contains "==> PASS test-10-pass.sh" "${all_pass_output}" "run-tests.sh should report passing top-level tests"
assert_contains "git-snapshot suite exit 0" "${all_pass_output}" "run-tests.sh should execute the git-snapshot suite after top-level tests"

local_fail_output=""
local_fail_status=0
run_runner_fixture "${local_fail_fixture}" local_fail_output local_fail_status
assert_exit_code 1 "${local_fail_status}" "run-tests.sh should aggregate top-level test failures"
assert_contains "==> RUN test-10-pass.sh" "${local_fail_output}" "run-tests.sh should keep the discovered test order"
assert_contains "==> PASS test-10-pass.sh" "${local_fail_output}" "run-tests.sh should report passing top-level tests before failures"
assert_contains "==> RUN test-20-fail.sh" "${local_fail_output}" "run-tests.sh should continue through later top-level tests"
assert_contains "==> FAIL test-20-fail.sh" "${local_fail_output}" "run-tests.sh should report failing top-level tests"
assert_contains "git-snapshot suite exit 0" "${local_fail_output}" "run-tests.sh should still execute the git-snapshot suite after a top-level failure"

git_snapshot_fail_output=""
git_snapshot_fail_status=0
run_runner_fixture "${git_snapshot_fail_fixture}" git_snapshot_fail_output git_snapshot_fail_status
assert_exit_code 1 "${git_snapshot_fail_status}" "run-tests.sh should aggregate git-snapshot suite failures"
assert_contains "==> PASS test-10-pass.sh" "${git_snapshot_fail_output}" "run-tests.sh should still run top-level tests before the git-snapshot suite"
assert_contains "git-snapshot suite exit 1" "${git_snapshot_fail_output}" "run-tests.sh should surface git-snapshot suite output"
