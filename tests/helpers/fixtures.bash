#!/usr/bin/env bash

set -euo pipefail

TEST_HELPERS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
BASH_HELPERS_ROOT="$(cd "${TEST_HELPERS_DIR}/../.." && pwd -P)"
GIT_SNAPSHOT_BIN="${BASH_HELPERS_ROOT}/bin/git-snapshot"
GIT_SNAPSHOT_TEST_HOST_NVM_DIR="${NVM_DIR:-${HOME}/.nvm}"

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
  NVM_DIR="${NVM_DIR:-${GIT_SNAPSHOT_TEST_HOST_NVM_DIR}}" \
  GIT_SNAPSHOT_ENFORCE_ROOT_PREFIX="${GIT_SNAPSHOT_ENFORCE_ROOT_PREFIX}" \
  "${GIT_SNAPSHOT_BIN}" "$@"
}

git_snapshot_test_find_available_locale() {
  local available="$1"
  shift

  local candidate
  for candidate in "$@"; do
    [[ -z "${candidate}" ]] && continue
    if printf "%s\n" "${available}" | grep -Fx "${candidate}" >/dev/null 2>&1; then
      printf "%s\n" "${candidate}"
      return 0
    fi
  done
  return 1
}

git_snapshot_test_hostile_collate_locale() {
  if [[ -n "${GIT_SNAPSHOT_TEST_HOSTILE_COLLATE_LOCALE:-}" ]]; then
    printf "%s\n" "${GIT_SNAPSHOT_TEST_HOSTILE_COLLATE_LOCALE}"
    return 0
  fi

  local available fallback
  available="$(locale -a 2>/dev/null || true)"
  GIT_SNAPSHOT_TEST_HOSTILE_COLLATE_LOCALE="$(
    git_snapshot_test_find_available_locale "${available}" \
      "en_GB.UTF-8" \
      "en_GB.utf8" \
      "en_GB.utf-8" \
      "en_US.UTF-8" \
      "en_US.utf8" \
      "en_US.utf-8" \
      "nl_NL.UTF-8" \
      "sv_SE.UTF-8" \
      "de_DE.UTF-8" \
      || true
  )"
  if [[ -z "${GIT_SNAPSHOT_TEST_HOSTILE_COLLATE_LOCALE}" ]]; then
    fallback="$(printf "%s\n" "${available}" | awk 'BEGIN { IGNORECASE = 1 } $0 !~ /^(C|POSIX)(\.|$)/ && $0 ~ /(UTF-8|UTF8)/ { print; exit }')"
    GIT_SNAPSHOT_TEST_HOSTILE_COLLATE_LOCALE="${fallback}"
  fi
  if [[ -z "${GIT_SNAPSHOT_TEST_HOSTILE_COLLATE_LOCALE}" ]]; then
    fail "Expected at least one non-C locale for compare locale regression tests."
  fi
  printf "%s\n" "${GIT_SNAPSHOT_TEST_HOSTILE_COLLATE_LOCALE}"
}

git_snapshot_test_hostile_ctype_locale() {
  if [[ -n "${GIT_SNAPSHOT_TEST_HOSTILE_CTYPE_LOCALE:-}" ]]; then
    printf "%s\n" "${GIT_SNAPSHOT_TEST_HOSTILE_CTYPE_LOCALE}"
    return 0
  fi

  local available preferred
  available="$(locale -a 2>/dev/null || true)"
  preferred="$(
    git_snapshot_test_find_available_locale "${available}" \
      "he_IL.UTF-8" \
      "he_IL.utf8" \
      "he_IL.utf-8" \
      "fa_IR.UTF-8" \
      "fa_IR.utf8" \
      "fa_IR.utf-8" \
      "en_US.UTF-8" \
      "en_US.utf8" \
      "en_US.utf-8" \
      || true
  )"
  if [[ -z "${preferred}" ]]; then
    preferred="$(git_snapshot_test_hostile_collate_locale)"
  fi
  GIT_SNAPSHOT_TEST_HOSTILE_CTYPE_LOCALE="${preferred}"
  printf "%s\n" "${GIT_SNAPSHOT_TEST_HOSTILE_CTYPE_LOCALE}"
}

git_snapshot_test_cmd_hostile_locale() {
  if [[ -z "${GIT_SNAPSHOT_ENFORCE_ROOT_PREFIX:-}" ]]; then
    printf "test helper misuse: missing GIT_SNAPSHOT_ENFORCE_ROOT_PREFIX\n" >&2
    return 1
  fi

  local collate_locale ctype_locale
  collate_locale="$(git_snapshot_test_hostile_collate_locale)"
  ctype_locale="$(git_snapshot_test_hostile_ctype_locale)"

  env -u LC_ALL \
    HOME="${TEST_HOME}" \
    NVM_DIR="${NVM_DIR:-${GIT_SNAPSHOT_TEST_HOST_NVM_DIR}}" \
    GIT_SNAPSHOT_ENFORCE_ROOT_PREFIX="${GIT_SNAPSHOT_ENFORCE_ROOT_PREFIX}" \
    LANG="${collate_locale}" \
    LC_COLLATE="${collate_locale}" \
    LC_CTYPE="${ctype_locale}" \
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

git_snapshot_test_extract_porcelain_field() {
  local output="$1"
  local row_kind="$2"
  local field_name="$3"

  printf "%s\n" "${output}" | awk -F'\t' -v row="${row_kind}" -v key="${field_name}" '
    $1 == row {
      for (i = 1; i <= NF; i++) {
        if ($i ~ ("^" key "=")) {
          sub("^" key "=", "", $i)
          print $i
          exit
        }
      }
    }
  '
}

git_snapshot_test_normalize_compare_porcelain() {
  local output="$1"

  printf "%s\n" "${output}" | sed -E \
    -e 's/current_root=[^\t]+/current_root=NORMALIZED/' \
    -e 's/elapsed_ms=[0-9]+/elapsed_ms=NORMALIZED/' \
    -e 's/cache_hit_repos=[0-9]+/cache_hit_repos=NORMALIZED/' \
    -e 's/cache_miss_repos=[0-9]+/cache_miss_repos=NORMALIZED/'
}

git_snapshot_test_snapshot_root_for_repo() {
  local root_repo="$1"
  printf "%s/git-snapshots/%s\n" "${TEST_HOME}" "$(basename "${root_repo}")"
}

git_snapshot_test_collect_dirty_relative_paths() {
  local root_repo="$1"
  local rel_path repo_abs

  {
    printf ".\n"
    git -C "${root_repo}" submodule --quiet foreach --recursive 'printf "%s\n" "$displaypath"'
  } | while IFS= read -r rel_path; do
    [[ -z "${rel_path}" ]] && continue
    repo_abs="${root_repo}/${rel_path}"
    if [[ ! -d "${repo_abs}" ]]; then
      continue
    fi
    if [[ -n "$(git -C "${repo_abs}" status --porcelain 2>/dev/null || true)" ]]; then
      printf "%s\n" "${rel_path}"
    fi
  done
}
