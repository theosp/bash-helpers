#!/usr/bin/env bash

dockerRemoveUntaggedImages () {
    docker images -q --filter "dangling=true" | platformXargs -n1 -r docker rmi
}

dockerQuietStopRemove () {
    local container="$1"

    docker stop "$container" &> /dev/null
    docker rm "$container" &> /dev/null   
}
