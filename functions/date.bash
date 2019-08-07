#!/usr/bin/env bash

getCurrentYear () {
    date +%Y
}

getUnicodeDate () {
    date +%Y-%m-%d
}

getUnicodeDateTime () {
    date +%Y-%m-%d--%H:%M
}

getUnicodeDateTimeNoColon () {
    date +%Y-%m-%d--%H%M
}

getCurrentTimestamp () {
    date +%s
}
