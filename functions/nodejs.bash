#!/usr/bin/env bash

ensureNvmExists () {
  # Check if nvm is installed and install it if not
  # Since nvm is a shell script instead of an executable, it's normal if a user has nvm installed in zsh and see this message (since the script is running in bash)
  # Run "which nvm" to see the how it's done
  if ! commandExists nvm; then
      announceStep "Ensuring nvm exists"
      curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash 
      
      export NVM_DIR="$HOME/.nvm"
      [ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"  # This loads nvm
      [ -s "$NVM_DIR/bash_completion" ] && \. "$NVM_DIR/bash_completion"  # This loads nvm bash_completion
  fi
}

requireNodeJsVersion () {
  ensureNvmExists

  # Install & use the required NodeJS version
  node_version="$(node -v)"
  required_node_version="$1"
  if isVersionHigher "$node_version" "$required_node_version"; then
      announceStep "This script require node version $required_node_version or higher. You have $node_version."
      announceStep "Attempting to switch to $required_node_version..."
      nvm use "$required_node_version"
      if [[ "$?" != 0 ]]; then
          announceStep "Failed to switch to $required_node_version. Attempting to install..."
          nvm install "$required_node_version"
      fi
  fi
}