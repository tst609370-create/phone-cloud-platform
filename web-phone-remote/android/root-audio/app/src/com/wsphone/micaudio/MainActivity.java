package com.wsphone.micaudio;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.view.View;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;

/**
 * Desktop entry of 「手机声音」: shows whether recording is allowed and whether sound is
 * being sent, and lets the phone user grant the microphone with one tap when the
 * computer's {@code pm grant} did not stick (MIUI).
 */
public final class MainActivity extends Activity {
    private static final String MIC = "android.permission.RECORD_AUDIO";
    private TextView status;

    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(48, 64, 48, 48);
        TextView title = new TextView(this);
        title.setText("手机声音");
        title.setTextSize(24);
        status = new TextView(this);
        status.setTextSize(17);
        status.setPadding(0, 32, 0, 32);
        Button grant = new Button(this);
        grant.setText("去授权（允许录音）");
        grant.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                requestPermissions(new String[] {MIC}, 1);
            }
        });
        Button settings = new Button(this);
        settings.setText("打开权限设置（自启动、后台弹出界面）");
        settings.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                openSettings();
            }
        });
        TextView help = new TextView(this);
        help.setTextSize(14);
        help.setPadding(0, 32, 0, 0);
        help.setText("这个 App 把手机外放的声音用麦克风录下来传到电脑的远程控制台。平时不用打开，电脑上点「听声音」会自动启动。手机要开着外放、音量调大。");
        root.addView(title);
        root.addView(status);
        root.addView(grant);
        root.addView(settings);
        root.addView(help);
        setContentView(root);
    }

    @Override
    protected void onResume() {
        super.onResume();
        refresh();
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        refresh();
    }

    private void refresh() {
        boolean granted = checkSelfPermission(MIC) == 0;
        status.setText("录音权限：" + (granted ? "已允许" : "未允许（点下面「去授权」）")
                + "\n声音传输：" + (!MicService.streaming ? "没有在传（电脑上点「听声音」开始）"
                        : com.wsphone.rootaudio.RootAudioMain.pausedForCall ? "通话中已暂停，挂断后自动继续" : "正在传给电脑"));
    }

    private void openSettings() {
        // MIUI's own permission page first, then the standard app details page.
        try {
            Intent miui = new Intent("miui.intent.action.APP_PERM_EDITOR");
            miui.setClassName("com.miui.securitycenter", "com.miui.permcenter.permissions.PermissionsEditorActivity");
            miui.putExtra("extra_pkgname", getPackageName());
            startActivity(miui);
            return;
        } catch (Throwable ignored) {
            // not MIUI
        }
        try {
            startActivity(new Intent("android.settings.APPLICATION_DETAILS_SETTINGS", Uri.fromParts("package", getPackageName(), null)));
        } catch (Throwable ignored) {
            // nothing else to open
        }
    }
}
