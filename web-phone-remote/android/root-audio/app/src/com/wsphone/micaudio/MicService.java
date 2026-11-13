package com.wsphone.micaudio;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.drawable.Icon;
import android.net.LocalServerSocket;
import android.net.LocalSocket;
import android.os.IBinder;

import com.wsphone.rootaudio.RootAudioMain;

/**
 * Phone sound for Android 8-10 phones without root: a foreground service records the
 * microphone (the phone plays out loud) and serves the scrcpy-style audio stream on an
 * abstract socket that the computer reaches with {@code adb forward}.
 *
 * <p>Started by the server: {@code am start-foreground-service -n
 * com.wsphone.micaudio/.MicService --es socket wsmic_x --es codec aac}. One connection
 * per start; the service stops itself when the computer hangs up.
 */
public final class MicService extends Service {
    private static final String CHANNEL = "mic";
    private volatile LocalServerSocket server;
    private volatile Thread worker;

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        goForeground();
        if (intent == null || "stop".equals(intent.getAction())) {
            stopNow();
            return 2; // START_NOT_STICKY
        }
        final String name = intent.getStringExtra("socket");
        final String codec = intent.getStringExtra("codec") != null ? intent.getStringExtra("codec") : "aac";
        if (name == null) {
            stopNow();
            return 2;
        }
        closeServer();
        Thread t = new Thread(new Runnable() {
            @Override
            public void run() {
                serve(name, codec);
            }
        }, "mic-audio");
        worker = t;
        t.start();
        return 2;
    }

    private void serve(String name, String codec) {
        LocalSocket client = null;
        try {
            server = new LocalServerSocket(name);
            client = server.accept();
            RootAudioMain.stream(client.getOutputStream(), codec, true, false);
        } catch (Throwable thrown) {
            System.err.println("mic-audio: " + thrown);
        } finally {
            try {
                if (client != null) client.close();
            } catch (Throwable ignored) {
                // ignore
            }
            closeServer();
            if (Thread.currentThread() == worker) stopNow();
        }
    }

    private void closeServer() {
        LocalServerSocket s = server;
        server = null;
        if (s != null) {
            try {
                s.close();
            } catch (Throwable ignored) {
                // ignore
            }
        }
    }

    private void stopNow() {
        try {
            stopForeground(true);
        } catch (Throwable ignored) {
            // ignore
        }
        stopSelf();
    }

    /** Android 8+ needs a visible notification for a service that records. */
    private void goForeground() {
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        nm.createNotificationChannel(new NotificationChannel(CHANNEL, "手机声音", 2));
        Bitmap dot = Bitmap.createBitmap(24, 24, Bitmap.Config.ARGB_8888);
        dot.eraseColor(0xFFFFFFFF);
        Notification n = new Notification.Builder(this, CHANNEL)
                .setSmallIcon(Icon.createWithBitmap(dot))
                .setContentTitle("正在把手机声音传到电脑")
                .setContentText("远程控制台开着「听声音」")
                .setOngoing(true)
                .build();
        startForeground(1, n);
    }

    @Override
    public void onDestroy() {
        closeServer();
        super.onDestroy();
    }
}
