#!/usr/bin/env bash

gitCheckoutMasterRec () {
    rep_path="$1"
    reset_to_origin_origin_master="$2"

    announceMainStep "Checkout master of ${rep_path}"

    pushd .

    cd "$rep_path"

    git checkout master

    if [[ "$reset_to_origin_origin_master" == "true" ]]; then
        git fetch

        git reset --hard origin/master
    fi

    git submodule update --init --recursive

    if [[ -d modules ]]; then
        cd modules
        for submodule in "justdo-shared-pacakges" "justdo-internal-pacakges" "justdo.gridctrl"; do
            if [[ -e "$submodule" ]]; then
                announceStep "Checkout submodule "$submodule" master of ${rep_path}"

                pushd .

                cd "$submodule"

                git checkout master

                if [[ "$reset_to_origin_origin_master" == "true" ]]; then
                    git fetch

                    git reset --hard origin/master
                fi

                popd
            fi
        done
    fi

    popd
}

getCurrentGitBranch () {
    git branch | grep '*' | awk '{print $2}'
}

getLastFileModification () {
    git log -1 --format="%ai" "$1"
}

isCleanGitRep () {
    [ -z "$(git status --porcelain)" ]
}

getContributersEmailsByCommitsCount () {
    git log | grep 'Author:' | sed -e 's/Author: .*<\(.*\)>/\1/' | sort | uniq -c | sort -r
}