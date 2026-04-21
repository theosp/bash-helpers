#!/usr/bin/env bash

set -euo pipefail

SOURCE="${BASH_SOURCE[0]}"
while [[ -L "${SOURCE}" ]]; do
  DIR="$(cd -P "$(dirname "${SOURCE}")" && pwd)"
  SOURCE="$(readlink "${SOURCE}")"
  [[ "${SOURCE}" != /* ]] && SOURCE="${DIR}/${SOURCE}"
done

SCRIPT_DIR="$(cd -P "$(dirname "${SOURCE}")" && pwd)"
TESTS_DIR="${SCRIPT_DIR}/tests"
PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-${SCRIPT_DIR}/.ms-playwright}"
RUN_TESTS_ARTIFACTS_DIR="${SCRIPT_DIR}/.run-tests-artifacts"
RUN_TESTS_CACHE_FILE="${SCRIPT_DIR}/.run-tests.cache"
RUN_TESTS_CACHE_VERSION="1"
RUN_TESTS_CACHE_KEY_MANUAL_LAST_CATEGORY="manual.last_category"
HOST_HOME="${HOME}"
NODE_VERSION=""
ACTIVE_RUNTIME_DIR=""
ACTIVE_RUN_MODE="automated"
PLAYWRIGHT_BROWSER_NAME="${GIT_SNAPSHOT_UI_TEST_BROWSER:-chromium}"
TEST_CATEGORIES=()
TEST_CATEGORY_DESCRIPTIONS=()
MANUAL_CATEGORY_SELECTION=""

# shellcheck source=/dev/null
source "${SCRIPT_DIR}/../node-runtime.bash"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

print_header() {
  printf "\n"
  printf "%b\n" "${BLUE}========================================${NC}"
  printf "%b\n" "${BLUE}git-snapshot Playwright UI Tests${NC}"
  printf "%b\n" "${BLUE}========================================${NC}"
}

print_info() {
  printf "%b\n" "${BLUE}$1${NC}"
}

print_success() {
  printf "%b\n" "${GREEN}$1${NC}"
}

print_warning() {
  printf "%b\n" "${YELLOW}$1${NC}"
}

print_error() {
  printf "%b\n" "${RED}$1${NC}" >&2
}

NODE_VERSION="$(git_snapshot_node_runtime_version print_error)"

is_truthy_value() {
  local raw="$1"
  case "$(printf "%s" "${raw}" | tr '[:upper:]' '[:lower:]')" in
    1|true|yes|on)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

use_pinned_node() {
  if [[ -z "${NVM_DIR:-}" ]]; then
    export NVM_DIR="${HOST_HOME}/.nvm"
  fi

  if ! git_snapshot_node_runtime_use print_error; then
    return 1
  fi
}

setup_node() {
  use_pinned_node
  printf "Node:   %s\n" "$(node -v 2>/dev/null || echo "not found")"
  printf "Browser: %s\n" "${PLAYWRIGHT_BROWSER_NAME}"
}

ensure_tooling() {
  mkdir -p "${RUN_TESTS_ARTIFACTS_DIR}"
  setup_node

  case "${PLAYWRIGHT_BROWSER_NAME}" in
    chromium|webkit|firefox)
      ;;
    *)
      print_error "Unsupported Playwright browser: ${PLAYWRIGHT_BROWSER_NAME}"
      return 1
      ;;
  esac

  if [[ ! -x "${SCRIPT_DIR}/node_modules/.bin/playwright" ]]; then
    (
      cd "${SCRIPT_DIR}"
      if [[ -f package-lock.json ]]; then
        HOME="${HOST_HOME}" npm ci
      else
        HOME="${HOST_HOME}" npm install
      fi
    )
  fi

  if ! find "${PLAYWRIGHT_BROWSERS_PATH}" -mindepth 1 -maxdepth 1 -type d -name "${PLAYWRIGHT_BROWSER_NAME}-*" | grep -q . 2>/dev/null; then
    (
      cd "${SCRIPT_DIR}"
      HOME="${HOST_HOME}" \
      PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH}" \
      ./node_modules/.bin/playwright install "${PLAYWRIGHT_BROWSER_NAME}"
    )
  fi
}

cache_get_value() {
  local key="$1"
  local line=""
  local current_key=""
  local current_value=""

  [[ -f "${RUN_TESTS_CACHE_FILE}" ]] || return 1

  while IFS= read -r line; do
    case "${line}" in
      ""|\#*)
        continue
        ;;
    esac

    [[ "${line}" == *=* ]] || continue
    current_key="${line%%=*}"
    current_value="${line#*=}"

    if [[ "${current_key}" == "${key}" ]]; then
      printf "%s" "${current_value}"
      return 0
    fi
  done < "${RUN_TESTS_CACHE_FILE}"

  return 1
}

cache_set_value() {
  local key="$1"
  local value="$2"
  local tmp_file="${RUN_TESTS_CACHE_FILE}.tmp.$$"
  local line=""
  local current_key=""
  local current_value=""

  {
    printf "# git-snapshot ui-tests cache (key=value)\n"
    printf "cache.version=%s\n" "${RUN_TESTS_CACHE_VERSION}"

    if [[ -f "${RUN_TESTS_CACHE_FILE}" ]]; then
      while IFS= read -r line; do
        case "${line}" in
          ""|\#*)
            continue
            ;;
        esac

        [[ "${line}" == *=* ]] || continue
        current_key="${line%%=*}"
        current_value="${line#*=}"

        if [[ "${current_key}" == "cache.version" || "${current_key}" == "${key}" ]]; then
          continue
        fi

        printf "%s=%s\n" "${current_key}" "${current_value}"
      done < "${RUN_TESTS_CACHE_FILE}"
    fi

    printf "%s=%s\n" "${key}" "${value}"
  } > "${tmp_file}"

  mv "${tmp_file}" "${RUN_TESTS_CACHE_FILE}"
}

get_category_description() {
  local category="$1"
  local line=""
  local key="category.${category}"

  [[ -f "${TESTS_DIR}/category-descriptions.conf" ]] || return 1

  while IFS= read -r line; do
    [[ -z "${line}" || "${line}" == \#* ]] && continue
    if [[ "${line%%=*}" == "${key}" ]]; then
      printf "%s" "${line#*=}"
      return 0
    fi
  done < "${TESTS_DIR}/category-descriptions.conf"

  return 1
}

prompt_manual_category_selection() {
  local default_index="$1"
  local categories=("${TEST_CATEGORIES[@]}")
  local descriptions=("${TEST_CATEGORY_DESCRIPTIONS[@]}")
  local total="${#categories[@]}"
  local selected=1
  local key=""
  local number_input=""
  local numeric_value=0
  local i=0
  local display_description=""

  if [[ "${total}" -eq 0 ]]; then
    return 1
  fi

  if [[ "${default_index}" =~ ^[0-9]+$ ]] && [[ "${default_index}" -ge 1 ]] && [[ "${default_index}" -le "${total}" ]]; then
    selected="${default_index}"
  fi

  MANUAL_CATEGORY_SELECTION=""

  printf "\nAvailable categories:\n"
  for ((i = 0; i < total; i++)); do
    display_description="${descriptions[$i]}"
    [[ -z "${display_description}" ]] && display_description="No description yet."
    printf "  %2d) %s\n" "$((i + 1))" "${categories[$i]}"
    printf "      - %s\n" "${display_description}"
  done
  printf "\nUse Up/Down arrows, type a number to preview, then Enter to confirm.\n"
  printf "Selection [%d]: %s" "${selected}" "${categories[$((selected - 1))]}"

  while true; do
    IFS= read -rsn1 key || return 1

    case "${key}" in
      "")
        if [[ -n "${number_input}" ]]; then
          numeric_value=$((10#${number_input}))
          if [[ "${numeric_value}" -ge 1 ]] && [[ "${numeric_value}" -le "${total}" ]]; then
            selected="${numeric_value}"
          else
            printf "\r\033[KInvalid selection. Enter a number between 1 and %d.\n" "${total}"
            printf "Selection [%d]: %s" "${selected}" "${categories[$((selected - 1))]}"
            number_input=""
            continue
          fi
        fi

        printf "\n"
        MANUAL_CATEGORY_SELECTION="${categories[$((selected - 1))]}"
        return 0
        ;;
      $'\x1b')
        IFS= read -rsn1 -t 1 key || continue
        [[ "${key}" == "[" ]] || continue
        IFS= read -rsn1 -t 1 key || continue
        case "${key}" in
          A)
            number_input=""
            if [[ "${selected}" -gt 1 ]]; then
              selected=$((selected - 1))
            else
              selected="${total}"
            fi
            ;;
          B)
            number_input=""
            if [[ "${selected}" -lt "${total}" ]]; then
              selected=$((selected + 1))
            else
              selected=1
            fi
            ;;
          *)
            continue
            ;;
        esac
        printf "\r\033[KSelection [%d]: %s" "${selected}" "${categories[$((selected - 1))]}"
        ;;
      [0-9])
        number_input="${number_input}${key}"
        numeric_value=$((10#${number_input}))
        if [[ "${numeric_value}" -ge 1 ]] && [[ "${numeric_value}" -le "${total}" ]]; then
          selected="${numeric_value}"
          printf "\r\033[KSelection [%d]: %s | number: %s" "${selected}" "${categories[$((selected - 1))]}" "${number_input}"
        else
          printf "\r\033[KSelection [%s]: unknown file | number: %s" "${number_input}" "${number_input}"
        fi
        ;;
      $'\x7f')
        if [[ -n "${number_input}" ]]; then
          number_input="${number_input%?}"
        fi
        if [[ -n "${number_input}" ]]; then
          numeric_value=$((10#${number_input}))
          if [[ "${numeric_value}" -ge 1 ]] && [[ "${numeric_value}" -le "${total}" ]]; then
            selected="${numeric_value}"
            printf "\r\033[KSelection [%d]: %s | number: %s" "${selected}" "${categories[$((selected - 1))]}" "${number_input}"
          else
            printf "\r\033[KSelection [%s]: unknown file | number: %s" "${number_input}" "${number_input}"
          fi
        else
          printf "\r\033[KSelection [%d]: %s" "${selected}" "${categories[$((selected - 1))]}"
        fi
        ;;
      q|Q)
        printf "\n"
        return 1
        ;;
      *)
        ;;
    esac
  done
}

collect_test_categories() {
  local category_dir=""
  local category=""
  local description=""

  TEST_CATEGORIES=()
  TEST_CATEGORY_DESCRIPTIONS=()

  for category_dir in "${TESTS_DIR}"/*/; do
    [[ -d "${category_dir}" ]] || continue
    category="$(basename "${category_dir}")"
    [[ "${category}" == "helpers" ]] && continue

    if find "${category_dir}" -maxdepth 1 -type f \
      \( -name '*.spec.cjs' -o -name '*.spec.js' -o -name '*.spec.ts' \) | grep -q .; then
      TEST_CATEGORIES+=("${category}")
      description="$(get_category_description "${category}" || true)"
      [[ -z "${description}" ]] && description="No description yet."
      TEST_CATEGORY_DESCRIPTIONS+=("${description}")
    fi
  done
}

print_available_categories() {
  local i=0

  collect_test_categories
  printf "\nAvailable categories:\n"
  for ((i = 0; i < ${#TEST_CATEGORIES[@]}; i++)); do
    printf "  %s - %s\n" "${TEST_CATEGORIES[$i]}" "${TEST_CATEGORY_DESCRIPTIONS[$i]}"
  done
}

find_test_file() {
  local category_dir="$1"
  local test_num="${2:-}"
  local match=""

  if [[ -n "${test_num}" ]]; then
    match="$(find "${category_dir}" -maxdepth 1 -type f \
      \( -name "${test_num}-*.spec.cjs" -o -name "${test_num}-*.spec.js" -o -name "${test_num}-*.spec.ts" \) \
      | sort | head -n 1)"
  else
    match="$(find "${category_dir}" -maxdepth 1 -type f \
      \( -name '*.spec.cjs' -o -name '*.spec.js' -o -name '*.spec.ts' \) \
      | sort | head -n 1)"
  fi

  [[ -n "${match}" ]] || return 1
  printf "%s\n" "${match}"
}

list_category_test_files() {
  local category_dir="$1"
  local test_file=""

  while IFS= read -r test_file; do
    printf "  %s\n" "$(basename "${test_file}")"
  done < <(find "${category_dir}" -maxdepth 1 -type f \
    \( -name '*.spec.cjs' -o -name '*.spec.js' -o -name '*.spec.ts' \) | sort)
}

for_each_category_test_file() {
  local category_dir="$1"
  find "${category_dir}" -maxdepth 1 -type f \
    \( -name '*.spec.cjs' -o -name '*.spec.js' -o -name '*.spec.ts' \) | sort
}

list_tests() {
  local category=""
  local category_dir=""
  local description=""
  local test_file=""
  local test_name=""
  local i=0

  collect_test_categories

  printf "\nAvailable test categories:\n\n"

  if [[ "${#TEST_CATEGORIES[@]}" -eq 0 ]]; then
    printf "  (none found)\n\n"
    return 0
  fi

  for ((i = 0; i < ${#TEST_CATEGORIES[@]}; i++)); do
    category="${TEST_CATEGORIES[$i]}"
    description="${TEST_CATEGORY_DESCRIPTIONS[$i]}"
    category_dir="${TESTS_DIR}/${category}"
    printf "%b\n" "${BLUE}${category}${NC}"
    printf "  - %s\n" "${description}"
    while IFS= read -r test_file; do
      test_name="$(basename "${test_file}")"
      test_name="${test_name%%.spec.*}"
      printf "  %s\n" "${test_name}"
    done < <(find "${category_dir}" -maxdepth 1 -type f \
      \( -name '*.spec.cjs' -o -name '*.spec.js' -o -name '*.spec.ts' \) | sort)
    printf "\n"
  done
}

show_help() {
  local cmd="$0"
  cat <<EOF
git-snapshot Playwright UI Test Runner

Usage:
  ${cmd} --list
  ${cmd} --all
  ${cmd} --manual
  ${cmd} --manual <category>
  ${cmd} --manual <category> <test-num>
  ${cmd} <category>
  ${cmd} <category> <test-num>
  ${cmd} <category> <test-num> "<pattern>"

Options:
  --all       Run every Playwright category
  --manual    Start manual UI mode with an interactive category picker if omitted
  --list      List available categories and tests
  --headed    Run with a visible browser
  --debug     Run in Playwright debug mode
  --ui        Run with the Playwright UI
  --help      Show this help

Examples:
  ${cmd} --list
  ${cmd} --manual
  ${cmd} --manual general-ui
  ${cmd} --manual general-ui 00
  ${cmd} general-ui
  ${cmd} general-ui 00
  ${cmd} general-ui 00 "scroll"
  ${cmd} --headed general-ui 00

Notes:
  - This runner mirrors the txtd-server category-based Playwright workflow.
  - The root symlink ./run-tests.sh points here for day-to-day use.
  - tests/git-snapshot/test-compare-gui-playwright.sh delegates here so run-all.sh still covers the browser suite.
  - Manual mode opens the compare GUI in your browser and keeps the fixture alive until Ctrl+C.
EOF
}

resolve_test_path() {
  local category_dir="$1"
  local test_num="$2"
  local match=""

  if [[ -z "${test_num}" ]]; then
    printf "%s\n" "${category_dir}"
    return 0
  fi

  match="$(find "${category_dir}" -maxdepth 1 -type f \
    \( -name "${test_num}-*.spec.cjs" -o -name "${test_num}-*.spec.js" -o -name "${test_num}-*.spec.ts" \) \
    | sort | head -n 1)"

  if [[ -z "${match}" ]]; then
    return 1
  fi

  printf "%s\n" "${match}"
}

load_runtime_env() {
  local runtime_dir="$1"
  local env_file="${runtime_dir}/playwright.env"

  [[ -f "${env_file}" ]] || return 0

  set -a
  # shellcheck source=/dev/null
  source "${env_file}"
  set +a
}

cleanup_runtime_dir() {
  local runtime_dir="$1"
  local status="$2"
  local cleanup_script="${runtime_dir}/cleanup.bash"

  [[ -d "${runtime_dir}" ]] || return 0

  if [[ -x "${cleanup_script}" ]]; then
    "${cleanup_script}" || true
  fi

  if [[ "${status}" -eq 0 ]]; then
    rm -rf "${runtime_dir}"
  else
    print_warning "Retained failure artifacts at: ${runtime_dir}"
  fi
}

cleanup_active_runtime() {
  local status="${1:-1}"
  if [[ -n "${ACTIVE_RUNTIME_DIR}" ]]; then
    cleanup_runtime_dir "${ACTIVE_RUNTIME_DIR}" "${status}"
    ACTIVE_RUNTIME_DIR=""
  fi
}

handle_signal() {
  if [[ "${ACTIVE_RUN_MODE}" == "manual" ]]; then
    cleanup_active_runtime 0
  else
    cleanup_active_runtime 1
  fi
  exit 130
}

run_category_tests() {
  local category="$1"
  local test_num="${2:-}"
  local test_pattern="${3:-}"
  local category_dir="${TESTS_DIR}/${category}"
  local runtime_dir=""
  local test_path=""
  local status=0
  local playwright_args=()

  if [[ ! -d "${category_dir}" ]]; then
    print_error "Category not found: ${category}"
    return 1
  fi

  if [[ -z "${test_num}" && -f "${category_dir}/prepare-env.bash" ]]; then
    local test_file=""
    local child_test_num=""
    local child_status=0

    while IFS= read -r test_file; do
      child_test_num="$(basename "${test_file}")"
      child_test_num="${child_test_num%%-*}"
      if ! run_category_tests "${category}" "${child_test_num}" "${test_pattern}"; then
        child_status=1
      fi
    done < <(for_each_category_test_file "${category_dir}")

    return "${child_status}"
  fi

  test_path="$(resolve_test_path "${category_dir}" "${test_num}")" || {
    print_error "Test file not found in ${category}: ${test_num}-*.spec.*"
    return 1
  }

  runtime_dir="${RUN_TESTS_ARTIFACTS_DIR}/${category}-$(date '+%Y%m%d-%H%M%S')-$$"
  mkdir -p "${runtime_dir}"
  ACTIVE_RUNTIME_DIR="${runtime_dir}"

  if [[ -f "${category_dir}/prepare-env.bash" ]]; then
    if ! bash "${category_dir}/prepare-env.bash" "${runtime_dir}" "${test_num}" automated; then
      print_error "Suite environment preparation failed for ${category}."
      cleanup_active_runtime 1
      return 1
    fi
  fi

  load_runtime_env "${runtime_dir}"

  playwright_args+=("--config=playwright.config.cjs" "${test_path}")
  [[ "${HEADED:-false}" == "true" ]] && playwright_args+=("--headed")
  [[ "${DEBUG:-false}" == "true" ]] && playwright_args+=("--debug")
  [[ "${PW_UI:-false}" == "true" ]] && playwright_args+=("--ui")
  [[ -n "${test_pattern}" ]] && playwright_args+=("--grep" "${test_pattern}")

  print_header
  print_info "Category: ${category}"
  if [[ -n "${test_num}" ]]; then
    print_info "Test: $(basename "${test_path}")"
  fi
  if [[ -n "${GIT_SNAPSHOT_COMPARE_GUI_URL:-}" ]]; then
    print_info "GUI URL: ${GIT_SNAPSHOT_COMPARE_GUI_URL}"
  fi

  set +e
  (
    cd "${SCRIPT_DIR}"
    use_pinned_node
    HOME="${HOST_HOME}" \
    GIT_SNAPSHOT_UI_TEST_BROWSER="${PLAYWRIGHT_BROWSER_NAME}" \
    PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH}" \
    ./node_modules/.bin/playwright test "${playwright_args[@]}"
  )
  status=$?
  set -e

  cleanup_active_runtime "${status}"
  return "${status}"
}

open_manual_url() {
  local url="$1"

  if is_truthy_value "${GIT_SNAPSHOT_UI_TESTS_SKIP_OPEN:-0}"; then
    print_info "Browser launch skipped by GIT_SNAPSHOT_UI_TESTS_SKIP_OPEN=1."
    return 0
  fi

  if command -v open >/dev/null 2>&1; then
    print_info "Opening browser..."
    open "${url}" >/dev/null 2>&1 || true
    return 0
  fi

  if command -v xdg-open >/dev/null 2>&1; then
    print_info "Opening browser..."
    xdg-open "${url}" >/dev/null 2>&1 || true
    return 0
  fi

  print_warning "No browser opener found. Open this URL manually: ${url}"
  return 0
}

run_manual_mode() {
  local category="${1:-}"
  local test_num="${2:-}"
  local category_dir=""
  local selected_test_file=""
  local selected_test_name=""
  local runtime_dir=""
  local cached_category=""
  local default_index=1
  local i=0
  local gui_pid=""

  print_header
  setup_node
  printf "%b\n" "${BLUE}========================================${NC}"

  collect_test_categories
  if [[ "${#TEST_CATEGORIES[@]}" -eq 0 ]]; then
    print_error "No Playwright categories found under ${TESTS_DIR}"
    return 1
  fi

  if [[ -z "${category}" ]]; then
    if [[ -t 0 && -t 1 ]]; then
      cached_category="$(cache_get_value "${RUN_TESTS_CACHE_KEY_MANUAL_LAST_CATEGORY}" || true)"
      if [[ -n "${cached_category}" ]]; then
        for ((i = 0; i < ${#TEST_CATEGORIES[@]}; i++)); do
          if [[ "${TEST_CATEGORIES[$i]}" == "${cached_category}" ]]; then
            default_index=$((i + 1))
            break
          fi
        done
      fi

      if ! prompt_manual_category_selection "${default_index}"; then
        print_error "No category selected"
        return 1
      fi
      category="${MANUAL_CATEGORY_SELECTION}"
      printf "\n"
      print_info "Selected category: ${category}"
    else
      print_error "Manual mode requires a category in non-interactive mode."
      print_available_categories
      return 1
    fi
  fi

  category_dir="${TESTS_DIR}/${category}"
  if [[ ! -d "${category_dir}" ]]; then
    print_error "Category not found: ${category}"
    print_available_categories
    return 1
  fi

  selected_test_file="$(find_test_file "${category_dir}" "${test_num}")" || {
    print_error "Test file not found in ${category}: ${test_num:-<first>}"
    printf "\nAvailable test files in this category:\n"
    list_category_test_files "${category_dir}"
    return 1
  }
  selected_test_name="$(basename "${selected_test_file}")"

  mkdir -p "${RUN_TESTS_ARTIFACTS_DIR}"
  runtime_dir="${RUN_TESTS_ARTIFACTS_DIR}/manual-${category}-$(date '+%Y%m%d-%H%M%S')-$$"
  mkdir -p "${runtime_dir}"
  ACTIVE_RUNTIME_DIR="${runtime_dir}"

  if [[ -f "${category_dir}/prepare-env.bash" ]]; then
    if ! bash "${category_dir}/prepare-env.bash" "${runtime_dir}" "${selected_test_name%%-*}" manual; then
      print_error "Suite environment preparation failed for ${category}."
      cleanup_active_runtime 1
      return 1
    fi
  fi

  load_runtime_env "${runtime_dir}"
  if [[ -z "${GIT_SNAPSHOT_COMPARE_GUI_URL:-}" ]]; then
    print_error "Manual mode did not receive a GUI URL from suite preparation."
    cleanup_active_runtime 1
    return 1
  fi

  cache_set_value "${RUN_TESTS_CACHE_KEY_MANUAL_LAST_CATEGORY}" "${category}" || true

  print_info "Manual Testing Mode"
  printf "\n"
  printf "Category: %s\n" "${category}"
  printf "Test file: %s\n" "${selected_test_name}"
  printf "Artifacts: %s\n" "${runtime_dir}"
  printf "\n"
  print_success "GUI server running at: ${GIT_SNAPSHOT_COMPARE_GUI_URL}"
  printf "\n"

  open_manual_url "${GIT_SNAPSHOT_COMPARE_GUI_URL}"

  printf "\nAvailable test files in this category:\n"
  list_category_test_files "${category_dir}"
  printf "\n"
  print_info "Use the selected test file as the verification guide for this manual session."
  print_info "Press Ctrl+C to stop the GUI server when done."
  printf "\n"

  ACTIVE_RUN_MODE="manual"
  gui_pid="${GIT_SNAPSHOT_UI_TEST_GUI_PID:-}"

  if [[ -n "${gui_pid}" ]]; then
    while kill -0 "${gui_pid}" >/dev/null 2>&1; do
      sleep 1
    done
    ACTIVE_RUN_MODE="automated"
    print_error "GUI server exited before manual session ended."
    cleanup_active_runtime 1
    return 1
  fi

  while true; do
    sleep 1
  done
}

run_all_tests() {
  local status=0
  local category=""

  collect_test_categories
  if [[ "${#TEST_CATEGORIES[@]}" -eq 0 ]]; then
    print_error "No Playwright categories found under ${TESTS_DIR}"
    return 1
  fi

  for category in "${TEST_CATEGORIES[@]}"; do
    if ! run_category_tests "${category}"; then
      status=1
    fi
  done

  return "${status}"
}

main() {
  local run_all=false
  local list_only=false
  local manual_mode=false
  local category=""
  local test_num=""
  local test_pattern=""

  HEADED=false
  DEBUG=false
  PW_UI=false

  while [[ "$#" -gt 0 ]]; do
    case "$1" in
      --all)
        run_all=true
        shift
        ;;
      --manual)
        manual_mode=true
        shift
        ;;
      --list)
        list_only=true
        shift
        ;;
      --headed)
        HEADED=true
        shift
        ;;
      --debug)
        DEBUG=true
        shift
        ;;
      --ui)
        PW_UI=true
        shift
        ;;
      --help|-h)
        show_help
        exit 0
        ;;
      --)
        shift
        break
        ;;
      -*)
        print_error "Unknown option: $1"
        show_help
        exit 1
        ;;
      *)
        break
        ;;
    esac
  done

  if [[ "${list_only}" == "true" ]]; then
    list_tests
    exit 0
  fi

  if [[ "${manual_mode}" == "true" && "${run_all}" == "true" ]]; then
    print_error "--manual cannot be combined with --all."
    exit 1
  fi

  if [[ "${run_all}" == "true" ]]; then
    ensure_tooling
    run_all_tests
    exit $?
  fi

  category="${1:-}"
  test_num="${2:-}"
  test_pattern="${3:-}"

  if [[ "${manual_mode}" == "true" && -n "${test_pattern}" ]]; then
    print_error "Manual mode accepts only <category> and optional <test-num>."
    exit 1
  fi

  if [[ -z "${category}" ]]; then
    if [[ "${manual_mode}" == "true" ]]; then
      run_manual_mode
      exit $?
    fi
    show_help
    exit 0
  fi

  if [[ "${manual_mode}" == "true" ]]; then
    run_manual_mode "${category}" "${test_num}"
    exit $?
  fi

  ensure_tooling
  run_category_tests "${category}" "${test_num}" "${test_pattern}"
}

trap 'cleanup_active_runtime $?' EXIT
trap 'handle_signal' INT TERM

main "$@"
