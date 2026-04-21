#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/../helpers/assertions.bash"
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/../helpers/fixtures.bash"

git_snapshot_test_setup_sandbox
root_repo="$(git_snapshot_test_make_nested_fixture)"

printf "changed\n" >> "${root_repo}/root.txt"
create_output="$(cd "${root_repo}" && git_snapshot_test_cmd create)"
snapshot_id="$(git_snapshot_test_get_snapshot_id_from_create_output "${create_output}")"
assert_non_empty "${snapshot_id}"

list_output="$(cd "${root_repo}" && git_snapshot_test_cmd list)"
assert_contains "${snapshot_id}" "${list_output}" "list should include snapshot id"
assert_contains "Snapshots (" "${list_output}" "list should include human header"
assert_contains "Repos" "${list_output}" "list should include repo count column"
assert_not_contains "Repos Root" "${list_output}" "single-root list should not include root column"
assert_contains "Note: snapshot registry is keyed by root repo folder name." "${list_output}" "list should include shared registry note"

inspect_output="$(cd "${root_repo}" && git_snapshot_test_cmd inspect "${snapshot_id}")"
assert_contains "Snapshot inspect: ${snapshot_id}" "${inspect_output}" "inspect should include human snapshot header"
assert_contains "Repos in scope: " "${inspect_output}" "inspect should include repo count summary"
assert_contains "Repo: super" "${inspect_output}" "inspect should display root repo by folder name"
assert_contains "Details (stat mode):" "${inspect_output}" "inspect default should render stat details"
assert_contains "Hint: use --name-only for file paths or --diff for full patch output." "${inspect_output}" "inspect should include hint for alternate render modes"

list_porcelain_output="$(cd "${root_repo}" && git_snapshot_test_cmd list --porcelain)"
assert_contains $'snapshot\tid='"${snapshot_id}" "${list_porcelain_output}" "list porcelain should include snapshot row"
assert_contains "origin=user" "${list_porcelain_output}" "list porcelain should include snapshot origin metadata"

inspect_porcelain_output="$(cd "${root_repo}" && git_snapshot_test_cmd inspect "${snapshot_id}" --porcelain)"
assert_contains $'inspect_target\tsnapshot_id='"${snapshot_id}" "${inspect_porcelain_output}" "inspect porcelain should include target summary row"
assert_contains "contract_version=2" "${inspect_porcelain_output}" "inspect porcelain should expose the v2 contract marker"
assert_contains $'inspect_repo\tsnapshot_id='"${snapshot_id}" "${inspect_porcelain_output}" "inspect porcelain should include repo summary rows"
assert_contains $'inspect\tsnapshot_id='"${snapshot_id}" "${inspect_porcelain_output}" "inspect porcelain should include snapshot id"
assert_contains $'inspect_file\tsnapshot_id='"${snapshot_id}" "${inspect_porcelain_output}" "inspect porcelain should include file rows"
assert_contains "apply_check_staged=" "${inspect_porcelain_output}" "inspect repo rows should include staged apply-check status"
assert_contains "untracked_collision_count=" "${inspect_porcelain_output}" "inspect repo rows should include untracked collision counts"

inspect_newline_repo="${TEST_REPOS_ROOT}/inspect-newline-path"
git_snapshot_test_init_repo "${inspect_newline_repo}"
git_snapshot_test_commit_file "${inspect_newline_repo}" "tracked.txt" "tracked-base" "init inspect newline repo"
inspect_newline_path=$'note\nline.txt'
printf "captured inspect newline payload\n" > "${inspect_newline_repo}/${inspect_newline_path}"
inspect_newline_create_output="$(cd "${inspect_newline_repo}" && git_snapshot_test_cmd create inspect-newline)"
inspect_newline_snapshot_id="$(git_snapshot_test_get_snapshot_id_from_create_output "${inspect_newline_create_output}")"
assert_eq "inspect-newline" "${inspect_newline_snapshot_id}" "inspect newline snapshot id should remain stable"

inspect_newline_porcelain="$(cd "${inspect_newline_repo}" && git_snapshot_test_cmd inspect "${inspect_newline_snapshot_id}" --untracked --porcelain)"
assert_contains $'inspect_file\tsnapshot_id=inspect-newline\trepo=.\tcategory=untracked\tfile=note\\nline.txt\tlines_added=1\tlines_removed=0' "${inspect_newline_porcelain}" "inspect porcelain should preserve newline filenames via escaped output"

inspect_row_stats_telemetry="$(cd "${inspect_newline_repo}" && GIT_SNAPSHOT_ROW_STATS_TELEMETRY=1 GIT_SNAPSHOT_ROW_STATS_SLOW_MS=0 git_snapshot_test_cmd inspect "${inspect_newline_snapshot_id}" --untracked --porcelain 2>&1 >/dev/null)"
assert_contains "ROW_STATS mode=inspect category=untracked" "${inspect_row_stats_telemetry}" "inspect row-stats telemetry should emit untracked timing when enabled"

inspect_tab_repo="${TEST_REPOS_ROOT}/inspect-tab-path"
git_snapshot_test_init_repo "${inspect_tab_repo}"
git_snapshot_test_commit_file "${inspect_tab_repo}" "tracked.txt" "tracked-base" "init inspect tab repo"
inspect_tab_path=$'note\tline.txt'
printf "captured inspect tab payload\n" > "${inspect_tab_repo}/${inspect_tab_path}"
inspect_tab_create_output="$(cd "${inspect_tab_repo}" && git_snapshot_test_cmd create inspect-tab)"
inspect_tab_snapshot_id="$(git_snapshot_test_get_snapshot_id_from_create_output "${inspect_tab_create_output}")"
assert_eq "inspect-tab" "${inspect_tab_snapshot_id}" "inspect tab snapshot id should remain stable"

inspect_tab_porcelain="$(cd "${inspect_tab_repo}" && git_snapshot_test_cmd inspect "${inspect_tab_snapshot_id}" --untracked --porcelain)"
assert_contains $'inspect_file\tsnapshot_id=inspect-tab\trepo=.\tcategory=untracked\tfile=note\\tline.txt\tlines_added=1\tlines_removed=0' "${inspect_tab_porcelain}" "inspect porcelain should preserve tab filenames via escaped output"
