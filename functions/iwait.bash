#!/usr/bin/env bash

# https://github.com/theosp/osp-dist/blob/master/sys-root/home/theosp/.bash/alias/iwait.sh

iwait () {
    # Usage example:
    #
    #   $ iwait file-name/dir-name ./command-to-execute arg1 arg2...

    # Usage example2, more than one command to execute:
    #
    #   $ iwait file-name/dir-name /bin/bash -c './command-to-execute-2 arg1 arg2...; ./command-to-execute-1 arg1 arg2...; ...'

    watched_paths="$(csvVals "$1")" # Note, if a folder provided symbolic links under it are not traversed.

    shift # All the other arguments are considered the command to execute

    announceStep ">>> iwait first run BEGIN"

    "${@}"

    announceStep ">>> iwait first run DONE"

    # We use while without -m to avoid exit inotifywait from exit/stop watchin
    # the file when move_self happens (this is the way vim saves files)
    #
    # By running the while this way, we re-initializing inotify after every
    # event, this way we know for sure that in cases like move_self based
    # save the new file will be watched in the next itteration.
    while inotifywait -e moved_from -e moved_to -e move_self -e close_write -r $watched_paths; do
        announceStep ">>> iwait action BEGIN"
        "${@}"
        announceStep ">>> iwait action DONE"

        # short sleep for case file was saved by moving temp file (in
        # which case it won't exist for few ms move_self case).
        sleep .1
    done
}
