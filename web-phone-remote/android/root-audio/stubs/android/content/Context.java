package android.content;
public abstract class Context {
    public abstract String getPackageName();
    public String getOpPackageName() { throw new RuntimeException("stub"); }
}
