package com.wsphone.virtualmic;

import de.robv.android.xposed.XC_MethodHook;
import de.robv.android.xposed.XposedBridge;
import de.robv.android.xposed.XposedHelpers;

/**
 * Replaces microphone AudioRecord reads with PCM from the computer.
 * Source numbers must stay in sync with INJECTABLE_AUDIO_SOURCES in
 * src/common/micProtocol.ts. REMOTE_SUBMIX (8) is scrcpy's playback capture
 * and must not be replaced.
 */
public final class AudioRecordHook {
    private static boolean installed;

    private AudioRecordHook() {}

    public static void install() {
        if (installed) return;
        synchronized (AudioRecordHook.class) {
            if (installed) return;
            Class<?> audioRecord = XposedHelpers.findClass("android.media.AudioRecord", null);
            XposedBridge.hookAllMethods(audioRecord, "read", new XC_MethodHook() {
                @Override
                protected void beforeHookedMethod(MethodHookParam param) {
                    int source = audioSource(param.thisObject);
                    if (!injectable(source)) return;
                    int filled = MicClient.fill(param.thisObject, param.args);
                    if (filled >= 0) param.setResult(Integer.valueOf(filled));
                }
            });
            installed = true;
        }
    }

    /** @return true for mic-like sources. Keep the case labels in sync with the TS list. */
    static boolean injectable(int source) {
        switch (source) {
            case 0: // DEFAULT
            case 1: // MIC
            case 5: // CAMCORDER
            case 6: // VOICE_RECOGNITION
            case 7: // VOICE_COMMUNICATION
            case 9: // UNPROCESSED
            case 10: // VOICE_PERFORMANCE
                return true;
            default:
                // case 8 REMOTE_SUBMIX is intentionally excluded
                return false;
        }
    }

    private static int audioSource(Object record) {
        try {
            Object value = XposedHelpers.callMethod(record, "getAudioSource");
            if (value instanceof Integer) return ((Integer) value).intValue();
        } catch (Throwable ignored) {
            // hidden API shape differs by release
        }
        try {
            return XposedHelpers.getIntField(record, "mAudioSource");
        } catch (Throwable ignored) {
            return -1;
        }
    }
}
