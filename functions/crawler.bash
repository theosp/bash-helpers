#!/usr/bin/env bash

USE_CACHE="${USE_CACHE:-"true"}"
CACHE_TARGET="${CACHE_TARGET:-"cache/crawler"}"
CACHE_TIMEOUT_SECS="${CACHE_TIMEOUT_SECS:-$((60 * 60 * 24))}" # 24 hours
LYNX_USER_AGENT="${LYNX_USER_AGENT:-"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/92.0.4515.131 Safari/537.36"}"
USE_HEADLESS_CHROME="${USE_HEADLESS_CHROME:-"true"}"

crawlerGetPage () {
    local url="$1"

    local fetch_page_command
    if [[ "$USE_HEADLESS_CHROME" == "true" ]]; then
        fetch_page_command=(headlessChrome "$url")
        lynx_parser=(lynx -stdin -dump -hiddenlinks=listonly)
    else
        fetch_page_command=(lynx -useragent="$LYNX_USER_AGENT" -dump -hiddenlinks=listonly "$url")
    fi

    local content_cache_path # Can't init and assign on same line, otherwise $?
                             # will get the succesful init return value and not
                             # the subshell return code
    content_cache_path=$(cacheManager $CACHE_TIMEOUT_SECS "${fetch_page_command[*]}")
    local cache_return_code=$?

    if [[ "$cache_return_code" == "${CACHE_MANAGER_RETURN_CODES["EXISTS"]}" ]]; then
        # echo "Exists"

        cat "$content_cache_path"

        return 0
    fi

    local output

    if [[ "$USE_HEADLESS_CHROME" == "true" ]]; then
        output="$("${fetch_page_command[@]}")"
        output="$(echo "$output" | "${lynx_parser[@]}" | LC_CTYPE=C LANG=C sed "s/file:\/\//https:\/\/www.sec.gov/g") " # https://stackoverflow.com/questions/19242275/re-error-illegal-byte-sequence-on-mac-os-x
    else
        output="$("${fetch_page_command[@]}")"
    fi

    if [[ "$cache_return_code" == "${CACHE_MANAGER_RETURN_CODES["DISABLED"]}" ]]; then
        # echo "Cache is disabled"

        echo "$output"
    elif [[ "$cache_return_code" == "${CACHE_MANAGER_RETURN_CODES["NOT_FOUND_OR_EXPIRED"]}" ]]; then
        # echo "Not found or expired"

        cat > "$content_cache_path" <<< "$output"

        cat "$content_cache_path"
    fi

    rateLimitter
}

crawlerGetAllPageLinks () {
    local url="$1"

    cat <<< "$(crawlerGetPage "$url")" | platformSed -n '/References/,$p' | tail -n +3 | awk '{print $2}'
}
