package android.app;
public abstract class Service extends android.content.ContextWrapper {
    public Service() { super(null); throw new RuntimeException("stub"); }
    public abstract android.os.IBinder onBind(android.content.Intent intent);
    public int onStartCommand(android.content.Intent intent, int flags, int startId) { throw new RuntimeException("stub"); }
    public void onDestroy() { throw new RuntimeException("stub"); }
    public final void startForeground(int id, Notification n) { throw new RuntimeException("stub"); }
    public final void stopForeground(boolean remove) { throw new RuntimeException("stub"); }
    public final void stopSelf() { throw new RuntimeException("stub"); }
}
