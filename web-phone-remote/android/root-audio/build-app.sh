#!/bin/sh
# Build the no-root microphone app into android/root-audio/prebuilt/mic-audio.apk.
# No Android SDK needed: javac against stubs/, dalvik-dx for classes.dex, pyaxml for the
# binary manifest, jarsigner (v1 signature, enough for minSdk 23 / target 28).
# The keystore is committed on purpose so `adb install -r` keeps upgrading in place.
set -eu
ROOT=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
WORK="$ROOT/build-app"
DX_VERSION="16.0.1"
DX_JAR="${DX_JAR:-/tmp/dalvik-dx-$DX_VERSION.jar}"
DX_URL="https://repo1.maven.org/maven2/com/jakewharton/android/repackaged/dalvik-dx/$DX_VERSION/dalvik-dx-$DX_VERSION.jar"
VENV="${AXML_VENV:-/tmp/wsphone-axml-venv}"

rm -rf "$WORK"
mkdir -p "$WORK/stubs" "$WORK/classes" "$WORK/apk" "$ROOT/prebuilt"
find "$ROOT/stubs" -name '*.java' > "$WORK/stubs.list"
javac --release 8 -encoding UTF-8 -Xlint:-options -d "$WORK/stubs" @"$WORK/stubs.list"
{ find "$ROOT/src" -name '*.java'; find "$ROOT/app/src" -name '*.java'; } > "$WORK/sources.list"
javac --release 8 -encoding UTF-8 -Xlint:-options -cp "$WORK/stubs" -d "$WORK/classes" @"$WORK/sources.list"
[ -f "$DX_JAR" ] || curl -fsSL "$DX_URL" -o "$DX_JAR"
java -cp "$DX_JAR" com.android.dx.command.Main --dex --min-sdk-version=23 --output="$WORK/apk/classes.dex" "$WORK/classes"

[ -x "$VENV/bin/python" ] || { python3 -m venv "$VENV" && "$VENV/bin/pip" install -q pyaxml lxml; }
"$VENV/bin/python" "$ROOT/app/encode_manifest.py" "$ROOT/app/AndroidManifest.xml" "$WORK/apk/AndroidManifest.xml"

(cd "$WORK/apk" && rm -f ../unsigned.apk && zip -q -X ../unsigned.apk AndroidManifest.xml classes.dex)
jarsigner -keystore "$ROOT/app/wsphone-mic.keystore" -storepass wsphone -keypass wsphone \
    -digestalg SHA-256 -sigalg SHA256withRSA -signedjar "$ROOT/prebuilt/mic-audio.apk" "$WORK/unsigned.apk" mic >/dev/null
echo "Wrote $ROOT/prebuilt/mic-audio.apk"
