#!/usr/bin/env bash

# Usage: strReplace "original string" "search pattern" "replacement text"
strReplace() {
  local input_string="$1"
  local search_pattern="$2"
  local replacement="$3"

  # In bash any unquoted instances of ‘&’ in string are replaced with the matching portion of pattern
  # https://www.gnu.org/software/bash/manual/html_node/Shell-Parameter-Expansion.html | https://archive.is/wip/3NXye
  # Hence, we escape it.
  local prepared_replacement
  prepared_replacement="${replacement//&/\\&}"

  echo "${input_string//$search_pattern/$prepared_replacement}"
}