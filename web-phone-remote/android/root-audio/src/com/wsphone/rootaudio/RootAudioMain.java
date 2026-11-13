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

        LocalSocket socket = new LocalSocket();
        socket.connect(new LocalSocketAddress(args[0]));
        DataOutputStream out = new DataOutputStream(new BufferedOutputStream(socket.getOutputStream(), 1 << 16));

        AudioRecord recorder;
        try {
            prepareProcess();
            recorder = openRecorder();
        } catch (Throwable thrown) {
            status("ROOT_AUDIO_NO:" + sanitize(thrown));
            out.writeInt(AUDIO_ERROR);
            out.flush();
            Thread.sleep(500);
            socket.close();
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
        status("ROOT_AUDIO_OK:" + (encoder != null ? "aac" : "raw") + " uid=" + android.os.Process.myUid());
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
            try {
                socket.close();
            } catch (IOException ignored) {
                // ignore
            }
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

    private static AudioRecord openRecorder() {
        int min = AudioRecord.getMinBufferSize(SAMPLE_RATE, CHANNEL_IN_STEREO, ENCODING_PCM_16BIT);
        int size = Math.max(min, 0) * 4;
        if (size < CHUNK_BYTES * 8) size = CHUNK_BYTES * 8;
        AudioRecord recorder = new AudioRecord(SOURCE_REMOTE_SUBMIX, SAMPLE_RATE, CHANNEL_IN_STEREO, ENCODING_PCM_16BIT, size);
        if (recorder.getState() != AudioRecord.STATE_INITIALIZED) {
            recorder.release();
            throw new IllegalStateException("AudioRecord(REMOTE_SUBMIX) not initialized; root may be missing");
        }
        recorder.startRecording();
        if (recorder.getRecordingState() != 3) {
            recorder.release();
            throw new IllegalStateException("AudioRecord(REMOTE_SUBMIX) did not start");
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

    private static void pumpRaw(AudioRecord recorder, DataOutputStream out) throws IOException {
        byte[] buf = new byte[CHUNK_BYTES];
        long frames = 0;
        while (true) {
            int n = recorder.read(buf, 0, buf.length);
            if (n < 0) throw new IllegalStateException("AudioRecord.read " + n);
            if (n == 0) continue;
            writePacket(out, frames * 1000000L / SAMPLE_RATE, buf, 0, n);
            out.flush();
            frames += n / 4;
        }
    }

    private static void pumpAac(AudioRecord recorder, MediaCodec encoder, DataOutputStream out) throws IOException {
        byte[] buf = new byte[CHUNK_BYTES];
        byte[] packet = new byte[64 * 1024];
        MediaCodec.BufferInfo info = new MediaCodec.BufferInfo();
        long frames = 0;
        while (true) {
            int n = recorder.read(buf, 0, buf.length);
            if (n < 0) throw new IllegalStateException("AudioRecord.read " + n);
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
