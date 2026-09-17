package ar.kevinroberts.nicotind.apkupdate;

import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;

import androidx.core.content.FileProvider;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * Sideloaded-APK self-update (no store channel): {@code downloadAndInstall}
 * streams a release APK from GitHub into the app cache and hands it to the
 * system package installer via the app's FileProvider. The installer UI (and
 * the one-time "install unknown apps" grant it may redirect to) is the
 * system's own — D-pad friendly on TV. Progress is emitted as
 * {@code apkDownloadProgress} events so the web UI can show a percentage.
 *
 * {@code getInstallerPackage} exists so the web layer can tell whether it
 * should offer that at all: since #1168 there is ONE APK, and the same binary
 * is sideloaded from GitHub and distributed through our F-Droid repository.
 * Self-updating is right for the first and wrong for the second — F-Droid is
 * the updater there, and a second update path beside it is confusing at best.
 * Asking the system who installed us replaces what used to be a build flavor.
 */
@CapacitorPlugin(name = "NicotindApkUpdate")
public class NicotindApkUpdatePlugin extends Plugin {
    private static final String TAG = "NicotindApkUpdate";

    /**
     * The package that installed this app ("org.fdroid.fdroid" for the F-Droid
     * client, "com.android.packageinstaller"/null for a sideload), or null when
     * the platform will not say.
     *
     * `getInstallSourceInfo` is API 30+; `getInstallerPackageName` is the
     * deprecated fallback that still works down to our minSdk of 26. Both throw
     * for an unknown package, which is reported as null rather than an error —
     * "who installed this" failing is not a reason to break the settings page.
     */
    @PluginMethod
    public void getInstallerPackage(PluginCall call) {
        String installer = null;
        try {
            PackageManager pm = getContext().getPackageManager();
            String self = getContext().getPackageName();
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                installer = pm.getInstallSourceInfo(self).getInstallingPackageName();
            } else {
                installer = pm.getInstallerPackageName(self);
            }
        } catch (Exception e) {
            installer = null;
        }
        JSObject result = new JSObject();
        result.put("installer", installer);
        call.resolve(result);
    }

    @PluginMethod
    public void downloadAndInstall(PluginCall call) {
        String url = call.getString("url");
        if (url == null || url.isEmpty()) {
            call.reject("url is required");
            return;
        }
        String fileName = call.getString("fileName", "update.apk");
        // Own thread: plugin methods may run on the main thread, where Android
        // forbids network I/O.
        new Thread(() -> {
            try {
                File apk = download(url, fileName);
                launchInstaller(apk);
                call.resolve();
            } catch (Exception e) {
                android.util.Log.w(TAG, "downloadAndInstall failed", e);
                call.reject("update download failed: " + e.getMessage());
            }
        }).start();
    }

    private File download(String url, String fileName) throws IOException {
        File dir = new File(getContext().getCacheDir(), "apk-updates");
        if (!dir.isDirectory() && !dir.mkdirs()) {
            throw new IOException("cannot create " + dir);
        }
        File out = new File(dir, fileName);
        HttpURLConnection conn = (HttpURLConnection) new URL(url).openConnection();
        try {
            // GitHub release-asset URLs 302 to a CDN host; https→https redirects
            // are followed by default.
            conn.connect();
            int status = conn.getResponseCode();
            if (status != HttpURLConnection.HTTP_OK) throw new IOException("HTTP " + status);
            long total = conn.getContentLengthLong();
            try (InputStream in = conn.getInputStream();
                    FileOutputStream fos = new FileOutputStream(out)) {
                byte[] buffer = new byte[64 * 1024];
                long read = 0;
                int lastPercent = -1;
                int n;
                while ((n = in.read(buffer)) > 0) {
                    fos.write(buffer, 0, n);
                    read += n;
                    if (total > 0) {
                        int percent = (int) (read * 100 / total);
                        if (percent != lastPercent) {
                            lastPercent = percent;
                            JSObject data = new JSObject();
                            data.put("percent", percent);
                            notifyListeners("apkDownloadProgress", data);
                        }
                    }
                }
            }
        } finally {
            conn.disconnect();
        }
        return out;
    }

    private void launchInstaller(File apk) {
        // The cache dir is covered by the app FileProvider's <cache-path>.
        Uri uri = FileProvider.getUriForFile(
                getContext(), getContext().getPackageName() + ".fileprovider", apk);
        Intent intent = new Intent(Intent.ACTION_VIEW)
                .setDataAndType(uri, "application/vnd.android.package-archive")
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_GRANT_READ_URI_PERMISSION);
        getContext().startActivity(intent);
    }
}
