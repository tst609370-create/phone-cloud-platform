#!/bin/sh
# Build the shell AudioPolicy injector into android/virtual-mic/prebuilt/virtual-mic.jar.
# Requires a JDK (javac --release 8) and network access the first time, to fetch d8 (r8).
set -eu
ROOT=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
SRC="$ROOT/shell/src"
WORK="$ROOT/shell/build"
PREBUILT="$ROOT/prebuilt"
R8_VERSION="8.7.18"
R8_JAR="${R8_JAR:-/tmp/r8-$R8_VERSION.jar}"
R8_URL="https://dl.google.com/dl/android/maven2/com/android/tools/r8/${R8_VERSION}/r8-${R8_VERSION}.jar"

rm -rf "$WORK"
mkdir -p "$WORK/classes" "$WORK/dex" "$PREBUILT"

find "$SRC" -name '*.java' > "$WORK/sources.list"
javac --release 8 -encoding UTF-8 -Xlint:-options -d "$WORK/classes" @"$WORK/sources.list"
jar cf "$WORK/classes.jar" -C "$WORK/classes" .

if [ ! -f "$R8_JAR" ]; then
    echo "Downloading d8 ($R8_VERSION) ..."
    if command -v curl >/dev/null 2>&1; then
        curl -fsSL "$R8_URL" -o "$R8_JAR"
    else
        wget -q -O "$R8_JAR" "$R8_URL"
    fi
fi

java -cp "$R8_JAR" com.android.tools.r8.D8 --min-api 26 --output "$WORK/dex" "$WORK/classes.jar"
cp "$WORK/dex/classes.dex" "$WORK/classes.dex"
# app_process reads classes.dex from a jar on CLASSPATH.
jar cf "$PREBUILT/virtual-mic.jar" -C "$WORK" classes.dex
echo "Wrote $PREBUILT/virtual-mic.jar"
