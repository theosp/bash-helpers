#!/usr/bin/env bash

ensureNvmExistsAndLoaded () {
  # Check if nvm is installed and install it if not
  if ! commandExists nvm; then
      # Install if needed
      if [[ ! -f "$HOME/.nvm/nvm.sh" ]]; then
          announceStep "nvm is not installed. Attempting to install it..."
          curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
      fi

      # Load nvm (note happens not only when nvm is installed but also when it is already installed but not loaded)
      #
      # It is common that when running the script not inside an interactive shell, the nvm command will be installed
      # but not loaded.
      export NVM_DIR="$HOME/.nvm"
      [ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"  # This loads nvm
      [ -s "$NVM_DIR/bash_completion" ] && \. "$NVM_DIR/bash_completion"  # This loads nvm bash_completion
  fi
}

requireNodeJsVersion () {
  ensureNvmExistsAndLoaded

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

          if [[ "$?" == 0 ]]; then
              announceStep "Successfully installed $required_node_version. Switching to it..."
              nvm use "$required_node_version"
          else
              announceStep "Failed to install $required_node_version. Exiting..."
              exit 1
          fi
      fi
  fi
}