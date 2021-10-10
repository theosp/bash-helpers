#!/usr/bin/env bash

RATE_LIMITER_SLEEP_TIME="${RATE_LIMITER_SLEEP_TIME:-"10"}"

rateLimitter () {
    >&2 echo "[RATE LIMITTER] sleep ${RATE_LIMITER_SLEEP_TIME}"
    
    sleep "$RATE_LIMITER_SLEEP_TIME"
}