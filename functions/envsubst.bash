#!/usr/bin/env bash

inplaceEnvsubst () {
    # inplaceEnvsubst(source_file[, vars_to_replace])
    #
    # vars_to_replace, if defined, should be in the form '$VAR1 $VAR2...', if empty all
    # the vars will be substituted.
    local source_file="$1"
    local vars_to_replace="$2"

    envsubst "$vars_to_replace" < $source_file > "${source_file}-output"
    mv "${source_file}-output" "$source_file"
}

cpEnvsubst () {
    # inplaceEnvsubst(source_file, destination_file[, vars_to_replace])
    #
    # vars_to_replace, if defined, should be in the form '$VAR1 $VAR2...', if empty all
    # the vars will be substituted.
    local source_file="$1"
    local destination_file="$2"
    local vars_to_replace="$3"

    cp "$source_file" "$destination_file"
    inplaceEnvsubst "$destination_file" "$vars_to_replace"
}

recursiveEnvsubst () {
    # recursiveEnvsubst(source_dir, destination_dir[, vars_to_replace])
    #
    # vars_to_replace, if defined, should be in the form '$VAR1 $VAR2...', if empty all
    # the vars will be substituted.
    local source_dir="$1"
    local destination_dir="$2"
    local vars_to_replace="$3"

    if [ -e "$destination_dir" ]; then
        announceErrorAndExit "recursiveEnvsubst Error: \$destination_dir $destination_dir already exist"
    fi

    cp -r "$source_dir" "$destination_dir"


    template_filler_command='envsubst '
    if [ -n "$vars_to_replace" ]; then
        template_filler_command+="'"$vars_to_replace"' "
    fi
    template_filler_command+='< % > %-output; mv %-output %'

    find "$destination_dir" -type f -print0 | platformXargs -0 -I % /bin/bash -c "$template_filler_command"
}
