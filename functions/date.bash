#!/usr/bin/env bash

getUnicodeDateTime () {
    date +%Y-%m-%d--%H:%M
}

getUnicodeDateTimeNoColon () {
    date +%Y-%m-%d--%H%M
}

getCurrentTimestamp () {
    date +%s
}
