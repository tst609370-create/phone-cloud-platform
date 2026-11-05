#!/bin/sh
# Build PhoneRemoteSetup.exe on Linux. The novice PC does not compile anything.
set -eu
ROOT=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)
STAGE=$(mktemp -d)
PAY="$STAGE/payload"
mkdir -p "$PAY/app/dist" "$PAY/runtime/node" "$PAY/dependencies/adb" "$PAY/dependencies/scrcpy-server" "$PAY/frp" "$PAY/tools" "$PAY/phone"

echo "staging prebuilt app"
cp -a "$ROOT/dist/." "$PAY/app/dist/"
if [ -f "$ROOT/android/virtual-mic/prebuilt/virtual-mic.jar" ]; then
    cp -f "$ROOT/android/virtual-mic/prebuilt/virtual-mic.jar" "$PAY/app/dist/virtual-mic.jar"
    cp -f "$ROOT/android/virtual-mic/prebuilt/virtual-mic.jar" "$PAY/phone/virtual-mic.jar"
fi
if [ -f "$ROOT/android/virtual-mic/prebuilt/virtual-mic.apk" ]; then
    cp -f "$ROOT/android/virtual-mic/prebuilt/virtual-mic.apk" "$PAY/phone/virtual-mic.apk"
fi
if [ -f "$ROOT/assets/scrcpy-server" ]; then
    cp -f "$ROOT/assets/scrcpy-server" "$PAY/dependencies/scrcpy-server/scrcpy-server"
fi
cp -f "$ROOT/installer/setup-auth.mjs" "$PAY/tools/setup-auth.mjs"

echo "staging production node modules for win32"
MOD="$STAGE/npm"
mkdir -p "$MOD"
cat > "$MOD/package.json" <<'EOF'
{
  "name": "phone-remote-runtime",
  "private": true,
  "dependencies": {
    "qrcode": "1.5.4",
    "velopack": "1.2.0",
    "ws": "8.21.3"
  }
}
EOF
(cd "$MOD" && npm install --omit=dev --no-fund --no-audit --os=win32 --cpu=x64)
cp -a "$MOD/node_modules" "$PAY/app/node_modules"

fetch() {
    url=$1
    out=$2
    i=0
    while [ "$i" -lt 4 ]; do
        i=$((i + 1))
        echo "download $url (try $i)"
        if curl -fL --retry 3 --retry-delay 2 -o "$out" "$url"; then
            return 0
        fi
        sleep 2
    done
    echo "failed $url" >&2
    return 1
}

echo "staging node.exe"
fetch "https://nodejs.org/dist/v24.15.0/node-v24.15.0-win-x64.zip" "$STAGE/node.zip"
unzip -q -j "$STAGE/node.zip" "node-v24.15.0-win-x64/node.exe" -d "$PAY/runtime/node"

echo "staging adb"
fetch "https://dl.google.com/android/repository/platform-tools-latest-windows.zip" "$STAGE/pt.zip"
unzip -q -j "$STAGE/pt.zip" "platform-tools/adb.exe" "platform-tools/AdbWinApi.dll" "platform-tools/AdbWinUsbApi.dll" -d "$PAY/dependencies/adb"

echo "staging frpc"
fetch "https://github.com/fatedier/frp/releases/download/v0.61.1/frp_0.61.1_windows_amd64.zip" "$STAGE/frp.zip"
unzip -q -j "$STAGE/frp.zip" "frp_0.61.1_windows_amd64/frpc.exe" -d "$PAY/frp"

echo "packing zip"
(cd "$PAY" && zip -qr "$STAGE/payload.zip" .)

echo "compiling exe"
# Console subsystem so the Chinese progress stays visible. The program is unsigned.
(cd "$ROOT/installer/windows" && GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build -o "$STAGE/PhoneRemoteSetup.exe" .)

python3 - "$STAGE/PhoneRemoteSetup.exe" "$STAGE/payload.zip" <<'PY'
import pathlib, sys
exe, payload = map(pathlib.Path, sys.argv[1:])
blob = exe.read_bytes() + payload.read_bytes()
blob += len(payload.read_bytes()).to_bytes(8, "little") + b"PRSETUP1"
exe.write_bytes(blob)
print(f"wrote {exe} ({exe.stat().st_size} bytes)")
PY

mkdir -p /opt/cursor/artifacts
cp -f "$STAGE/PhoneRemoteSetup.exe" /opt/cursor/artifacts/PhoneRemoteSetup.exe
sha256sum /opt/cursor/artifacts/PhoneRemoteSetup.exe
echo "staged files:" 
find "$PAY" -type f | wc -l
