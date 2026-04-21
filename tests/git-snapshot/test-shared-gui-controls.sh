#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
BASH_HELPERS_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd -P)"
RUNNER="${BASH_HELPERS_ROOT}/lib/git-snapshot/ui-tests/run-tests.sh"
SPEC_FILE="${BASH_HELPERS_ROOT}/lib/git-snapshot/ui-tests/tests/general-ui/04-shared-gui-controls.spec.cjs"
GROUP_PORT_START_BASE="${GIT_SNAPSHOT_UI_TEST_GROUP_PORT_START:-34957}"
GROUP_PORT_COUNT="${GIT_SNAPSHOT_GUI_PORT_COUNT:-32}"
FIXTURE_RECOVERY_FAIL_THRESHOLD="${GIT_SNAPSHOT_UI_TEST_FIXTURE_RECOVERY_FAIL_THRESHOLD:-}"
WEBKIT_SMOKE_LABEL="shared-controls-webkit-diff-selection-smoke"
WEBKIT_SMOKE_PATTERN="shared browser helpers bootstrap into the embedded page script|diff selection context menu opens from the keyboard shortcut on selected text|diff selection real mouse drag across structured diff lines preserves newlines|diff selection works against real inspect and review previews"

if [[ "$#" -gt 0 ]]; then
  exec "${RUNNER}" general-ui 04 "$@"
fi

GROUP_LABELS=(
  "diff-selection-bootstrap-and-copy"
  "diff-selection-ask-history"
  "diff-selection-multiline-and-cross-mode"
  "shared-controls-core"
  "shared-controls-aggregate-and-refresh"
  "shared-controls-viewed-state"
)
GROUP_PATTERNS=(
  "shared browser helpers bootstrap into the embedded page script|diff selection context menu appears inside plain preview bodies|diff selection context menu opens from the keyboard shortcut on selected text|diff selection context menu appears inside aggregate preview body content|diff selection context menu tolerates incidental gutter co-selection but stays disabled for headers and content outside #diff"
  "diff selection Ask freezes the selected text|Ask history selection stays synchronized when clipboard copy fails|Ask history stays scoped to the current physical root repo"
  "diff selection Copy and Ask preserve newlines across multiple structured diff lines|diff selection real mouse drag across structured diff lines preserves newlines|diff selection large structured captures stay under a practical latency budget|diff selection works against real inspect and review previews|shared controls long-run smoke keeps the GUI server alive across repeated cross-mode interactions|mode switch preserves snapshot and repo context across browse, compare, inspect, and review"
  "review repo picker filters|review presets save|review refresh reloads current branch metadata|rapid review base changes|review base controls make fallback|repo filter picker stays reusable|legacy repeated review_repo URL params|status strip shows the physical root repo path|refresh split button adapts|snapshot picker sorts newest first|refresh keeps snapshot inventory stale|refresh reloads current-view data without using force=1|refresh helper rejects failed gui-data reloads|inspect primary refresh reloads snapshot inventory|compare no-effect toggle auto-refreshes row visibility|filters panel shows active state"
  "browse state is encoded in the URL|browse repo and category headers are selectable|malformed browse file URLs|browse repo aggregate preview keeps partially staged|browse live refresh updates category summary pills|browse selection preserves a surviving file|inspect repo and category headers are selectable|compare rows render simplified labels|compare repo aggregate preview paginates|aggregate append failures keep existing preview blocks|aggregate previews remain usable at narrow viewport widths|stale aggregate preview responses do not override a newer aggregate selection|compare state is encoded in the URL|compare base falls back to localStorage|URL compare_base overrides localStorage fallback|delayed compare responses do not override a newer inspect selection|browse create dialog can clear the working tree after capture|review repo aggregate preview uses the effective custom base"
  "browse file rows can be marked viewed|viewed counts stay aligned|viewed state ignores entries stored|browse changed-since-viewed rows expose|changed viewed rows fall back|browse category and repo rows can bulk mark|browse bulk mark uses current live file signatures|compare repo rows expose bulk viewed actions|file-row context menu opens from keyboard"
)

validate_group_patterns() {
  local title=""
  local pattern=""
  local group_match_count=0
  local match_count=0
  local i=0
  local title_count=0
  local had_error=0
  local mandatory_bootstrap_title="shared browser helpers bootstrap into the embedded page script"
  local mandatory_bootstrap_seen=0
  local titles=()

  if [[ "${#GROUP_LABELS[@]}" -ne "${#GROUP_PATTERNS[@]}" ]]; then
    printf "shared-gui-controls shard configuration drifted: %d labels vs %d patterns.\n" "${#GROUP_LABELS[@]}" "${#GROUP_PATTERNS[@]}" >&2
    return 1
  fi
  if [[ ! -f "${SPEC_FILE}" ]]; then
    printf "shared-gui-controls spec file is missing: %s\n" "${SPEC_FILE}" >&2
    return 1
  fi

  mapfile -t titles < <(
    node - "${SPEC_FILE}" <<'NODE'
const fs = require("fs");

const specPath = process.argv[2];
const content = fs.readFileSync(specPath, "utf8");
const titlePattern = /\btest(?:\.only)?\(\s*(["'`])((?:\\.|(?!\1)[\s\S])*?)\1/g;
let match = titlePattern.exec(content);
while (match) {
  process.stdout.write(match[2] + "\n");
  match = titlePattern.exec(content);
}
NODE
  )

  title_count="${#titles[@]}"
  if [[ "${title_count}" -eq 0 ]]; then
    printf "shared-gui-controls shard validation found no test titles in %s\n" "${SPEC_FILE}" >&2
    return 1
  fi

  for ((i = 0; i < ${#GROUP_PATTERNS[@]}; i++)); do
    pattern="${GROUP_PATTERNS[$i]}"
    group_match_count=0
    for title in "${titles[@]}"; do
      if printf '%s\n' "${title}" | grep -Eq "${pattern}"; then
        group_match_count=$((group_match_count + 1))
      fi
    done
    if [[ "${group_match_count}" -eq 0 ]]; then
      printf "shared-gui-controls shard [%s] does not match any tests.\n" "${GROUP_LABELS[$i]}" >&2
      had_error=1
    fi
  done

  for title in "${titles[@]}"; do
    match_count=0
    for pattern in "${GROUP_PATTERNS[@]}"; do
      if printf '%s\n' "${title}" | grep -Eq "${pattern}"; then
        match_count=$((match_count + 1))
      fi
    done
    if [[ "${title}" == "${mandatory_bootstrap_title}" ]]; then
      mandatory_bootstrap_seen=1
    fi
    if [[ "${match_count}" -eq 0 ]]; then
      printf "shared-gui-controls shard validation missed test title: %s\n" "${title}" >&2
      had_error=1
    elif [[ "${match_count}" -gt 1 ]]; then
      printf "shared-gui-controls shard validation matched test title more than once: %s\n" "${title}" >&2
      had_error=1
    fi
  done

  if [[ "${mandatory_bootstrap_seen}" -ne 1 ]]; then
    printf "shared-gui-controls shard validation could not find mandatory bootstrap smoke title.\n" >&2
    had_error=1
  fi

  return "${had_error}"
}

group_port_start_for_index() {
  local index="${1:-0}"
  printf '%s' "$((GROUP_PORT_START_BASE + (index * GROUP_PORT_COUNT)))"
}

create_group_log_file() {
  local label="$1"
  local sanitized_label=""
  local tmp_root="${TMPDIR:-/tmp}"
  local log_file=""

  sanitized_label="$(printf '%s' "${label}" | tr -c 'A-Za-z0-9._-' '-')"
  if ! log_file="$(mktemp "${tmp_root%/}/git-snapshot-shared-gui-controls.${sanitized_label}.XXXXXX")"; then
    printf 'shared-gui-controls could not create a log file for group [%s]\n' "${label}" >&2
    return 1
  fi

  printf '%s' "${log_file}"
}

parse_fixture_recovery_summary_from_log() {
  local log_file="$1"
  node - "${log_file}" <<'NODE'
const fs = require("fs");

const logPath = process.argv[2];
const content = fs.readFileSync(logPath, "utf8");
const summaryMatches = Array.from(content.matchAll(/^\[fixture-recovery-summary\] (.+)$/gm));
if (summaryMatches.length > 0) {
  process.stdout.write(summaryMatches[summaryMatches.length - 1][1]);
  process.exit(0);
}
const eventMatches = Array.from(content.matchAll(/^\[fixture-recovery\] (.+)$/gm));
if (eventMatches.length === 0) {
  process.exit(0);
}
const byType = {};
for (const match of eventMatches) {
  try {
    const event = JSON.parse(match[1]);
    const type = String(event && event.type ? event.type : "event");
    byType[type] = Number(byType[type] || 0) + 1;
  } catch (_error) {
    byType.event = Number(byType.event || 0) + 1;
  }
}
const total = Object.values(byType).reduce((sum, value) => sum + Number(value || 0), 0);
process.stdout.write(JSON.stringify({
  total,
  byType,
}));
NODE
}

read_fixture_recovery_total() {
  local summary_json="$1"
  if [[ -z "${summary_json}" ]]; then
    printf '0'
    return 0
  fi
  node -e 'const summary = JSON.parse(process.argv[1] || "{}"); process.stdout.write(String(Number(summary.total || 0)));' "${summary_json}"
}

run_group_and_capture_recovery() {
  local label="$1"
  local pattern="$2"
  local port_index="$3"
  local browser_name="${4:-}"
  local log_file=""
  local summary_json=""
  local recovery_total=0
  local group_status=0

  if ! log_file="$(create_group_log_file "${label}")"; then
    return 1
  fi
  if [[ -n "${browser_name}" ]]; then
    if ! GIT_SNAPSHOT_GUI_PORT_START="$(group_port_start_for_index "${port_index}")" \
      GIT_SNAPSHOT_GUI_PORT_COUNT="${GROUP_PORT_COUNT}" \
      GIT_SNAPSHOT_UI_TEST_BROWSER="${browser_name}" \
      "${RUNNER}" general-ui 04 "${pattern}" 2>&1 | tee "${log_file}"; then
      group_status=1
    fi
  else
    if ! GIT_SNAPSHOT_GUI_PORT_START="$(group_port_start_for_index "${port_index}")" \
      GIT_SNAPSHOT_GUI_PORT_COUNT="${GROUP_PORT_COUNT}" \
      "${RUNNER}" general-ui 04 "${pattern}" 2>&1 | tee "${log_file}"; then
      group_status=1
    fi
  fi

  summary_json="$(parse_fixture_recovery_summary_from_log "${log_file}")"
  recovery_total="$(read_fixture_recovery_total "${summary_json}")"
  if [[ "${recovery_total}" -gt 0 ]]; then
    printf 'shared-gui-controls group [%s] used fixture recovery paths: %s\n' "${label}" "${summary_json}" >&2
    OVERALL_FIXTURE_RECOVERY_TOTAL=$((OVERALL_FIXTURE_RECOVERY_TOTAL + recovery_total))
  fi
  rm -f "${log_file}"
  return "${group_status}"
}

status=0
OVERALL_FIXTURE_RECOVERY_TOTAL=0
if ! validate_group_patterns; then
  exit 1
fi

for i in "${!GROUP_PATTERNS[@]}"; do
  printf '\n== shared-gui-controls group: %s ==\n' "${GROUP_LABELS[$i]}"
  if ! run_group_and_capture_recovery "${GROUP_LABELS[$i]}" "${GROUP_PATTERNS[$i]}" "${i}"; then
    status=1
  fi
done

printf '\n== shared-gui-controls group: %s ==\n' "${WEBKIT_SMOKE_LABEL}"
if ! run_group_and_capture_recovery "${WEBKIT_SMOKE_LABEL}" "${WEBKIT_SMOKE_PATTERN}" "${#GROUP_PATTERNS[@]}" "webkit"; then
  status=1
fi

if [[ "${OVERALL_FIXTURE_RECOVERY_TOTAL}" -gt 0 ]]; then
  printf 'shared-gui-controls completed with %s fixture recovery event(s) across grouped runs.\n' "${OVERALL_FIXTURE_RECOVERY_TOTAL}" >&2
  printf 'Set GIT_SNAPSHOT_UI_TEST_STRICT_FIXTURE_RECOVERY=1 to fail inside each shard, or GIT_SNAPSHOT_UI_TEST_FIXTURE_RECOVERY_FAIL_THRESHOLD=<n> to fail the wrapper when the total exceeds a threshold.\n' >&2
fi

if [[ -n "${FIXTURE_RECOVERY_FAIL_THRESHOLD}" ]]; then
  if [[ ! "${FIXTURE_RECOVERY_FAIL_THRESHOLD}" =~ ^[0-9]+$ ]]; then
    printf 'GIT_SNAPSHOT_UI_TEST_FIXTURE_RECOVERY_FAIL_THRESHOLD must be a non-negative integer, got: %s\n' "${FIXTURE_RECOVERY_FAIL_THRESHOLD}" >&2
    status=1
  elif [[ "${OVERALL_FIXTURE_RECOVERY_TOTAL}" -gt "${FIXTURE_RECOVERY_FAIL_THRESHOLD}" ]]; then
    printf 'shared-gui-controls fixture recovery total %s exceeded threshold %s.\n' "${OVERALL_FIXTURE_RECOVERY_TOTAL}" "${FIXTURE_RECOVERY_FAIL_THRESHOLD}" >&2
    status=1
  fi
fi

exit "${status}"
