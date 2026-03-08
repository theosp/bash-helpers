#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/../helpers/assertions.bash"
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/../helpers/fixtures.bash"

LIB_DIR="${BASH_HELPERS_ROOT}/lib/git-snapshot"
# shellcheck source=/dev/null
source "${LIB_DIR}/ui.bash"
# shellcheck source=/dev/null
source "${LIB_DIR}/repo-discovery.bash"
# shellcheck source=/dev/null
source "${LIB_DIR}/status-hash.bash"
# shellcheck source=/dev/null
source "${LIB_DIR}/bundle-store.bash"
# shellcheck source=/dev/null
source "${LIB_DIR}/restore.bash"
# shellcheck source=/dev/null
source "${LIB_DIR}/inspect.bash"
# shellcheck source=/dev/null
source "${LIB_DIR}/core.bash"

git_snapshot_test_setup_sandbox

find_signature_row() {
  local encoded_path="$1"
  local signatures_file="$2"

  awk -F $'\t' -v encoded_path="${encoded_path}" '$1 == encoded_path { print; exit }' "${signatures_file}"
}

signature_mode() {
  local row="$1"
  printf "%s\n" "${row}" | awk -F $'\t' '{print $2}'
}

signature_oid() {
  local row="$1"
  printf "%s\n" "${row}" | awk -F $'\t' '{print $3}'
}

repo="${TEST_REPOS_ROOT}/targeted-signatures"
git_snapshot_test_init_repo "${repo}"
printf "regular-base\n" > "${repo}/regular.txt"
printf '#!/usr/bin/env bash\nprintf "hi\\n"\n' > "${repo}/mode-script.sh"
chmod 644 "${repo}/mode-script.sh"
printf "delete-base\n" > "${repo}/delete-me.txt"
printf "target-a\n" > "${repo}/target-a.txt"
printf "target-b\n" > "${repo}/target-b.txt"
ln -s target-a.txt "${repo}/link.txt"
git -C "${repo}" add regular.txt mode-script.sh delete-me.txt target-a.txt target-b.txt link.txt
git -C "${repo}" commit -m "seed targeted signature fixture" >/dev/null

printf "regular-updated\n" > "${repo}/regular.txt"
chmod +x "${repo}/mode-script.sh"
rm -f "${repo}/delete-me.txt"
rm -f "${repo}/link.txt"
ln -s target-b.txt "${repo}/link.txt"
printf "untracked-payload\n" > "${repo}/note.txt"

target_paths_file="$(mktemp)"
target_signatures_file="$(mktemp)"
for file_path in regular.txt mode-script.sh delete-me.txt link.txt note.txt; do
  _git_snapshot_compare_emit_encoded_path "${file_path}" >> "${target_paths_file}"
done

if ! _git_snapshot_compare_collect_temp_index_signatures "${repo}" "${target_paths_file}" "${target_signatures_file}"; then
  fail "temp-index signature collection should succeed for mixed path types"
fi

regular_row="$(find_signature_row "$(_git_snapshot_store_base64_encode "regular.txt")" "${target_signatures_file}")"
mode_row="$(find_signature_row "$(_git_snapshot_store_base64_encode "mode-script.sh")" "${target_signatures_file}")"
link_row="$(find_signature_row "$(_git_snapshot_store_base64_encode "link.txt")" "${target_signatures_file}")"
note_row="$(find_signature_row "$(_git_snapshot_store_base64_encode "note.txt")" "${target_signatures_file}")"
delete_row="$(find_signature_row "$(_git_snapshot_store_base64_encode "delete-me.txt")" "${target_signatures_file}")"

assert_non_empty "${regular_row}" "regular file row should be present"
assert_eq "100644" "$(signature_mode "${regular_row}")" "regular file should keep non-executable mode"
assert_eq "$(git -C "${repo}" hash-object --no-filters -- regular.txt)" "$(signature_oid "${regular_row}")" "regular file object id should match working tree content"

assert_non_empty "${mode_row}" "mode-only row should be present"
assert_eq "100755" "$(signature_mode "${mode_row}")" "mode-only update should surface executable mode"
assert_eq "$(git -C "${repo}" hash-object --no-filters -- mode-script.sh)" "$(signature_oid "${mode_row}")" "mode-only update should keep current blob id"

assert_non_empty "${link_row}" "symlink row should be present"
assert_eq "120000" "$(signature_mode "${link_row}")" "symlink row should surface symlink mode"
assert_eq "$(printf "target-b.txt" | git -C "${repo}" hash-object --stdin)" "$(signature_oid "${link_row}")" "symlink row should hash the current target payload"

assert_non_empty "${note_row}" "untracked row should be present"
assert_eq "100644" "$(signature_mode "${note_row}")" "untracked regular file should surface blob mode"
assert_eq "$(git -C "${repo}" hash-object --no-filters -- note.txt)" "$(signature_oid "${note_row}")" "untracked row should hash the working tree payload"

assert_eq "" "${delete_row}" "deleted paths should stay absent from temp-index signatures"
assert_eq "" "$(git -C "${repo}" diff --cached --name-only)" "temp-index collection must not mutate the real index"

unborn_repo="${TEST_REPOS_ROOT}/targeted-signatures-unborn"
git_snapshot_test_init_repo "${unborn_repo}"
printf "unborn-payload\n" > "${unborn_repo}/unborn.txt"
unborn_paths_file="$(mktemp)"
unborn_signatures_file="$(mktemp)"
_git_snapshot_compare_emit_encoded_path "unborn.txt" > "${unborn_paths_file}"

if ! _git_snapshot_compare_collect_temp_index_signatures "${unborn_repo}" "${unborn_paths_file}" "${unborn_signatures_file}"; then
  fail "temp-index signature collection should succeed for unborn-head repos"
fi

unborn_row="$(find_signature_row "$(_git_snapshot_store_base64_encode "unborn.txt")" "${unborn_signatures_file}")"
assert_non_empty "${unborn_row}" "unborn-head working tree file should produce a signature row"
assert_eq "100644" "$(signature_mode "${unborn_row}")" "unborn-head file should carry regular-file mode"

submodule_source="${TEST_REPOS_ROOT}/targeted-signatures-submodule-source"
git_snapshot_test_init_repo "${submodule_source}"
git_snapshot_test_commit_file "${submodule_source}" "sub.txt" "sub-one" "seed submodule v1"
submodule_v1="$(git -C "${submodule_source}" rev-parse HEAD)"

super_repo="${TEST_REPOS_ROOT}/targeted-signatures-super"
git_snapshot_test_init_repo "${super_repo}"
git_snapshot_test_commit_file "${super_repo}" "tracked.txt" "base" "seed super repo"
git -C "${super_repo}" -c protocol.file.allow=always submodule add "${submodule_source}" "modules/sub" >/dev/null
git -C "${super_repo}" commit -am "add submodule" >/dev/null
git -C "${super_repo}" -c protocol.file.allow=always submodule update --init >/dev/null

printf "sub-two\n" > "${submodule_source}/sub.txt"
git -C "${submodule_source}" add sub.txt
git -C "${submodule_source}" commit -m "seed submodule v2" >/dev/null
submodule_v2="$(git -C "${submodule_source}" rev-parse HEAD)"
assert_ne "${submodule_v1}" "${submodule_v2}" "submodule fixture should have two distinct commits"

git -C "${super_repo}/modules/sub" fetch >/dev/null
git -C "${super_repo}/modules/sub" checkout "${submodule_v2}" >/dev/null 2>&1

gitlink_paths_file="$(mktemp)"
gitlink_signatures_file="$(mktemp)"
_git_snapshot_compare_emit_encoded_path "modules/sub" > "${gitlink_paths_file}"

if ! _git_snapshot_compare_collect_temp_index_signatures "${super_repo}" "${gitlink_paths_file}" "${gitlink_signatures_file}"; then
  fail "temp-index signature collection should succeed for gitlink paths"
fi

gitlink_row="$(find_signature_row "$(_git_snapshot_store_base64_encode "modules/sub")" "${gitlink_signatures_file}")"
assert_non_empty "${gitlink_row}" "gitlink row should be present"
assert_eq "160000" "$(signature_mode "${gitlink_row}")" "gitlink row should keep gitlink mode"
assert_eq "${submodule_v2}" "$(signature_oid "${gitlink_row}")" "gitlink row should use the current submodule HEAD"

git -C "${super_repo}" rm -f --cached modules/sub >/dev/null

deleted_gitlink_signatures_file="$(mktemp)"
if ! _git_snapshot_compare_collect_temp_index_signatures "${super_repo}" "${gitlink_paths_file}" "${deleted_gitlink_signatures_file}"; then
  fail "temp-index signature collection should succeed for deleted gitlink paths with leftover repo directories"
fi

deleted_gitlink_row="$(find_signature_row "$(_git_snapshot_store_base64_encode "modules/sub")" "${deleted_gitlink_signatures_file}")"
assert_eq "" "${deleted_gitlink_row}" "deleted gitlink paths should stay absent even when the repo directory still exists"

rm -f "${target_paths_file}" "${target_signatures_file}" "${unborn_paths_file}" "${unborn_signatures_file}" "${gitlink_paths_file}" "${gitlink_signatures_file}" "${deleted_gitlink_signatures_file}"
