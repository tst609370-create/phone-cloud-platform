package com.wsphone.virtualmic;

import de.robv.android.xposed.IXposedHookLoadPackage;
import de.robv.android.xposed.XposedBridge;
import de.robv.android.xposed.callbacks.XC_LoadPackage;

public final class VirtualMicModule implements IXposedHookLoadPackage {
    @Override
    public void handleLoadPackage(XC_LoadPackage.LoadPackageParam lpparam) {
        if ("com.wsphone.virtualmic".equals(lpparam.packageName)) return;
        try {
            AudioRecordHook.install();
        } catch (Throwable thrown) {
            XposedBridge.log("virtual-mic: hook failed in " + lpparam.packageName + ": " + thrown);
        }
    }
}
