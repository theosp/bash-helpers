#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/../helpers/assertions.bash"
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/../helpers/fixtures.bash"

git_snapshot_test_setup_sandbox
root_repo="$(git_snapshot_test_make_nested_fixture)"

create_output="$(cd "${root_repo}" && git_snapshot_test_cmd create verify-baseline)"
snapshot_id="$(git_snapshot_test_get_snapshot_id_from_create_output "${create_output}")"
assert_eq "verify-baseline" "${snapshot_id}" "create should preserve explicit verify id"

verify_clean_output="$(cd "${root_repo}" && git_snapshot_test_cmd verify "${snapshot_id}")"
assert_contains "Snapshot verify: ${snapshot_id}" "${verify_clean_output}" "verify should include heading"
assert_contains "VERIFY IS A WRAPPER OVER COMPARE" "${verify_clean_output}" "verify output should document wrapper semantics"
assert_contains "Repos checked: 3 | repos with file differences: 0 | repos with head differences: 0" "${verify_clean_output}" "clean verify should report zero differences"
assert_contains "Verification: match within snapshot scope." "${verify_clean_output}" "clean snapshot should verify"
assert_not_contains "Warnings:" "${verify_clean_output}" "verify should not print warnings section"
assert_not_contains "Follow-up commands for deeper details:" "${verify_clean_output}" "verify should not print mismatch follow-up guidance"
assert_not_contains "Hint: run" "${verify_clean_output}" "verify should not print strict-head hints"

verify_default_target_output="$(cd "${root_repo}" && git_snapshot_test_cmd verify)"
assert_contains "Snapshot verify: ${snapshot_id}" "${verify_default_target_output}" "verify without id should use latest user-created snapshot"
assert_contains "Selected snapshot mode: latest-user-default" "${verify_default_target_output}" "verify without id should disclose default target selection"

# Move only HEAD: working-set stays clean, verify should still pass and report head differences.
printf "head-shift\n" >> "${root_repo}/root.txt"
git -C "${root_repo}" add root.txt
git -C "${root_repo}" commit -m "head shift for verify tests" >/dev/null

set +e
verify_head_output="$(cd "${root_repo}" && git_snapshot_test_cmd verify "${snapshot_id}" 2>&1)"
verify_head_code=$?
set -e
assert_exit_code 0 "${verify_head_code}" "verify should not fail on head-only differences"
assert_contains "Head differences:" "${verify_head_output}" "verify should print dedicated head differences section"
assert_contains "super: snapshot=" "${verify_head_output}" "verify should print root repo head details"
assert_contains "relation=current-ahead" "${verify_head_output}" "verify should include relation for head drift"
assert_contains "Verification: match within snapshot scope." "${verify_head_output}" "verify should still match when file state is unchanged"

set +e
verify_strict_compat_output="$(cd "${root_repo}" && git_snapshot_test_cmd verify "${snapshot_id}" --strict-head 2>&1)"
verify_strict_compat_code=$?
set -e
assert_exit_code 0 "${verify_strict_compat_code}" "verify --strict-head should be accepted in compatibility mode"
assert_contains "Option --strict-head is deprecated and currently a compatibility no-op." "${verify_strict_compat_output}" "verify strict-head should emit compatibility warning"
assert_contains "Head differences:" "${verify_strict_compat_output}" "verify strict-head should still print head differences section"
assert_contains "Verification: match within snapshot scope." "${verify_strict_compat_output}" "verify strict-head should keep informational head policy"

# Capture new clean baseline on current HEAD for staged/unstaged/untracked mismatch checks.
second_create_output="$(cd "${root_repo}" && git_snapshot_test_cmd create verify-working-set)"
second_snapshot_id="$(git_snapshot_test_get_snapshot_id_from_create_output "${second_create_output}")"
assert_eq "verify-working-set" "${second_snapshot_id}" "second snapshot should preserve explicit id"

printf "staged-delta\n" >> "${root_repo}/root.txt"
git -C "${root_repo}" add root.txt
set +e
verify_staged_output="$(cd "${root_repo}" && git_snapshot_test_cmd verify "${second_snapshot_id}" --repo . 2>&1)"
verify_staged_code=$?
set -e
assert_exit_code 3 "${verify_staged_code}" "verify should fail when staged patch differs"
assert_contains "Differences:" "${verify_staged_output}" "verify should report differences section"
assert_contains "Repo: super" "${verify_staged_output}" "verify staged mismatch should include repo section"
assert_contains "File: root.txt" "${verify_staged_output}" "verify staged mismatch should include file"
assert_contains "[staged] snapshot_state=false current_state=true" "${verify_staged_output}" "verify should include state-aware staged transition detail"
assert_contains "state transition: true" "${verify_staged_output}" "verify staged mismatch against clean snapshot should be a transition"
assert_contains "diff kind: state-transition-only" "${verify_staged_output}" "verify staged mismatch should classify as state-transition-only"
assert_not_contains "Follow-up commands for deeper details:" "${verify_staged_output}" "verify should not print follow-up guidance"
set +e
verify_staged_porcelain_output="$(cd "${root_repo}" && git_snapshot_test_cmd verify "${second_snapshot_id}" --repo . --porcelain 2>&1)"
verify_staged_porcelain_code=$?
set -e
assert_exit_code 3 "${verify_staged_porcelain_code}" "verify porcelain should fail on staged mismatch"
assert_contains $'verify_file\tsnapshot_id='"${second_snapshot_id}"$'\trepo=.\tfile=root.txt\tsnapshot_states=none\tcurrent_states=staged\tstate_transition=true\thas_diff=true\tdiff_kind=state-transition-only' "${verify_staged_porcelain_output}" "verify porcelain should classify staged transition mismatches"
git -C "${root_repo}" reset --hard >/dev/null

printf "unstaged-delta\n" >> "${root_repo}/root.txt"
set +e
verify_unstaged_output="$(cd "${root_repo}" && git_snapshot_test_cmd verify "${second_snapshot_id}" --repo . 2>&1)"
verify_unstaged_code=$?
set -e
assert_exit_code 3 "${verify_unstaged_code}" "verify should fail when unstaged patch differs"
assert_contains "[unstaged] snapshot_state=false current_state=true" "${verify_unstaged_output}" "verify should include unstaged state-aware transition detail"
git -C "${root_repo}" reset --hard >/dev/null

printf "untracked-delta\n" > "${root_repo}/verify-untracked.txt"
set +e
verify_untracked_output="$(cd "${root_repo}" && git_snapshot_test_cmd verify "${second_snapshot_id}" --repo . 2>&1)"
verify_untracked_code=$?
set -e
assert_exit_code 3 "${verify_untracked_code}" "verify should fail when untracked set/content differs"
assert_contains "[untracked] snapshot_state=false current_state=true" "${verify_untracked_output}" "verify should include untracked state transition detail"
assert_contains "state transition: true" "${verify_untracked_output}" "verify should mark untracked transition"
git -C "${root_repo}" clean -fd >/dev/null

verify_porcelain_output="$(cd "${root_repo}" && git_snapshot_test_cmd verify "${second_snapshot_id}" --repo . --porcelain)"
assert_contains $'verify\tsnapshot_id='"${second_snapshot_id}"$'\trepo=.\thead_state=same\thead_relation=same\thead_ahead=0\thead_behind=0\tfile_diff=false\tchanged_files=0' "${verify_porcelain_output}" "porcelain verify should include per-repo row"
assert_contains $'verify_summary\tsnapshot_id='"${second_snapshot_id}"$'\trepos_checked=1\tdiff_repos=0\thead_diff_repos=0\tdiff_files_total=0' "${verify_porcelain_output}" "porcelain verify should include summary row"
assert_contains $'verify_summary\tsnapshot_id='"${second_snapshot_id}"$'\trepos_checked=1\tdiff_repos=0\thead_diff_repos=0\tdiff_files_total=0\tcontract_version=2' "${verify_porcelain_output}" "verify summary row should expose contract version"
assert_not_contains $'strict_head=' "${verify_porcelain_output}" "porcelain verify should not include strict-head fields"

# Staged rename parity should verify cleanly.
git_snapshot_test_commit_file "${root_repo}" "rename-source.txt" "rename-base" "add rename source"
git -C "${root_repo}" mv rename-source.txt rename-target.txt
rename_create_output="$(cd "${root_repo}" && git_snapshot_test_cmd create verify-rename-parity)"
rename_snapshot_id="$(git_snapshot_test_get_snapshot_id_from_create_output "${rename_create_output}")"
assert_eq "verify-rename-parity" "${rename_snapshot_id}" "rename parity snapshot id should be preserved"

set +e
verify_rename_output="$(cd "${root_repo}" && git_snapshot_test_cmd verify "${rename_snapshot_id}" --repo . 2>&1)"
verify_rename_code=$?
set -e
assert_exit_code 0 "${verify_rename_code}" "verify should pass for unchanged staged rename parity"
assert_contains "Verification: match within snapshot scope." "${verify_rename_output}" "rename parity verify should report match"
assert_not_contains "Differences:" "${verify_rename_output}" "rename parity verify should not emit differences section"

verify_rename_porcelain_output="$(cd "${root_repo}" && git_snapshot_test_cmd verify "${rename_snapshot_id}" --repo . --porcelain)"
assert_contains $'verify_file\tsnapshot_id='"${rename_snapshot_id}"$'\trepo=.\tfile=rename-target.txt\tsnapshot_states=staged\tcurrent_states=staged\tstate_transition=false\thas_diff=false\tdiff_kind=none' "${verify_rename_porcelain_output}" "rename parity porcelain should classify unchanged file as no diff"
