package android.content;
public abstract class Context {
    public abstract String getPackageName();
    public static final String NOTIFICATION_SERVICE = "notification";
    public Object getSystemService(String name) { throw new RuntimeException("stub"); }
    public static final String APP_OPS_SERVICE = "appops";
    public static final String AUDIO_SERVICE = "audio";
    public int checkSelfPermission(String permission) { throw new RuntimeException("stub"); }
    public String getOpPackageName() { throw new RuntimeException("stub"); }
}
