package com.vlapp.android;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import org.json.JSONArray;
import org.json.JSONObject;

public class MainActivity extends Activity {
    static final String START_URL = "https://videoloader.7hvn4hvz8h.workers.dev";
    WebView webViewRef;

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        DownloadEngine.attach(this);
        webViewRef = new WebView(this);
        WebSettings s = webViewRef.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        webViewRef.addJavascriptInterface(new Bridge(), "AndroidBridge");
        webViewRef.setWebViewClient(new WebViewClient());
        webViewRef.loadUrl(START_URL);
        setContentView(webViewRef);
        if (Build.VERSION.SDK_INT >= 33)
            requestPermissions(new String[]{"android.permission.POST_NOTIFICATIONS"}, 1);
    }

    @Override
    public void onBackPressed() {
        if (webViewRef != null && webViewRef.canGoBack()) webViewRef.goBack();
        else super.onBackPressed();
    }

    @Override
    protected void onDestroy() { DownloadEngine.detach(); super.onDestroy(); }

    void startDlService() {
        Intent i = new Intent(this, DlService.class);
        if (Build.VERSION.SDK_INT >= 26) startForegroundService(i); else startService(i);
    }
    void stopDlService() { stopService(new Intent(this, DlService.class)); }
    void runOnUiThread(Runnable r) { super.runOnUiThread(r); }

    public class Bridge {
        @android.webkit.JavascriptInterface
        public void saveVideo(String url, String name, String size) {
            DownloadEngine.enqueue(url, name);
        }
        @android.webkit.JavascriptInterface
        public void saveVideoBatch(String json) {
            try {
                JSONArray arr = new JSONArray(json);
                for (int i = 0; i < arr.length(); i++) {
                    JSONObject o = arr.getJSONObject(i);
                    DownloadEngine.enqueue(o.getString("url"), o.optString("name", "video.mp4"));
                }
            } catch (Exception ignore) {}
        }
        @android.webkit.JavascriptInterface
        public boolean isAndroidApp() { return true; }
    }
}
