#!/usr/bin/env bash


ensureCoffeescriptExists () {
  if ! commandExists coffee; then
    announceStep "Ensuring coffeescript exists"
    npm install --global coffeescript
  fi
}