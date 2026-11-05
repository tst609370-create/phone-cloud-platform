#!/bin/sh
# Build the LSPosed module APK. This runs on a build machine, not on the phone
# and not on the novice's Windows PC. It does not install anything on a device.
set -eu
ROOT=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
SDK=${ANDROID_SDK_ROOT:-/tmp/android-sdk}
CMD=/tmp/android-cmdline-tools.zip
GRADLE=/tmp/gradle-8.2.1

if [ ! -x "$SDK/cmdline-tools/latest/bin/sdkmanager" ]; then
    mkdir -p "$SDK/cmdline-tools"
    if [ ! -f "$CMD" ]; then
        curl -fL -o "$CMD" https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip
    fi
    rm -rf /tmp/cmdtools-extract
    unzip -q "$CMD" -d /tmp/cmdtools-extract
    rm -rf "$SDK/cmdline-tools/latest"
    mv /tmp/cmdtools-extract/cmdline-tools "$SDK/cmdline-tools/latest"
fi

export ANDROID_SDK_ROOT="$SDK"
export ANDROID_HOME="$SDK"
yes | "$SDK/cmdline-tools/latest/bin/sdkmanager" --sdk_root="$SDK" --licenses >/tmp/sdk-licenses.log || true
"$SDK/cmdline-tools/latest/bin/sdkmanager" --sdk_root="$SDK" "platforms;android-34" "build-tools;34.0.0"

if [ ! -x "$GRADLE/bin/gradle" ]; then
    curl -fL -o /tmp/gradle.zip https://services.gradle.org/distributions/gradle-8.2.1-bin.zip
    rm -rf /tmp/gradle-extract
    unzip -q /tmp/gradle.zip -d /tmp/gradle-extract
    rm -rf "$GRADLE"
    mv /tmp/gradle-extract/gradle-8.2.1 "$GRADLE"
fi

cd "$ROOT/lsposed-module"
"$GRADLE/bin/gradle" --no-daemon assembleDebug
APK=$(find app/build/outputs/apk/debug -name '*.apk' | head -n 1)
mkdir -p "$ROOT/prebuilt"
cp -f "$APK" "$ROOT/prebuilt/virtual-mic.apk"
echo "Wrote $ROOT/prebuilt/virtual-mic.apk"
