#!/bin/zsh
set -eu

ROOT="$HOME/Library/Application Support/PhoneCloudManager"
exec "$ROOT/cloudflared/cloudflared" --no-autoupdate --config "$ROOT/tunnel/config.yml" tunnel run
