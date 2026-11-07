package com.vlapp.android;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Intent;
import android.os.IBinder;

public class DlService extends Service {
    @Override
    public void onCreate() {
        super.onCreate();
        NotificationManager nm = getSystemService(NotificationManager.class);
        Notification.Builder b;
        if (android.os.Build.VERSION.SDK_INT >= 26) {
            NotificationChannel ch = new NotificationChannel("dl", "下载", NotificationManager.IMPORTANCE_LOW);
            nm.createNotificationChannel(ch);
            b = new Notification.Builder(this, "dl");
        } else {
            b = new Notification.Builder(this);
        }
        b.setContentTitle("VideoLoader 下载中").setSmallIcon(android.R.drawable.stat_sys_download);
        startForeground(1, b.build());
    }
    @Override
    public IBinder onBind(Intent i) { return null; }
}
