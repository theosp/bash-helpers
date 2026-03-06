#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/../helpers/assertions.bash"
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/../helpers/fixtures.bash"

git_snapshot_test_setup_sandbox
repo="${TEST_REPOS_ROOT}/status-contract"

git_snapshot_test_init_repo "${repo}"
printf '#!/usr/bin/env bash\nprintf "hi\\n"\n' > "${repo}/mode-script.sh"
chmod 644 "${repo}/mode-script.sh"
printf 'target-a\n' > "${repo}/target-a.txt"
printf 'target-b\n' > "${repo}/target-b.txt"
ln -s target-a.txt "${repo}/link.txt"
git -C "${repo}" add mode-script.sh target-a.txt target-b.txt link.txt
git -C "${repo}" commit -m "seed status contract fixture" >/dev/null

# Mode-only staged change should be uncommitted until commit lands.
chmod +x "${repo}/mode-script.sh"
git -C "${repo}" add mode-script.sh
mode_create_output="$(cd "${repo}" && git_snapshot_test_cmd create status-mode)"
mode_snapshot_id="$(git_snapshot_test_get_snapshot_id_from_create_output "${mode_create_output}")"
assert_eq "status-mode" "${mode_snapshot_id}" "mode status snapshot id should be preserved"

mode_porcelain_output="$(cd "${repo}" && git_snapshot_test_cmd compare "${mode_snapshot_id}" --repo . --all --porcelain)"
assert_contains $'compare_file\tsnapshot_id='"${mode_snapshot_id}"$'\trepo=.\tfile=mode-script.sh\tstatus=resolved_uncommitted' "${mode_porcelain_output}" "mode-only staged change should classify as resolved_uncommitted"

git -C "${repo}" commit -m "commit mode change" >/dev/null
mode_committed_porcelain_output="$(cd "${repo}" && git_snapshot_test_cmd compare "${mode_snapshot_id}" --repo . --all --porcelain)"
assert_contains $'compare_file\tsnapshot_id='"${mode_snapshot_id}"$'\trepo=.\tfile=mode-script.sh\tstatus=resolved_committed' "${mode_committed_porcelain_output}" "mode-only committed change should classify as resolved_committed"

# Symlink object-type parity should follow the same committed/uncommitted/diverged contract.
rm -f "${repo}/link.txt"
ln -s target-b.txt "${repo}/link.txt"
git -C "${repo}" add link.txt
symlink_create_output="$(cd "${repo}" && git_snapshot_test_cmd create status-symlink)"
symlink_snapshot_id="$(git_snapshot_test_get_snapshot_id_from_create_output "${symlink_create_output}")"
assert_eq "status-symlink" "${symlink_snapshot_id}" "symlink status snapshot id should be preserved"

symlink_porcelain_output="$(cd "${repo}" && git_snapshot_test_cmd compare "${symlink_snapshot_id}" --repo . --all --porcelain)"
assert_contains $'compare_file\tsnapshot_id='"${symlink_snapshot_id}"$'\trepo=.\tfile=link.txt\tstatus=resolved_uncommitted' "${symlink_porcelain_output}" "symlink staged change should classify as resolved_uncommitted"

git -C "${repo}" commit -m "commit symlink target" >/dev/null
symlink_committed_porcelain_output="$(cd "${repo}" && git_snapshot_test_cmd compare "${symlink_snapshot_id}" --repo . --all --porcelain)"
assert_contains $'compare_file\tsnapshot_id='"${symlink_snapshot_id}"$'\trepo=.\tfile=link.txt\tstatus=resolved_committed' "${symlink_committed_porcelain_output}" "symlink committed change should classify as resolved_committed"

# HEAD parity alone is not enough when current worktree diverges.
rm -f "${repo}/link.txt"
ln -s target-a.txt "${repo}/link.txt"

symlink_diverged_output="$(cd "${repo}" && git_snapshot_test_cmd compare "${symlink_snapshot_id}" --repo .)"
assert_contains "Compare: unresolved snapshot work remains." "${symlink_diverged_output}" "worktree divergence should keep compare unresolved"
assert_contains "link.txt [unresolved_diverged]" "${symlink_diverged_output}" "diverged symlink should classify as unresolved_diverged"

symlink_diverged_porcelain_output="$(cd "${repo}" && git_snapshot_test_cmd compare "${symlink_snapshot_id}" --repo . --all --porcelain)"
assert_contains $'compare_file\tsnapshot_id='"${symlink_snapshot_id}"$'\trepo=.\tfile=link.txt\tstatus=unresolved_diverged\treason=current content or mode diverges from snapshot target' "${symlink_diverged_porcelain_output}" "porcelain should expose unresolved_diverged status and reason for symlink divergence"
assert_contains $'compare_summary\tsnapshot_id='"${symlink_snapshot_id}"$'\trepos_checked=1\tfiles_total=1\tresolved_committed=0\tresolved_uncommitted=0\tunresolved_missing=0\tunresolved_diverged=1\tunresolved_total=1\tshown_files=1\tengine=v2\telapsed_ms=' "${symlink_diverged_porcelain_output}" "porcelain summary should keep v5 counters for diverged symlink"
assert_contains $'\tcontract_version=5' "${symlink_diverged_porcelain_output}" "porcelain summary should expose v5 contract version"
