#!/usr/bin/env bash

# The following commands makes sure that we are using the correct commands
# available on the platform we are running on.
#
# They assume the README-OSX.md was followed on OSX devices and required
# packages were installed.

platformReadlink () {
    # Prefer greadlink over readlink - installed by $ brew install coreutils

    local readlink="readlink"

    if commandExists greadlink; then
        readlink="greadlink"
    fi

    "$readlink" "$@"   
}

platformXargs () {
    # Prefer gxargs over xargs - installed by $ brew install findutils 

    local xargs="xargs"

    if commandExists gxargs; then
        xargs="gxargs"
    fi

    "$xargs" "$@"   
}

platformSed () {
    # Prefer gsed over sed - installed by $ brew install gnu-sed

    local sed="sed"

    if commandExists gsed; then
        sed="gsed"
    fi

    "$sed" "$@"   
}

platformTar () {
    # Prefer gtar over tar - installed by $ brew install gnu-tar

    local tar="tar"

    if commandExists gtar; then
        tar="gtar"
    fi

    "$tar" "$@"   
}

platformDu () {
    # Prefer gdu over du

    local du="du"

    if commandExists gcp; then
        du="gdu"
    fi

    "$du" "$@"
}

platformTr () {
    # Prefer gcp over cp

    local tr="tr"

    if commandExists gtr; then
        tr="gtr"
    fi

    "$tr" "$@"
}

platformCp () {
    # Prefer gcp over cp

    local cp="cp"

    if commandExists gcp; then
        cp="gcp"
    fi

    "$cp" "$@"
}

platformGrep () {
    # Prefer ggrep over grep

    local grep="grep"

    if commandExists ggrep; then
        grep="ggrep"
    fi

    "$grep" "$@"
}

platformStat () {
    # Prefer gstat over stat

    local stat="stat"

    if commandExists gstat; then
        stat="gstat"
    fi

    "$stat" "$@"
}

platformDd () {
    # Prefer gdd over dd

    local dd="dd"

    if commandExists gdd; then
        dd="gdd"
    fi

    "$dd" "$@"
}

platformFind () {
    # Prefer gfind over find

    local find="find"

    if commandExists gfind; then
        find="gfind"
    fi

    "$find" "$@"
}