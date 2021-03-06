#!/usr/bin/env bash

getPackageFullName () {
    local package_path="$1"

    cat "$package_path" | grep -m 1 name | platformSed -e $'s/\s\+"\\?name"\\?:\s*["\']\(.\+\)["\'].*/\\1/g'
}