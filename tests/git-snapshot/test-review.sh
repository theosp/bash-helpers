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

git -C "${root_repo}" branch master >/dev/null
git -C "${root_repo}/modules/sub1" branch master >/dev/null

printf "review committed delta\n" >> "${root_repo}/modules/sub1/sub1.txt"
git -C "${root_repo}/modules/sub1" add sub1.txt
git -C "${root_repo}/modules/sub1" commit -m "review committed delta" >/dev/null
printf "review dirty metadata\n" > "${root_repo}/modules/sub1/review-dirty.txt"

porcelain_output="$(
  cd "${root_repo}" \
    && git_snapshot_test_cmd review --repo modules/sub1 --repo modules/sub1/modules/sub2 --porcelain
)"

assert_contains $'review_target\tdefault_base_ref=master\tselected_repos=2\trepos_resolved=1\trepos_failed=1\trepos_fallback_to_master=0\tcontract_version=1' "${porcelain_output}" "review porcelain should expose selected repo counts and fallback totals"
assert_contains $'review_summary\tdefault_base_ref=master\trepos_checked=2\trepos_with_delta=1\trepos_fallback_to_master=0\tshown_files=1\tshown_lines_added=1\tshown_lines_removed=0\tcontract_version=1' "${porcelain_output}" "review summary should expose committed review totals"
assert_contains $'review_repo\trepo=modules/sub1\t' "${porcelain_output}" "review should include the changed selected repo"
assert_contains $'requested_base_ref=master\trequested_base_source=default\trequested_base_resolved=true\teffective_base_ref=master\t' "${porcelain_output}" "review should expose requested and effective base fields"
assert_contains $'base_source=default\tbase_resolution=resolved\tbase_note=\tmerge_base=' "${porcelain_output}" "review should expose the resolved merge-base for selected repos"
assert_contains $'dirty=true\thas_delta=true\tfiles_changed=1\tlines_added=1\tlines_removed=0\tstatus=ok\tmessage=' "${porcelain_output}" "review should report committed delta and dirty metadata separately"
assert_contains $'review_repo\trepo=modules/sub1/modules/sub2\t' "${porcelain_output}" "review should include selected repos even when baseline resolution fails"
assert_contains $'requested_base_ref=master\trequested_base_source=default\trequested_base_resolved=false\teffective_base_ref=\teffective_base_head=\tbase_source=default\tbase_resolution=unavailable\tbase_note=Default base master is unavailable here.\t' "${porcelain_output}" "review should surface unresolved requested bases and make the missing default explicit"
assert_contains $'status=baseline_missing\tmessage=Default base master is unavailable here.' "${porcelain_output}" "review should surface missing local master per repo"
assert_contains $'review_file\trepo=modules/sub1\tfile=sub1.txt\tlines_added=1\tlines_removed=0\tdisplay_kind=text_change\tdisplay_label=' "${porcelain_output}" "review should emit committed file rows for changed repos"
assert_contains $'review_ref\trepo=modules/sub1\tkind=branch\tref=master' "${porcelain_output}" "review should emit review_ref branch suggestions per selected repo"
assert_not_contains $'review_file\trepo=modules/sub1/modules/sub2\t' "${porcelain_output}" "review should not emit file rows for repos that failed baseline resolution"

human_output="$(
  cd "${root_repo}" \
    && git_snapshot_test_cmd review --repo modules/sub1 --repo modules/sub1/modules/sub2
)"

assert_contains "Review default base: master" "${human_output}" "human review output should show the default base"
assert_contains "Review rows: files=1 | lines=+1/-0 | repos=2" "${human_output}" "human review output should summarize selected repos"
assert_contains "Repo: modules/sub1 | branch: main | base: master | dirty: true | files: 1 | lines: +1/-0" "${human_output}" "human review output should show committed delta repo metadata"
assert_contains "  - sub1.txt (+1/-0)" "${human_output}" "human review output should show committed file stats"
assert_contains "Repo: modules/sub1/modules/sub2 | branch: (detached) | base: unavailable | dirty: false | files: 0 | lines: +0/-0 | Default base master is unavailable here." "${human_output}" "human review output should report repo-level baseline failures clearly"

alias_output="$(cd "${root_repo}" && git_snapshot_test_cmd review --repo "${root_repo_basename}" --porcelain)"
assert_contains $'review_repo\trepo=.\t' "${alias_output}" "review should normalize the root repo basename to ."
assert_contains $'requested_base_ref=master\trequested_base_source=default\trequested_base_resolved=true\teffective_base_ref=master\t' "${alias_output}" "review should report root review base metadata"
assert_contains $'status=no_delta\tmessage=No committed delta vs master.' "${alias_output}" "review should report selected repos with no committed delta"

git -C "${root_repo}/modules/sub1" checkout --detach >/dev/null 2>&1
detached_output="$(cd "${root_repo}" && git_snapshot_test_cmd review --repo modules/sub1 --porcelain)"
assert_contains $'review_repo\trepo=modules/sub1\t' "${detached_output}" "review should still work for detached HEAD"
assert_contains "current_branch=(detached)" "${detached_output}" "review should label detached HEAD repos explicitly"

git -C "${root_repo}/modules/sub1" checkout main >/dev/null 2>&1
git -C "${root_repo}/modules/sub1/modules/sub2" branch master >/dev/null
if git -C "${root_repo}/modules/sub1/modules/sub2" show-ref --verify --quiet refs/heads/main; then
  git -C "${root_repo}/modules/sub1/modules/sub2" branch -D main >/dev/null
fi

fallback_output="$(
  cd "${root_repo}" \
    && git_snapshot_test_cmd review --repo modules/sub1 --repo modules/sub1/modules/sub2 --base main --porcelain
)"
assert_contains $'review_target\tdefault_base_ref=main\tselected_repos=2\trepos_resolved=2\trepos_failed=0\trepos_fallback_to_master=1\tcontract_version=1' "${fallback_output}" "review should report fallback-to-master counts"
assert_contains $'review_summary\tdefault_base_ref=main\trepos_checked=2\trepos_with_delta=0\trepos_fallback_to_master=1\tshown_files=0\tshown_lines_added=0\tshown_lines_removed=0\tcontract_version=1' "${fallback_output}" "review summary should reflect the configured default base even when selected repos have no committed delta"
assert_contains $'review_repo\trepo=modules/sub1\t' "${fallback_output}" "review should include the selected repo when the default base exists"
assert_contains $'requested_base_ref=main\trequested_base_source=default\trequested_base_resolved=true\teffective_base_ref=main\t' "${fallback_output}" "review should use the requested base when it resolves"
assert_contains 'message=No committed delta vs main.' "${fallback_output}" "review should report no committed delta when the selected branch already matches the configured base"
assert_contains $'review_repo\trepo=modules/sub1/modules/sub2\t' "${fallback_output}" "review should still include repos that fall back to master"
assert_contains $'requested_base_ref=main\trequested_base_source=default\trequested_base_resolved=false\teffective_base_ref=master\t' "${fallback_output}" "review should expose fallback-to-master per repo"
assert_contains $'base_source=fallback_master\tbase_resolution=fallback_master\tbase_note=Requested default main is unavailable here; fell back to local master.\t' "${fallback_output}" "review should mark the fallback source and note explicitly"
assert_contains 'message=Requested default main is unavailable here; fell back to local master. No committed delta vs master.' "${fallback_output}" "review should explain fallback-to-master in the repo message"

fallback_human_output="$(
  cd "${root_repo}" \
    && git_snapshot_test_cmd review --repo modules/sub1 --repo modules/sub1/modules/sub2 --base main
)"
assert_contains "Repo: modules/sub1/modules/sub2 | branch: (detached) | base: master (fell back from default main) | dirty: false | files: 0 | lines: +0/-0 | Requested default main is unavailable here; fell back to local master. No committed delta vs master." "${fallback_human_output}" "human review output should make fallback-to-master explicit in the base field"

git -C "${root_repo}/modules/sub1" tag -f review-base-tag >/dev/null
override_output="$(
  cd "${root_repo}" \
    && git_snapshot_test_cmd review --repo modules/sub1 --base main --repo-base modules/sub1 review-base-tag --porcelain
)"
assert_contains $'review_target\tdefault_base_ref=main\tselected_repos=1\trepos_resolved=1\trepos_failed=0\trepos_fallback_to_master=0\tcontract_version=1' "${override_output}" "review should keep the configured default base in target output when overrides are present"
assert_contains $'review_repo\trepo=modules/sub1\t' "${override_output}" "review should include the overridden repo"
assert_contains $'requested_base_ref=review-base-tag\trequested_base_source=override\trequested_base_resolved=true\teffective_base_ref=review-base-tag\t' "${override_output}" "review should honor per-repo tag overrides"
assert_contains $'base_source=override\tbase_resolution=resolved\t' "${override_output}" "review should mark override bases explicitly"

missing_override_output="$(
  cd "${root_repo}" \
    && git_snapshot_test_cmd review --repo modules/sub1/modules/sub2 --base main --repo-base modules/sub1/modules/sub2 does-not-exist --porcelain
)"
assert_contains $'requested_base_ref=does-not-exist\trequested_base_source=override\trequested_base_resolved=false\teffective_base_ref=master\t' "${missing_override_output}" "review should fall back from missing overrides to master when available"
assert_contains $'base_source=fallback_master\tbase_resolution=fallback_master\tbase_note=Requested override does-not-exist is unavailable here; fell back to local master.\t' "${missing_override_output}" "review should surface fallback source for missing overrides"

set +e
missing_repo_output="$(cd "${root_repo}" && git_snapshot_test_cmd review 2>&1)"
missing_repo_code=$?
set -e
assert_exit_code 1 "${missing_repo_code}" "review should require at least one --repo in CLI mode"
assert_contains "review requires at least one --repo in CLI mode." "${missing_repo_output}" "review should explain missing repo selection in CLI mode"

set +e
missing_override_repo_output="$(cd "${root_repo}" && git_snapshot_test_cmd review --repo modules/sub1 --repo-base modules/sub1/modules/sub2 master 2>&1)"
missing_override_repo_code=$?
set -e
assert_exit_code 1 "${missing_override_repo_code}" "review should reject repo overrides for repos outside the selected set"
assert_contains "--repo-base requires the repo to also be selected with --repo: modules/sub1/modules/sub2" "${missing_override_repo_output}" "review should explain invalid repo-base usage"
