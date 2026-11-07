package com.vlapp.android;

import android.app.Activity;
import android.content.ContentValues;
import android.content.Context;
import android.net.Uri;
import android.os.Environment;
import android.provider.MediaStore;
import android.webkit.WebView;

import org.json.JSONObject;

import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public class DownloadEngine {
    private static final ExecutorService POOL = Executors.newFixedThreadPool(2);
    private static final Map<String, Job> active = new LinkedHashMap<>();
    private static MainActivity main;

    public static void attach(MainActivity activity) { main = activity; }
    public static void detach() { main = null; }

    static class Job {
        String id, url, name, state = "pending", err = "";
        long bytes, total;
        long lastMark; long lastBytes;
        double speed;
    }

    public static void enqueue(String url, String name) {
        final Job j = new Job();
        j.id = Integer.toHexString(url.hashCode()) + "-" + Long.toHexString(System.currentTimeMillis() & 0xFFFF);
        j.url = url; j.name = name;
        final String dupKey = url;
        for (Job x : active.values()) if (x.url.equals(dupKey)) return;
        active.put(j.id, j);
        ensureService();
        pushState();
        POOL.execute(() -> run(j));
    }

    private static void run(Job j) {
        j.state = "downloading";
        pushState();
        Uri collection = MediaStore.Video.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY);
        String safeName = j.name.replaceAll("[\\\\/:*?\"<>|\\r\\n]", "_");
        ContentValues cv = new ContentValues();
        cv.put(MediaStore.Video.Media.DISPLAY_NAME, safeName);
        cv.put(MediaStore.Video.Media.RELATIVE_PATH, "Movies/VideoLoader");
        cv.put(MediaStore.Video.Media.IS_PENDING, 1);
        Context ctx = main != null ? main : null;
        if (ctx == null) { j.state = "failed"; j.err = "no context"; pushState(); return; }
        Uri out = ctx.getContentResolver().insert(collection, cv);
        if (out == null) { j.state = "failed"; j.err = "MediaStore insert failed"; pushState(); return; }
        try {
            URL u = new URL(j.url);
            HttpURLConnection conn = (HttpURLConnection) u.openConnection();
            conn.setConnectTimeout(20000);
            conn.setReadTimeout(60000);
            conn.setInstanceFollowRedirects(true);
            int code = conn.getResponseCode();
            if (code >= 400) throw new Exception("HTTP " + code);
            long total = conn.getContentLength();
            InputStream in = conn.getInputStream();
            OutputStream os = ctx.getContentResolver().openOutputStream(out);
            byte[] buf = new byte[256 * 1024];
            long lastUi = 0;
            int n;
            while ((n = in.read(buf)) > 0) {
                os.write(buf, 0, n);
                j.bytes += n;
                long now = System.currentTimeMillis();
                if (now - lastUi > 500) { j.total = total > 0 ? total : 0; pushState(); lastUi = now; }
            }
            os.flush(); os.close(); in.close();
            cv.clear(); cv.put(MediaStore.Video.Media.IS_PENDING, 0);
            ctx.getContentResolver().update(out, cv, null, null);
            j.state = "done";
            j.bytes = 0; // 已落库
            pushState();
            evalJS("window.nativeSaveDone && window.nativeSaveDone(true, '已存入相册：" + esc(safeName) + "')");
            active.remove(j.id);
            pushState();
        } catch (Exception e) {
            try { ctx.getContentResolver().delete(out, null, null); } catch (Exception ignore) {}
            j.state = "failed";
            j.err = e.getMessage() == null ? e.toString() : e.getMessage();
            pushState();
            evalJS("window.nativeSaveDone && window.nativeSaveDone(false, '失败：" + esc(safeName) + "：" + esc(j.err) + "')");
        }
        if (active.isEmpty()) stopService();
    }

    private static String esc(String s) {
        return s.replace("\\", "\\\\").replace("'", "\\'").replace("\"", "&quot;");
    }

    private static void pushState() {
        StringBuilder arr = new StringBuilder("[");
        boolean first = true;
        for (Job j : active.values()) {
            if (!first) arr.append(",");
            first = false;
            arr.append("{id:'").append(j.id).append("',name:'").append(esc(j.name))
               .append("',state:'").append(j.state).append("',bytes:").append(j.bytes)
               .append(",total:").append(j.total).append(",speed:0")
               .append(",err:'").append(esc(j.err == null ? "" : j.err)).append("'}");
        }
        arr.append("]");
        evalJS("window.nativeQueueProgress && window.nativeQueueProgress({t:" + (active.size())
                + ",d:0,f:0,a:" + active.size() + ",jobs:" + arr + "})");
    }

    private static void evalJS(final String js) {
        if (main == null) return;
        final WebView wv = main.webViewRef;
        if (wv == null) return;
        main.runOnUi(() -> wv.evaluateJavascript(js, null));
    }

    private static void ensureService() { if (main != null) main.startDlService(); }
    private static void stopService() { if (main != null) main.stopDlService(); }
}
