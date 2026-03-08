#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/../helpers/assertions.bash"
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/../helpers/fixtures.bash"

git_snapshot_test_setup_sandbox
root_repo="$(git_snapshot_test_make_nested_fixture)"
sub1="${root_repo}/modules/sub1"
sub2="${sub1}/modules/sub2"

# Build mixed snapshot-target work across the full nested fixture.
printf "root-staged\n" >> "${root_repo}/root.txt"
git -C "${root_repo}" add root.txt
printf "root-unstaged\n" >> "${root_repo}/root.txt"
mkdir -p "${root_repo}/.cursor/skills/roundtrip"
printf "root-hidden-untracked\n" > "${root_repo}/.cursor/skills/roundtrip/SKILL.md"

printf "sub1-staged\n" >> "${sub1}/sub1.txt"
git -C "${sub1}" add sub1.txt
printf "sub1-unstaged\n" >> "${sub1}/sub1.txt"
printf "sub1-untracked\n" > "${sub1}/sub1-extra.txt"

printf "sub2-staged\n" >> "${sub2}/sub2.txt"
git -C "${sub2}" add sub2.txt
printf "sub2-unstaged\n" >> "${sub2}/sub2.txt"
printf "sub2-untracked\n" > "${sub2}/sub2-extra.txt"

create_output="$(cd "${root_repo}" && git_snapshot_test_cmd create v4-roundtrip)"
snapshot_id="$(git_snapshot_test_get_snapshot_id_from_create_output "${create_output}")"
assert_eq "v4-roundtrip" "${snapshot_id}" "roundtrip snapshot id should be preserved"

snapshot_root="$(git_snapshot_test_snapshot_root_for_repo "${root_repo}")"
snapshot_path="${snapshot_root}/${snapshot_id}"
assert_file_exists "${snapshot_path}/meta.env" "roundtrip snapshot metadata should exist"

meta_output="$(cat "${snapshot_path}/meta.env")"
assert_contains "FORMAT=git_snapshot_meta_v4" "${meta_output}" "roundtrip snapshot should use v4 metadata"
assert_contains "REPO_COUNT=3" "${meta_output}" "roundtrip snapshot should record all nested repos"

compare_target_meta_count="$(find "${snapshot_path}" -name 'compare-target.meta.env' | wc -l | tr -d ' ')"
compare_target_sig_count="$(find "${snapshot_path}" -name 'compare-target.signatures.tsv' | wc -l | tr -d ' ')"
compare_target_paths_count="$(find "${snapshot_path}" -name 'compare-target.paths.b64' | wc -l | tr -d ' ')"
assert_eq "3" "${compare_target_meta_count}" "every repo bundle should include compare target meta"
assert_eq "3" "${compare_target_sig_count}" "every repo bundle should include compare target signatures"
assert_eq "3" "${compare_target_paths_count}" "every repo bundle should include compare target paths"

compare_before_output="$(cd "${root_repo}" && git_snapshot_test_cmd compare "${snapshot_id}" --all --porcelain)"
assert_eq "v3" "$(git_snapshot_test_extract_porcelain_field "${compare_before_output}" "compare_summary" "engine")" "fresh roundtrip compare should use v3 engine"
assert_eq "0" "$(git_snapshot_test_extract_porcelain_field "${compare_before_output}" "compare_summary" "unresolved_total")" "fresh roundtrip compare should start fully resolved"
normalized_compare_before="$(git_snapshot_test_normalize_compare_porcelain "${compare_before_output}")"

# Disrupt back to recorded HEADs and remove captured untracked files.
git -C "${sub2}" reset --hard >/dev/null
git -C "${sub2}" clean -fd >/dev/null
git -C "${sub1}" reset --hard >/dev/null
git -C "${sub1}" clean -fd >/dev/null
git -C "${root_repo}" reset --hard >/dev/null
git -C "${root_repo}" clean -fd >/dev/null

compare_disrupted_output="$(cd "${root_repo}" && git_snapshot_test_cmd compare "${snapshot_id}" --all --porcelain)"
assert_ne "0" "$(git_snapshot_test_extract_porcelain_field "${compare_disrupted_output}" "compare_summary" "unresolved_total")" "disrupted roundtrip compare should expose unresolved work"

set +e
restore_check_output="$(cd "${root_repo}" && git_snapshot_test_cmd restore-check "${snapshot_id}" --all-repos --porcelain 2>&1)"
restore_check_code=$?
set -e
assert_exit_code 0 "${restore_check_code}" "roundtrip restore-check should stay clean after reset/clean disruption"
assert_not_contains "has_issues=true" "${restore_check_output}" "roundtrip restore-check should report no blocking issues"

export GIT_SNAPSHOT_CONFIRM_RESTORE="RESTORE"
restore_output="$(cd "${root_repo}" && git_snapshot_test_cmd restore "${snapshot_id}" --porcelain)"
assert_contains $'restore_summary\tsnapshot_id='"${snapshot_id}"$'\tmode=reject\tresult=success' "${restore_output}" "roundtrip restore should succeed in default reject mode"
assert_contains "exit_code=0" "${restore_output}" "roundtrip restore should return success exit code"

compare_after_output="$(cd "${root_repo}" && git_snapshot_test_cmd compare "${snapshot_id}" --all --porcelain)"
assert_eq "0" "$(git_snapshot_test_extract_porcelain_field "${compare_after_output}" "compare_summary" "unresolved_total")" "roundtrip compare should return to zero unresolved items after restore"
assert_eq "${normalized_compare_before}" "$(git_snapshot_test_normalize_compare_porcelain "${compare_after_output}")" "roundtrip compare should match the pre-disruption baseline after restore"
