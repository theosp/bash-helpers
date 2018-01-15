#!/bin/bash

getPackageFullName () {
  local package_path="$1"

  cat "$package_path" | grep -m 1 name | sed -e $'s/\s\+name:\s*["\']\(.\+\)["\'].*/\\1/g'
}