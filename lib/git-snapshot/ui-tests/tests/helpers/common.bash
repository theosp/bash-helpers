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
  local tool_name="${3:-fake-tool}"
  local fake_bin_dir="${runtime_dir}/fake-bin"
  local fake_tool_path="${fake_bin_dir}/${tool_name}"

  mkdir -p "${fake_bin_dir}"
  cat > "${fake_tool_path}" <<EOF
#!/usr/bin/env bash

set -euo pipefail

printf "tool=${tool_name}\nsnapshot_file=%s\ncurrent_file=%s\n\n" "\$1" "\$2" >> "${external_diff_log}"
EOF
  chmod +x "${fake_tool_path}"
}

git_snapshot_ui_write_fake_named_external_diff_tool() {
  local fake_bin_dir="$1"
  local tool_name="$2"
  local external_diff_log="$3"
  local tool_path="${fake_bin_dir}/${tool_name}"

  mkdir -p "${fake_bin_dir}"
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
  for tool_name in meld kdiff3 opendiff bcompare code; do
    git_snapshot_ui_write_fake_named_external_diff_tool "${fake_bin_dir}" "${tool_name}" "${external_diff_log}"
  done
}

git_snapshot_ui_prepare_general_ui_suite() {
  local runtime_dir="$1"
  local selected_test="${2:-}"
  local run_mode="${3:-automated}"
  local repo=""
  local clean_sub_repo=""
  local create_output=""
  local older_create_output=""
  local snapshot_id=""
  local older_snapshot_id=""
  local gui_log_file=""
  local gui_pid=""
  local gui_url=""
  local external_diff_tool=""
  local external_diff_command_template=""
  local external_diff_log=""
  local external_diff_spawn_log=""
  local fake_bin_dir=""
  local allow_real_external_diff="${GIT_SNAPSHOT_UI_TESTS_ALLOW_REAL_EXTERNAL_DIFF:-0}"
  local malicious_branch=""
  local trailing_space_path=""
  local i=0

  mkdir -p "${runtime_dir}"

  git_snapshot_test_setup_sandbox
  GIT_SNAPSHOT_UI_PREP_KEEP_SANDBOX=0
  GIT_SNAPSHOT_UI_PREP_GUI_PID=""
  trap 'git_snapshot_ui_prepare_cleanup' EXIT

  repo="${TEST_REPOS_ROOT}/gui-scroll"
  clean_sub_repo="${TEST_REPOS_ROOT}/gui-scroll-clean-sub"

  git_snapshot_test_init_repo "${clean_sub_repo}"
  git_snapshot_test_commit_file "${clean_sub_repo}" "clean-sub.txt" "clean-sub-base" "init clean submodule"

  git_snapshot_test_init_repo "${repo}"

  printf "base-target\n" > "${repo}/000-scroll-target.txt"
  printf "staged-base\n" > "${repo}/inspect-staged.txt"
  printf "unstaged-base\n" > "${repo}/inspect-unstaged.txt"
  printf "older-base\n" > "${repo}/older-only.txt"
  for i in $(seq -w 1 140); do
    printf "base row %s\n" "${i}" > "${repo}/row-${i}.txt"
  done
  git -C "${repo}" add .
  git -C "${repo}" commit -m "seed gui scroll fixture" >/dev/null
  git -C "${repo}" -c protocol.file.allow=always submodule add "${clean_sub_repo}" "modules/clean-sub" >/dev/null
  git -C "${repo}" commit -am "add clean submodule" >/dev/null

  printf "older snapshot line\n" >> "${repo}/older-only.txt"
  git -C "${repo}" add older-only.txt
  older_create_output="$(cd "${repo}" && git_snapshot_test_cmd create gui-scroll-earlier)"
  older_snapshot_id="$(git_snapshot_test_get_snapshot_id_from_create_output "${older_create_output}")"
  if [[ "${older_snapshot_id}" != "gui-scroll-earlier" ]]; then
    git_snapshot_ui_fail "expected snapshot id gui-scroll-earlier, got ${older_snapshot_id}"
  fi
  git -C "${repo}" reset --hard >/dev/null
  git -C "${repo}" clean -fd >/dev/null
  git -C "${repo}" -c protocol.file.allow=always submodule update --init --recursive >/dev/null

  printf "snapshot anchor\n" >> "${repo}/000-scroll-target.txt"
  printf "captured staged line\n" >> "${repo}/inspect-staged.txt"
  printf "captured unstaged line\n" >> "${repo}/inspect-unstaged.txt"
  {
    printf "captured untracked line 1\n"
    printf "captured untracked line 2\n"
  } > "${repo}/inspect-untracked.txt"
  if [[ "${selected_test}" == "05" ]]; then
    printf "captured dash-prefixed untracked line\n" > "${repo}/--inspect-untracked.txt"
  elif [[ "${selected_test}" == "07" ]]; then
    trailing_space_path="trailing-space.txt "
    printf "captured trailing-space payload\n" > "${repo}/${trailing_space_path}"
  fi
  for i in $(seq -w 1 140); do
    printf "snapshot row %s\n" "${i}" >> "${repo}/row-${i}.txt"
  done
  (
    cd "${repo}"
    git add 000-scroll-target.txt inspect-staged.txt row-*.txt
  )

  create_output="$(cd "${repo}" && git_snapshot_test_cmd create gui-scroll-playwright)"
  snapshot_id="$(git_snapshot_test_get_snapshot_id_from_create_output "${create_output}")"
  if [[ "${snapshot_id}" != "gui-scroll-playwright" ]]; then
    git_snapshot_ui_fail "expected snapshot id gui-scroll-playwright, got ${snapshot_id}"
  fi

  for i in $(seq 1 240); do
    printf "diverged line %03d\n" "${i}" >> "${repo}/000-scroll-target.txt"
  done

  if [[ "${selected_test}" == "05" ]]; then
    malicious_branch='inspect-<svg/onload=window.__inspectSummaryXss=1>'
    git -C "${repo}" checkout -b "${malicious_branch}" >/dev/null
  fi

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
        export GIT_SNAPSHOT_GUI_EXTERNAL_DIFF_CANDIDATES="meld,kdiff3,opendiff,bcompare,code"
        unset GIT_SNAPSHOT_GUI_EXTERNAL_DIFF_COMMAND_TEMPLATE
        external_diff_command_template=""
        unset GIT_SNAPSHOT_GUI_TEST_EXTERNAL_DIFF_TOOL
      elif [[ "${selected_test}" == "01" ]]; then
        external_diff_tool="fake-template"
        external_diff_command_template='fake-template --left "$SOURCE" --title "Snapshot file" --right "$TARGET"'
        git_snapshot_ui_write_fake_named_external_diff_tool "${fake_bin_dir}" "${external_diff_tool}" "${external_diff_log}"
        export GIT_SNAPSHOT_GUI_EXTERNAL_DIFF_COMMAND_TEMPLATE="${external_diff_command_template}"
        unset GIT_SNAPSHOT_GUI_EXTERNAL_DIFF_CANDIDATES
        unset GIT_SNAPSHOT_GUI_TEST_EXTERNAL_DIFF_TOOL
      elif [[ "${selected_test}" == "06" ]]; then
        external_diff_tool="definitely-missing-tool"
        export GIT_SNAPSHOT_GUI_EXTERNAL_DIFF_TOOL="${external_diff_tool}"
        unset GIT_SNAPSHOT_GUI_EXTERNAL_DIFF_COMMAND_TEMPLATE
        unset GIT_SNAPSHOT_GUI_EXTERNAL_DIFF_CANDIDATES
        unset GIT_SNAPSHOT_GUI_TEST_EXTERNAL_DIFF_TOOL
      else
        external_diff_tool="fake-tool"
        git_snapshot_ui_write_fake_external_diff_tool "${runtime_dir}" "${external_diff_log}"
        unset GIT_SNAPSHOT_GUI_EXTERNAL_DIFF_COMMAND_TEMPLATE
        unset GIT_SNAPSHOT_GUI_EXTERNAL_DIFF_CANDIDATES
        export GIT_SNAPSHOT_GUI_TEST_EXTERNAL_DIFF_TOOL="${external_diff_tool}"
      fi
      export GIT_SNAPSHOT_GUI_TEST_EXTERNAL_DIFF_SPAWN_LOG="${external_diff_spawn_log}"
      export PATH="${fake_bin_dir}:${PATH}"
      unset GIT_SNAPSHOT_GUI_TEST_EXTERNAL_DIFF_LOG
      if [[ "${selected_test}" != "06" ]]; then
        unset GIT_SNAPSHOT_GUI_EXTERNAL_DIFF_TOOL
      fi
    else
      unset GIT_SNAPSHOT_GUI_EXTERNAL_DIFF_CANDIDATES
      if [[ "${allow_real_external_diff}" == "1" || "${allow_real_external_diff}" == "true" ]]; then
        unset GIT_SNAPSHOT_GUI_EXTERNAL_DIFF_TOOL
        unset GIT_SNAPSHOT_GUI_EXTERNAL_DIFF_COMMAND_TEMPLATE
        unset GIT_SNAPSHOT_GUI_TEST_EXTERNAL_DIFF_TOOL
        unset GIT_SNAPSHOT_GUI_TEST_EXTERNAL_DIFF_LOG
        unset GIT_SNAPSHOT_GUI_TEST_EXTERNAL_DIFF_SPAWN_LOG
        external_diff_command_template=""
      else
        external_diff_tool="manual-noop-external-diff"
        external_diff_log="${runtime_dir}/manual-external-diff.log"
        export GIT_SNAPSHOT_GUI_EXTERNAL_DIFF_TOOL="${external_diff_tool}"
        unset GIT_SNAPSHOT_GUI_EXTERNAL_DIFF_COMMAND_TEMPLATE
        export GIT_SNAPSHOT_GUI_TEST_EXTERNAL_DIFF_LOG="${external_diff_log}"
        unset GIT_SNAPSHOT_GUI_TEST_EXTERNAL_DIFF_TOOL
        unset GIT_SNAPSHOT_GUI_TEST_EXTERNAL_DIFF_SPAWN_LOG
        external_diff_command_template=""
      fi
    fi

    if [[ "${selected_test}" == "02" ]]; then
      export GIT_SNAPSHOT_GUI_TEST_FAIL_DATA=1
    else
      unset GIT_SNAPSHOT_GUI_TEST_FAIL_DATA
    fi

    if [[ "${selected_test}" == "04" ]]; then
      export GIT_SNAPSHOT_GUI_TEST_COMPARE_DATA_DELAY_MS=400
    else
      unset GIT_SNAPSHOT_GUI_TEST_COMPARE_DATA_DELAY_MS
    fi
    unset GIT_SNAPSHOT_GUI_TEST_INSPECT_DATA_DELAY_MS

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
    if [[ "${selected_test}" == "01" ]]; then
      external_diff_tool="fake-template"
      external_diff_command_template='fake-template --left "$SOURCE" --title "Snapshot file" --right "$TARGET"'
    elif [[ "${selected_test}" == "06" ]]; then
      external_diff_tool="definitely-missing-tool"
    elif [[ "${selected_test}" != "03" ]]; then
      external_diff_tool="fake-tool"
    fi
  elif [[ "${allow_real_external_diff}" != "1" && "${allow_real_external_diff}" != "true" ]]; then
    external_diff_tool="manual-noop-external-diff"
    external_diff_log="${runtime_dir}/manual-external-diff.log"
  fi

  gui_url="$(git_snapshot_ui_wait_for_gui_url "${gui_log_file}" "${gui_pid}")"

  git_snapshot_ui_write_env_file "${runtime_dir}/playwright.env" \
    GIT_SNAPSHOT_COMPARE_GUI_URL "${gui_url}" \
    GIT_SNAPSHOT_UI_TEST_REPO "${repo}" \
    GIT_SNAPSHOT_UI_TEST_CLEAN_REPO "modules/clean-sub" \
    GIT_SNAPSHOT_UI_TEST_RUNTIME_DIR "${runtime_dir}" \
    GIT_SNAPSHOT_UI_TEST_GUI_PID "${gui_pid}" \
    GIT_SNAPSHOT_UI_TEST_GUI_LOG_FILE "${gui_log_file}" \
    GIT_SNAPSHOT_GUI_EXTERNAL_DIFF_TOOL "${external_diff_tool}" \
    GIT_SNAPSHOT_GUI_EXTERNAL_DIFF_COMMAND_TEMPLATE "${external_diff_command_template}" \
    GIT_SNAPSHOT_UI_TEST_PRIMARY_SNAPSHOT_ID "${snapshot_id}" \
    GIT_SNAPSHOT_UI_TEST_OLDER_SNAPSHOT_ID "${older_snapshot_id}" \
    GIT_SNAPSHOT_UI_TEST_MALICIOUS_BRANCH "${malicious_branch}" \
    GIT_SNAPSHOT_UI_TEST_TRAILING_SPACE_PATH "${trailing_space_path}" \
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
