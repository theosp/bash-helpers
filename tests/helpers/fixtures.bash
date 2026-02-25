#!/usr/bin/env bash

set -euo pipefail

TEST_HELPERS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
BASH_HELPERS_ROOT="$(cd "${TEST_HELPERS_DIR}/../.." && pwd -P)"
GIT_SNAPSHOT_BIN="${BASH_HELPERS_ROOT}/bin/git-snapshot"

git_snapshot_test_setup_sandbox() {
  TEST_SANDBOX="$(mktemp -d "${TMPDIR:-/tmp}/git-snapshot-test.XXXXXX")"
  TEST_HOME="${TEST_SANDBOX}/home"
  TEST_REPOS_ROOT="${TEST_SANDBOX}/repos"

  mkdir -p "${TEST_HOME}" "${TEST_REPOS_ROOT}"

  export HOME="${TEST_HOME}"
  export GIT_SNAPSHOT_ENFORCE_ROOT_PREFIX="${TEST_REPOS_ROOT}"

  git config --global init.defaultBranch main >/dev/null 2>&1 || true
  git config --global protocol.file.allow always >/dev/null 2>&1 || true

  trap 'git_snapshot_test_cleanup_sandbox' EXIT
}

git_snapshot_test_cleanup_sandbox() {
  if [[ -n "${TEST_SANDBOX:-}" && -d "${TEST_SANDBOX}" ]]; then
    rm -rf "${TEST_SANDBOX}"
  fi
}

git_snapshot_test_cmd() {
  if [[ -z "${GIT_SNAPSHOT_ENFORCE_ROOT_PREFIX:-}" ]]; then
    printf "test helper misuse: missing GIT_SNAPSHOT_ENFORCE_ROOT_PREFIX\n" >&2
    return 1
  fi

  HOME="${TEST_HOME}" \
  GIT_SNAPSHOT_ENFORCE_ROOT_PREFIX="${GIT_SNAPSHOT_ENFORCE_ROOT_PREFIX}" \
  "${GIT_SNAPSHOT_BIN}" "$@"
}

git_snapshot_test_init_repo() {
  local repo_path="$1"

  mkdir -p "${repo_path}"
  git -C "${repo_path}" init >/dev/null
  git -C "${repo_path}" config user.email "tests@example.com"
  git -C "${repo_path}" config user.name "git-snapshot-tests"
  git -C "${repo_path}" config protocol.file.allow always
}

git_snapshot_test_commit_file() {
  local repo_path="$1"
  local rel_file="$2"
  local content="$3"
  local message="$4"

  mkdir -p "$(dirname "${repo_path}/${rel_file}")"
  printf "%s\n" "${content}" > "${repo_path}/${rel_file}"
  git -C "${repo_path}" add "${rel_file}"
  git -C "${repo_path}" commit -m "${message}" >/dev/null
}

git_snapshot_test_make_nested_fixture() {
  local root_repo="${TEST_REPOS_ROOT}/super"
  local sub1_repo="${TEST_REPOS_ROOT}/sub1"
  local sub2_repo="${TEST_REPOS_ROOT}/sub2"

  git_snapshot_test_init_repo "${sub2_repo}"
  git_snapshot_test_commit_file "${sub2_repo}" "sub2.txt" "sub2-base" "init sub2"

  git_snapshot_test_init_repo "${sub1_repo}"
  git_snapshot_test_commit_file "${sub1_repo}" "sub1.txt" "sub1-base" "init sub1"
  git -C "${sub1_repo}" -c protocol.file.allow=always submodule add "${sub2_repo}" "modules/sub2" >/dev/null
  git -C "${sub1_repo}" commit -am "add nested sub2" >/dev/null

  git_snapshot_test_init_repo "${root_repo}"
  git_snapshot_test_commit_file "${root_repo}" "root.txt" "root-base" "init root"
  git -C "${root_repo}" -c protocol.file.allow=always submodule add "${sub1_repo}" "modules/sub1" >/dev/null
  git -C "${root_repo}" commit -am "add sub1" >/dev/null
  git -C "${root_repo}" -c protocol.file.allow=always submodule update --init --recursive >/dev/null

  printf "%s\n" "$(cd "${root_repo}" && pwd -P)"
}

git_snapshot_test_get_snapshot_id_from_create_output() {
  local output="$1"
  printf "%s\n" "${output}" | tail -n 1
}

git_snapshot_test_snapshot_root_for_repo() {
  local root_repo="$1"
  printf "%s/git-snapshots/%s\n" "${TEST_HOME}" "$(basename "${root_repo}")"
}
