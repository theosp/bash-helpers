#!/usr/bin/env bash

getFileModifiedDate () {
    date -r "$1" +%s
}

