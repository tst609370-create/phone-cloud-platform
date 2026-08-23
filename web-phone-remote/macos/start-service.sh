#!/bin/zsh
set -eu

ROOT="$HOME/Library/Application Support/PhoneCloudManager"
RUNTIME="$ROOT/runtime"
export DATA_ROOT="$ROOT/state"
export DEPS_PATH="$RUNTIME/dependencies"
export WS_SCRCPY_CONFIG="$ROOT/state/config.json"
export WS_SCRCPY_WEB_PORT=8002
export WS_SCRCPY_NO_BROWSER=1
mkdir -p "$ROOT/state" "$ROOT/logs"
TOKEN_FILE="$ROOT/state/admin-token"
if [[ ! -s "$TOKEN_FILE" ]]; then
    /usr/bin/openssl rand -hex 32 > "$TOKEN_FILE"
    /bin/chmod 600 "$TOKEN_FILE"
fi
export PHONECLOUD_ADMIN_TOKEN="$(/bin/cat "$TOKEN_FILE")"
cd "$RUNTIME"
exec "$RUNTIME/node/bin/node" "$RUNTIME/dist/index.js"
