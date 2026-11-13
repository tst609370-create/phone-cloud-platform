package android.content;
public class Intent {
    public static final int FLAG_ACTIVITY_NEW_TASK = 0x10000000;
    public Intent(String action) { throw new RuntimeException("stub"); }
    public Intent(String action, android.net.Uri uri) { throw new RuntimeException("stub"); }
    public Intent putExtra(String name, String value) { throw new RuntimeException("stub"); }
    public Intent setClassName(String pkg, String cls) { throw new RuntimeException("stub"); }
    public Intent addFlags(int flags) { throw new RuntimeException("stub"); }
    public String getStringExtra(String name) { throw new RuntimeException("stub"); }
    public String getAction() { throw new RuntimeException("stub"); }
}
