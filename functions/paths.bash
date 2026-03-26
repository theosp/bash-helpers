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

isRelativePath () {
    local path="$1"

    if [[ -n "$(csvIntersection "${path:0:1}" "~,/")"  ]]; then
        return 1 # Not relative
    fi

    return 0 # Relative
}
