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
assert_contains $'compare_summary\tsnapshot_id='"${base_snapshot_id}"$'\trepos_checked=1\tfiles_total=0\tresolved_committed=0\tresolved_uncommitted=0\tunresolved_missing=0\tunresolved_diverged=0\tunresolved_total=0\tshown_files=0\tengine=v3\telapsed_ms=' "${dash_porcelain_output}" "dash path regression should still emit normal compare summary"
assert_contains $'\tcontract_version=5' "${dash_porcelain_output}" "dash path regression should expose v5 compare contract"
assert_not_contains "compare_error" "${dash_porcelain_output}" "dash path regression should not emit compare_error rows"
rm -f "${repo}/--dash-untracked.txt"

# 2) Focused path-shape coverage: spaces + quotes in untracked filenames.
printf "space-noise\n" > "${repo}/space name.txt"
printf "quote-noise\n" > "${repo}/quote'and\"double\".txt"

shape_compare_output="$(cd "${repo}" && git_snapshot_test_cmd compare "${base_snapshot_id}" --repo .)"
assert_contains "Compare: no unresolved snapshot work." "${shape_compare_output}" "space/quote path shapes should not break compare"
assert_contains "No rows to display for current visibility filter." "${shape_compare_output}" "space/quote path shapes should keep unresolved view empty"
rm -f "${repo}/space name.txt" "${repo}/quote'and\"double\".txt"

# 3) Tracked tab/newline paths should survive compare classification and porcelain escaping.
tracked_control_repo="${TEST_REPOS_ROOT}/tracked-control-path-shapes"
git_snapshot_test_init_repo "${tracked_control_repo}"
tracked_tab_path=$'tracked\tname.txt'
tracked_newline_path=$'tracked\nline.txt'

printf "tracked-base\n" > "${tracked_control_repo}/${tracked_tab_path}"
printf "tracked-base\n" > "${tracked_control_repo}/${tracked_newline_path}"
git -C "${tracked_control_repo}" add "${tracked_tab_path}" "${tracked_newline_path}"
git -C "${tracked_control_repo}" commit -m "seed tracked control-path fixture" >/dev/null

printf "tracked-snapshot\n" > "${tracked_control_repo}/${tracked_tab_path}"
printf "tracked-snapshot\n" > "${tracked_control_repo}/${tracked_newline_path}"
git -C "${tracked_control_repo}" add "${tracked_tab_path}" "${tracked_newline_path}"

tracked_control_create_output="$(cd "${tracked_control_repo}" && git_snapshot_test_cmd create tracked-control-path-shapes)"
tracked_control_snapshot_id="$(git_snapshot_test_get_snapshot_id_from_create_output "${tracked_control_create_output}")"
assert_eq "tracked-control-path-shapes" "${tracked_control_snapshot_id}" "tracked control-path snapshot id should be preserved"

tracked_control_output="$(cd "${tracked_control_repo}" && git_snapshot_test_cmd compare "${tracked_control_snapshot_id}" --repo . --all)"
assert_contains 'tracked\tname.txt [resolved_uncommitted]' "${tracked_control_output}" "tracked tab path should render escaped and resolved before commit"
assert_contains 'tracked\nline.txt [resolved_uncommitted]' "${tracked_control_output}" "tracked newline path should render escaped and resolved before commit"

tracked_control_porcelain="$(cd "${tracked_control_repo}" && git_snapshot_test_cmd compare "${tracked_control_snapshot_id}" --repo . --all --porcelain)"
assert_contains $'compare_file\tsnapshot_id='"${tracked_control_snapshot_id}"$'\trepo=.\tfile=tracked\\tname.txt\tstatus=resolved_uncommitted\treason=snapshot target content and mode match working tree but not HEAD' "${tracked_control_porcelain}" "tracked tab path should stay intact in porcelain"
assert_contains $'compare_file\tsnapshot_id='"${tracked_control_snapshot_id}"$'\trepo=.\tfile=tracked\\nline.txt\tstatus=resolved_uncommitted\treason=snapshot target content and mode match working tree but not HEAD' "${tracked_control_porcelain}" "tracked newline path should stay intact in porcelain"

git -C "${tracked_control_repo}" commit -m "commit tracked control-path update" >/dev/null
tracked_control_committed="$(cd "${tracked_control_repo}" && git_snapshot_test_cmd compare "${tracked_control_snapshot_id}" --repo . --all --porcelain)"
assert_contains $'compare_file\tsnapshot_id='"${tracked_control_snapshot_id}"$'\trepo=.\tfile=tracked\\tname.txt\tstatus=resolved_committed\treason=snapshot target content and mode match HEAD and working tree' "${tracked_control_committed}" "tracked tab path should classify as resolved_committed after commit"
assert_contains $'compare_file\tsnapshot_id='"${tracked_control_snapshot_id}"$'\trepo=.\tfile=tracked\\nline.txt\tstatus=resolved_committed\treason=snapshot target content and mode match HEAD and working tree' "${tracked_control_committed}" "tracked newline path should classify as resolved_committed after commit"

# 4) Untracked tab/newline paths should survive snapshot manifests, compare output, and divergence checks.
untracked_control_repo="${TEST_REPOS_ROOT}/untracked-control-path-shapes"
git_snapshot_test_init_repo "${untracked_control_repo}"
git_snapshot_test_commit_file "${untracked_control_repo}" "tracked.txt" "tracked-base" "init untracked control repo"
untracked_tab_path=$'note\tname.txt'
untracked_newline_path=$'note\nline.txt'

printf "untracked-snapshot\n" > "${untracked_control_repo}/${untracked_tab_path}"
printf "untracked-snapshot\n" > "${untracked_control_repo}/${untracked_newline_path}"

untracked_control_create_output="$(cd "${untracked_control_repo}" && git_snapshot_test_cmd create untracked-control-path-shapes)"
untracked_control_snapshot_id="$(git_snapshot_test_get_snapshot_id_from_create_output "${untracked_control_create_output}")"
assert_eq "untracked-control-path-shapes" "${untracked_control_snapshot_id}" "untracked control-path snapshot id should be preserved"

untracked_control_output="$(cd "${untracked_control_repo}" && git_snapshot_test_cmd compare "${untracked_control_snapshot_id}" --repo . --all)"
assert_contains 'note\tname.txt [resolved_uncommitted]' "${untracked_control_output}" "untracked tab path should render escaped and resolved"
assert_contains 'note\nline.txt [resolved_uncommitted]' "${untracked_control_output}" "untracked newline path should render escaped and resolved"

untracked_control_porcelain="$(cd "${untracked_control_repo}" && git_snapshot_test_cmd compare "${untracked_control_snapshot_id}" --repo . --all --porcelain)"
assert_contains $'compare_file\tsnapshot_id='"${untracked_control_snapshot_id}"$'\trepo=.\tfile=note\\tname.txt\tstatus=resolved_uncommitted\treason=snapshot target content and mode match working tree but not HEAD' "${untracked_control_porcelain}" "untracked tab path should stay intact in porcelain"
assert_contains $'compare_file\tsnapshot_id='"${untracked_control_snapshot_id}"$'\trepo=.\tfile=note\\nline.txt\tstatus=resolved_uncommitted\treason=snapshot target content and mode match working tree but not HEAD' "${untracked_control_porcelain}" "untracked newline path should stay intact in porcelain"

printf "untracked-diverged\n" > "${untracked_control_repo}/${untracked_tab_path}"
printf "untracked-diverged\n" > "${untracked_control_repo}/${untracked_newline_path}"

untracked_control_diverged="$(cd "${untracked_control_repo}" && git_snapshot_test_cmd compare "${untracked_control_snapshot_id}" --repo . --all --porcelain)"
assert_contains $'compare_file\tsnapshot_id='"${untracked_control_snapshot_id}"$'\trepo=.\tfile=note\\tname.txt\tstatus=unresolved_diverged\treason=current content or mode diverges from snapshot target' "${untracked_control_diverged}" "untracked tab path should classify as unresolved_diverged after edits"
assert_contains $'compare_file\tsnapshot_id='"${untracked_control_snapshot_id}"$'\trepo=.\tfile=note\\nline.txt\tstatus=unresolved_diverged\treason=current content or mode diverges from snapshot target' "${untracked_control_diverged}" "untracked newline path should classify as unresolved_diverged after edits"

# 5) Symlink path-shape coverage: spaces/quotes in symlink path should classify correctly.
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

# 6) Structured compare porcelain errors: emit stable compare_error identifier rows.
error_repo="${TEST_REPOS_ROOT}/porcelain-errors"
git_snapshot_test_init_repo "${error_repo}"
git_snapshot_test_commit_file "${error_repo}" "tracked.txt" "tracked-base" "init tracked"

printf "staged-change\n" >> "${error_repo}/tracked.txt"
git -C "${error_repo}" add tracked.txt

error_create_output="$(cd "${error_repo}" && git_snapshot_test_cmd create compare-error-row)"
error_snapshot_id="$(git_snapshot_test_get_snapshot_id_from_create_output "${error_create_output}")"
assert_eq "compare-error-row" "${error_snapshot_id}" "error snapshot id should be preserved"

assert_compare_integrity_failure() {
  local snapshot_id="$1"
  local output="$2"
  local code="$3"
  local description="$4"

  assert_exit_code 1 "${code}" "${description}"
  assert_contains $'compare_target\tselected_snapshot_id='"${snapshot_id}"$'\tselection_mode=explicit\tsnapshot_origin=user\tsnapshot_root=' "${output}" "${description}"
  assert_contains $'compare_error\tsnapshot_id='"${snapshot_id}"$'\trepo=.\terror_id=compare_target_metadata_hash_mismatch\tstage=target_metadata_integrity\tmessage=Snapshot compare target metadata failed integrity verification.\tcontract_version=1' "${output}" "${description}"
  assert_not_contains $'compare_summary\tsnapshot_id='"${snapshot_id}" "${output}" "${description}"
}

snapshot_root="$(git_snapshot_test_snapshot_root_for_repo "${error_repo}")"
repo_bundle_dir="${snapshot_root}/${error_snapshot_id}/repos/repo-0001"
printf "this-is-not-a-valid-patch\n" > "${snapshot_root}/${error_snapshot_id}/repos/repo-0001/staged.patch"

error_v3_output="$(cd "${error_repo}" && git_snapshot_test_cmd compare "${error_snapshot_id}" --repo . --all --porcelain)"
assert_contains $'\tengine=v3\t' "${error_v3_output}" "metadata-backed compare should keep using the v3 engine even when snapshot patches are corrupted"
assert_not_contains $'compare_error\tsnapshot_id='"${error_snapshot_id}" "${error_v3_output}" "metadata-backed compare should not emit compare_error rows for unused patch corruption"

# Compare-target signature tampering must fail even on cold cache runs.
signature_cold_create_output="$(cd "${error_repo}" && git_snapshot_test_cmd create compare-signature-tamper-cold)"
signature_cold_snapshot_id="$(git_snapshot_test_get_snapshot_id_from_create_output "${signature_cold_create_output}")"
signature_cold_repo_bundle_dir="${snapshot_root}/${signature_cold_snapshot_id}/repos/repo-0001"
: > "${signature_cold_repo_bundle_dir}/compare-target.signatures.tsv"

set +e
signature_cold_output="$(cd "${error_repo}" && GIT_SNAPSHOT_COMPARE_CACHE=0 git_snapshot_test_cmd compare "${signature_cold_snapshot_id}" --repo . --all --porcelain 2>&1)"
signature_cold_code=$?
set -e
assert_compare_integrity_failure "${signature_cold_snapshot_id}" "${signature_cold_output}" "${signature_cold_code}" "compare should fail on cold-cache signature metadata tampering"

# Integrity verification must run before warmed cache reuse.
signature_warm_create_output="$(cd "${error_repo}" && git_snapshot_test_cmd create compare-signature-tamper-warm)"
signature_warm_snapshot_id="$(git_snapshot_test_get_snapshot_id_from_create_output "${signature_warm_create_output}")"
signature_warm_repo_bundle_dir="${snapshot_root}/${signature_warm_snapshot_id}/repos/repo-0001"
signature_warm_seed_output="$(cd "${error_repo}" && git_snapshot_test_cmd compare "${signature_warm_snapshot_id}" --repo . --all --porcelain)"
assert_contains $'compare_summary\tsnapshot_id='"${signature_warm_snapshot_id}"$'\t' "${signature_warm_seed_output}" "warm signature tamper setup should populate compare cache"
: > "${signature_warm_repo_bundle_dir}/compare-target.signatures.tsv"

set +e
signature_warm_output="$(cd "${error_repo}" && git_snapshot_test_cmd compare "${signature_warm_snapshot_id}" --repo . --all --porcelain 2>&1)"
signature_warm_code=$?
set -e
assert_compare_integrity_failure "${signature_warm_snapshot_id}" "${signature_warm_output}" "${signature_warm_code}" "compare should fail on warmed-cache signature metadata tampering before cache reuse"

# Compare-target path tampering must fail while metadata files are still present.
paths_tamper_create_output="$(cd "${error_repo}" && git_snapshot_test_cmd create compare-paths-tamper)"
paths_tamper_snapshot_id="$(git_snapshot_test_get_snapshot_id_from_create_output "${paths_tamper_create_output}")"
paths_tamper_repo_bundle_dir="${snapshot_root}/${paths_tamper_snapshot_id}/repos/repo-0001"
printf "%s\n" "$(printf "unexpected-path.txt" | base64 | tr -d '\n')" >> "${paths_tamper_repo_bundle_dir}/compare-target.paths.b64"

set +e
paths_tamper_output="$(cd "${error_repo}" && GIT_SNAPSHOT_COMPARE_CACHE=0 git_snapshot_test_cmd compare "${paths_tamper_snapshot_id}" --repo . --all --porcelain 2>&1)"
paths_tamper_code=$?
set -e
assert_compare_integrity_failure "${paths_tamper_snapshot_id}" "${paths_tamper_output}" "${paths_tamper_code}" "compare should fail on compare-target path tampering"

rm -f "${repo_bundle_dir}/compare-target.paths.b64" "${repo_bundle_dir}/compare-target.signatures.tsv" "${repo_bundle_dir}/compare-target.meta.env"

set +e
error_porcelain_output="$(cd "${error_repo}" && git_snapshot_test_cmd compare "${error_snapshot_id}" --repo . --porcelain 2>&1)"
error_porcelain_code=$?
set -e

assert_exit_code 1 "${error_porcelain_code}" "compare should fail when compare-target metadata is missing"
assert_contains $'compare_target\tselected_snapshot_id='"${error_snapshot_id}"$'\tselection_mode=explicit\tsnapshot_origin=user\tsnapshot_root=' "${error_porcelain_output}" "porcelain compare should emit compare_target before failure"
assert_contains $'compare_error\tsnapshot_id='"${error_snapshot_id}"$'\trepo=.\terror_id=compare_target_metadata_missing\tstage=target_metadata_validate\tmessage=Snapshot compare target metadata is missing.\tcontract_version=1' "${error_porcelain_output}" "porcelain compare should emit structured compare_error row when compare-target metadata is missing"
assert_not_contains $'compare_summary\tsnapshot_id='"${error_snapshot_id}" "${error_porcelain_output}" "failed compare should not emit compare summary"
