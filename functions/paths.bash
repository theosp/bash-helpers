#!/bin/bash

expandPath () {
    platformReadlink -f "$@"
}

isRelativePath () {
    local path="$1"

    if [[ -n "$(csvIntersection "${path:0:1}" "~,/")"  ]]; then
        return 1 # Not relative
    fi

    return 0 # Relative
}
