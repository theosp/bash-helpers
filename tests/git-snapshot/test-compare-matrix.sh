#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/../helpers/assertions.bash"
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/../helpers/fixtures.bash"

git_snapshot_test_setup_sandbox
repo="${TEST_REPOS_ROOT}/matrix"

git_snapshot_test_init_repo "${repo}"
git_snapshot_test_commit_file "${repo}" "tracked.txt" "tracked-base" "init tracked"

# 1) staged-only mismatch
base_create_output="$(cd "${repo}" && git_snapshot_test_cmd create matrix-base)"
base_snapshot_id="$(git_snapshot_test_get_snapshot_id_from_create_output "${base_create_output}")"
assert_eq "matrix-base" "${base_snapshot_id}" "base snapshot id should be preserved"

printf "staged-change\n" >> "${repo}/tracked.txt"
git -C "${repo}" add tracked.txt

staged_compare_output="$(cd "${repo}" && git_snapshot_test_cmd compare "${base_snapshot_id}" --repo .)"
assert_contains "File: tracked.txt" "${staged_compare_output}" "staged mismatch should include tracked file"
assert_contains "state transition: true" "${staged_compare_output}" "staged-only mismatch against clean snapshot should be transition"
assert_contains "diff kind: state-transition-only" "${staged_compare_output}" "staged-only mismatch should classify diff kind"
assert_contains "[staged] snapshot_state=false current_state=true" "${staged_compare_output}" "staged mismatch should compare staged transition payloads"

set +e
staged_assert_output="$(cd "${repo}" && git_snapshot_test_cmd compare "${base_snapshot_id}" --repo . --assert-equal 2>&1)"
staged_assert_code=$?
set -e
assert_exit_code 3 "${staged_assert_code}" "assert-equal should fail on staged mismatch"
assert_contains "Differences:" "${staged_assert_output}" "assert-equal staged mismatch should keep diff details"

git -C "${repo}" reset --hard >/dev/null

# 2) unstaged-only mismatch
printf "unstaged-change\n" >> "${repo}/tracked.txt"
unstaged_compare_output="$(cd "${repo}" && git_snapshot_test_cmd compare "${base_snapshot_id}" --repo .)"
assert_contains "[unstaged] snapshot_state=false current_state=true" "${unstaged_compare_output}" "unstaged mismatch should compare unstaged transition payloads"
git -C "${repo}" reset --hard >/dev/null

# 3) untracked content mismatch
printf "untracked-change\n" > "${repo}/new-untracked.txt"
untracked_compare_output="$(cd "${repo}" && git_snapshot_test_cmd compare "${base_snapshot_id}" --repo .)"
assert_contains "File: new-untracked.txt" "${untracked_compare_output}" "untracked mismatch should include untracked file"
assert_contains "[untracked] snapshot_state=false current_state=true" "${untracked_compare_output}" "untracked mismatch should show state transition"
assert_contains "state transition: true" "${untracked_compare_output}" "untracked mismatch should mark transition"
git -C "${repo}" clean -fd >/dev/null

# 4) snapshot untracked -> current staged+unstaged transition
printf "transition-base\n" > "${repo}/transition.txt"
transition_create_output="$(cd "${repo}" && git_snapshot_test_cmd create matrix-transition)"
transition_snapshot_id="$(git_snapshot_test_get_snapshot_id_from_create_output "${transition_create_output}")"
assert_eq "matrix-transition" "${transition_snapshot_id}" "transition snapshot id should be preserved"

git -C "${repo}" add transition.txt
printf "transition-unstaged\n" >> "${repo}/transition.txt"

transition_compare_output="$(cd "${repo}" && git_snapshot_test_cmd compare "${transition_snapshot_id}" --repo .)"
assert_contains "File: transition.txt" "${transition_compare_output}" "transition compare should include target file"
assert_contains "states: snapshot=[untracked] current=[staged+unstaged]" "${transition_compare_output}" "transition compare should disclose mixed-state transition"
assert_contains "[untracked] snapshot_state=true current_state=false" "${transition_compare_output}" "transition compare should compare dropped untracked state"
assert_contains "[staged] snapshot_state=false current_state=true" "${transition_compare_output}" "transition compare should compare new staged state"
assert_contains "[unstaged] snapshot_state=false current_state=true" "${transition_compare_output}" "transition compare should compare new unstaged state"

git -C "${repo}" reset --hard >/dev/null
git -C "${repo}" clean -fd >/dev/null

# 5) same file has staged+unstaged on snapshot and current sides
printf "combo-base\n" > "${repo}/combo.txt"
git -C "${repo}" add combo.txt
git -C "${repo}" commit -m "add combo" >/dev/null
printf "snapshot-staged\n" >> "${repo}/combo.txt"
git -C "${repo}" add combo.txt
printf "snapshot-unstaged\n" >> "${repo}/combo.txt"
combo_create_output="$(cd "${repo}" && git_snapshot_test_cmd create matrix-combo)"
combo_snapshot_id="$(git_snapshot_test_get_snapshot_id_from_create_output "${combo_create_output}")"
assert_eq "matrix-combo" "${combo_snapshot_id}" "combo snapshot id should be preserved"

git -C "${repo}" reset --hard >/dev/null
printf "current-staged\n" >> "${repo}/combo.txt"
git -C "${repo}" add combo.txt
printf "current-unstaged\n" >> "${repo}/combo.txt"

combo_compare_output="$(cd "${repo}" && git_snapshot_test_cmd compare "${combo_snapshot_id}" --repo .)"
assert_contains "File: combo.txt" "${combo_compare_output}" "combo compare should include combo file"
assert_contains "states: snapshot=[staged+unstaged] current=[staged+unstaged]" "${combo_compare_output}" "combo compare should keep states unified per file"
assert_contains "diff kind: content-only" "${combo_compare_output}" "combo compare should classify same-state payload changes as content-only"
assert_contains "[staged] snapshot_state=true current_state=true" "${combo_compare_output}" "combo compare should include staged sub-diff"
assert_contains "[unstaged] snapshot_state=true current_state=true" "${combo_compare_output}" "combo compare should include unstaged sub-diff"
combo_porcelain_output="$(cd "${repo}" && git_snapshot_test_cmd compare "${combo_snapshot_id}" --repo . --porcelain)"
assert_contains $'compare_file\tsnapshot_id='"${combo_snapshot_id}"$'\trepo=.\tfile=combo.txt\tsnapshot_states=staged+unstaged\tcurrent_states=staged+unstaged\tstate_transition=false\thas_diff=true\tdiff_kind=content-only' "${combo_porcelain_output}" "combo porcelain row should classify content-only diffs"

git -C "${repo}" reset --hard >/dev/null
git -C "${repo}" clean -fd >/dev/null

# 6) repo missing path handling
nested_root="$(git_snapshot_test_make_nested_fixture)"
missing_create_output="$(cd "${nested_root}" && git_snapshot_test_cmd create matrix-missing)"
missing_snapshot_id="$(git_snapshot_test_get_snapshot_id_from_create_output "${missing_create_output}")"
assert_eq "matrix-missing" "${missing_snapshot_id}" "missing snapshot id should be preserved"
rm -rf "${nested_root}/modules/sub1"

missing_compare_output="$(cd "${nested_root}" && git_snapshot_test_cmd compare "${missing_snapshot_id}" --repo modules/sub1)"
assert_contains "Head differences:" "${missing_compare_output}" "missing repo should be listed in head differences"
assert_contains "repo missing at path=modules/sub1" "${missing_compare_output}" "missing repo head detail should be explicit"
assert_contains "File: __repo_missing__" "${missing_compare_output}" "missing repo should emit pseudo file in differences"
assert_contains "diff kind: state-transition-only" "${missing_compare_output}" "missing repo pseudo-file should classify as state-transition-only"

# 7) compare_file porcelain rows
printf "porcelain-staged\n" >> "${repo}/tracked.txt"
git -C "${repo}" add tracked.txt
porcelain_matrix_output="$(cd "${repo}" && git_snapshot_test_cmd compare "${base_snapshot_id}" --repo . --porcelain)"
assert_contains $'compare_file\tsnapshot_id='"${base_snapshot_id}"$'\trepo=.\tfile=tracked.txt\tsnapshot_states=none\tcurrent_states=staged\tstate_transition=true\thas_diff=true\tdiff_kind=state-transition-only' "${porcelain_matrix_output}" "porcelain compare should emit compare_file row for changed file"
assert_contains $'compare_summary\tsnapshot_id='"${base_snapshot_id}"$'\trepos_checked=1\tdiff_repos=1\thead_diff_repos=1\tdiff_files_total=1' "${porcelain_matrix_output}" "porcelain compare summary should expose diff and head-diff counts"
assert_contains $'compare_summary\tsnapshot_id='"${base_snapshot_id}"$'\trepos_checked=1\tdiff_repos=1\thead_diff_repos=1\tdiff_files_total=1\tcontract_version=2' "${porcelain_matrix_output}" "porcelain compare summary should expose contract version"

git -C "${repo}" reset --hard >/dev/null
git -C "${repo}" clean -fd >/dev/null

# 8) staged rename parity should compare equal
printf "rename-base\n" > "${repo}/rename-from.txt"
git -C "${repo}" add rename-from.txt
git -C "${repo}" commit -m "add rename source" >/dev/null
git -C "${repo}" mv rename-from.txt rename-to.txt

rename_create_output="$(cd "${repo}" && git_snapshot_test_cmd create matrix-rename)"
rename_snapshot_id="$(git_snapshot_test_get_snapshot_id_from_create_output "${rename_create_output}")"
assert_eq "matrix-rename" "${rename_snapshot_id}" "rename snapshot id should be preserved"

set +e
rename_assert_output="$(cd "${repo}" && git_snapshot_test_cmd compare "${rename_snapshot_id}" --repo . --assert-equal 2>&1)"
rename_assert_code=$?
set -e
assert_exit_code 0 "${rename_assert_code}" "staged rename parity should compare as equal"
assert_contains "Compare: no differences within snapshot scope." "${rename_assert_output}" "rename parity should report no differences"
assert_not_contains "Differences:" "${rename_assert_output}" "rename parity should not emit differences section"

git -C "${repo}" reset --hard >/dev/null
git -C "${repo}" clean -fd >/dev/null

# 9) mode-only staged parity should compare equal and classify no diff in porcelain
printf "#!/usr/bin/env bash\nprintf \"mode-base\\n\"\n" > "${repo}/mode-script.sh"
git -C "${repo}" add mode-script.sh
git -C "${repo}" commit -m "add mode script" >/dev/null
chmod +x "${repo}/mode-script.sh"
git -C "${repo}" add mode-script.sh

mode_create_output="$(cd "${repo}" && git_snapshot_test_cmd create matrix-mode-only)"
mode_snapshot_id="$(git_snapshot_test_get_snapshot_id_from_create_output "${mode_create_output}")"
assert_eq "matrix-mode-only" "${mode_snapshot_id}" "mode-only snapshot id should be preserved"

set +e
mode_assert_output="$(cd "${repo}" && git_snapshot_test_cmd compare "${mode_snapshot_id}" --repo . --assert-equal 2>&1)"
mode_assert_code=$?
set -e
assert_exit_code 0 "${mode_assert_code}" "mode-only parity should compare as equal"
assert_contains "Compare: no differences within snapshot scope." "${mode_assert_output}" "mode-only parity should report no differences"
assert_not_contains "Differences:" "${mode_assert_output}" "mode-only parity should not emit differences section"

mode_porcelain_output="$(cd "${repo}" && git_snapshot_test_cmd compare "${mode_snapshot_id}" --repo . --porcelain)"
assert_contains $'compare_file\tsnapshot_id='"${mode_snapshot_id}"$'\trepo=.\tfile=mode-script.sh\tsnapshot_states=staged\tcurrent_states=staged\tstate_transition=false\thas_diff=false\tdiff_kind=none' "${mode_porcelain_output}" "mode-only parity should emit no-diff file classification"
