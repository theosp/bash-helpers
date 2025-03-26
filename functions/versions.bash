#!/usr/bin/env bash

getVersionComponents () {
    local version="$1"

    version="$(echo "$version" | platformSed 's/^v//i')"

    version_parts=( ${version//./ } )

    echo "${version_parts[@]}"
}

isVersionHigher () {
    # Exits with 0 if version_1 < version_2
    local version_1="$1"
    local version_2="$2"

    v1_components=( $(getVersionComponents "$version_1") )
    v2_components=( $(getVersionComponents "$version_2") )

    if (( "${v1_components[0]}" > "${v2_components[0]}" )); then
        return 1
    fi

    if (( "${v1_components[0]}" < "${v2_components[0]}" )); then
        return 0
    fi

    if (( "${v1_components[1]}" > "${v2_components[1]}" )); then
        return 1
    fi

    if (( "${v1_components[1]}" < "${v2_components[1]}" )); then
        return 0
    fi

    if (( "${v1_components[2]}" > "${v2_components[2]}" )); then
        return 1
    fi

    if (( "${v1_components[2]}" < "${v2_components[2]}" )); then
        return 0
    fi

    return 1
}

# More comprehensive bash version check that allows specifying both major and minor version
# Usage: requireMinimumBashVersion 4 3  # Requires bash 4.3+
# Returns: 0 if requirements met, exits with error otherwise
requireMinimumBashVersion() {
  local required_major="$1"
  local required_minor="${2:-0}"  # Default to 0 if not specified
  local help_user="${3:-true}"    # Whether to provide help for upgrading
  
  local current_major="${BASH_VERSINFO[0]}"
  local current_minor="${BASH_VERSINFO[1]}"
  
  if ! (( ( current_major > required_major ) || 
         ( current_major == required_major && current_minor >= required_minor ) )); then
    
    echo "This script requires Bash $required_major.$required_minor or later"
    echo "Current version: $BASH_VERSION"
    
    if [[ "$help_user" == "true" ]]; then
      # Suggest appropriate command for the platform
      if [[ "$OSTYPE" == "darwin"* ]]; then
        echo "Try running with: /opt/homebrew/bin/bash $0 $@"
        echo "If not installed: brew install bash"
      else
        echo "Try running with: bash $0 $@"
        echo "If Bash $required_major.$required_minor+ is not your default, try:"
        echo "  apt-get install -y bash (Debian/Ubuntu)"
        echo "  dnf install -y bash (Fedora/RHEL)"
      fi
    fi
    
    exit 1
  fi
  
  return 0
}
