#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/../helpers/assertions.bash"
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/../helpers/fixtures.bash"

git_snapshot_test_setup_sandbox

# 1) Regression: dash-prefixed untracked files must not break compare materialization.
repo="${TEST_REPOS_ROOT}/path-shapes"
git_snapshot_test_init_repo "${repo}"
git_snapshot_test_commit_file "${repo}" "tracked.txt" "tracked-base" "init tracked"

base_create_output="$(cd "${repo}" && git_snapshot_test_cmd create path-shapes-base)"
base_snapshot_id="$(git_snapshot_test_get_snapshot_id_from_create_output "${base_create_output}")"
assert_eq "path-shapes-base" "${base_snapshot_id}" "path-shapes snapshot id should be preserved"

printf "dash-noise\n" > "${repo}/--dash-untracked.txt"

dash_compare_output="$(cd "${repo}" && git_snapshot_test_cmd compare "${base_snapshot_id}" --repo .)"
assert_contains "Compare: no unresolved snapshot work." "${dash_compare_output}" "dash-prefixed untracked paths should not break compare"
assert_contains "No rows to display for current visibility filter." "${dash_compare_output}" "clean snapshot scope should keep default unresolved view empty"

dash_porcelain_output="$(cd "${repo}" && git_snapshot_test_cmd compare "${base_snapshot_id}" --repo . --porcelain)"
assert_contains $'compare_summary\tsnapshot_id='"${base_snapshot_id}"$'\trepos_checked=1\tfiles_total=0\tresolved_committed=0\tresolved_uncommitted=0\tunresolved_missing=0\tunresolved_diverged=0\tunresolved_total=0\tshown_files=0\tcontract_version=3' "${dash_porcelain_output}" "dash path regression should still emit normal compare summary"
assert_not_contains "compare_error" "${dash_porcelain_output}" "dash path regression should not emit compare_error rows"
rm -f "${repo}/--dash-untracked.txt"

# 2) Focused path-shape coverage: spaces + quotes in untracked filenames.
printf "space-noise\n" > "${repo}/space name.txt"
printf "quote-noise\n" > "${repo}/quote'and\"double\".txt"

shape_compare_output="$(cd "${repo}" && git_snapshot_test_cmd compare "${base_snapshot_id}" --repo .)"
assert_contains "Compare: no unresolved snapshot work." "${shape_compare_output}" "space/quote path shapes should not break compare"
assert_contains "No rows to display for current visibility filter." "${shape_compare_output}" "space/quote path shapes should keep unresolved view empty"
rm -f "${repo}/space name.txt" "${repo}/quote'and\"double\".txt"

# 3) Symlink path-shape coverage: spaces/quotes in symlink path should classify correctly.
symlink_repo="${TEST_REPOS_ROOT}/symlink-path-shapes"
git_snapshot_test_init_repo "${symlink_repo}"
target_one="target one.txt"
target_two="target'\"two\".txt"
symlink_path="link path '\"mix\".lnk"

printf "target-one\n" > "${symlink_repo}/${target_one}"
printf "target-two\n" > "${symlink_repo}/${target_two}"
ln -s "${target_one}" "${symlink_repo}/${symlink_path}"
git -C "${symlink_repo}" add "${target_one}" "${target_two}" "${symlink_path}"
git -C "${symlink_repo}" commit -m "seed symlink path-shape fixture" >/dev/null

rm -f "${symlink_repo}/${symlink_path}"
ln -s "${target_two}" "${symlink_repo}/${symlink_path}"
git -C "${symlink_repo}" add "${symlink_path}"

symlink_create_output="$(cd "${symlink_repo}" && git_snapshot_test_cmd create symlink-path-shapes)"
symlink_snapshot_id="$(git_snapshot_test_get_snapshot_id_from_create_output "${symlink_create_output}")"
assert_eq "symlink-path-shapes" "${symlink_snapshot_id}" "symlink path-shapes snapshot id should be preserved"

symlink_uncommitted_output="$(cd "${symlink_repo}" && git_snapshot_test_cmd compare "${symlink_snapshot_id}" --repo . --all)"
assert_contains "${symlink_path} [resolved_uncommitted]" "${symlink_uncommitted_output}" "symlink path-shape update should classify as resolved_uncommitted before commit"

git -C "${symlink_repo}" commit -m "commit symlink path-shape update" >/dev/null
symlink_committed_output="$(cd "${symlink_repo}" && git_snapshot_test_cmd compare "${symlink_snapshot_id}" --repo . --all)"
assert_contains "${symlink_path} [resolved_committed]" "${symlink_committed_output}" "symlink path-shape update should classify as resolved_committed after commit"

rm -f "${symlink_repo}/${symlink_path}"
ln -s "${target_one}" "${symlink_repo}/${symlink_path}"
symlink_diverged_output="$(cd "${symlink_repo}" && git_snapshot_test_cmd compare "${symlink_snapshot_id}" --repo .)"
assert_contains "${symlink_path} [unresolved_diverged]" "${symlink_diverged_output}" "symlink path-shape divergence should classify as unresolved_diverged"

# 4) Structured compare porcelain errors: emit stable compare_error identifier rows.
error_repo="${TEST_REPOS_ROOT}/porcelain-errors"
git_snapshot_test_init_repo "${error_repo}"
git_snapshot_test_commit_file "${error_repo}" "tracked.txt" "tracked-base" "init tracked"

printf "staged-change\n" >> "${error_repo}/tracked.txt"
git -C "${error_repo}" add tracked.txt

error_create_output="$(cd "${error_repo}" && git_snapshot_test_cmd create compare-error-row)"
error_snapshot_id="$(git_snapshot_test_get_snapshot_id_from_create_output "${error_create_output}")"
assert_eq "compare-error-row" "${error_snapshot_id}" "error snapshot id should be preserved"

snapshot_root="$(git_snapshot_test_snapshot_root_for_repo "${error_repo}")"
printf "this-is-not-a-valid-patch\n" > "${snapshot_root}/${error_snapshot_id}/repos/repo-0001/staged.patch"

set +e
error_porcelain_output="$(cd "${error_repo}" && git_snapshot_test_cmd compare "${error_snapshot_id}" --repo . --porcelain 2>&1)"
error_porcelain_code=$?
set -e

assert_exit_code 1 "${error_porcelain_code}" "compare should fail when snapshot staged bundle is corrupted"
assert_contains $'compare_target\tselected_snapshot_id='"${error_snapshot_id}"$'\tselection_mode=explicit\tsnapshot_origin=user\tsnapshot_root=' "${error_porcelain_output}" "porcelain compare should emit compare_target before failure"
assert_contains $'compare_error\tsnapshot_id='"${error_snapshot_id}"$'\trepo=.\terror_id=compare_snapshot_staged_apply_failed\tstage=snapshot_staged_apply\tmessage=Failed to materialize staged snapshot bundle for compare.\tcontract_version=1' "${error_porcelain_output}" "porcelain compare should emit structured compare_error row with stable error identifier"
assert_not_contains $'compare_summary\tsnapshot_id='"${error_snapshot_id}" "${error_porcelain_output}" "failed compare should not emit compare summary"
