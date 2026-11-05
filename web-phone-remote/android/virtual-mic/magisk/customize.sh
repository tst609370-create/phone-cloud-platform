#!/system/bin/sh
# Optional: pack the built APK as virtual-mic.apk next to this script before
# flashing the module. Magisk runs this in the install environment.
APK="$MODPATH/virtual-mic.apk"
if [ -f "$APK" ]; then
    pm install -r "$APK" || ui_print "pm install failed; install the APK with adb"
else
    ui_print "No virtual-mic.apk in the module. Install the LSPosed APK separately."
fi
