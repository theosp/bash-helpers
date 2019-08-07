#!/usr/bin/env bash

isBrewPackageInstalled () {
    brew ls --versions $1 &> /dev/null

    return $?
}
