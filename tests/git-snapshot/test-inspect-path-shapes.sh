#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/../helpers/assertions.bash"
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/../helpers/fixtures.bash"

git_snapshot_test_setup_sandbox

repo="${TEST_REPOS_ROOT}/inspect-path-shapes"
git_snapshot_test_init_repo "${repo}"
git_snapshot_test_commit_file "${repo}" "tracked.txt" "tracked-base" "init inspect path-shapes repo"

dash_untracked_path="--inspect-untracked.txt"
dash_untracked_content="captured dash-prefixed untracked line"
printf "%s\n" "${dash_untracked_content}" > "${repo}/${dash_untracked_path}"

create_output="$(cd "${repo}" && git_snapshot_test_cmd create inspect-path-shapes)"
snapshot_id="$(git_snapshot_test_get_snapshot_id_from_create_output "${create_output}")"
assert_eq "inspect-path-shapes" "${snapshot_id}" "inspect path-shapes snapshot id should be preserved"

snapshot_root="$(git_snapshot_test_snapshot_root_for_repo "${repo}")"
snapshot_path="${snapshot_root}/${snapshot_id}"
repos_tsv="${snapshot_path}/repos.tsv"
repo_id="$(awk -F'\t' '$2=="." {print $1; exit}' "${repos_tsv}")"
assert_non_empty "${repo_id}" "root repo id should exist in snapshot metadata"

bundle_dir="${snapshot_path}/repos/${repo_id}"
untracked_tar="${bundle_dir}/untracked.tar"
assert_file_exists "${untracked_tar}" "snapshot should contain an untracked tar bundle"

tar_listing="$(tar -tf "${untracked_tar}")"
assert_contains "${dash_untracked_path}" "${tar_listing}" "dash-prefixed untracked file should be archived in the snapshot bundle"

tar_preview="$(tar -xOf "${untracked_tar}" -- "${dash_untracked_path}")"
assert_eq "${dash_untracked_content}" "${tar_preview}" "dash-prefixed untracked file should extract from the snapshot bundle with literal path handling"

inspect_name_only_output="$(cd "${repo}" && git_snapshot_test_cmd inspect "${snapshot_id}" --repo . --untracked --name-only)"
assert_contains "${dash_untracked_path}" "${inspect_name_only_output}" "inspect --name-only should list dash-prefixed captured untracked files"

inspect_porcelain_output="$(cd "${repo}" && git_snapshot_test_cmd inspect "${snapshot_id}" --repo . --untracked --porcelain)"
assert_contains $'inspect_target\tsnapshot_id='"${snapshot_id}"$'\trepo_filter=.\tshow_all_repos=false\tinclude_staged=false\tinclude_unstaged=false\tinclude_untracked=true' "${inspect_porcelain_output}" "inspect porcelain should preserve the untracked-only selection"
assert_contains $'inspect_file\tsnapshot_id='"${snapshot_id}"$'\trepo=.\tcategory=untracked\tfile=--inspect-untracked.txt' "${inspect_porcelain_output}" "inspect porcelain should report the dash-prefixed captured untracked file"
