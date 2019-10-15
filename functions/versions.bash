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
