#!/system/bin/sh
# The audio path is adb reverse into the computer. This only leaves a marker
# so an operator can see the Magisk module booted.
MARK=/data/local/tmp/wsphone_virtualmic.magisk
echo "wsphone_virtualmic" > "$MARK" 2>/dev/null || true
chmod 644 "$MARK" 2>/dev/null || true
