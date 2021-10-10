#!/usr/bin/env bash

HEADLESS_CHROME_COMMAND="${HEADLESS_CHROME_COMMAND:-"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"}"
CHROME_USER_AGENT="${CHROME_USER_AGENT:-"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/94.0.4606.71 Safari/537.36"}"

headlessChrome () {
    local url="$1"

    # "--crash-dumps-dir=/tmp" -> https://stackoverflow.com/questions/49103799/running-chrome-in-headless-mode
    "$HEADLESS_CHROME_COMMAND" "--headless" "--incognito" "--disable-gpu" "--crash-dumps-dir=/tmp" "--dump-dom" "--user-agent=$CHROME_USER_AGENT" "$url"
}
