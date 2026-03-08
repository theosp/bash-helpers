#!/usr/bin/env bash

set -euo pipefail

GIT_SNAPSHOT_UI_TESTS_HELPERS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
GIT_SNAPSHOT_UI_TESTS_DIR="$(cd "${GIT_SNAPSHOT_UI_TESTS_HELPERS_DIR}/.." && pwd -P)"
GIT_SNAPSHOT_UI_PROJECT_DIR="$(cd "${GIT_SNAPSHOT_UI_TESTS_DIR}/.." && pwd -P)"
BASH_HELPERS_ROOT="$(cd "${GIT_SNAPSHOT_UI_PROJECT_DIR}/../../.." && pwd -P)"

# shellcheck source=/dev/null
source "${BASH_HELPERS_ROOT}/tests/helpers/fixtures.bash"

GIT_SNAPSHOT_UI_PREP_KEEP_SANDBOX=0
GIT_SNAPSHOT_UI_PREP_GUI_PID=""

git_snapshot_ui_fail() {
  printf "git-snapshot ui-tests: %s\n" "$*" >&2
  exit 1
}

git_snapshot_ui_prepare_cleanup() {
  local status=$?

  if [[ "${GIT_SNAPSHOT_UI_PREP_KEEP_SANDBOX:-0}" == "1" ]]; then
    return "${status}"
  fi

  if [[ -n "${GIT_SNAPSHOT_UI_PREP_GUI_PID:-}" ]] && kill -0 "${GIT_SNAPSHOT_UI_PREP_GUI_PID}" >/dev/null 2>&1; then
    kill "${GIT_SNAPSHOT_UI_PREP_GUI_PID}" >/dev/null 2>&1 || true
    for _i in $(seq 1 50); do
      if ! kill -0 "${GIT_SNAPSHOT_UI_PREP_GUI_PID}" >/dev/null 2>&1; then
        break
      fi
      sleep 0.1
    done
  fi

  git_snapshot_test_cleanup_sandbox || true
  return "${status}"
}

git_snapshot_ui_extract_gui_url() {
  local gui_log_file="$1"

  [[ -f "${gui_log_file}" ]] || return 0
  grep -Eo 'http://127\.0\.0\.1:[0-9]+/' "${gui_log_file}" | tail -n 1 || true
}

git_snapshot_ui_wait_for_gui_url() {
  local gui_log_file="$1"
  local gui_pid="$2"
  local url=""
  local attempt=0

  for attempt in $(seq 1 200); do
    if [[ -n "${gui_pid}" ]] && ! kill -0 "${gui_pid}" >/dev/null 2>&1; then
      printf "GUI server exited before publishing a URL.\n" >&2
      sed -n '1,200p' "${gui_log_file}" >&2 || true
      return 1
    fi

    url="$(git_snapshot_ui_extract_gui_url "${gui_log_file}")"
    if [[ -n "${url}" ]]; then
      printf "%s\n" "${url}"
      return 0
    fi

    sleep 0.1
  done

  printf "Timed out waiting for GUI server URL.\n" >&2
  sed -n '1,200p' "${gui_log_file}" >&2 || true
  return 1
}

git_snapshot_ui_write_env_file() {
  local env_file="$1"
  shift

  : > "${env_file}"
  while [[ "$#" -gt 1 ]]; do
    printf "%s=%q\n" "$1" "$2" >> "${env_file}"
    shift 2
  done
}

git_snapshot_ui_write_cleanup_script() {
  local cleanup_file="$1"
  local gui_pid="$2"
  local test_sandbox="$3"

  {
    printf '#!/usr/bin/env bash\n'
    printf 'set -euo pipefail\n'
    printf 'GUI_PID=%q\n' "${gui_pid}"
    printf 'TEST_SANDBOX=%q\n' "${test_sandbox}"
    printf '\n'
    printf 'if [[ -n "${GUI_PID}" ]] && kill -0 "${GUI_PID}" >/dev/null 2>&1; then\n'
    printf '  kill "${GUI_PID}" >/dev/null 2>&1 || true\n'
    printf '  for _i in $(seq 1 50); do\n'
    printf '    if ! kill -0 "${GUI_PID}" >/dev/null 2>&1; then\n'
    printf '      break\n'
    printf '    fi\n'
    printf '    sleep 0.1\n'
    printf '  done\n'
    printf 'fi\n'
    printf '\n'
    printf 'if [[ -n "${TEST_SANDBOX}" && -d "${TEST_SANDBOX}" ]]; then\n'
    printf '  rm -rf "${TEST_SANDBOX}"\n'
    printf 'fi\n'
  } > "${cleanup_file}"

  chmod +x "${cleanup_file}"
}

git_snapshot_ui_write_fake_external_diff_tool() {
  local runtime_dir="$1"
  local external_diff_log="$2"
  local fake_bin_dir="${runtime_dir}/fake-bin"
  local fake_tool_path="${fake_bin_dir}/fake-tool"

  mkdir -p "${fake_bin_dir}"
  cat > "${fake_tool_path}" <<EOF
#!/usr/bin/env bash

set -euo pipefail

printf "tool=fake-tool\nsnapshot_file=%s\ncurrent_file=%s\n\n" "\$1" "\$2" >> "${external_diff_log}"
EOF
  chmod +x "${fake_tool_path}"
}

git_snapshot_ui_write_fake_named_external_diff_tool() {
  local fake_bin_dir="$1"
  local tool_name="$2"
  local external_diff_log="$3"
  local tool_path="${fake_bin_dir}/${tool_name}"

  {
    printf '#!/usr/bin/env bash\n'
    printf '\n'
    printf 'set -euo pipefail\n'
    printf '\n'
    printf 'LOG_FILE=%q\n' "${external_diff_log}"
    printf 'TOOL_NAME=%q\n' "${tool_name}"
    printf '\n'
    printf '{\n'
    printf '  printf "tool=%%s\\n" "${TOOL_NAME}"\n'
    printf '  printf "argc=%%s\\n" "$#"\n'
    printf '  i=0\n'
    printf '  for arg in "$@"; do\n'
    printf '    printf "arg_%%s=%%s\\n" "${i}" "${arg}"\n'
    printf '    i=$((i + 1))\n'
    printf '  done\n'
    printf '  printf "\\n"\n'
    printf '} >> "${LOG_FILE}"\n'
  } > "${tool_path}"

  chmod +x "${tool_path}"
}

git_snapshot_ui_write_fake_which() {
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

git_snapshot_ui_write_fake_auto_detect_tools() {
  local runtime_dir="$1"
  local external_diff_log="$2"
  local fake_bin_dir="${runtime_dir}/fake-bin"
  local tool_name=""

  mkdir -p "${fake_bin_dir}"
  git_snapshot_ui_write_fake_which "${fake_bin_dir}"
  for tool_name in meld opendiff code; do
    git_snapshot_ui_write_fake_named_external_diff_tool "${fake_bin_dir}" "${tool_name}" "${external_diff_log}"
  done
}

git_snapshot_ui_prepare_general_ui_suite() {
  local runtime_dir="$1"
  local selected_test="${2:-}"
  local run_mode="${3:-automated}"
  local repo=""
  local create_output=""
  local snapshot_id=""
  local gui_log_file=""
  local gui_pid=""
  local gui_url=""
  local external_diff_tool=""
  local external_diff_log=""
  local external_diff_spawn_log=""
  local fake_bin_dir=""
  local i=0

  mkdir -p "${runtime_dir}"

  git_snapshot_test_setup_sandbox
  GIT_SNAPSHOT_UI_PREP_KEEP_SANDBOX=0
  GIT_SNAPSHOT_UI_PREP_GUI_PID=""
  trap 'git_snapshot_ui_prepare_cleanup' EXIT

  repo="${TEST_REPOS_ROOT}/gui-scroll"
  git_snapshot_test_init_repo "${repo}"

  printf "base-target\n" > "${repo}/000-scroll-target.txt"
  for i in $(seq -w 1 140); do
    printf "base row %s\n" "${i}" > "${repo}/row-${i}.txt"
  done
  git -C "${repo}" add .
  git -C "${repo}" commit -m "seed gui scroll fixture" >/dev/null

  printf "snapshot anchor\n" >> "${repo}/000-scroll-target.txt"
  for i in $(seq -w 1 140); do
    printf "snapshot row %s\n" "${i}" >> "${repo}/row-${i}.txt"
  done
  git -C "${repo}" add .

  create_output="$(cd "${repo}" && git_snapshot_test_cmd create gui-scroll-playwright)"
  snapshot_id="$(git_snapshot_test_get_snapshot_id_from_create_output "${create_output}")"
  if [[ "${snapshot_id}" != "gui-scroll-playwright" ]]; then
    git_snapshot_ui_fail "expected snapshot id gui-scroll-playwright, got ${snapshot_id}"
  fi

  for i in $(seq 1 240); do
    printf "diverged line %03d\n" "${i}" >> "${repo}/000-scroll-target.txt"
  done

  gui_log_file="${runtime_dir}/gui-server.log"
  (
    cd "${repo}"
    export GIT_SNAPSHOT_GUI_NO_BROWSER=1
    export GIT_SNAPSHOT_GUI_STREAM_OUTPUT=1

    if [[ "${run_mode}" != "manual" ]]; then
      external_diff_log="${runtime_dir}/external-diff.log"
      external_diff_spawn_log="${runtime_dir}/external-diff-spawn.log"
      fake_bin_dir="${runtime_dir}/fake-bin"
      if [[ "${selected_test}" == "03" ]]; then
        git_snapshot_ui_write_fake_auto_detect_tools "${runtime_dir}" "${external_diff_log}"
        unset GIT_SNAPSHOT_GUI_TEST_EXTERNAL_DIFF_TOOL
      else
        external_diff_tool="fake-tool"
        git_snapshot_ui_write_fake_external_diff_tool "${runtime_dir}" "${external_diff_log}"
        export GIT_SNAPSHOT_GUI_TEST_EXTERNAL_DIFF_TOOL="${external_diff_tool}"
      fi
      export GIT_SNAPSHOT_GUI_TEST_EXTERNAL_DIFF_SPAWN_LOG="${external_diff_spawn_log}"
      export PATH="${fake_bin_dir}:${PATH}"
      unset GIT_SNAPSHOT_GUI_TEST_EXTERNAL_DIFF_LOG
    else
      unset GIT_SNAPSHOT_GUI_TEST_EXTERNAL_DIFF_TOOL
      unset GIT_SNAPSHOT_GUI_TEST_EXTERNAL_DIFF_LOG
      unset GIT_SNAPSHOT_GUI_TEST_EXTERNAL_DIFF_SPAWN_LOG
    fi

    if [[ "${selected_test}" == "02" ]]; then
      export GIT_SNAPSHOT_GUI_TEST_FAIL_DATA=1
    else
      unset GIT_SNAPSHOT_GUI_TEST_FAIL_DATA
    fi

    git_snapshot_test_cmd compare "${snapshot_id}" --repo . --all --gui > "${gui_log_file}" 2>&1
  ) &
  gui_pid=$!
  GIT_SNAPSHOT_UI_PREP_GUI_PID="${gui_pid}"

  external_diff_tool=""
  external_diff_log=""
  external_diff_spawn_log=""
  fake_bin_dir=""
  if [[ "${run_mode}" != "manual" ]]; then
    external_diff_log="${runtime_dir}/external-diff.log"
    external_diff_spawn_log="${runtime_dir}/external-diff-spawn.log"
    fake_bin_dir="${runtime_dir}/fake-bin"
    if [[ "${selected_test}" != "03" ]]; then
      external_diff_tool="fake-tool"
    fi
  fi

  gui_url="$(git_snapshot_ui_wait_for_gui_url "${gui_log_file}" "${gui_pid}")"

  git_snapshot_ui_write_env_file "${runtime_dir}/playwright.env" \
    GIT_SNAPSHOT_COMPARE_GUI_URL "${gui_url}" \
    GIT_SNAPSHOT_UI_TEST_REPO "${repo}" \
    GIT_SNAPSHOT_UI_TEST_RUNTIME_DIR "${runtime_dir}" \
    GIT_SNAPSHOT_UI_TEST_GUI_PID "${gui_pid}" \
    GIT_SNAPSHOT_UI_TEST_GUI_LOG_FILE "${gui_log_file}" \
    GIT_SNAPSHOT_GUI_TEST_EXTERNAL_DIFF_TOOL "${external_diff_tool}" \
    GIT_SNAPSHOT_GUI_TEST_EXTERNAL_DIFF_LOG "${external_diff_log}" \
    GIT_SNAPSHOT_GUI_TEST_EXTERNAL_DIFF_SPAWN_LOG "${external_diff_spawn_log}" \
    GIT_SNAPSHOT_UI_TEST_FAKE_BIN_DIR "${fake_bin_dir}" \
    GIT_SNAPSHOT_UI_TEST_SELECTED_TEST "${selected_test}" \
    GIT_SNAPSHOT_UI_TEST_RUN_MODE "${run_mode}"
  git_snapshot_ui_write_cleanup_script "${runtime_dir}/cleanup.bash" "${gui_pid}" "${TEST_SANDBOX}"
  GIT_SNAPSHOT_UI_PREP_KEEP_SANDBOX=1
  trap - EXIT
}
