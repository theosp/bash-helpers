#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/../helpers/assertions.bash"
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/../helpers/fixtures.bash"

wait_for_gui_log_line() {
  local gui_log_file="$1"
  local gui_pid="$2"
  local pattern="$3"
  local text=""
  local attempt=0

  for attempt in $(seq 1 200); do
    if ! kill -0 "${gui_pid}" >/dev/null 2>&1; then
      text="$(cat "${gui_log_file}" 2>/dev/null || true)"
      fail "GUI command exited before logging '${pattern}'. Output: ${text}"
    fi

    text="$(cat "${gui_log_file}" 2>/dev/null || true)"
    if [[ "${text}" == *"${pattern}"* ]]; then
      return 0
    fi

    sleep 0.1
  done

  text="$(cat "${gui_log_file}" 2>/dev/null || true)"
  fail "Timed out waiting for '${pattern}'. Output: ${text}"
}

wait_for_file_non_empty() {
  local target_file="$1"
  local gui_pid="$2"
  local attempt=0

  for attempt in $(seq 1 200); do
    if [[ -s "${target_file}" ]]; then
      return 0
    fi

    if ! kill -0 "${gui_pid}" >/dev/null 2>&1; then
      fail "GUI command exited before writing ${target_file}"
    fi

    sleep 0.1
  done

  fail "Timed out waiting for non-empty file: ${target_file}"
}

extract_gui_url() {
  local gui_log_file="$1"
  grep -Eo 'http://127\.0\.0\.1:[0-9]+/' "${gui_log_file}" | tail -n 1
}

extract_gui_port() {
  local gui_log_file="$1"
  extract_gui_url "${gui_log_file}" | sed -E 's#http://127\.0\.0\.1:([0-9]+)/#\1#'
}

extract_logged_arg0() {
  local opener_log_file="$1"
  awk -F= '/^arg_0=/{print $2; exit}' "${opener_log_file}"
}

find_free_loopback_port() {
  python3 - <<'PY'
import socket

sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
sock.bind(("127.0.0.1", 0))
print(sock.getsockname()[1])
sock.close()
PY
}

start_port_blocker() {
  local port="$1"
  local blocker_pid=""
  local attempt=0

  python3 -c 'import socket, sys, time
port = int(sys.argv[1])
sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
sock.bind(("127.0.0.1", port))
sock.listen(1)
time.sleep(120)' "${port}" >/dev/null 2>&1 &
  blocker_pid=$!

  for attempt in $(seq 1 50); do
    if ! kill -0 "${blocker_pid}" >/dev/null 2>&1; then
      fail "Port blocker exited before binding 127.0.0.1:${port}"
    fi
    if python3 -c 'import socket, sys
port = int(sys.argv[1])
sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
sock.settimeout(0.2)
result = sock.connect_ex(("127.0.0.1", port))
sock.close()
raise SystemExit(0 if result == 0 else 1)' "${port}" >/dev/null 2>&1; then
      printf "%s\n" "${blocker_pid}"
      return 0
    fi
    sleep 0.1
  done

  kill "${blocker_pid}" >/dev/null 2>&1 || true
  wait "${blocker_pid}" 2>/dev/null || true
  fail "Timed out waiting for port blocker on 127.0.0.1:${port}"
}

stop_port_blocker() {
  local blocker_pid="${1:-}"
  if [[ -n "${blocker_pid}" ]] && kill -0 "${blocker_pid}" >/dev/null 2>&1; then
    kill "${blocker_pid}" >/dev/null 2>&1 || true
    wait "${blocker_pid}" 2>/dev/null || true
  fi
}

write_fake_which() {
  local fake_bin_dir="$1"
  local which_path="${fake_bin_dir}/which"

  {
    printf '#!/usr/bin/env bash\n'
    printf '\n'
    printf 'set -euo pipefail\n'
    printf 'FAKE_BIN_DIR=%q\n' "${fake_bin_dir}"
    printf 'CANDIDATE=${1:-}\n'
    printf 'TARGET="${FAKE_BIN_DIR}/${CANDIDATE}"\n'
    printf 'if [[ -n "${CANDIDATE}" && -x "${TARGET}" && "${CANDIDATE}" != "which" ]]; then\n'
    printf '  printf "%%s\\n" "${TARGET}"\n'
    printf '  exit 0\n'
    printf 'fi\n'
    printf 'exit 1\n'
  } > "${which_path}"

  chmod +x "${which_path}"
}

write_fake_opener() {
  local fake_bin_dir="$1"
  local opener_name="$2"
  local log_file="$3"
  local exit_code="$4"
  local opener_path="${fake_bin_dir}/${opener_name}"

  {
    printf '#!/usr/bin/env bash\n'
    printf '\n'
    printf 'set -euo pipefail\n'
    printf 'LOG_FILE=%q\n' "${log_file}"
    printf 'EXIT_CODE=%q\n' "${exit_code}"
    printf '{\n'
    printf '  printf "command=%s\\n" %q\n' "${opener_name}" "${opener_name}"
    printf '  printf "arg_0=%%s\\n" "${1:-}"\n'
    printf '  printf "\\n"\n'
    printf '} >> "${LOG_FILE}"\n'
    printf 'exit "${EXIT_CODE}"\n'
  } > "${opener_path}"

  chmod +x "${opener_path}"
}

start_gui_compare() {
  local root_repo="$1"
  local snapshot_id="$2"
  local fake_bin_dir="$3"
  local gui_log_file="$4"
  local no_browser="${5:-0}"
  local gui_port_start="${6:-}"
  local gui_port_count="${7:-}"
  local gui_pid=""

  (
    cd "${root_repo}"
    exec env \
      HOME="${TEST_HOME}" \
      NVM_DIR="${GIT_SNAPSHOT_TEST_HOST_NVM_DIR}" \
      GIT_SNAPSHOT_ENFORCE_ROOT_PREFIX="${GIT_SNAPSHOT_ENFORCE_ROOT_PREFIX}" \
      PATH="${fake_bin_dir}:${PATH}" \
      GIT_SNAPSHOT_GUI_STREAM_OUTPUT=1 \
      GIT_SNAPSHOT_GUI_NO_BROWSER="${no_browser}" \
      GIT_SNAPSHOT_GUI_PORT_START="${gui_port_start}" \
      GIT_SNAPSHOT_GUI_PORT_COUNT="${gui_port_count}" \
      "${GIT_SNAPSHOT_BIN}" compare "${snapshot_id}" --repo . --include-no-effect --gui
  ) > "${gui_log_file}" 2>&1 &
  gui_pid=$!

  wait_for_gui_log_line "${gui_log_file}" "${gui_pid}" "Snapshot GUI server (compare):"
  printf "%s\n" "${gui_pid}"
}

stop_gui_compare() {
  local gui_pid="$1"

  if kill -0 "${gui_pid}" >/dev/null 2>&1; then
    kill "${gui_pid}" >/dev/null 2>&1 || true
    wait "${gui_pid}" 2>/dev/null || true
  fi
}

run_gui_compare_expect_failure() {
  local case_name="$1"
  local gui_port_start="${2:-}"
  local gui_port_count="${3:-}"
  local expected_log_line="$4"
  local case_dir="${TEST_SANDBOX}/${case_name}"
  local fake_bin_dir="${case_dir}/bin"
  local gui_log_file="${case_dir}/gui.log"
  local gui_output=""
  local status=0

  mkdir -p "${fake_bin_dir}"
  write_fake_which "${fake_bin_dir}"

  set +e
  (
    cd "${root_repo}"
    exec env \
      HOME="${TEST_HOME}" \
      NVM_DIR="${GIT_SNAPSHOT_TEST_HOST_NVM_DIR}" \
      GIT_SNAPSHOT_ENFORCE_ROOT_PREFIX="${GIT_SNAPSHOT_ENFORCE_ROOT_PREFIX}" \
      PATH="${fake_bin_dir}:${PATH}" \
      GIT_SNAPSHOT_GUI_STREAM_OUTPUT=1 \
      GIT_SNAPSHOT_GUI_NO_BROWSER=1 \
      GIT_SNAPSHOT_GUI_PORT_START="${gui_port_start}" \
      GIT_SNAPSHOT_GUI_PORT_COUNT="${gui_port_count}" \
      "${GIT_SNAPSHOT_BIN}" compare "${snapshot_id}" --repo . --include-no-effect --gui
  ) > "${gui_log_file}" 2>&1
  status=$?
  set -e

  gui_output="$(cat "${gui_log_file}")"

  if [[ "${status}" -eq 0 ]]; then
    fail "Expected compare --gui to fail for ${case_name}. Output: ${gui_output}"
  fi

  assert_contains "${expected_log_line}" "${gui_output}" "failure output should mention ${case_name}"
  assert_not_contains "Snapshot GUI server (compare):" "${gui_output}" "failed GUI case should not publish a server URL"
}

run_browser_launch_case() {
  local case_name="$1"
  local include_open="$2"
  local open_exit_code="$3"
  local include_xdg_open="$4"
  local xdg_exit_code="$5"
  local no_browser="$6"
  local expected_log_line="$7"
  local expect_open_invocation="${8:-0}"
  local expect_xdg_invocation="${9:-0}"
  local gui_port_start="${10:-}"
  local gui_port_count="${11:-}"
  local case_dir="${TEST_SANDBOX}/${case_name}"
  local fake_bin_dir="${case_dir}/bin"
  local gui_log_file="${case_dir}/gui.log"
  local open_log_file="${case_dir}/open.log"
  local xdg_log_file="${case_dir}/xdg-open.log"
  local gui_pid=""
  local gui_output=""
  local gui_url=""

  mkdir -p "${fake_bin_dir}"
  write_fake_which "${fake_bin_dir}"
  if [[ "${include_open}" == "1" ]]; then
    write_fake_opener "${fake_bin_dir}" "open" "${open_log_file}" "${open_exit_code}"
  fi
  if [[ "${include_xdg_open}" == "1" ]]; then
    write_fake_opener "${fake_bin_dir}" "xdg-open" "${xdg_log_file}" "${xdg_exit_code}"
  fi

  gui_pid="$(start_gui_compare "${root_repo}" "${snapshot_id}" "${fake_bin_dir}" "${gui_log_file}" "${no_browser}" "${gui_port_start}" "${gui_port_count}")"
  wait_for_gui_log_line "${gui_log_file}" "${gui_pid}" "${expected_log_line}"
  gui_output="$(cat "${gui_log_file}")"
  gui_url="$(extract_gui_url "${gui_log_file}")"

  assert_non_empty "${gui_url}" "GUI URL should be published for ${case_name}"
  assert_contains "${expected_log_line}" "${gui_output}" "browser launch log should match ${case_name}"

  if [[ "${expect_open_invocation}" == "1" ]]; then
    wait_for_file_non_empty "${open_log_file}" "${gui_pid}"
  else
    assert_file_not_exists "${open_log_file}" "open should not be invoked for ${case_name}"
  fi

  if [[ "${expect_xdg_invocation}" == "1" ]]; then
    wait_for_file_non_empty "${xdg_log_file}" "${gui_pid}"
  else
    assert_file_not_exists "${xdg_log_file}" "xdg-open should not be invoked for ${case_name}"
  fi

  stop_gui_compare "${gui_pid}"
}

git_snapshot_test_setup_sandbox
root_repo="$(git_snapshot_test_make_nested_fixture)"

printf "browser-launch-stage\n" >> "${root_repo}/root.txt"
git -C "${root_repo}" add root.txt
create_output="$(cd "${root_repo}" && git_snapshot_test_cmd create gui-browser-launch)"
snapshot_id="$(git_snapshot_test_get_snapshot_id_from_create_output "${create_output}")"
assert_eq "gui-browser-launch" "${snapshot_id}" "browser launch snapshot id should be preserved"
fallback_blocker_pid=""
trap 'stop_port_blocker "${fallback_blocker_pid:-}"' EXIT

run_browser_launch_case \
  "open-preferred" \
  "1" "0" \
  "1" "0" \
  "0" \
  "Opened in browser via: open" \
  "1" "0"

run_browser_launch_case \
  "open-fallback-xdg" \
  "1" "1" \
  "1" "0" \
  "0" \
  "Opened in browser via: xdg-open" \
  "1" "1"

run_browser_launch_case \
  "no-browser-opener" \
  "0" "0" \
  "0" "0" \
  "0" \
  "Open URL manually in a browser." \
  "0" "0"

run_browser_launch_case \
  "skip-browser-launch" \
  "1" "0" \
  "1" "0" \
  "1" \
  "Browser launch skipped by GIT_SNAPSHOT_GUI_NO_BROWSER=1." \
  "0" "0"

preferred_port_case_port="$(find_free_loopback_port)"
run_browser_launch_case \
  "preferred-port-free" \
  "0" "0" \
  "0" "0" \
  "1" \
  "Browser launch skipped by GIT_SNAPSHOT_GUI_NO_BROWSER=1." \
  "0" "0" \
  "${preferred_port_case_port}" "3"
assert_eq "${preferred_port_case_port}" "$(extract_gui_port "${TEST_SANDBOX}/preferred-port-free/gui.log")" "GUI should bind the first preferred port when it is free"

fallback_port_case_port="$(find_free_loopback_port)"
fallback_blocker_pid="$(start_port_blocker "${fallback_port_case_port}")"
run_browser_launch_case \
  "preferred-port-fallback" \
  "0" "0" \
  "0" "0" \
  "1" \
  "Browser launch skipped by GIT_SNAPSHOT_GUI_NO_BROWSER=1." \
  "0" "0" \
  "${fallback_port_case_port}" "3"
stop_port_blocker "${fallback_blocker_pid}"
fallback_blocker_pid=""
assert_eq "$((fallback_port_case_port + 1))" "$(extract_gui_port "${TEST_SANDBOX}/preferred-port-fallback/gui.log")" "GUI should bind the next preferred port when the first one is occupied"

run_gui_compare_expect_failure \
  "preferred-port-invalid-count" \
  "${preferred_port_case_port}" "0" \
  "GIT_SNAPSHOT_GUI_PORT_COUNT must be a positive integer."

run_gui_compare_expect_failure \
  "preferred-port-range-overflow" \
  "65535" "2" \
  "Configured GUI port range exceeds 65535: start=65535, count=2."

exhausted_port_case_port="$(find_free_loopback_port)"
fallback_blocker_pid="$(start_port_blocker "${exhausted_port_case_port}")"
run_gui_compare_expect_failure \
  "preferred-port-range-exhausted" \
  "${exhausted_port_case_port}" "1" \
  "Failed to bind GUI server on 127.0.0.1 within preferred port range ${exhausted_port_case_port}-${exhausted_port_case_port}."
stop_port_blocker "${fallback_blocker_pid}"
fallback_blocker_pid=""

open_preferred_log="${TEST_SANDBOX}/open-preferred/gui.log"
fallback_log="${TEST_SANDBOX}/open-fallback-xdg/gui.log"
no_opener_log="${TEST_SANDBOX}/no-browser-opener/gui.log"
skip_browser_log="${TEST_SANDBOX}/skip-browser-launch/gui.log"

open_preferred_url="$(extract_gui_url "${open_preferred_log}")"
fallback_url="$(extract_gui_url "${fallback_log}")"
no_opener_url="$(extract_gui_url "${no_opener_log}")"
skip_browser_url="$(extract_gui_url "${skip_browser_log}")"

assert_eq "${open_preferred_url}" "$(extract_logged_arg0 "${TEST_SANDBOX}/open-preferred/open.log")" "open should receive the exact GUI URL"
assert_eq "${fallback_url}" "$(extract_logged_arg0 "${TEST_SANDBOX}/open-fallback-xdg/open.log")" "failed open should still receive the exact GUI URL"
assert_eq "${fallback_url}" "$(extract_logged_arg0 "${TEST_SANDBOX}/open-fallback-xdg/xdg-open.log")" "xdg-open fallback should receive the exact GUI URL"
assert_non_empty "${no_opener_url}" "manual-open case should still publish a URL"
assert_non_empty "${skip_browser_url}" "no-browser case should still publish a URL"
