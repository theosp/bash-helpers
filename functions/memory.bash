#!/usr/bin/env bash

getPhysicalMemoryBytes () {
    UNAME=$(uname)

    if [[ "$UNAME" == "Darwin" ]]; then
        sysctl hw.memsize | awk '{print $2}'

        return 0
    elif [[ "$UNAME" == "Linux" ]]; then
        if [[ $(grep MemTotal /proc/meminfo | awk '{print $3}') != "kB" ]]; then
            # To the best of my knowledge, we should always expect kB, if we'll find
            # out it isn't the case we'll adjust this code.
            echo "WARNING: Couldn't determine memory size from /proc/meminfo"

            return 1
        fi

        echo $(( $(grep MemTotal /proc/meminfo | awk '{print $2}') * 1000 ))

        return 0
    fi

    echo 0

    return 1
}

getPhysicalMemoryMegabytes () {
    echo $(( "$(getPhysicalMemoryBytes)" / (1000 * 1000) ))
}