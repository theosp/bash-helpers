#!/usr/bin/env bash

fail() {
  printf "ASSERTION FAILED: %s\n" "$*" >&2
  exit 1
}

assert_eq() {
  local expected="$1"
  local actual="$2"
  local msg="${3:-}"
  if [[ "${expected}" != "${actual}" ]]; then
    fail "Expected '${expected}', got '${actual}'. ${msg}"
  fi
}

assert_ne() {
  local left="$1"
  local right="$2"
  local msg="${3:-}"
  if [[ "${left}" == "${right}" ]]; then
    fail "Expected values to differ but both are '${left}'. ${msg}"
  fi
}

assert_contains() {
  local needle="$1"
  local haystack="$2"
  local msg="${3:-}"
  if [[ "${haystack}" != *"${needle}"* ]]; then
    fail "Expected output to contain '${needle}'. ${msg}. Output: ${haystack}"
  fi
}

assert_not_contains() {
  local needle="$1"
  local haystack="$2"
  local msg="${3:-}"
  if [[ "${haystack}" == *"${needle}"* ]]; then
    fail "Expected output not to contain '${needle}'. ${msg}. Output: ${haystack}"
  fi
}

assert_file_exists() {
  local path="$1"
  local msg="${2:-}"
  [[ -e "${path}" ]] || fail "Expected file to exist: ${path}. ${msg}"
}

assert_file_not_exists() {
  local path="$1"
  local msg="${2:-}"
  [[ ! -e "${path}" ]] || fail "Expected file not to exist: ${path}. ${msg}"
}

assert_non_empty() {
  local value="$1"
  local msg="${2:-}"
  [[ -n "${value}" ]] || fail "Expected non-empty value. ${msg}"
}

assert_exit_code() {
  local expected="$1"
  local actual="$2"
  local msg="${3:-}"
  if [[ "${expected}" -ne "${actual}" ]]; then
    fail "Expected exit code ${expected}, got ${actual}. ${msg}"
  fi
}
