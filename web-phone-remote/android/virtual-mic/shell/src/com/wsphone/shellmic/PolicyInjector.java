package com.wsphone.shellmic;

import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.util.ArrayList;
import java.util.List;

/**
 * Registers a shell AudioPolicy whose loopback replaces microphone capture.
 *
 * <p>This only works when the shell uid can call the hidden
 * {@code AudioManager.registerAudioPolicy} (AOSP grants shell
 * {@code MODIFY_AUDIO_ROUTING}; many retail builds do not). On refusal the
 * process prints {@code SHELL_MIC_NO} and the server grays the button out or
 * falls back to the LSPosed bridge.
 *
 * <p>Presets covered: MIC, VOICE_RECOGNITION, VOICE_COMMUNICATION, CAMCORDER,
 * UNPROCESSED, VOICE_PERFORMANCE, DEFAULT. REMOTE_SUBMIX is intentionally
 * absent so scrcpy's own playback capture is left alone.
 */
final class PolicyInjector {
    private static final int[] PRESETS = {1, 6, 7, 5, 9, 10, 0};
    private static final int[] CHANNEL_MASKS = {0x10, 0x4};
    private static final int ROUTE_LOOP_BACK = 0x2;
    private static final int RULE_CAPTURE_PRESET = 0x2;
    private static final int SAMPLE_RATE = 48000;

    private Object audioManager;
    private Object policy;
    private List<Object> tracks = new ArrayList<Object>();

    void start() throws Exception {
        Exception last = null;
        for (int mask : CHANNEL_MASKS) {
            try {
                attempt(mask);
                return;
            } catch (Exception err) {
                last = err;
                stop();
            }
        }
        if (last == null) throw new IllegalStateException("AudioPolicy not attempted");
        throw last;
    }

    void write(byte[] pcm) throws Exception {
        if (tracks.isEmpty() || pcm.length == 0) return;
        Exception last = null;
        int wrote = 0;
        for (Object track : tracks) {
            try {
                Object result = call(track, "write", new Class<?>[] {byte[].class, int.class, int.class}, new Object[] {pcm, 0, pcm.length});
                if (result instanceof Integer && ((Integer) result).intValue() < 0) {
                    throw new IllegalStateException("AudioTrack.write=" + result);
                }
                wrote++;
            } catch (Exception err) {
                last = err;
            }
        }
        if (wrote == 0 && last != null) throw last;
    }

    void stop() {
        for (Object track : tracks) {
            quietly(track, "pause");
            quietly(track, "flush");
            quietly(track, "release");
        }
        tracks = new ArrayList<Object>();
        if (audioManager != null && policy != null) {
            try {
                call(audioManager, "unregisterAudioPolicy", new Class<?>[] {policy.getClass()}, new Object[] {policy});
            } catch (Exception ignored) {
                // binder death removes the mix if unregister is missing
            }
        }
        policy = null;
        audioManager = null;
    }

    private void attempt(int channelMask) throws Exception {
        Object context = systemContext();
        Object manager = call(context, "getSystemService", new Class<?>[] {String.class}, new Object[] {"audio"});
        if (manager == null) throw new IllegalStateException("AudioManager missing");

        Object format = audioFormat(channelMask);
        Class<?> mixClass = Class.forName("android.media.audiopolicy.AudioMix");
        Class<?> policyClass = Class.forName("android.media.audiopolicy.AudioPolicy");
        Class<?> policyBuilderClass = Class.forName("android.media.audiopolicy.AudioPolicy$Builder");
        Object builder = policyBuilderClass.getConstructor(Class.forName("android.content.Context")).newInstance(context);

        List<Object> mixes = new ArrayList<Object>();
        for (int preset : PRESETS) {
            try {
                Object mix = mixFor(format, preset);
                call(builder, "addMix", new Class<?>[] {mixClass}, new Object[] {mix});
                mixes.add(mix);
            } catch (Exception ignored) {
                // this preset is not accepted on this release; keep the others
            }
        }
        if (mixes.isEmpty()) throw new IllegalStateException("no capture mix for mask " + channelMask);

        Object built = call(builder, "build", new Class<?>[0], new Object[0]);
        Object registered = call(manager, "registerAudioPolicy", new Class<?>[] {policyClass}, new Object[] {built});
        if (!(registered instanceof Integer) || ((Integer) registered).intValue() != 0) {
            throw new IllegalStateException("registerAudioPolicy=" + registered);
        }

        List<Object> opened = new ArrayList<Object>();
        for (Object mix : mixes) {
            Object track = call(built, "createAudioTrackSource", new Class<?>[] {mixClass}, new Object[] {mix});
            if (track == null) continue;
            call(track, "play", new Class<?>[0], new Object[0]);
            opened.add(track);
        }
        if (opened.isEmpty()) {
            this.audioManager = manager;
            this.policy = built;
            throw new IllegalStateException("createAudioTrackSource returned null");
        }
        this.audioManager = manager;
        this.policy = built;
        this.tracks = opened;
    }

    private static Object audioFormat(int channelMask) throws Exception {
        Class<?> builderClass = Class.forName("android.media.AudioFormat$Builder");
        Object builder = builderClass.getDeclaredConstructor().newInstance();
        call(builder, "setSampleRate", new Class<?>[] {int.class}, new Object[] {Integer.valueOf(SAMPLE_RATE)});
        call(builder, "setEncoding", new Class<?>[] {int.class}, new Object[] {Integer.valueOf(2)});
        call(builder, "setChannelMask", new Class<?>[] {int.class}, new Object[] {Integer.valueOf(channelMask)});
        return call(builder, "build", new Class<?>[0], new Object[0]);
    }

    private static Object mixFor(Object format, int preset) throws Exception {
        Class<?> attributesClass = Class.forName("android.media.AudioAttributes");
        Object attributes = captureAttributes(preset);
        Class<?> ruleBuilderClass = Class.forName("android.media.audiopolicy.AudioMixingRule$Builder");
        Object ruleBuilder = ruleBuilderClass.getDeclaredConstructor().newInstance();
        call(ruleBuilder, "addRule", new Class<?>[] {attributesClass, int.class}, new Object[] {attributes, Integer.valueOf(RULE_CAPTURE_PRESET)});
        Object rule = call(ruleBuilder, "build", new Class<?>[0], new Object[0]);
        Class<?> mixBuilderClass = Class.forName("android.media.audiopolicy.AudioMix$Builder");
        Class<?> ruleClass = Class.forName("android.media.audiopolicy.AudioMixingRule");
        Class<?> formatClass = Class.forName("android.media.AudioFormat");
        Object mixBuilder = mixBuilderClass.getConstructor(ruleClass).newInstance(rule);
        call(mixBuilder, "setFormat", new Class<?>[] {formatClass}, new Object[] {format});
        call(mixBuilder, "setRouteFlags", new Class<?>[] {int.class}, new Object[] {Integer.valueOf(ROUTE_LOOP_BACK)});
        return call(mixBuilder, "build", new Class<?>[0], new Object[0]);
    }

    private static Object captureAttributes(int preset) throws Exception {
        Class<?> builderClass = Class.forName("android.media.AudioAttributes$Builder");
        Object builder = builderClass.getDeclaredConstructor().newInstance();
        try {
            call(builder, "setCapturePreset", new Class<?>[] {int.class}, new Object[] {Integer.valueOf(preset)});
        } catch (NoSuchMethodException missing) {
            call(builder, "setInternalCapturePreset", new Class<?>[] {int.class}, new Object[] {Integer.valueOf(preset)});
        }
        return call(builder, "build", new Class<?>[0], new Object[0]);
    }

    private static Object systemContext() throws Exception {
        Class<?> activityThread = Class.forName("android.app.ActivityThread");
        Object thread = activityThread.getMethod("systemMain").invoke(null);
        Object context = activityThread.getMethod("getSystemContext").invoke(thread);
        if (context == null) throw new IllegalStateException("system context missing");
        forceShellPackage(context);
        return context;
    }

    private static void forceShellPackage(Object context) {
        Object current = context;
        for (int depth = 0; depth < 6 && current != null; depth++) {
            setString(current, "mBasePackageName", "com.android.shell");
            setString(current, "mOpPackageName", "com.android.shell");
            current = getField(current, "mBase");
        }
    }

    private static void setString(Object target, String name, String value) {
        Class<?> type = target.getClass();
        while (type != null) {
            try {
                java.lang.reflect.Field field = type.getDeclaredField(name);
                field.setAccessible(true);
                field.set(target, value);
                return;
            } catch (Exception ignored) {
                type = type.getSuperclass();
            }
        }
    }

    private static Object getField(Object target, String name) {
        Class<?> type = target.getClass();
        while (type != null) {
            try {
                java.lang.reflect.Field field = type.getDeclaredField(name);
                field.setAccessible(true);
                return field.get(target);
            } catch (Exception ignored) {
                type = type.getSuperclass();
            }
        }
        return null;
    }

    private static void quietly(Object target, String name) {
        try {
            call(target, name, new Class<?>[0], new Object[0]);
        } catch (Exception ignored) {
            // best-effort teardown
        }
    }

    private static Object call(Object target, String name, Class<?>[] types, Object[] args) throws Exception {
        Method method;
        try {
            method = target.getClass().getMethod(name, types);
        } catch (NoSuchMethodException missing) {
            method = target.getClass().getDeclaredMethod(name, types);
            method.setAccessible(true);
        }
        try {
            return method.invoke(target, args);
        } catch (InvocationTargetException wrapped) {
            Throwable cause = wrapped.getCause();
            if (cause instanceof Exception) throw (Exception) cause;
            if (cause instanceof Error) throw (Error) cause;
            throw wrapped;
        }
    }
}
