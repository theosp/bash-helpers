#!/usr/bin/env bash

set -euo pipefail

usage() {
  cat <<'USAGE'
Usage:
  link-into-repo.bash <consumer_repo_root> [--force]

Description:
  Creates or updates a symlink:
    <consumer_repo_root>/.cursor/skills/git-snapshot-workflow
  -> this shared skill directory.

Options:
  --force  Replace existing target (including broken symlink).
USAGE
}

FORCE=false
REPO_ROOT=""

for arg in "$@"; do
  case "$arg" in
    --force)
      FORCE=true
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      if [[ -n "$REPO_ROOT" ]]; then
        printf "[link-into-repo] ERROR: Multiple repo roots provided.\n" >&2
        usage
        exit 1
      fi
      REPO_ROOT="$arg"
      ;;
  esac
done

if [[ -z "$REPO_ROOT" ]]; then
  printf "[link-into-repo] ERROR: Missing consumer repo root.\n" >&2
  usage
  exit 1
fi

if [[ ! -d "$REPO_ROOT" ]]; then
  printf "[link-into-repo] ERROR: Repo root does not exist: %s\n" "$REPO_ROOT" >&2
  exit 1
fi

if ! git -C "$REPO_ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  printf "[link-into-repo] ERROR: Not a git repository: %s\n" "$REPO_ROOT" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
SKILL_DIR="$(cd "$SCRIPT_DIR/.." && pwd -P)"

if [[ ! -f "$SKILL_DIR/SKILL.md" ]]; then
  printf "[link-into-repo] ERROR: SKILL.md missing in skill directory: %s\n" "$SKILL_DIR" >&2
  exit 1
fi

CURSOR_SKILLS_DIR="$REPO_ROOT/.cursor/skills"
mkdir -p "$CURSOR_SKILLS_DIR"

LINK_PATH="$CURSOR_SKILLS_DIR/git-snapshot-workflow"

if [[ -L "$LINK_PATH" ]]; then
  CURRENT_TARGET="$(readlink "$LINK_PATH")"
  if [[ -e "$LINK_PATH" ]]; then
    if [[ "$FORCE" == "false" ]]; then
      printf "[link-into-repo] INFO: Link already exists: %s -> %s\n" "$LINK_PATH" "$CURRENT_TARGET"
      exit 0
    fi
    rm -f "$LINK_PATH"
  else
    if [[ "$FORCE" == "false" ]]; then
      printf "[link-into-repo] ERROR: Broken symlink exists at %s (target=%s). Re-run with --force to replace.\n" "$LINK_PATH" "$CURRENT_TARGET" >&2
      exit 1
    fi
    rm -f "$LINK_PATH"
  fi
elif [[ -e "$LINK_PATH" ]]; then
  if [[ "$FORCE" == "false" ]]; then
    printf "[link-into-repo] ERROR: Path already exists and is not a symlink: %s\n" "$LINK_PATH" >&2
    exit 1
  fi
  rm -rf "$LINK_PATH"
fi

if command -v python3 >/dev/null 2>&1; then
  REL_TARGET="$(python3 - "$SKILL_DIR" "$CURSOR_SKILLS_DIR" <<'PY'
import os, sys
src = os.path.realpath(sys.argv[1])
dst = os.path.realpath(sys.argv[2])
print(os.path.relpath(src, dst))
PY
)"
else
  REL_TARGET="$SKILL_DIR"
fi

ln -s "$REL_TARGET" "$LINK_PATH"

if [[ ! -f "$LINK_PATH/SKILL.md" ]]; then
  printf "[link-into-repo] ERROR: Created symlink but SKILL.md is not readable through link: %s\n" "$LINK_PATH" >&2
  exit 1
fi

printf "[link-into-repo] Linked %s -> %s\n" "$LINK_PATH" "$REL_TARGET"
