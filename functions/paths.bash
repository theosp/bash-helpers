#!/usr/bin/env bash

expandPath () {
    platformReadlink -f "$@"
}

expandUserPath () {
    local path="${1:-}"

    if [[ "$path" == "~/"* ]]; then
        printf "%s/%s\n" "$HOME" "${path#"~/"}"
    elif [[ "$path" == "~" ]]; then
        printf "%s\n" "$HOME"
    else
        printf "%s\n" "$path"
    fi
}

_resolvePathAgainstPhysicalBaseDir () {
    local requested_path="${1:-}"
    local base_dir="${2:-}"
    local resolved_path=""
    local resolved_base_dir=""
    local parent_path=""
    local resolved_parent_path=""
    local requested_basename=""

    requested_path="$(expandUserPath "$requested_path")"
    [[ -n "$requested_path" ]] || return 1

    base_dir="$(expandUserPath "$base_dir")"
    [[ -n "$base_dir" ]] || return 1

    if isRelativePath "$base_dir"; then
        base_dir="$(pwd -P)/$base_dir"
    fi

    resolved_base_dir="$(expandPath "$base_dir" 2>/dev/null || true)"
    [[ -n "$resolved_base_dir" ]] || return 1

    if isRelativePath "$requested_path"; then
        if [[ "$resolved_base_dir" == "/" ]]; then
            requested_path="/$requested_path"
        else
            requested_path="$resolved_base_dir/$requested_path"
        fi
    fi

    resolved_path="$(expandPath "$requested_path" 2>/dev/null || true)"
    if [[ -n "$resolved_path" ]]; then
        printf "%s\n" "$resolved_path"
        return 0
    fi

    if [[ "$requested_path" == "/" ]]; then
        printf "/\n"
        return 0
    fi

    parent_path="$(dirname "$requested_path")"
    requested_basename="$(basename "$requested_path")"
    resolved_parent_path="$(_resolvePathAgainstPhysicalBaseDir "$parent_path" "$resolved_base_dir")" || return 1

    if [[ "$resolved_parent_path" == "/" ]]; then
        printf "/%s\n" "$requested_basename"
    else
        printf "%s/%s\n" "$resolved_parent_path" "$requested_basename"
    fi
}

resolvePathAgainstPhysicalBaseDir () {
    _resolvePathAgainstPhysicalBaseDir "$@"
}

pathIsWithinRoot () {
    # pathIsWithinRoot(candidate_path, root_path, [base_dir])
    #
    # Returns success when candidate_path resolves to root_path itself or one of
    # its descendants.
    #
    # Both paths may be absolute, relative, or use ~. Relative inputs are
    # resolved from the physical (non-symlink) working directory by default, or
    # from the optional base_dir when one is provided. Non-existent leaf paths
    # are still compared safely by resolving the deepest existing parent first.
    # Existing file roots match only themselves, not synthetic child paths.
    local candidate_path="${1:-}"
    local root_path="${2:-}"
    local base_dir="${3:-$(pwd -P)}"
    local resolved_candidate_path=""
    local resolved_root_path=""

    [[ -n "$candidate_path" ]] || return 1
    [[ -n "$root_path" ]] || return 1

    resolved_candidate_path="$(resolvePathAgainstPhysicalBaseDir "$candidate_path" "$base_dir")" || return 1
    resolved_root_path="$(resolvePathAgainstPhysicalBaseDir "$root_path" "$base_dir")" || return 1

    [[ "$resolved_candidate_path" == "$resolved_root_path" ]] && return 0

    if [[ -e "$resolved_root_path" && ! -d "$resolved_root_path" ]]; then
        return 1
    fi

    [[ "$resolved_candidate_path" == "$resolved_root_path"/* ]]
}

pathBasenameHasDelimitedToken () {
    # pathBasenameHasDelimitedToken(path, token)
    #
    # Returns success when the basename of path contains token as a whole
    # hyphen/underscore-delimited component. This matches names like:
    #   build
    #   build-cache
    #   cache-build
    #   cache_build_tmp
    # and intentionally rejects partial-word matches like:
    #   rebuild
    #   building
    local path="${1:-}"
    local token="${2:-}"
    local basename

    [[ -n "$token" ]] || return 1

    basename="$(basename "$path")"

    case "$basename" in
        "$token"|"$token"-*|*-"$token"|*-"$token"-*|"$token"_*|*_"$token"|*_"$token"_*)
            return 0
            ;;
    esac

    return 1
}

pathBasenameHasAnyDelimitedToken () {
    # pathBasenameHasAnyDelimitedToken(path, token1, token2, ...)
    #
    # Returns success as soon as any provided token matches according to
    # pathBasenameHasDelimitedToken().
    local path="$1"
    shift || true
    local token

    for token in "$@"; do
        if pathBasenameHasDelimitedToken "$path" "$token"; then
            return 0
        fi
    done

    return 1
}

isRelativePath () {
    local path="$1"

    if [[ -n "$(csvIntersection "${path:0:1}" "~,/")"  ]]; then
        return 1 # Not relative
    fi

    return 0 # Relative
}
