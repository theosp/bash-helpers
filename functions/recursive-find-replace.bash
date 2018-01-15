#!/bin/bash

#
# Update packages' package.js api
#
recursiveFindReplace () {
    # recursiveFindRepl-e ace (sed_command, space_separated_find_ops_and_paths, [find_expr_arg1, find_expr_arg2, ...])

    # Env var:
    #
    # TEST: can be either: "false" or "true", any other value will be regarded as "false".
    # if TEST is "true", we'll just print the list of file names that is going to be affected.

    # Example 1:
    #
    #   Replace subdomainA.example.com with subdomainB.example.com in paths: x/y x/z
    #
    #   recursiveFindReplace 's/subdomainA\.example\.com/subdomainB.example.com/g' "x/y x/z" -name "1" -or -name "2" 

    # Example 2:
    #
    #   Replace subdomainA.example.com with subdomainB.example.com in paths: x/y x/z
    #   follow sym links
    #
    #   recursiveFindReplace 's/subdomainA\.example\.com/subdomainB.example.com/g' "-L x/y x/z" -name "1" -or -name "2" 

    local sed_command="$1"
    local space_separated_find_ops_and_paths="$2"
    shift
    shift

    echo
    echo "Sed command (extended regex): $sed_command"
    echo
    if [[ "$TEST" == "true" ]]; then
        echo find $space_separated_find_ops_and_paths \( "$@" \) -type f

        find $space_separated_find_ops_and_paths \( "$@" \) -type f  -print0 | platformXargs -0 -n 1 echo
    else
        find $space_separated_find_ops_and_paths \( "$@" \) -type f  -print0 | platformXargs -0 sed -i -r -e "$sed_command"
    fi
}
