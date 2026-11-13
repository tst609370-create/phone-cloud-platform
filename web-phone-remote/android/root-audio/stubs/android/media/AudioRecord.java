package android.media;
public class AudioRecord {
    public static final int STATE_INITIALIZED = 1;
    public AudioRecord(int source, int rate, int channelConfig, int format, int bufferSize) { throw new RuntimeException("stub"); }
    public static int getMinBufferSize(int rate, int channelConfig, int format) { throw new RuntimeException("stub"); }
    public int getState() { throw new RuntimeException("stub"); }
    public int getRecordingState() { throw new RuntimeException("stub"); }
    public void startRecording() { throw new RuntimeException("stub"); }
    public int read(byte[] data, int off, int size) { throw new RuntimeException("stub"); }
    public void stop() { throw new RuntimeException("stub"); }
    public void release() { throw new RuntimeException("stub"); }
}
