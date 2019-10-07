#!/usr/bin/env bash

dockerRemoveUntaggedImages () {
    docker images -q --filter "dangling=true" | platformXargs -n1 -r docker rmi
}

dockerQuietStopRemove () {
    local container="$1"

    docker stop "$container" &> /dev/null
    docker rm "$container" &> /dev/null   
}

isDockerRunning () {
    docker ps &> /dev/null
}

dockerAvailableMemory () {
    local available_mem

    if ! available_mem="$(docker info 2> /dev/null | grep Mem )"; then
        >&2 echo "Error: Couldn't determine Docker Available Memory, check whether Docker is running"

        return 1
    fi

    echo "$available_mem" | awk '{print $3}'
}

dockerAvailableGiBMemory () {
    local available_mem available_gib

    if ! available_mem="$(dockerAvailableMemory)"; then
        return 1
    fi

    if ! available_gib="$(echo "$available_mem" | grep "GiB")"; then
        >&2 echo "Error: the memory available for Docker ($available_mem) isn't supported"

        return 1
    fi

    available_gib="$(echo "$available_gib" | sed -e 's/GiB//g')"

    echo "$available_gib"
}

dockerRequireAvailableGiBMemory () {
    local required_gib="$1"

    local available_gib

    if ! available_gib="$(dockerAvailableGiBMemory)"; then
        return 1
    fi

    if [[ "$(echo "$available_gib < $required_gib" | bc)" == 1 ]]; then
        >&2 echo "Error: the memory available for Docker (${available_gib}GiB) doesn't meet the memory requirement (${required_gib}GiB)"

        return 1
    fi

    return 0
}