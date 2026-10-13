#!/bin/sh
# Build, then pack dist/ into release/port-switch-<version>.tar.gz.
# Local runtime files (servers.json, .env, run/) are left out, so extracting the archive
# over an existing install upgrades it without touching its config or logs:
#   tar -xzf port-switch-<version>.tar.gz -C ~/port-switch
set -e
cd "$(dirname "$0")/.."

yarn build
version=$(node -p "require('./package.json').version")
out="release/port-switch-$version.tar.gz"
mkdir -p release
tar -czf "$out" -C dist --exclude=servers.json --exclude=.env --exclude=run .
echo "wrote $out:"
tar -tzf "$out"
