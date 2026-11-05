package com.wsphone.virtualmic;

import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.DataInputStream;
import java.io.DataOutputStream;
import java.io.IOException;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;

/**
 * Pulls PCM from the host hub at 127.0.0.1:28256 (adb reverse).
 * Frame layout matches src/common/micProtocol.ts.
 */
final class MicClient {
    static final int PORT = 28256;
    static final int MAX_PAYLOAD = 256 * 1024;
    private static final MicClient INSTANCE = new MicClient();

    private Socket socket;
    private DataInputStream in;
    private DataOutputStream out;

    static int fill(Object record, Object[] args) {
        return INSTANCE.fillLocked(record, args);
    }

    private synchronized int fillLocked(Object record, Object[] args) {
        if (args == null || args.length < 2 || args[0] == null) return -1;
        int rate = intMethod(record, "getSampleRate");
        int channels = Math.max(1, intMethod(record, "getChannelCount"));
        int encoding = intMethod(record, "getAudioFormat");
        if (rate <= 0 || encoding <= 0) return -1;
        try {
            if (args[0] instanceof byte[]) {
                int offset = (Integer) args[1];
                int size = (Integer) args[2];
                byte[] pcm = read(rate, channels, encoding, size);
                if (pcm == null) return -1;
                int count = Math.min(size, pcm.length);
                System.arraycopy(pcm, 0, args[0], offset, count);
                return count;
            }
            if (args[0] instanceof short[]) {
                int offset = (Integer) args[1];
                int size = (Integer) args[2];
                byte[] pcm = read(rate, channels, 2, size * 2);
                if (pcm == null) return -1;
                int shorts = Math.min(size, pcm.length / 2);
                short[] dest = (short[]) args[0];
                ByteBuffer buffer = ByteBuffer.wrap(pcm).order(ByteOrder.LITTLE_ENDIAN);
                for (int i = 0; i < shorts; i++) dest[offset + i] = buffer.getShort();
                return shorts;
            }
            if (args[0] instanceof float[]) {
                int offset = (Integer) args[1];
                int size = (Integer) args[2];
                byte[] pcm = read(rate, channels, 4, size * 4);
                if (pcm == null) return -1;
                int floats = Math.min(size, pcm.length / 4);
                float[] dest = (float[]) args[0];
                ByteBuffer buffer = ByteBuffer.wrap(pcm).order(ByteOrder.LITTLE_ENDIAN);
                for (int i = 0; i < floats; i++) dest[offset + i] = buffer.getFloat();
                return floats;
            }
            if (args[0] instanceof ByteBuffer) {
                int size = (Integer) args[1];
                byte[] pcm = read(rate, channels, encoding, size);
                if (pcm == null) return -1;
                ByteBuffer dest = (ByteBuffer) args[0];
                int count = Math.min(size, pcm.length);
                int saved = dest.position();
                dest.put(pcm, 0, count);
                dest.position(saved);
                return count;
            }
        } catch (Exception ignored) {
            close();
        }
        return -1;
    }

    private byte[] read(int sampleRate, int channels, int encoding, int byteCount) throws IOException {
        if (byteCount <= 0 || byteCount > MAX_PAYLOAD) return null;
        ensure();
        ByteBuffer body = ByteBuffer.allocate(12).order(ByteOrder.LITTLE_ENDIAN);
        body.putInt(sampleRate);
        body.putShort((short) channels);
        body.putShort((short) encoding);
        body.putInt(byteCount);
        writeFrame(16, body.array());
        int type = in.readUnsignedByte();
        int length = in.readInt();
        if (length < 0 || length > MAX_PAYLOAD) {
            close();
            return null;
        }
        byte[] payload = new byte[length];
        if (length > 0) in.readFully(payload);
        if (type == 18) return null;
        if (type != 17) return null;
        return payload;
    }

    private void ensure() throws IOException {
        if (socket != null && socket.isConnected() && !socket.isClosed()) return;
        close();
        Socket opened = new Socket();
        opened.connect(new InetSocketAddress("127.0.0.1", PORT), 400);
        opened.setTcpNoDelay(true);
        opened.setSoTimeout(3000);
        socket = opened;
        in = new DataInputStream(new BufferedInputStream(opened.getInputStream()));
        out = new DataOutputStream(new BufferedOutputStream(opened.getOutputStream()));
        writeFrame(1, "CONSUME".getBytes("UTF-8"));
        out.flush();
    }

    private void writeFrame(int type, byte[] payload) throws IOException {
        out.writeByte(type);
        out.writeInt(payload.length);
        out.write(payload);
        out.flush();
    }

    private void close() {
        if (socket != null) {
            try {
                socket.close();
            } catch (IOException ignored) {
                // reconnect on the next read
            }
        }
        socket = null;
        in = null;
        out = null;
    }

    private static int intMethod(Object target, String name) {
        try {
            Object value = target.getClass().getMethod(name).invoke(target);
            if (value instanceof Integer) return ((Integer) value).intValue();
        } catch (Exception ignored) {
            // recorder is not ready
        }
        return 0;
    }
}
