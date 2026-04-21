#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/../helpers/assertions.bash"
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/../helpers/fixtures.bash"

git_snapshot_test_setup_sandbox
root_repo="$(git_snapshot_test_make_nested_fixture)"
root_repo_basename="$(basename "${root_repo}")"
git -C "${root_repo}/modules/sub1" config user.email "tests@example.com"
git -C "${root_repo}/modules/sub1" config user.name "git-snapshot-tests"

initial_output="$(cd "${root_repo}" && git_snapshot_test_cmd browse --porcelain)"
assert_contains $'browse_target\tbaseline_kind=head\tbaseline_ref=HEAD' "${initial_output}" "browse should expose the HEAD baseline in porcelain output"
assert_contains $'browse_repo\tbaseline_kind=head\tbaseline_ref=HEAD\trepo=.\thas_changes=false' "${initial_output}" "browse should include the root repo even when it is clean"
assert_not_contains $'browse_file\t' "${initial_output}" "browse should emit no file rows when the tree is clean"

git_snapshot_test_commit_file "${root_repo}" "browse-unstaged.txt" "browse-unstaged-base" "seed root browse file"
git_snapshot_test_commit_file "${root_repo}" "browse-partial.txt" "browse-partial-base" "seed partially staged browse file"
git_snapshot_test_commit_file "${root_repo}/modules/sub1" "browse-submodule-base.txt" "browse-submodule-base" "seed submodule browse file"

printf "browse staged root\n" >> "${root_repo}/root.txt"
git -C "${root_repo}" add root.txt
printf "browse unstaged root\n" >> "${root_repo}/browse-unstaged.txt"
printf "browse partial staged root\n" >> "${root_repo}/browse-partial.txt"
git -C "${root_repo}" add browse-partial.txt
printf "browse partial unstaged root\n" >> "${root_repo}/browse-partial.txt"
printf "browse untracked root\n" > "${root_repo}/browse-untracked.txt"

printf "browse staged submodule\n" >> "${root_repo}/modules/sub1/sub1.txt"
git -C "${root_repo}/modules/sub1" add sub1.txt

browse_output="$(cd "${root_repo}" && git_snapshot_test_cmd browse --porcelain)"
assert_contains $'browse_repo\tbaseline_kind=head\tbaseline_ref=HEAD\trepo=.\thas_changes=true' "${browse_output}" "browse should mark the root repo as changed"
assert_contains $'browse_repo\tbaseline_kind=head\tbaseline_ref=HEAD\trepo=modules/sub1\thas_changes=true' "${browse_output}" "browse should mark changed submodule repos as changed"
assert_contains $'browse_file\tbaseline_kind=head\tbaseline_ref=HEAD\trepo=.\tcategory=staged\tentry_kind=file\tfile=root.txt' "${browse_output}" "browse should report staged root files"
assert_contains $'browse_file\tbaseline_kind=head\tbaseline_ref=HEAD\trepo=.\tcategory=staged\tentry_kind=file\tfile=browse-partial.txt' "${browse_output}" "browse should report staged rows for partially staged files"
assert_contains $'browse_file\tbaseline_kind=head\tbaseline_ref=HEAD\trepo=.\tcategory=unstaged\tentry_kind=file\tfile=browse-unstaged.txt' "${browse_output}" "browse should report unstaged root files"
assert_contains $'browse_file\tbaseline_kind=head\tbaseline_ref=HEAD\trepo=.\tcategory=unstaged\tentry_kind=file\tfile=browse-partial.txt' "${browse_output}" "browse should report unstaged rows for partially staged files"
assert_contains $'browse_file\tbaseline_kind=head\tbaseline_ref=HEAD\trepo=.\tcategory=untracked\tentry_kind=file\tfile=browse-untracked.txt' "${browse_output}" "browse should report untracked root files"
assert_contains $'browse_file\tbaseline_kind=head\tbaseline_ref=HEAD\trepo=.\tcategory=submodules\tentry_kind=submodule\tfile=modules/sub1' "${browse_output}" "browse should report live submodule paths under the root repo"
assert_contains $'browse_file\tbaseline_kind=head\tbaseline_ref=HEAD\trepo=modules/sub1\tcategory=staged\tentry_kind=file\tfile=sub1.txt' "${browse_output}" "browse should report staged files inside changed submodule repos"

repo_alias_output="$(cd "${root_repo}" && git_snapshot_test_cmd browse --repo "${root_repo_basename}" --staged --porcelain)"
assert_contains $'browse_target\tbaseline_kind=head\tbaseline_ref=HEAD\trepo_filter=.\tshow_all_repos=false\tinclude_staged=true\tinclude_unstaged=false\tinclude_untracked=false\tinclude_submodules=false' "${repo_alias_output}" "browse should normalize the root repo basename to ."
assert_contains $'browse_file\tbaseline_kind=head\tbaseline_ref=HEAD\trepo=.\tcategory=staged\tentry_kind=file\tfile=root.txt' "${repo_alias_output}" "browse --staged should keep staged root rows"
assert_not_contains $'category=untracked' "${repo_alias_output}" "browse --staged should filter out untracked rows"
assert_not_contains $'category=submodules' "${repo_alias_output}" "browse --staged should filter out submodule rows"

all_repos_output="$(cd "${root_repo}" && git_snapshot_test_cmd browse --all-repos --porcelain)"
assert_contains $'browse_repo\tbaseline_kind=head\tbaseline_ref=HEAD\trepo=modules/sub1/modules/sub2\thas_changes=false' "${all_repos_output}" "browse --all-repos should expose clean initialized recursive submodules"

printf "browse nested submodule\n" > "${root_repo}/modules/sub1/modules/sub2/browse-sub2-untracked.txt"

nested_browse_output="$(cd "${root_repo}" && git_snapshot_test_cmd browse --porcelain)"
assert_contains $'browse_repo\tbaseline_kind=head\tbaseline_ref=HEAD\trepo=modules/sub1/modules/sub2\thas_changes=true' "${nested_browse_output}" "browse should mark nested dirty submodule repos as changed"
assert_contains $'browse_file\tbaseline_kind=head\tbaseline_ref=HEAD\trepo=modules/sub1\tcategory=submodules\tentry_kind=submodule\tfile=modules/sub2' "${nested_browse_output}" "browse should surface nested dirty submodules under their direct parent repo"
assert_contains $'browse_file\tbaseline_kind=head\tbaseline_ref=HEAD\trepo=modules/sub1/modules/sub2\tcategory=untracked\tentry_kind=file\tfile=browse-sub2-untracked.txt' "${nested_browse_output}" "browse should report files inside nested dirty submodule repos"

nested_repo_output="$(cd "${root_repo}" && git_snapshot_test_cmd browse --repo modules/sub1/modules/sub2 --all --porcelain)"
assert_contains $'browse_target\tbaseline_kind=head\tbaseline_ref=HEAD\trepo_filter=modules/sub1/modules/sub2\tshow_all_repos=false\tinclude_staged=true\tinclude_unstaged=true\tinclude_untracked=true\tinclude_submodules=true' "${nested_repo_output}" "browse --repo should preserve nested repo filters"
assert_contains $'browse_file\tbaseline_kind=head\tbaseline_ref=HEAD\trepo=modules/sub1/modules/sub2\tcategory=untracked\tentry_kind=file\tfile=browse-sub2-untracked.txt' "${nested_repo_output}" "browse --repo should expose nested repo file rows"
assert_not_contains $'browse_repo\tbaseline_kind=head\tbaseline_ref=HEAD\trepo=.\t' "${nested_repo_output}" "browse --repo should hide unrelated repo rows"

gui_output="$(cd "${root_repo}" && GIT_SNAPSHOT_GUI_TEST_MODE=1 git_snapshot_test_cmd browse --repo modules/sub1 --staged --gui)"
assert_contains "GUI_TEST mode=browse" "${gui_output}" "browse --gui should launch the browse UI"
assert_contains "browse_staged=true" "${gui_output}" "browse --gui should preserve staged-only mode"
assert_contains "browse_unstaged=false" "${gui_output}" "browse --gui should preserve category filters"
assert_contains "browse_submodules=false" "${gui_output}" "browse --gui should preserve submodule filter state"
assert_contains "repo_filter=modules/sub1" "${gui_output}" "browse --gui should preserve the repo filter"

fake_git_bin="${TEST_SANDBOX}/fake-git-bin"
real_git_bin="$(command -v git)"
mkdir -p "${fake_git_bin}"
cat > "${fake_git_bin}/git" <<EOF
#!/usr/bin/env bash
set -euo pipefail

for arg in "\$@"; do
  if [[ "\${arg}" == "--porcelain=v2" ]]; then
    printf "fatal: unsupported porcelain format version 2\n" >&2
    exit 128
  fi
done

exec "${real_git_bin}" "\$@"
EOF
chmod +x "${fake_git_bin}/git"

set +e
unsupported_browse_output="$(cd "${root_repo}" && PATH="${fake_git_bin}:${PATH}" git_snapshot_test_cmd browse --porcelain 2>&1)"
unsupported_browse_code=$?
set -e

assert_exit_code 1 "${unsupported_browse_code}" "browse should fail fast when git status porcelain v2 is unsupported"
assert_contains "git-snapshot browse requires Git with support for 'git status --porcelain=v2 --branch'." "${unsupported_browse_output}" "browse should surface a clear unsupported-git error"

counting_git_bin="${TEST_SANDBOX}/counting-git-bin"
counting_git_state_dir="${TEST_SANDBOX}/counting-git-state"
mkdir -p "${counting_git_bin}" "${counting_git_state_dir}"
cat > "${counting_git_bin}/git" <<EOF
#!/usr/bin/env bash
set -euo pipefail

real_git="${real_git_bin}"
state_dir="${counting_git_state_dir}"

is_status="false"
is_porcelain_v2="false"
for arg in "\$@"; do
  if [[ "\${arg}" == "status" ]]; then
    is_status="true"
  fi
  if [[ "\${arg}" == "--porcelain=v2" ]]; then
    is_porcelain_v2="true"
  fi
done

if [[ "\${is_status}" == "true" && "\${is_porcelain_v2}" == "true" ]]; then
  lock_dir="\${state_dir}/lock"
  current_file="\${state_dir}/current"
  max_file="\${state_dir}/max"

  update_counter() {
    local delta="\$1"
    local current="0"
    local max_seen="0"
    while ! mkdir "\${lock_dir}" 2>/dev/null; do
      sleep 0.01
    done
    if [[ -f "\${current_file}" ]]; then
      read -r current < "\${current_file}" || current="0"
    fi
    if [[ -f "\${max_file}" ]]; then
      read -r max_seen < "\${max_file}" || max_seen="0"
    fi
    current=\$((current + delta))
    if [[ "\${current}" -lt 0 ]]; then
      current=0
    fi
    if [[ "\${current}" -gt "\${max_seen}" ]]; then
      max_seen="\${current}"
    fi
    printf "%s\n" "\${current}" > "\${current_file}"
    printf "%s\n" "\${max_seen}" > "\${max_file}"
    rmdir "\${lock_dir}"
  }

  update_counter 1
  trap 'update_counter -1' EXIT
  sleep 0.2
fi

set +e
"\${real_git}" "\$@"
command_status=\$?
set -e
exit "\${command_status}"
EOF
chmod +x "${counting_git_bin}/git"

cat > "${root_repo}/.git-snapshot.config" <<EOF
[browse]
jobs = 1
EOF

printf "0\n" > "${counting_git_state_dir}/current"
printf "0\n" > "${counting_git_state_dir}/max"
(cd "${root_repo}" && PATH="${counting_git_bin}:${PATH}" git_snapshot_test_cmd browse --porcelain >/dev/null)
configured_max_concurrency="$(cat "${counting_git_state_dir}/max")"
assert_eq "1" "${configured_max_concurrency}" "browse config should cap concurrency at one worker"

printf "0\n" > "${counting_git_state_dir}/current"
printf "0\n" > "${counting_git_state_dir}/max"
(cd "${root_repo}" && PATH="${counting_git_bin}:${PATH}" GIT_SNAPSHOT_BROWSE_JOBS=2 git_snapshot_test_cmd browse --porcelain >/dev/null)
override_max_concurrency="$(cat "${counting_git_state_dir}/max")"
if [[ ! "${override_max_concurrency}" =~ ^[0-9]+$ || "${override_max_concurrency}" -lt 2 ]]; then
  fail "Expected browse env override to allow concurrent workers, saw max concurrency '${override_max_concurrency}'."
fi

bulk_untracked_repo="${TEST_REPOS_ROOT}/browse-bulk-untracked"
git_snapshot_test_init_repo "${bulk_untracked_repo}"
git_snapshot_test_commit_file "${bulk_untracked_repo}" "tracked.txt" "tracked-base" "init bulk untracked browse repo"
for i in $(seq 1 12); do
  bulk_path="${bulk_untracked_repo}/bulk-untracked-$(printf '%02d' "${i}").txt"
  : > "${bulk_path}"
  for line in $(seq 1 180); do
    printf "bulk %02d line %03d\n" "${i}" "${line}" >> "${bulk_path}"
  done
done

bulk_untracked_output="$(cd "${bulk_untracked_repo}" && git_snapshot_test_cmd browse --untracked --porcelain)"
assert_contains $'browse_target\tbaseline_kind=head\tbaseline_ref=HEAD\trepo_filter=\tshow_all_repos=false\tinclude_staged=false\tinclude_unstaged=false\tinclude_untracked=true\tinclude_submodules=false\trepos_in_scope=1\trepos_with_changes=1\ttotal_staged=0\ttotal_unstaged=0\ttotal_untracked=12\ttotal_submodules=0\tcontract_version=1' "${bulk_untracked_output}" "browse should keep untracked-only bulk scans scoped and counted"
if ! printf "%s" "${bulk_untracked_output}" | grep -Eq $'browse\tbaseline_kind=head\tbaseline_ref=HEAD\trepo=\\.\tcategory=untracked\tfile_count=12\tlines_added=[1-9][0-9]*\tlines_removed=0'; then
  fail "Expected browse bulk untracked category stats to report 12 files with nonzero added-line totals."
fi

bulk_untracked_telemetry="$(cd "${bulk_untracked_repo}" && GIT_SNAPSHOT_ROW_STATS_TELEMETRY=1 GIT_SNAPSHOT_ROW_STATS_SLOW_MS=0 git_snapshot_test_cmd browse --untracked --porcelain 2>&1 >/dev/null)"
assert_contains "ROW_STATS mode=browse category=untracked" "${bulk_untracked_telemetry}" "browse row-stats telemetry should emit untracked timing when enabled"

browse_newline_repo="${TEST_REPOS_ROOT}/browse-newline-path"
git_snapshot_test_init_repo "${browse_newline_repo}"
git_snapshot_test_commit_file "${browse_newline_repo}" "tracked.txt" "tracked-base" "init browse newline repo"
browse_newline_path=$'note\nline.txt'
printf "browse newline payload\n" > "${browse_newline_repo}/${browse_newline_path}"

browse_newline_output="$(cd "${browse_newline_repo}" && git_snapshot_test_cmd browse --untracked --porcelain)"
assert_contains $'browse_file\tbaseline_kind=head\tbaseline_ref=HEAD\trepo=.\tcategory=untracked\tentry_kind=file\tfile=note\\nline.txt\tlines_added=1\tlines_removed=0' "${browse_newline_output}" "browse porcelain should preserve newline filenames via escaped output"

browse_tab_repo="${TEST_REPOS_ROOT}/browse-tab-path"
git_snapshot_test_init_repo "${browse_tab_repo}"
git_snapshot_test_commit_file "${browse_tab_repo}" "tracked.txt" "tracked-base" "init browse tab repo"
browse_tab_path=$'note\tline.txt'
printf "browse tab payload\n" > "${browse_tab_repo}/${browse_tab_path}"

browse_tab_output="$(cd "${browse_tab_repo}" && git_snapshot_test_cmd browse --untracked --porcelain)"
assert_contains $'browse_file\tbaseline_kind=head\tbaseline_ref=HEAD\trepo=.\tcategory=untracked\tentry_kind=file\tfile=note\\tline.txt\tlines_added=1\tlines_removed=0' "${browse_tab_output}" "browse porcelain should preserve tab filenames via escaped output"
