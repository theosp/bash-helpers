#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/../helpers/assertions.bash"
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/../helpers/fixtures.bash"

git_snapshot_test_setup_sandbox
repo="${TEST_REPOS_ROOT}/compare-locale-stability"

git_snapshot_test_init_repo "${repo}"
printf "aligned-base\n" > "${repo}/aligned.txt"
printf "diverged-base\n" > "${repo}/diverged.txt"
printf '#!/usr/bin/env bash\nprintf "ok\\n"\n' > "${repo}/mode-script.sh"
chmod 644 "${repo}/mode-script.sh"
git -C "${repo}" add aligned.txt diverged.txt mode-script.sh
git -C "${repo}" commit -m "seed locale compare fixture" >/dev/null

printf "aligned-snapshot\n" >> "${repo}/aligned.txt"
git -C "${repo}" add aligned.txt
printf "diverged-snapshot\n" >> "${repo}/diverged.txt"
git -C "${repo}" add diverged.txt
chmod +x "${repo}/mode-script.sh"
git -C "${repo}" add mode-script.sh

create_output="$(cd "${repo}" && git_snapshot_test_cmd create compare-locale-stability)"
snapshot_id="$(git_snapshot_test_get_snapshot_id_from_create_output "${create_output}")"
assert_eq "compare-locale-stability" "${snapshot_id}" "locale compare snapshot id should be preserved"

printf "diverged-current\n" >> "${repo}/diverged.txt"
current_tab_path=$'current\tpath.txt'
printf "current-only\n" > "${repo}/${current_tab_path}"

baseline_porcelain="$(cd "${repo}" && GIT_SNAPSHOT_COMPARE_CACHE=0 git_snapshot_test_cmd compare "${snapshot_id}" --repo . --porcelain)"
hostile_porcelain="$(cd "${repo}" && GIT_SNAPSHOT_COMPARE_CACHE=0 git_snapshot_test_cmd_hostile_locale compare "${snapshot_id}" --repo . --porcelain)"

assert_eq \
  "$(git_snapshot_test_normalize_compare_porcelain "${baseline_porcelain}")" \
  "$(git_snapshot_test_normalize_compare_porcelain "${hostile_porcelain}")" \
  "mixed-locale compare should keep effect-only porcelain identical"
assert_contains $'compare_repo\tsnapshot_id='"${snapshot_id}"$'\trepo=.\tfiles_total=4\tshown_files=2\teffect_files=2\thidden_no_effect_files=2' "${baseline_porcelain}" "effect-only compare should expose repo-level shown/effect counts"
assert_contains $'compare_summary\tsnapshot_id='"${snapshot_id}"$'\trepos_checked=1\tfiles_total=4\tresolved_committed=0\tresolved_uncommitted=2\tunresolved_missing=0\tunresolved_diverged=2\tunresolved_total=2\tshown_files=2\tscope_both=3\tscope_snapshot_only=0\tscope_current_only=1\tengine=v3\telapsed_ms=' "${baseline_porcelain}" "effect-only compare should keep scope totals explicit"
assert_contains $'\teffect_files=2\tno_effect_files=2\thidden_no_effect_files=2\tinclude_no_effect=false\tcompare_base=snapshot\tcontract_version=8\tshown_lines_added=2\tshown_lines_removed=0\tscope_lines_added=2\tscope_lines_removed=0' "${baseline_porcelain}" "effect-only compare should keep effect/no-effect totals stable"
assert_contains $'compare_file\tsnapshot_id='"${snapshot_id}"$'\trepo=.\tfile=diverged.txt\tstatus=unresolved_diverged\treason=current content or mode diverges from snapshot target\tpath_scope=both\trestore_effect=changes\tlines_added=1\tlines_removed=0\tdisplay_kind=text_change\tdisplay_label=' "${baseline_porcelain}" "both-scope diverged row should remain effectful"
assert_contains $'compare_file\tsnapshot_id='"${snapshot_id}"$'\trepo=.\tfile=current\\tpath.txt\tstatus=unresolved_diverged\treason=current-only dirty path exists while restore baseline removes it\tpath_scope=current_only\trestore_effect=changes\tlines_added=1\tlines_removed=0\tdisplay_kind=text_change\tdisplay_label=' "${baseline_porcelain}" "current-only tab path should remain effectful and escaped"
assert_not_contains $'\tfile=aligned.txt\t' "${baseline_porcelain}" "no-effect aligned row should stay hidden by default"
assert_not_contains $'\tfile=mode-script.sh\t' "${baseline_porcelain}" "mode-only no-effect row should stay hidden by default"

baseline_all_porcelain="$(cd "${repo}" && GIT_SNAPSHOT_COMPARE_CACHE=0 git_snapshot_test_cmd compare "${snapshot_id}" --repo . --include-no-effect --porcelain)"
hostile_all_porcelain="$(cd "${repo}" && GIT_SNAPSHOT_COMPARE_CACHE=0 git_snapshot_test_cmd_hostile_locale compare "${snapshot_id}" --repo . --include-no-effect --porcelain)"

assert_eq \
  "$(git_snapshot_test_normalize_compare_porcelain "${baseline_all_porcelain}")" \
  "$(git_snapshot_test_normalize_compare_porcelain "${hostile_all_porcelain}")" \
  "mixed-locale compare should keep include-no-effect porcelain identical"
assert_contains $'compare_repo\tsnapshot_id='"${snapshot_id}"$'\trepo=.\tfiles_total=4\tshown_files=4\teffect_files=2\thidden_no_effect_files=0' "${baseline_all_porcelain}" "include-no-effect compare should expose repo-level shown/effect counts"
assert_contains $'compare_summary\tsnapshot_id='"${snapshot_id}"$'\trepos_checked=1\tfiles_total=4\tresolved_committed=0\tresolved_uncommitted=2\tunresolved_missing=0\tunresolved_diverged=2\tunresolved_total=2\tshown_files=4\tscope_both=3\tscope_snapshot_only=0\tscope_current_only=1\tengine=v3\telapsed_ms=' "${baseline_all_porcelain}" "include-no-effect compare should still report full scope totals"
assert_contains $'\teffect_files=2\tno_effect_files=2\thidden_no_effect_files=0\tinclude_no_effect=true\tcompare_base=snapshot\tcontract_version=8\tshown_lines_added=2\tshown_lines_removed=0\tscope_lines_added=2\tscope_lines_removed=0' "${baseline_all_porcelain}" "include-no-effect compare should keep effect/no-effect totals stable"
assert_contains $'compare_file\tsnapshot_id='"${snapshot_id}"$'\trepo=.\tfile=aligned.txt\tstatus=resolved_uncommitted\treason=snapshot target content and mode match working tree but not HEAD\tpath_scope=both\trestore_effect=none\tlines_added=0\tlines_removed=0\tdisplay_kind=no_effect\tdisplay_label=no restore effect' "${baseline_all_porcelain}" "aligned both-scope row should remain no-effect under hostile locale"
assert_contains $'compare_file\tsnapshot_id='"${snapshot_id}"$'\trepo=.\tfile=mode-script.sh\tstatus=resolved_uncommitted\treason=snapshot target content and mode match working tree but not HEAD\tpath_scope=both\trestore_effect=none\tlines_added=0\tlines_removed=0\tdisplay_kind=no_effect\tdisplay_label=no restore effect' "${baseline_all_porcelain}" "mode-only no-effect row should stay resolved_uncommitted with zero text stats"
assert_contains $'compare_file\tsnapshot_id='"${snapshot_id}"$'\trepo=.\tfile=current\\tpath.txt\tstatus=unresolved_diverged\treason=current-only dirty path exists while restore baseline removes it\tpath_scope=current_only\trestore_effect=changes\tlines_added=1\tlines_removed=0\tdisplay_kind=text_change\tdisplay_label=' "${baseline_all_porcelain}" "current-only tab path should remain escaped when no-effect rows are included"

shown_effect_rows="$(git_snapshot_test_extract_porcelain_field "${baseline_porcelain}" compare_summary shown_files)"
shown_all_rows="$(git_snapshot_test_extract_porcelain_field "${baseline_all_porcelain}" compare_summary shown_files)"

gui_hostile_output="$(cd "${repo}" && GIT_SNAPSHOT_GUI_TEST_MODE=1 GIT_SNAPSHOT_COMPARE_CACHE=0 git_snapshot_test_cmd_hostile_locale compare "${snapshot_id}" --repo . --gui)"
assert_contains "GUI_TEST mode=compare snapshot_id=${snapshot_id}" "${gui_hostile_output}" "gui test mode should expose the selected snapshot id under hostile locale"
assert_contains "rows=${shown_effect_rows}" "${gui_hostile_output}" "gui test mode should keep effect-only row count aligned with CLI under hostile locale"
assert_contains "include_no_effect=false" "${gui_hostile_output}" "gui hostile-locale compare should keep effect-only visibility"
assert_contains "payload_include_no_effect=false" "${gui_hostile_output}" "gui payload should disclose requested no-effect visibility rather than the internal compare fetch"

gui_hostile_all_output="$(cd "${repo}" && GIT_SNAPSHOT_GUI_TEST_MODE=1 GIT_SNAPSHOT_COMPARE_CACHE=0 git_snapshot_test_cmd_hostile_locale compare "${snapshot_id}" --repo . --include-no-effect --gui)"
assert_contains "rows=${shown_all_rows}" "${gui_hostile_all_output}" "gui include-no-effect row count should stay aligned with CLI under hostile locale"
assert_contains "include_no_effect=true" "${gui_hostile_all_output}" "gui hostile-locale compare should preserve explicit no-effect visibility"
assert_contains "payload_include_no_effect=true" "${gui_hostile_all_output}" "gui payload should disclose explicit no-effect visibility when requested"
