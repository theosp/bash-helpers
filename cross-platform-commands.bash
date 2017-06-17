#!/bin/bash

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
