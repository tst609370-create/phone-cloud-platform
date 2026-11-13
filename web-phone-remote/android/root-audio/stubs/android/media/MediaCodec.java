package android.media;
public final class MediaCodec {
    public static final int CONFIGURE_FLAG_ENCODE = 1;
    public static final int BUFFER_FLAG_CODEC_CONFIG = 2;
    public static final int INFO_TRY_AGAIN_LATER = -1;
    public static final class BufferInfo { public int offset; public int size; public long presentationTimeUs; public int flags; }
    public static MediaCodec createEncoderByType(String type) throws java.io.IOException { throw new RuntimeException("stub"); }
    public void configure(MediaFormat format, android.view.Surface surface, MediaCrypto crypto, int flags) { throw new RuntimeException("stub"); }
    public void start() { throw new RuntimeException("stub"); }
    public void stop() { throw new RuntimeException("stub"); }
    public void release() { throw new RuntimeException("stub"); }
    public int dequeueInputBuffer(long timeoutUs) { throw new RuntimeException("stub"); }
    public java.nio.ByteBuffer getInputBuffer(int index) { throw new RuntimeException("stub"); }
    public void queueInputBuffer(int index, int offset, int size, long ptsUs, int flags) { throw new RuntimeException("stub"); }
    public int dequeueOutputBuffer(BufferInfo info, long timeoutUs) { throw new RuntimeException("stub"); }
    public java.nio.ByteBuffer getOutputBuffer(int index) { throw new RuntimeException("stub"); }
    public void releaseOutputBuffer(int index, boolean render) { throw new RuntimeException("stub"); }
}
