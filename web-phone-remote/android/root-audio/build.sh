#!/bin/sh
# Build the root playback-capture helper into android/root-audio/prebuilt/root-audio.jar.
# Needs a JDK. Android classes come from the compile-only stubs in stubs/ (never packaged).
# Dexing uses dalvik-dx from Maven Central (Google's maven host is not always reachable).
set -eu
ROOT=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
WORK="$ROOT/build"
DX_VERSION="16.0.1"
DX_JAR="${DX_JAR:-/tmp/dalvik-dx-$DX_VERSION.jar}"
DX_URL="https://repo1.maven.org/maven2/com/jakewharton/android/repackaged/dalvik-dx/$DX_VERSION/dalvik-dx-$DX_VERSION.jar"

rm -rf "$WORK"
mkdir -p "$WORK/stubs" "$WORK/classes" "$ROOT/prebuilt"
find "$ROOT/stubs" -name '*.java' > "$WORK/stubs.list"
javac --release 8 -encoding UTF-8 -Xlint:-options -d "$WORK/stubs" @"$WORK/stubs.list"
find "$ROOT/src" -name '*.java' > "$WORK/sources.list"
javac --release 8 -encoding UTF-8 -Xlint:-options -cp "$WORK/stubs" -d "$WORK/classes" @"$WORK/sources.list"

[ -f "$DX_JAR" ] || curl -fsSL "$DX_URL" -o "$DX_JAR"
java -cp "$DX_JAR" com.android.dx.command.Main --dex --min-sdk-version=21 --output="$WORK/classes.dex" "$WORK/classes"
# app_process reads classes.dex from a jar on CLASSPATH.
(cd "$WORK" && jar cf "$ROOT/prebuilt/root-audio.jar" classes.dex)
echo "Wrote $ROOT/prebuilt/root-audio.jar"
