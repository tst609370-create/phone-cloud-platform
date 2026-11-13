package android.content;
public abstract class Context {
    public abstract String getPackageName();
    public static final String NOTIFICATION_SERVICE = "notification";
    public Object getSystemService(String name) { throw new RuntimeException("stub"); }
    public String getOpPackageName() { throw new RuntimeException("stub"); }
}
