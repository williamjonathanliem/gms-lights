#!/bin/bash
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then echo "Node.js is not installed. Get the LTS version from https://nodejs.org then run this again."; read -n 1; exit 1; fi
[ -d node_modules ] || { echo "Installing for the first time..."; npm install --omit=dev; }
node bridge.js
read -n 1 -p "Press any key to close"
