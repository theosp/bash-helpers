#!/bin/bash

getFileModifiedDate () {
    date -r "$1" +%s
}

