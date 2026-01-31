#!/usr/bin/env bash

# Based on the bupler lib

# Helper: returns 0 (true) if color output is enabled
style._colorEnabled ()
{
    [[ "${NO_COLOR:-}" != "1" && "${NO_COLOR:-}" != "true" ]]
}

style.bold ()
{
    style._colorEnabled && tput bold
    return 0
}

style.fcolor ()
{
    style._colorEnabled && tput setaf "$1"
    return 0
}

style.bcolor ()
{
    style._colorEnabled && tput setab "$1"
    return 0
}

style.error ()
{
    style.fcolor 1
}

style.info ()
{
    style.fcolor 2
}

style.importantInfo ()
{
    style.fcolor 5
}

style.reset ()
{
    style._colorEnabled && tput sgr0
}

# vim:ft=bash:
