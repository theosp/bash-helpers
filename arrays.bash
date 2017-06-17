inArray () {
    # inArray(array_name, needle)
    local -n arr="$1"
    local needle="$2"

    local item
    for item in "${arr[@]}"; do
        [[ "$item" == "$needle" ]] && return 0
    done

    return 1
}

join () {
    # join(separator, i1, i2, i3...)
    local separator="$1"
    shift

    local string="$( printf "%s" "${@/#/$separator}" )"
    string="${string:${#separator}}" # remove leading separator
    echo "${string}"
}