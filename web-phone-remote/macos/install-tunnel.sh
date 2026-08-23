#!/bin/zsh
set -euo pipefail

ROOT="$HOME/Library/Application Support/PhoneCloudManager"
AGENT="$HOME/Library/LaunchAgents/cn.anyuekf.phonecloud.tunnel.plist"
VERSION=2026.8.2
HASH=9042c2c5d8b2de78e60f313d5fb31b6c5c1cebde787a3caf1f2c9588084ac442
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

if [[ -n "${1:-}" ]]; then
    cp "$1" "$TMP/cloudflared.tgz"
else
    curl -A PhoneCloudManager -fsSL "https://github.com/cloudflare/cloudflared/releases/download/$VERSION/cloudflared-darwin-arm64.tgz" -o "$TMP/cloudflared.tgz"
fi
printf '%s  %s\n' "$HASH" "$TMP/cloudflared.tgz" | shasum -a 256 -c -
tar -xzf "$TMP/cloudflared.tgz" -C "$ROOT/cloudflared"
chmod 755 "$ROOT/cloudflared/cloudflared" "$ROOT/start-tunnel.sh"
chmod 600 "$ROOT/tunnel/credentials.json"
plutil -lint "$AGENT"
"$ROOT/cloudflared/cloudflared" --config "$ROOT/tunnel/config.yml" tunnel ingress validate
launchctl bootout "gui/$(id -u)" "$AGENT" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$AGENT"
launchctl enable "gui/$(id -u)/cn.anyuekf.phonecloud.tunnel"
launchctl kickstart -k "gui/$(id -u)/cn.anyuekf.phonecloud.tunnel"
