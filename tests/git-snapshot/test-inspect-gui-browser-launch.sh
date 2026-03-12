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

extract_logged_arg0() {
  local opener_log_file="$1"
  awk -F= '/^arg_0=/{print $2; exit}' "${opener_log_file}"
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
  local opener_path="${fake_bin_dir}/${opener_name}"

  {
    printf '#!/usr/bin/env bash\n'
    printf '\n'
    printf 'set -euo pipefail\n'
    printf 'LOG_FILE=%q\n' "${log_file}"
    printf '{\n'
    printf '  printf "command=%s\\n" %q\n' "${opener_name}" "${opener_name}"
    printf '  printf "arg_0=%%s\\n" "${1:-}"\n'
    printf '  printf "\\n"\n'
    printf '} >> "${LOG_FILE}"\n'
  } > "${opener_path}"

  chmod +x "${opener_path}"
}

stop_gui() {
  local gui_pid="$1"

  if kill -0 "${gui_pid}" >/dev/null 2>&1; then
    kill "${gui_pid}" >/dev/null 2>&1 || true
    wait "${gui_pid}" 2>/dev/null || true
  fi
}

git_snapshot_test_setup_sandbox
root_repo="$(git_snapshot_test_make_nested_fixture)"
fake_bin_dir="${TEST_SANDBOX}/bin"
gui_log_file="${TEST_SANDBOX}/inspect-gui.log"
open_log_file="${TEST_SANDBOX}/open.log"

mkdir -p "${fake_bin_dir}"
write_fake_which "${fake_bin_dir}"
write_fake_opener "${fake_bin_dir}" "open" "${open_log_file}"

printf "inspect-browser-stage\n" >> "${root_repo}/root.txt"
git -C "${root_repo}" add root.txt
printf "inspect-browser-untracked\n" > "${root_repo}/inspect-browser-untracked.txt"

create_output="$(cd "${root_repo}" && git_snapshot_test_cmd create gui-inspect-browser-launch)"
snapshot_id="$(git_snapshot_test_get_snapshot_id_from_create_output "${create_output}")"
assert_eq "gui-inspect-browser-launch" "${snapshot_id}" "inspect browser launch snapshot id should be preserved"

(
  cd "${root_repo}"
  exec env \
    HOME="${TEST_HOME}" \
    GIT_SNAPSHOT_ENFORCE_ROOT_PREFIX="${GIT_SNAPSHOT_ENFORCE_ROOT_PREFIX}" \
    PATH="${fake_bin_dir}:${PATH}" \
    GIT_SNAPSHOT_GUI_STREAM_OUTPUT=1 \
    "${GIT_SNAPSHOT_BIN}" inspect "${snapshot_id}" --gui
) > "${gui_log_file}" 2>&1 &
gui_pid=$!

wait_for_gui_log_line "${gui_log_file}" "${gui_pid}" "Snapshot GUI server (inspect):"
wait_for_gui_log_line "${gui_log_file}" "${gui_pid}" "Opened in browser via: open"
wait_for_file_non_empty "${open_log_file}" "${gui_pid}"

gui_url="$(extract_gui_url "${gui_log_file}")"
assert_non_empty "${gui_url}" "inspect gui launch should publish a URL"
assert_contains "Snapshot GUI server (inspect):" "$(cat "${gui_log_file}")" "inspect gui launch should log inspect mode"
assert_eq "${gui_url}" "$(extract_logged_arg0 "${open_log_file}")" "inspect gui opener should receive the exact GUI URL"

stop_gui "${gui_pid}"
