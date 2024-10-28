#!/usr/bin/env bash

# Ensure we have associative arrays support in the current shell
if declare -A ___assoc 2>/dev/null; then
    USE_CACHE="${USE_CACHE:-"true"}"
    CACHE_DIR_PATH="${CACHE_DIR_PATH:-"cache"}"
    
    declare -A CACHE_MANAGER_RETURN_CODES
    CACHE_MANAGER_RETURN_CODES=( ["EXISTS"]=0 ["DISABLED"]=1 ["NOT_FOUND_OR_EXPIRED"]=2 )
    
    cacheManager () {
        # cacheManager(timeout_seconds, key)
        #
        # cacheManager uses hashes key, checks whether a file exists in the cache
        # folder $CACHE_DIR_PATH named after that hash and whether its created
        # date is no later than timeout_seconds ago.
        #
        # If such file exists, output its path and returns: $CACHE_MANAGER_RETURN_CODES["EXISTS"].
        # Otherwise output the path to which content to be cached should
        # be stored and returns $CACHE_MANAGER_RETURN_CODES["NOT_FOUND_OR_EXPIRED"].
        # If $USE_CACHE is set to any value other than "true" will always
        # return $CACHE_MANAGER_RETURN_CODES["DISABLED"] and no output.
        #
        # Cache clearing:
        # 
        # The cache clear files in the following cases:
        #
        # * If a file exists for key, but is expired for the desired timeout_seconds
        # cacheManager will remove that file before returning cache path.
        #
        # Cache index:
        #
        # As long as cache is not disabled, for every request made to it, a record will be
        # added to a file named 000-INDEX in the format $hash\t$key (a record won't be added
        # more than once) .
        #
        # Note, since it is up to the program that called cacheManager to actually create
        # the file, a file might be logged to the index but not exist (if for example, the
        # calling program failed to create it).
        #
        # Arguments:
        #
        # timeout_seconds: timeout in seconds.
        # key: completly arbitrary string (can have spaces/tabs, any language chars...)
        #
        # Return codes:
        #
        # 0 cache file retrived and outputted.
        # 1 caching disabled
        # 2 cache file isn't available (either not exists or expired), 
        # target path to store value to outputted.
    
        local timeout_seconds="$1"
        local key="$2"
    
        if [[ "$USE_CACHE" != "true" ]]; then
            return "${CACHE_MANAGER_RETURN_CODES["DISABLED"]}"
        fi
    
        if which shasum &> /dev/null; then
            local cachefile_name=$(echo "$key" | shasum -a 256 | awk '{print $1}')
        else
            local cachefile_name=$(echo "$key" | sha256sum | awk '{print $1}')
        fi
    
        local cachefile_path="$CACHE_DIR_PATH/$cachefile_name"
    
        # Output file path
        echo "$cachefile_path"
    
        if [[ ! -e "$cachefile_path" ]]; then
            local index_file_path="$CACHE_DIR_PATH/000-INDEX"
    
            if [[ ! -e "$index_file_path" ]]; then
                # If no index file, likely that we don't have cache dir either
                mkdir -p "$CACHE_DIR_PATH"
            fi
    
            # When we don't find the file, we assume we never created it,
            # add a line to $index_file_path
            echo "${key}"$'\t'"${cachefile_path}" >> "$index_file_path"
    
            return "${CACHE_MANAGER_RETURN_CODES["NOT_FOUND_OR_EXPIRED"]}"
        fi
    
        if (( "$(getCurrentTimestamp)" - "$(getFileModifiedDate $cachefile_path)" >= $timeout_seconds )); then
            rm $cachefile_path
    
            # Note that if expired, we assume a record was added already to
            # $index_file_path
    
            return "${CACHE_MANAGER_RETURN_CODES["NOT_FOUND_OR_EXPIRED"]}"
        fi
    
        return "${CACHE_MANAGER_RETURN_CODES["EXISTS"]}"
    }
else
    if [[ "$SUPPRESS_MISSING_FEATURES_ERRORS" != "true" ]]; then
        echo "cache.bash: declare -A not available, skipping."
    fi
fi
