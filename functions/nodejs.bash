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

useNodeJsVersion () {
  ensureNvmExistsAndLoaded

  local required_node_version="$1"

  if [[ -z "$required_node_version" ]]; then
      announceErrorAndExit "useNodeJsVersion requires a Node.js version argument"
  fi

  announceStep "Setting nvm to use node version: $required_node_version"
  if nvm use "$required_node_version" > /dev/null; then
      announceStep "Successfully switched to node version: $(node -v)"
      return 0
  fi

  announceStep "Failed to switch to $required_node_version. Attempting to install..."
  if nvm install "$required_node_version"; then
      announceStep "Successfully installed $required_node_version. Switching to it..."
      nvm use "$required_node_version" > /dev/null || \
          announceErrorAndExit "Failed to switch to $required_node_version after installation"
      announceStep "Successfully switched to node version: $(node -v)"
  else
      announceErrorAndExit "Failed to install $required_node_version"
  fi
}

useNodeJsVersionFromNvmrc () {
  local nvmrc_path="${1:-"${MAIN_DIR:-.}/.nvmrc"}"
  local required_node_version

  if [[ ! -f "$nvmrc_path" ]]; then
      announceErrorAndExit "Missing .nvmrc file: $nvmrc_path"
  fi

  required_node_version="$(tr -d '\r\n[:space:]' < "$nvmrc_path")"
  if [[ -z "$required_node_version" ]]; then
      announceErrorAndExit ".nvmrc file is empty: $nvmrc_path"
  fi

  useNodeJsVersion "$required_node_version"
}

requireNodeJsVersion () {
  ensureNvmExistsAndLoaded

  # Install & use the required NodeJS version
  node_version="$(node -v)"
  required_node_version="$1"
  if isVersionHigher "$node_version" "$required_node_version"; then
      useNodeJsVersion "$required_node_version"
  fi
}
