#!/bin/zsh
set -euo pipefail

PROJECT="$(cd "$(dirname "$0")/.." && pwd)"
ROOT="$HOME/Library/Application Support/PhoneCloudManager"
RUNTIME="$ROOT/runtime"
APP="$HOME/Applications/手机管理端.app"
AGENT="$HOME/Library/LaunchAgents/cn.anyuekf.phonecloud.service.plist"
NODE_VERSION=v24.15.0
NODE_ARCHIVE="node-$NODE_VERSION-darwin-arm64.tar.gz"
NODE_URL="https://nodejs.org/dist/$NODE_VERSION/$NODE_ARCHIVE"

[[ -f "$PROJECT/dist/index.js" && -d "$PROJECT/dist/public" ]] || { echo "缺少 dist，请先构建"; exit 1; }

ADB="${ADB_PATH:-}"
for candidate in "$ADB" "$HOME/PhoneProxy/platform-tools-install-20260821/platform-tools/adb" "$HOME/Library/Android/sdk/platform-tools/adb"; do
    [[ -n "$candidate" && -x "$candidate" ]] && { ADB="$candidate"; break; }
done
[[ -x "$ADB" ]] || { echo "未找到 adb"; exit 1; }

mkdir -p "$ROOT" "$ROOT/logs" "$ROOT/state" "$RUNTIME/dependencies/adb" "$RUNTIME/dependencies/scrcpy-server" "$RUNTIME/node" "$HOME/Applications" "$HOME/Library/LaunchAgents"
ditto "$PROJECT/dist" "$RUNTIME/dist"
ditto "$PROJECT/node_modules/ws" "$RUNTIME/node_modules/ws"
ditto "$PROJECT/node_modules/velopack" "$RUNTIME/node_modules/velopack"
ditto "$PROJECT/node_modules/@neon-rs/load" "$RUNTIME/node_modules/@neon-rs/load"
cp "$PROJECT/package.json" "$RUNTIME/package.json"
cp "$ADB" "$RUNTIME/dependencies/adb/adb"
cp "$PROJECT/assets/scrcpy-server" "$RUNTIME/dependencies/scrcpy-server/scrcpy-server"
cp "$PROJECT/assets/scrcpy-server.version" "$RUNTIME/dependencies/scrcpy-server/.version"
chmod 755 "$RUNTIME/dependencies/adb/adb"

if [[ ! -x "$RUNTIME/node/bin/node" ]]; then
    TMP="$(mktemp -d)"
    trap 'rm -rf "$TMP"' EXIT
    curl -fsSL "https://nodejs.org/dist/$NODE_VERSION/SHASUMS256.txt" -o "$TMP/SHASUMS256.txt"
    curl -fsSL "$NODE_URL" -o "$TMP/$NODE_ARCHIVE"
    (cd "$TMP" && grep " $NODE_ARCHIVE\$" SHASUMS256.txt | shasum -a 256 -c -)
    tar -xzf "$TMP/$NODE_ARCHIVE" -C "$TMP"
    ditto "$TMP/node-$NODE_VERSION-darwin-arm64" "$RUNTIME/node"
fi

cp "$PROJECT/macos/config.json" "$ROOT/state/config.json"

mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
/usr/bin/swiftc -O -framework Cocoa -framework WebKit "$PROJECT/macos/PhoneCloudManager.swift" -o "$APP/Contents/MacOS/PhoneCloudManager"
cp "$PROJECT/macos/Info.plist" "$APP/Contents/Info.plist"
codesign --force --deep --sign - "$APP"

cp "$PROJECT/macos/start-service.sh" "$ROOT/start-service.sh"
chmod 755 "$ROOT/start-service.sh"
cp "$PROJECT/macos/cn.anyuekf.phonecloud.service.plist" "$AGENT"
/usr/libexec/PlistBuddy -c "Set :ProgramArguments:1 $ROOT/start-service.sh" "$AGENT"
plutil -replace StandardOutPath -string "$ROOT/logs/service.log" "$AGENT"
plutil -replace StandardErrorPath -string "$ROOT/logs/service-error.log" "$AGENT"
launchctl bootout "gui/$(id -u)" "$AGENT" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$AGENT"
launchctl enable "gui/$(id -u)/cn.anyuekf.phonecloud.service"
launchctl kickstart -k "gui/$(id -u)/cn.anyuekf.phonecloud.service"

for _ in {1..20}; do
    curl -fsS http://127.0.0.1:8002/ >/dev/null 2>&1 && break
    sleep 1
done
curl -fsS http://127.0.0.1:8002/ >/dev/null
open "$APP"
echo "手机管理端已安装：$APP"
