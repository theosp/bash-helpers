#!/usr/bin/env bash

getPackageFullName () {
    local package_path="$1"

    cat "$package_path" | grep -m 1 name | platformSed -e $'s/\s\+"\\?name"\\?:\s*["\']\(.\+\)["\'].*/\\1/g'
}

meteor-x86_64 () {
    NODE_TLS_REJECT_UNAUTHORIZED="0" arch -x86_64 meteor "$@"
}

getMeteorEnvTypeFromFilePath() {
    # Returns "server", "client", or "both" based on the path
    # In Meteor, if a file is under the "server" directory, it is a server file
    # If it is under the "client" directory, it is a client file
    local dir="$1"
    while true; do
        local base="$(basename "$dir")"
        if [[ "$base" == "server" ]]; then
            echo "server"
            return
        elif [[ "$base" == "client" ]]; then
            echo "client"
            return
        fi
        dir="$(dirname "$dir")"
        if [[ "$dir" == "/" || "$dir" == "." || "$dir" == "" ]]; then
            break
        fi
    done
    echo "both"
}
