#!/usr/bin/env bash

announceStep () {
    echo
    echo "$(style.info)> $@ $(style.reset)"
    echo
}

announceMainStep () {
    echo
    echo "$(style.importantInfo)>>> $@ $(style.reset)"
    echo
}

announceError () {
    echo
    echo "$(style.error)> Error:$(style.reset) $(style.fcolor 7)$@$(style.reset)"
    echo
}

announceErrorAndExit () {
    announceError $@

    exit 1
}
