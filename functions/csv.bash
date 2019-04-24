#!/usr/bin/env bash

csvVals () {
    # Print the values of the given csv string
    echo ${1//,/ }
}

csvIntersection () {
    # Prints the intersection of two csv strings provided as inputs

    # Assumptions:
    #   No way to escape a ,
    #   No sequence of "---" (3 dashes) in any value  

    local -a ar1=$(csvVals $1)
    local -a ar2=$(csvVals $2)

    # Join ar2 into a "---" separated string and wrap it with this string
    local l2
    local l2="---$(join "---" ${ar2[*]})---" # add framing blanks

    local -a result
    local item
    for item in ${ar1[@]}; do
        if [[ $l2 =~ "---$item---" ]] ; then # use $item as regexp
            result+=($item)
        fi
    done

    echo ${result[@]}
}
