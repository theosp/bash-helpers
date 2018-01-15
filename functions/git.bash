gitCheckoutMasterRec () {
    rep_path="$1"

    announceMainStep "Checkout master of ${rep_path}"

    pushd .

    cd "$rep_path"

    git checkout master

    git submodule update --init --recursive

    if [[ -d modules ]]; then
        cd modules
        for submodule in "justdo-shared-pacakges" "justdo.gridctrl"; do
            if [[ -e "$submodule" ]]; then
                announceStep "Checkout submodule "$submodule" master of ${rep_path}"

                pushd .

                cd "$submodule"

                git checkout master

                popd
            fi
        done
    fi

    popd
}

getCurrentGitBranch () {
    git branch | grep '*' | awk '{print $2}'
}