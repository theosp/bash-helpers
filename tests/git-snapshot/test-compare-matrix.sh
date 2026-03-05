#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/../helpers/assertions.bash"
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/../helpers/fixtures.bash"

git_snapshot_test_setup_sandbox

# 1) Missing-path status for snapshot-captured untracked files.
repo_missing_case="${TEST_REPOS_ROOT}/missing-case"
git_snapshot_test_init_repo "${repo_missing_case}"
git_snapshot_test_commit_file "${repo_missing_case}" "tracked.txt" "tracked-base" "init tracked"
printf "snapshot-untracked\n" > "${repo_missing_case}/ghost.txt"
missing_create_output="$(cd "${repo_missing_case}" && git_snapshot_test_cmd create matrix-missing-path)"
missing_snapshot_id="$(git_snapshot_test_get_snapshot_id_from_create_output "${missing_create_output}")"
assert_eq "matrix-missing-path" "${missing_snapshot_id}" "missing-path snapshot id should be preserved"
rm -f "${repo_missing_case}/ghost.txt"

missing_compare_output="$(cd "${repo_missing_case}" && git_snapshot_test_cmd compare "${missing_snapshot_id}" --repo .)"
assert_contains "ghost.txt [unresolved_missing]" "${missing_compare_output}" "missing untracked target should be unresolved_missing"

# 2) Deletion-target matrix: resolved_uncommitted -> resolved_committed -> unresolved_diverged.
repo_delete_case="${TEST_REPOS_ROOT}/delete-case"
git_snapshot_test_init_repo "${repo_delete_case}"
git_snapshot_test_commit_file "${repo_delete_case}" "delete-me.txt" "delete-base" "init delete target"

git -C "${repo_delete_case}" rm delete-me.txt >/dev/null
delete_create_output="$(cd "${repo_delete_case}" && git_snapshot_test_cmd create matrix-delete-target)"
delete_snapshot_id="$(git_snapshot_test_get_snapshot_id_from_create_output "${delete_create_output}")"
assert_eq "matrix-delete-target" "${delete_snapshot_id}" "delete-target snapshot id should be preserved"

delete_uncommitted_output="$(cd "${repo_delete_case}" && git_snapshot_test_cmd compare "${delete_snapshot_id}" --repo . --all)"
assert_contains "delete-me.txt [resolved_uncommitted]" "${delete_uncommitted_output}" "staged deletion should classify as resolved_uncommitted"

git -C "${repo_delete_case}" commit -m "commit delete target" >/dev/null
delete_committed_output="$(cd "${repo_delete_case}" && git_snapshot_test_cmd compare "${delete_snapshot_id}" --repo . --all)"
assert_contains "delete-me.txt [resolved_committed]" "${delete_committed_output}" "committed deletion should classify as resolved_committed"

printf "reintroduced\n" > "${repo_delete_case}/delete-me.txt"
delete_diverged_output="$(cd "${repo_delete_case}" && git_snapshot_test_cmd compare "${delete_snapshot_id}" --repo .)"
assert_contains "delete-me.txt [unresolved_diverged]" "${delete_diverged_output}" "reintroduced file should diverge from deletion target"

delete_diverged_porcelain="$(cd "${repo_delete_case}" && git_snapshot_test_cmd compare "${delete_snapshot_id}" --repo . --porcelain)"
assert_contains $'compare_file\tsnapshot_id='"${delete_snapshot_id}"$'\trepo=.\tfile=delete-me.txt\tstatus=unresolved_diverged\treason=' "${delete_diverged_porcelain}" "porcelain should expose unresolved_diverged status"
assert_contains $'compare_summary\tsnapshot_id='"${delete_snapshot_id}"$'\trepos_checked=1\tfiles_total=1\tresolved_committed=0\tresolved_uncommitted=0\tunresolved_missing=0\tunresolved_diverged=1\tunresolved_total=1\tshown_files=1\tcontract_version=3' "${delete_diverged_porcelain}" "porcelain summary should expose v3 unresolved counters"

# 3) Missing repo path should map snapshot files to unresolved_missing rows.
nested_root="$(git_snapshot_test_make_nested_fixture)"
printf "sub1-progress\n" >> "${nested_root}/modules/sub1/sub1.txt"

nested_create_output="$(cd "${nested_root}" && git_snapshot_test_cmd create matrix-repo-missing)"
nested_snapshot_id="$(git_snapshot_test_get_snapshot_id_from_create_output "${nested_create_output}")"
assert_eq "matrix-repo-missing" "${nested_snapshot_id}" "repo-missing snapshot id should be preserved"

rm -rf "${nested_root}/modules/sub1"
repo_missing_compare_output="$(cd "${nested_root}" && git_snapshot_test_cmd compare "${nested_snapshot_id}" --repo modules/sub1)"
assert_contains "sub1.txt [unresolved_missing]" "${repo_missing_compare_output}" "missing repo path should surface unresolved_missing rows"
assert_contains "repo missing at modules/sub1" "${repo_missing_compare_output}" "missing repo rows should include explicit reason"

# 4) No-user-snapshot failure path remains explicit.
repo_auto_only="${TEST_REPOS_ROOT}/auto-only"
git_snapshot_test_init_repo "${repo_auto_only}"
git_snapshot_test_commit_file "${repo_auto_only}" "auto.txt" "auto-base" "init auto-only"
auto_reset_output="$(cd "${repo_auto_only}" && git_snapshot_test_cmd reset-all --snapshot --porcelain)"
assert_contains $'reset_all_snapshot\tcreated=true\tsnapshot_id=pre-reset-' "${auto_reset_output}" "auto-only repo should create an auto snapshot"

set +e
no_user_compare_output="$(cd "${repo_auto_only}" && git_snapshot_test_cmd compare 2>&1)"
no_user_compare_code=$?
set -e
assert_exit_code 1 "${no_user_compare_code}" "compare should fail without any user-created snapshot"
assert_contains "No user-created snapshot found to compare against." "${no_user_compare_output}" "compare should explain missing user snapshot"

# 5) Rename source-path reintroduction should be unresolved.
repo_rename_case="${TEST_REPOS_ROOT}/rename-case"
git_snapshot_test_init_repo "${repo_rename_case}"
git_snapshot_test_commit_file "${repo_rename_case}" "old.txt" "rename-base" "init rename source"

git -C "${repo_rename_case}" mv old.txt new.txt
rename_create_output="$(cd "${repo_rename_case}" && git_snapshot_test_cmd create matrix-rename-source)"
rename_snapshot_id="$(git_snapshot_test_get_snapshot_id_from_create_output "${rename_create_output}")"
assert_eq "matrix-rename-source" "${rename_snapshot_id}" "rename snapshot id should be preserved"

printf "reintroduced old path\n" > "${repo_rename_case}/old.txt"
rename_compare_output="$(cd "${repo_rename_case}" && git_snapshot_test_cmd compare "${rename_snapshot_id}" --repo .)"
assert_contains "old.txt [unresolved_diverged]" "${rename_compare_output}" "reintroduced rename source should be unresolved_diverged"

rename_porcelain_output="$(cd "${repo_rename_case}" && git_snapshot_test_cmd compare "${rename_snapshot_id}" --repo . --porcelain)"
assert_contains $'compare_file\tsnapshot_id='"${rename_snapshot_id}"$'\trepo=.\tfile=old.txt\tstatus=unresolved_diverged\treason=' "${rename_porcelain_output}" "porcelain should expose unresolved_diverged for reintroduced rename source"
