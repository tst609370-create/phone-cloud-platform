package com.wsphone.rootaudio;

import android.app.Application;
import android.content.ContextWrapper;
import android.media.AudioRecord;
import android.media.MediaCodec;
import android.media.MediaFormat;
import android.net.LocalSocket;
import android.net.LocalSocketAddress;
import android.os.Looper;

import java.io.BufferedOutputStream;
import java.io.DataOutputStream;
import java.io.IOException;
import java.lang.reflect.Constructor;
import java.lang.reflect.Field;
import java.nio.ByteBuffer;

/**
 * Phone playback capture for Android 8-10 with root.
 *
 * <p>scrcpy only captures audio on Android 11+, because that is when the shell
 * uid got CAPTURE_AUDIO_OUTPUT. A root (uid 0) process passes those permission
 * checks on older Android too, so this helper runs under {@code su}, records
 * REMOTE_SUBMIX (the whole device output) and writes the same stream scrcpy 4.x
 * writes on its audio socket: a 4-byte codec id, then packets of
 * 8-byte pts-and-flags + 4-byte size + payload (config flag = bit 62).
 *
 * <p>Usage: {@code app_process / com.wsphone.rootaudio.RootAudioMain <abstract-socket> [aac|raw]}.
 * Status lines on stdout: {@code ROOT_AUDIO_OK:<codec>} or {@code ROOT_AUDIO_NO:<reason>}.
 */
public final class RootAudioMain {
    static final int CODEC_AAC = 0x00616163;
    static final int CODEC_RAW = 0x00726177;
    static final int AUDIO_ERROR = 1;
    static final long FLAG_CONFIG = 1L << 62;

    static final int SOURCE_REMOTE_SUBMIX = 8;
    static final int SOURCE_MIC = 1;
    static final int CHANNEL_IN_MONO = 16;
    /** Mic fallback on phones without stereo capture: record mono, duplicate to stereo. */
    static boolean mono;
    static final int SAMPLE_RATE = 48000;
    static final int CHANNEL_IN_STEREO = 12;
    static final int ENCODING_PCM_16BIT = 2;
    static final int CHUNK_BYTES = 4096; // 1024 stereo s16 frames = one AAC frame

    private RootAudioMain() {}

    public static void main(String[] args) {
        int code = 0;
        try {
            run(args);
        } catch (Throwable thrown) {
            System.err.println("root-audio: " + thrown);
            code = 1;
        }
        System.exit(code);
    }

    private static void run(String[] args) throws Exception {
        if (args.length < 1) throw new IllegalArgumentException("socket name required");
        String codec = args.length > 1 ? args[1] : "aac";
        // "submix" (whole device output, needs root) or "mic" (microphone; works as the
        // adb shell user without root: the phone plays out loud and the mic hears it).
        boolean mic = args.length > 2 && "mic".equals(args[2]);

        LocalSocket socket = new LocalSocket();
        socket.connect(new LocalSocketAddress(args[0]));
        try {
            stream(socket.getOutputStream(), codec, mic, true);
        } finally {
            try {
                socket.close();
            } catch (IOException ignored) {
                // ignore
            }
        }
    }

    /**
     * Record and write the scrcpy-style audio stream to {@code raw} until the reader
     * goes away. On a capture failure writes AUDIO_ERROR followed by a length-prefixed
     * UTF-8 reason (readers that only know scrcpy stop after the error code anyway).
     * {@code fakeContext} is for app_process only; an installed app must pass false.
     */
    public static void stream(java.io.OutputStream raw, String codec, boolean mic, boolean fakeContext) throws IOException {
        DataOutputStream out = new DataOutputStream(new BufferedOutputStream(raw, 1 << 16));
        AudioRecord recorder;
        micMode = mic;
        pausedForCall = false;
        inCall = false;
        try {
            if (fakeContext) prepareProcess();
            recorder = mic ? openMic() : openRecorder(SOURCE_REMOTE_SUBMIX, CHANNEL_IN_STEREO);
        } catch (Throwable thrown) {
            String reason = sanitize(thrown);
            status("ROOT_AUDIO_NO:" + reason);
            sleep(400); // let the reason reach the computer before the error code
            byte[] text = reason.getBytes("UTF-8");
            out.writeInt(AUDIO_ERROR);
            out.writeInt(text.length);
            out.write(text);
            out.flush();
            sleep(500);
            return;
        }

        MediaCodec encoder = null;
        if (!"raw".equals(codec)) {
            try {
                encoder = openAacEncoder();
            } catch (Throwable thrown) {
                System.err.println("root-audio: AAC encoder unavailable, sending raw PCM: " + thrown);
                encoder = null;
            }
        }
        status("ROOT_AUDIO_OK:" + (encoder != null ? "aac" : "raw") + " source=" + (mic ? "mic" : "submix") + (mic ? "/" + capRate + "Hz/" + capChannels + "ch" : "") + " uid=" + android.os.Process.myUid());
        out.writeInt(encoder != null ? CODEC_AAC : CODEC_RAW);
        out.flush();

        try {
            if (encoder != null) {
                pumpAac(recorder, encoder, out);
            } else {
                pumpRaw(recorder, out);
            }
        } catch (IOException closed) {
            // The computer closed the socket: session over.
        } finally {
            releaseSuppressor();
            try {
                recorder.stop();
            } catch (Throwable ignored) {
                // ignore
            }
            recorder.release();
            if (encoder != null) {
                try {
                    encoder.stop();
                } catch (Throwable ignored) {
                    // ignore
                }
                encoder.release();
            }
        }
    }

    private static void sleep(long ms) {
        try {
            Thread.sleep(ms);
        } catch (InterruptedException ignored) {
            Thread.currentThread().interrupt();
        }
    }

    private static void status(String line) {
        System.out.println(line);
        System.out.flush();
    }

    /**
     * AudioRecord passes ActivityThread.currentOpPackageName() to native code, and a
     * null there throws. app_process has no Application, so install one whose base
     * context reports the shell package (root skips the app-op check anyway).
     */
    private static void prepareProcess() {
        try {
            Looper.prepareMainLooper();
        } catch (Throwable ignored) {
            // already prepared
        }
        try {
            Class<?> atClass = Class.forName("android.app.ActivityThread");
            Constructor<?> ctor = atClass.getDeclaredConstructor();
            ctor.setAccessible(true);
            Object thread = ctor.newInstance();
            Field current = atClass.getDeclaredField("sCurrentActivityThread");
            current.setAccessible(true);
            current.set(null, thread);

            Application app = new Application();
            Field base = ContextWrapper.class.getDeclaredField("mBase");
            base.setAccessible(true);
            base.set(app, new ShellContext());
            Field initial = atClass.getDeclaredField("mInitialApplication");
            initial.setAccessible(true);
            initial.set(thread, app);
        } catch (Throwable thrown) {
            System.err.println("root-audio: context workaround failed: " + thrown);
        }
    }

    /** Rate/channels the mic actually opened with; readStereo converts to 48 kHz stereo. */
    static int capRate = SAMPLE_RATE;
    static int capChannels = 2;
    private static double resPos;
    private static int lastL, lastR;
    private static byte[] inBuf = new byte[0];
    /** Mic noise reduction (live: the app's service updates these). gateDb 0 = gate off. */
    public static volatile boolean denoise = true;
    static boolean micMode;
    public static volatile int gateDb = -50;
    /** Speech-band filter while denoise is on: high-pass removes hum, low-pass removes hiss. */
    public static volatile int highPassHz = 100;
    public static volatile int lowPassHz = 8000;
    private static final Biquad[] hp = {new Biquad(), new Biquad()};
    private static final Biquad[] lp = {new Biquad(), new Biquad()};
    private static int hpAt = -1, lpAt = -1;
    /** Phone call mode probe (AudioManager.getMode) set by the app; 2/3 = in a (WeChat) call. */
    public static volatile java.util.concurrent.Callable<Integer> callMode;
    /** True while paused for a call; listener is told on every change. */
    public static volatile boolean pausedForCall;
    public static volatile Runnable onPauseChange;
    private static long lastModeCheck;
    private static boolean inCall;
    private static volatile android.media.audiofx.NoiseSuppressor suppressor;
    private static double gateGain = 1;
    private static int gateHold;

    /** Turn noise reduction on/off while streaming. */
    public static void setDenoise(boolean on, int db, int highHz, int lowHz) {
        highPassHz = highHz;
        lowPassHz = lowHz;
        setDenoise(on, db);
    }

    public static void setDenoise(boolean on, int db) {
        denoise = on;
        gateDb = db;
        android.media.audiofx.NoiseSuppressor ns = suppressor;
        if (ns != null) {
            try {
                ns.setEnabled(on);
            } catch (Throwable ignored) {
                // ignore
            }
        }
    }

    private static void attachSuppressor(AudioRecord recorder) {
        try {
            if (android.media.audiofx.NoiseSuppressor.isAvailable()) {
                android.media.audiofx.NoiseSuppressor ns = android.media.audiofx.NoiseSuppressor.create(recorder.getAudioSessionId());
                if (ns != null) {
                    ns.setEnabled(denoise);
                    suppressor = ns;
                }
            }
        } catch (Throwable thrown) {
            System.err.println("root-audio: NoiseSuppressor unavailable: " + thrown);
        }
    }

    private static void releaseSuppressor() {
        android.media.audiofx.NoiseSuppressor ns = suppressor;
        suppressor = null;
        if (ns != null) {
            try {
                ns.release();
            } catch (Throwable ignored) {
                // ignore
            }
        }
    }

    /**
     * Noise gate on 48 kHz stereo s16: blocks quieter than {@code gateDb} dBFS (after a
     * 250 ms hold) fade to silence, louder blocks fade back in over ~10 ms, so the
     * constant hiss between sounds is gone without clicks.
     */
    static void gate(byte[] buf, int n) {
        boolean on = denoise && gateDb < 0;
        if (n < 4) return;
        if (denoise) filter(buf, n);
        double target;
        if (!on) {
            target = 1;
        } else {
            long sum = 0;
            int count = 0;
            for (int i = 0; i + 1 < n; i += 2) {
                int v = (short) ((buf[i] & 0xff) | (buf[i + 1] << 8));
                sum += (long) v * v;
                count++;
            }
            double rms = Math.sqrt((double) sum / Math.max(1, count));
            double threshold = 32768.0 * Math.pow(10, gateDb / 20.0);
            if (rms >= threshold) {
                gateHold = 12; // ~250 ms of 21 ms blocks
                target = 1;
            } else if (gateHold > 0) {
                gateHold--;
                target = 1;
            } else {
                target = 0;
            }
        }
        if (target == 1 && gateGain >= 1) return;
        double step = 1.0 / 480; // 10 ms at 48 kHz
        for (int i = 0; i + 3 < n; i += 4) {
            if (gateGain < target) gateGain = Math.min(target, gateGain + step);
            else if (gateGain > target) gateGain = Math.max(target, gateGain - step);
            for (int c = 0; c < 4; c += 2) {
                int v = (short) ((buf[i + c] & 0xff) | (buf[i + c + 1] << 8));
                int g = (int) Math.round(v * gateGain);
                buf[i + c] = (byte) g;
                buf[i + c + 1] = (byte) (g >> 8);
            }
        }
    }

    /** RBJ biquad, one per channel. */
    static final class Biquad {
        double b0 = 1, b1, b2, a1, a2, x1, x2, y1, y2;

        void set(boolean highPass, double hz) {
            double w = 2 * Math.PI * hz / SAMPLE_RATE;
            double alpha = Math.sin(w) / (2 * 0.7071);
            double cos = Math.cos(w);
            double a0 = 1 + alpha;
            if (highPass) {
                b0 = (1 + cos) / 2 / a0;
                b1 = -(1 + cos) / a0;
            } else {
                b0 = (1 - cos) / 2 / a0;
                b1 = (1 - cos) / a0;
            }
            b2 = b0;
            a1 = -2 * cos / a0;
            a2 = (1 - alpha) / a0;
        }

        double run(double x) {
            double y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
            x2 = x1;
            x1 = x;
            y2 = y1;
            y1 = y;
            return y;
        }
    }

    static void filter(byte[] buf, int n) {
        int h = highPassHz, l = lowPassHz;
        if (h != hpAt) {
            for (Biquad f : hp) f.set(true, Math.max(20, h));
            hpAt = h;
        }
        if (l != lpAt) {
            for (Biquad f : lp) f.set(false, Math.min(20000, Math.max(1000, l)));
            lpAt = l;
        }
        for (int i = 0; i + 3 < n; i += 4) {
            for (int c = 0; c < 2; c++) {
                int o = i + c * 2;
                double v = (short) ((buf[o] & 0xff) | (buf[o + 1] << 8));
                if (h > 0) v = hp[c].run(v);
                if (l > 0 && l < 20000) v = lp[c].run(v);
                int g = (int) Math.max(-32768, Math.min(32767, Math.round(v)));
                buf[o] = (byte) g;
                buf[o + 1] = (byte) (g >> 8);
            }
        }
    }

    /**
     * Read one block, but during a phone/WeChat call stop recording so the call app gets
     * the microphone; send silence meanwhile and start again when the call ends.
     */
    static int readMic(AudioRecord recorder, byte[] buf) {
        if (micMode) {
            long now = System.currentTimeMillis();
            java.util.concurrent.Callable<Integer> probe = callMode;
            if (probe != null && now - lastModeCheck > 500) {
                lastModeCheck = now;
                try {
                    int mode = probe.call();
                    inCall = mode == 2 || mode == 3;
                } catch (Throwable ignored) {
                    inCall = false;
                }
            }
            if (inCall) {
                if (!pausedForCall) {
                    try {
                        recorder.stop();
                    } catch (Throwable ignored) {
                        // ignore
                    }
                    setPaused(true);
                }
                sleep((long) (buf.length / 4) * 1000 / SAMPLE_RATE);
                java.util.Arrays.fill(buf, (byte) 0);
                return buf.length;
            }
            if (pausedForCall) {
                recorder.startRecording();
                setPaused(false);
            }
        }
        return readStereo(recorder, buf);
    }

    private static void setPaused(boolean paused) {
        pausedForCall = paused;
        System.err.println("root-audio: " + (paused ? "call started, mic released" : "call ended, recording again"));
        Runnable r = onPauseChange;
        if (r != null) {
            try {
                r.run();
            } catch (Throwable ignored) {
                // ignore
            }
        }
    }

    /** Set by the app: permission / busy state, appended to a mic failure. */
    public static volatile java.util.concurrent.Callable<String> diag;

    static final int[] MIC_SOURCES = {SOURCE_MIC, 6 /* VOICE_RECOGNITION */, 5 /* CAMCORDER */, 0 /* DEFAULT */, 7 /* VOICE_COMMUNICATION */};
    static final int[] MIC_RATES = {48000, 44100, 16000};

    /** Try every source / rate / channel combination a few times (the mic may be briefly busy). */
    private static AudioRecord openMic() {
        mono = false;
        String first = null;
        for (int round = 0; round < 3; round++) {
            for (int source : MIC_SOURCES) {
                for (int rate : MIC_RATES) {
                    for (int channels : new int[] {CHANNEL_IN_STEREO, CHANNEL_IN_MONO}) {
                        try {
                            AudioRecord r = openRecorder(source, channels, rate);
                            capRate = rate;
                            capChannels = channels == CHANNEL_IN_STEREO ? 2 : 1;
                            mono = capChannels == 1;
                            resPos = 0;
                            lastL = lastR = 0;
                            System.err.println("root-audio: mic open source=" + source + " rate=" + rate + " ch=" + capChannels);
                            gateGain = 1;
                            gateHold = 0;
                            attachSuppressor(r);
                            return r;
                        } catch (RuntimeException failed) {
                            if (first == null) first = failed.getMessage();
                        }
                    }
                }
            }
            sleep(700);
        }
        String extra = "";
        java.util.concurrent.Callable<String> d = diag;
        if (d != null) {
            try {
                extra = "；" + d.call();
            } catch (Throwable ignored) {
                // ignore
            }
        }
        throw new IllegalStateException("麦克风打不开（试了 5 种音源 × 48k/44.1k/16k × 立体声/单声道）：" + first + extra);
    }

    /** Fill {@code buf} with interleaved 48 kHz stereo s16; returns bytes or a negative error. */
    static int readStereo(AudioRecord recorder, byte[] buf) {
        if (capRate == SAMPLE_RATE && capChannels == 2) return recorder.read(buf, 0, buf.length);
        double step = (double) capRate / SAMPLE_RATE;
        int outFrames = buf.length / 4;
        int inFrames = Math.max(1, (int) Math.floor((outFrames - 1) * step));
        int frameBytes = 2 * capChannels;
        int want = inFrames * frameBytes;
        if (inBuf.length < want) inBuf = new byte[want];
        int n = recorder.read(inBuf, 0, want);
        if (n <= 0) return n;
        int got = n / frameBytes;
        if (got == 0) return 0;
        int o = 0;
        while (o + 4 <= buf.length && resPos <= got - 1) {
            int i0 = (int) Math.floor(resPos);
            double f = resPos - i0;
            int i1 = Math.min(i0 + 1, got - 1);
            int l0 = i0 < 0 ? lastL : sample(i0, 0, frameBytes);
            int r0 = i0 < 0 ? lastR : sample(i0, capChannels - 1, frameBytes);
            int l = (int) Math.round(l0 + (sample(i1, 0, frameBytes) - l0) * f);
            int r = (int) Math.round(r0 + (sample(i1, capChannels - 1, frameBytes) - r0) * f);
            buf[o] = (byte) l;
            buf[o + 1] = (byte) (l >> 8);
            buf[o + 2] = (byte) r;
            buf[o + 3] = (byte) (r >> 8);
            o += 4;
            resPos += step;
        }
        lastL = sample(got - 1, 0, frameBytes);
        lastR = sample(got - 1, capChannels - 1, frameBytes);
        resPos -= got;
        return o;
    }

    private static int sample(int frame, int channel, int frameBytes) {
        int i = frame * frameBytes + channel * 2;
        return (short) ((inBuf[i] & 0xff) | (inBuf[i + 1] << 8));
    }

    private static AudioRecord openRecorder(int source, int channels) {
        capRate = SAMPLE_RATE;
        capChannels = 2;
        return openRecorder(source, channels, SAMPLE_RATE);
    }

    private static AudioRecord openRecorder(int source, int channels, int rate) {
        int min = AudioRecord.getMinBufferSize(rate, channels, ENCODING_PCM_16BIT);
        if (min <= 0) throw new IllegalStateException("AudioRecord(source " + source + ", " + rate + "Hz) not supported: getMinBufferSize " + min);
        int size = min * 4;
        if (size < CHUNK_BYTES * 8) size = CHUNK_BYTES * 8;
        AudioRecord recorder = new AudioRecord(source, rate, channels, ENCODING_PCM_16BIT, size);
        if (recorder.getState() != AudioRecord.STATE_INITIALIZED) {
            recorder.release();
            throw new IllegalStateException("AudioRecord(source " + source + ") not initialized: no permission or busy");
        }
        recorder.startRecording();
        if (recorder.getRecordingState() != 3) {
            recorder.release();
            throw new IllegalStateException("AudioRecord(source " + source + ") did not start (mic busy?)");
        }
        return recorder;
    }

    private static MediaCodec openAacEncoder() throws IOException {
        MediaFormat format = MediaFormat.createAudioFormat("audio/mp4a-latm", SAMPLE_RATE, 2);
        format.setInteger("aac-profile", 2); // AAC-LC
        format.setInteger("bitrate", 128000);
        format.setInteger("max-input-size", CHUNK_BYTES * 4);
        MediaCodec codec = MediaCodec.createEncoderByType("audio/mp4a-latm");
        try {
            codec.configure(format, (android.view.Surface) null, (android.media.MediaCrypto) null, MediaCodec.CONFIGURE_FLAG_ENCODE);
            codec.start();
        } catch (RuntimeException e) {
            codec.release();
            throw e;
        }
        return codec;
    }

    static void pumpRaw(AudioRecord recorder, DataOutputStream out) throws IOException {
        byte[] buf = new byte[CHUNK_BYTES];
        long frames = 0;
        while (true) {
            int n = readMic(recorder, buf);
            if (n < 0) throw new IllegalStateException("AudioRecord.read " + n);
            if (micMode && !pausedForCall) gate(buf, n);
            if (n == 0) continue;
            writePacket(out, frames * 1000000L / SAMPLE_RATE, buf, 0, n);
            out.flush();
            frames += n / 4;
        }
    }

    static void pumpAac(AudioRecord recorder, MediaCodec encoder, DataOutputStream out) throws IOException {
        byte[] buf = new byte[CHUNK_BYTES];
        byte[] packet = new byte[64 * 1024];
        MediaCodec.BufferInfo info = new MediaCodec.BufferInfo();
        long frames = 0;
        while (true) {
            int n = readMic(recorder, buf);
            if (n < 0) throw new IllegalStateException("AudioRecord.read " + n);
            if (micMode && !pausedForCall) gate(buf, n);
            int off = 0;
            while (off < n) {
                int index = encoder.dequeueInputBuffer(20000);
                if (index < 0) {
                    drain(encoder, info, packet, out);
                    continue;
                }
                ByteBuffer input = encoder.getInputBuffer(index);
                input.clear();
                int len = Math.min(n - off, input.remaining());
                input.put(buf, off, len);
                encoder.queueInputBuffer(index, 0, len, (frames + off / 4) * 1000000L / SAMPLE_RATE, 0);
                off += len;
            }
            frames += n / 4;
            drain(encoder, info, packet, out);
        }
    }

    private static void drain(MediaCodec encoder, MediaCodec.BufferInfo info, byte[] packet, DataOutputStream out) throws IOException {
        boolean wrote = false;
        while (true) {
            int index = encoder.dequeueOutputBuffer(info, 0);
            if (index < 0) break; // try again later / format or buffers changed
            if (info.size > 0) {
                ByteBuffer output = encoder.getOutputBuffer(index);
                output.position(info.offset);
                output.limit(info.offset + info.size);
                byte[] data = info.size <= packet.length ? packet : new byte[info.size];
                output.get(data, 0, info.size);
                boolean config = (info.flags & MediaCodec.BUFFER_FLAG_CODEC_CONFIG) != 0;
                long pts = config ? FLAG_CONFIG : Math.max(0, info.presentationTimeUs);
                writePacket(out, pts, data, 0, info.size);
                wrote = true;
            }
            encoder.releaseOutputBuffer(index, false);
        }
        if (wrote) out.flush();
    }

    private static void writePacket(DataOutputStream out, long ptsAndFlags, byte[] data, int off, int len) throws IOException {
        out.writeLong(ptsAndFlags);
        out.writeInt(len);
        out.write(data, off, len);
    }

    private static String sanitize(Throwable thrown) {
        String msg = thrown.getClass().getSimpleName() + ": " + thrown.getMessage();
        return msg.replace('\n', ' ').replace('\r', ' ');
    }

    /** Base context for the fake Application: only the package names are ever asked. */
    static final class ShellContext extends ContextWrapper {
        ShellContext() {
            super(null);
        }

        @Override
        public String getPackageName() {
            return "com.android.shell";
        }

        @Override
        public String getOpPackageName() {
            return "com.android.shell";
        }
    }
}
