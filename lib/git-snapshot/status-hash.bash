#!/usr/bin/env bash

_git_snapshot_status_hash_for_repo() {
  local repo_path="$1"
  local status

  status="$(git -C "${repo_path}" status --porcelain=v1 --untracked-files=all --ignored=no)"
  printf "%s" "${status}" | shasum -a 256 | awk '{print $1}'
}
