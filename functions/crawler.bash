#!/bin/bash

USE_CACHE="${USE_CACHE:-"true"}"
CACHE_TARGET="${CACHE_TARGET:-"cache/crawler"}"
CACHE_TIMEOUT_SECS="${CACHE_TIMEOUT_SECS:-$((60 * 60 * 24))}" # seconds

crawlerGetPage () {
    local url="$1"

    local lynx_command=(lynx -dump -hiddenlinks=listonly "$url")

    local content_cache_path # Can't init and assign on same line, otherwise $?
                             #will get the succesful init return value and not
                             # the subshell return code
    content_cache_path=$(cacheManager $CACHE_TIMEOUT_SECS "${lynx_command[*]}")
    local return_code=$?

    if [[ "$return_code" == "${CACHE_MANAGER_RETURN_CODES["DISABLED"]}" ]]; then
        # echo "Cache is disabled"

        "${lynx_command[@]}"
    elif [[ "$return_code" == "${CACHE_MANAGER_RETURN_CODES["NOT_FOUND_OR_EXPIRED"]}" ]]; then
        # echo "Not found or expired"

        local output=$("${lynx_command[@]}")

        cat > "$content_cache_path" <<< "$output"

        cat "$content_cache_path"
    elif [[ "$return_code" == "${CACHE_MANAGER_RETURN_CODES["EXISTS"]}" ]]; then
        # echo "Exists"

        cat "$content_cache_path"
    fi
}

crawlerGetAllPageLinks () {
    local url="$1"

    cat <<< "$(crawlerGetPage "$url")" | platformSed -n '/References/,$p' | tail -n +3 | awk '{print $2}'
}