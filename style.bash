#!/bin/bash

# Based on the bupler lib

style.bold ()
{
    if ! $NO_COLOR; then
        tput bold
    fi

    return 0
}

style.fcolor ()
{
    if ! $NO_COLOR; then
        tput setaf "$1"
    fi

    return 0
}

style.bcolor ()
{
    if ! $NO_COLOR; then
        tput setab "$1"
    fi

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
    if ! $NO_COLOR; then
        tput sgr0
    fi
}

# vim:ft=bash: