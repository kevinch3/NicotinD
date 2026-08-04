package ar.kevinroberts.nicotind.tvchannels;

import android.app.SearchManager;
import android.app.UiModeManager;
import android.content.ContentUris;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.content.res.Configuration;
import android.database.Cursor;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.drawable.Drawable;
import android.net.Uri;
import android.provider.MediaStore;

import androidx.tvprovider.media.tv.Channel;
import androidx.tvprovider.media.tv.ChannelLogoUtils;
import androidx.tvprovider.media.tv.PreviewProgram;
import androidx.tvprovider.media.tv.TvContractCompat;
import androidx.tvprovider.media.tv.WatchNextProgram;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONObject;

/**
 * Android TV launcher integration:
 *
 * - {@code publishPlayNext}/{@code clearPlayNext} maintain ONE "Continue
 *   listening" entry in the Google TV Watch Next row for the current track.
 *   Everything is gated on {@link UiModeManager} reporting a television, so
 *   the same APK no-ops cleanly on phones. The previous entry's id is kept in
 *   SharedPreferences so each publish replaces rather than accumulates.
 *
 * - {@code publishChannel}/{@code clearChannel} (issue #395) maintain ONE
 *   preview channel row on the launcher home ("Recently added" albums).
 *   Replace-all semantics: each publish wipes the channel's programs and
 *   re-inserts, same id-in-SharedPreferences bookkeeping as Play Next. Each
 *   tile's intent URI carries the album's in-app route as an extra, forwarded
 *   to the web app as a {@code deepLink} event.
 *
 * - The Google Assistant's {@code MEDIA_PLAY_FROM_SEARCH} intent (voice: "play
 *   X on NicotinD") is forwarded to the web app as a {@code playFromSearch}
 *   event. {@code notifyListeners(..., true)} retains the event until the
 *   first listener attaches, covering the cold-start race where the intent
 *   arrives before the web layer is listening.
 */
@CapacitorPlugin(name = "NicotindTvChannels")
public class NicotindTvChannelsPlugin extends Plugin {
    private static final String TAG = "NicotindTvChannels";
    private static final String PREFS = "nicotind_tv_channels";
    private static final String KEY_PROGRAM_ID = "watch_next_program_id";
    private static final String KEY_CHANNEL_ID = "channel_id";
    private static final String EXTRA_ROUTE = "nicotind_route";

    @Override
    public void load() {
        if (getActivity() != null) {
            maybeForwardSearchIntent(getActivity().getIntent());
            maybeForwardDeepLink(getActivity().getIntent());
        }
    }

    @Override
    protected void handleOnNewIntent(Intent intent) {
        super.handleOnNewIntent(intent);
        maybeForwardSearchIntent(intent);
        maybeForwardDeepLink(intent);
    }

    private void maybeForwardDeepLink(Intent intent) {
        if (intent == null) return;
        String route = intent.getStringExtra(EXTRA_ROUTE);
        if (route == null || route.trim().isEmpty()) return;
        // Consume it so an activity recreation doesn't re-navigate.
        intent.removeExtra(EXTRA_ROUTE);
        JSObject data = new JSObject();
        data.put("route", route.trim());
        notifyListeners("deepLink", data, true);
    }

    private void maybeForwardSearchIntent(Intent intent) {
        if (intent == null) return;
        if (!MediaStore.INTENT_ACTION_MEDIA_PLAY_FROM_SEARCH.equals(intent.getAction())) return;
        String query = intent.getStringExtra(SearchManager.QUERY);
        if (query == null || query.trim().isEmpty()) return;
        JSObject data = new JSObject();
        data.put("query", query.trim());
        notifyListeners("playFromSearch", data, true);
    }

    private boolean isTelevision() {
        UiModeManager uiMode = (UiModeManager) getContext().getSystemService(Context.UI_MODE_SERVICE);
        return uiMode != null
                && uiMode.getCurrentModeType() == Configuration.UI_MODE_TYPE_TELEVISION;
    }

    @PluginMethod
    public void publishPlayNext(PluginCall call) {
        if (!isTelevision()) {
            call.resolve();
            return;
        }
        String title = call.getString("title");
        if (title == null || title.isEmpty()) {
            call.reject("title is required");
            return;
        }
        String artist = call.getString("artist", "");
        String coverUrl = call.getString("coverUrl");
        try {
            deleteStoredProgram();
            WatchNextProgram.Builder builder = new WatchNextProgram.Builder();
            builder
                    .setType(TvContractCompat.WatchNextPrograms.TYPE_CLIP)
                    .setWatchNextType(TvContractCompat.WatchNextPrograms.WATCH_NEXT_TYPE_CONTINUE)
                    .setLastEngagementTimeUtcMillis(System.currentTimeMillis())
                    .setTitle(title)
                    .setDescription(artist)
                    .setIntentUri(launchIntentUri(null));
            if (coverUrl != null && !coverUrl.isEmpty()) {
                builder
                        .setPosterArtUri(Uri.parse(coverUrl))
                        .setPosterArtAspectRatio(TvContractCompat.PreviewPrograms.ASPECT_RATIO_1_1);
            }
            Uri inserted = getContext()
                    .getContentResolver()
                    .insert(
                            TvContractCompat.WatchNextPrograms.CONTENT_URI,
                            builder.build().toContentValues());
            if (inserted != null) {
                long id = android.content.ContentUris.parseId(inserted);
                getContext()
                        .getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                        .edit()
                        .putLong(KEY_PROGRAM_ID, id)
                        .apply();
            }
            call.resolve();
        } catch (Exception e) {
            android.util.Log.w(TAG, "publishPlayNext failed", e);
            // A launcher without the TV provider (or a policy denial) must
            // never break playback — Play Next is best-effort.
            call.resolve();
        }
    }

    @PluginMethod
    public void clearPlayNext(PluginCall call) {
        if (isTelevision()) {
            try {
                deleteStoredProgram();
            } catch (Exception ignored) {
                // best-effort, see publishPlayNext
            }
        }
        call.resolve();
    }

    private void deleteStoredProgram() {
        long id = getContext()
                .getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .getLong(KEY_PROGRAM_ID, -1);
        if (id < 0) return;
        getContext()
                .getContentResolver()
                .delete(TvContractCompat.buildWatchNextProgramUri(id), null, null);
        getContext()
                .getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .edit()
                .remove(KEY_PROGRAM_ID)
                .apply();
    }

    @PluginMethod
    public void publishChannel(PluginCall call) {
        if (!isTelevision()) {
            call.resolve();
            return;
        }
        String title = call.getString("title");
        if (title == null || title.isEmpty()) {
            call.reject("title is required");
            return;
        }
        try {
            long channelId = ensureChannel(title);
            if (channelId >= 0) {
                deleteChannelPrograms(channelId);
                JSArray programs = call.getArray("programs");
                if (programs != null) {
                    for (int i = 0; i < programs.length(); i++) {
                        insertProgram(channelId, programs.getJSONObject(i));
                    }
                }
            }
            call.resolve();
        } catch (Exception e) {
            android.util.Log.w(TAG, "publishChannel failed", e);
            // Best-effort like Play Next — a launcher without the TV provider
            // must never break the app.
            call.resolve();
        }
    }

    @PluginMethod
    public void clearChannel(PluginCall call) {
        if (isTelevision()) {
            try {
                long id = getContext()
                        .getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                        .getLong(KEY_CHANNEL_ID, -1);
                if (id >= 0) {
                    // Deleting the channel row also deletes its programs.
                    getContext()
                            .getContentResolver()
                            .delete(TvContractCompat.buildChannelUri(id), null, null);
                    getContext()
                            .getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                            .edit()
                            .remove(KEY_CHANNEL_ID)
                            .apply();
                }
            } catch (Exception e) {
                android.util.Log.w(TAG, "clearChannel failed", e);
            }
        }
        call.resolve();
    }

    /** Get-or-create the app's single preview channel, refreshing its display
     *  name (a language switch retitles the row). Returns -1 on failure. */
    private long ensureChannel(String title) {
        Context ctx = getContext();
        long id = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getLong(KEY_CHANNEL_ID, -1);
        if (id >= 0) {
            try (Cursor cursor = ctx.getContentResolver()
                    .query(TvContractCompat.buildChannelUri(id), null, null, null, null)) {
                if (cursor != null && cursor.moveToFirst()) {
                    // Only the display name — the provider forbids re-writing
                    // immutable columns like TYPE on update.
                    ContentValues values = new ContentValues();
                    values.put(TvContractCompat.Channels.COLUMN_DISPLAY_NAME, title);
                    ctx.getContentResolver()
                            .update(TvContractCompat.buildChannelUri(id), values, null, null);
                    return id;
                }
            }
        }
        Channel channel = new Channel.Builder()
                .setType(TvContractCompat.Channels.TYPE_PREVIEW)
                .setDisplayName(title)
                .setAppLinkIntentUri(launchIntentUri(null))
                .build();
        Uri inserted = ctx.getContentResolver()
                .insert(TvContractCompat.Channels.CONTENT_URI, channel.toContentValues());
        if (inserted == null) return -1;
        id = ContentUris.parseId(inserted);
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .edit()
                .putLong(KEY_CHANNEL_ID, id)
                .apply();
        storeChannelLogo(id);
        try {
            // Asks the launcher to surface the row; some launchers auto-show
            // an app's first channel and ignore this.
            TvContractCompat.requestChannelBrowsable(ctx, id);
        } catch (Exception ignored) {
        }
        return id;
    }

    /** The channel logo is required by the TV provider contract — rendered
     *  from the app icon so there is no second asset to keep in sync. */
    private void storeChannelLogo(long channelId) {
        try {
            Drawable icon = getContext()
                    .getPackageManager()
                    .getApplicationIcon(getContext().getPackageName());
            int w = Math.max(icon.getIntrinsicWidth(), 1);
            int h = Math.max(icon.getIntrinsicHeight(), 1);
            Bitmap bitmap = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888);
            Canvas canvas = new Canvas(bitmap);
            icon.setBounds(0, 0, w, h);
            icon.draw(canvas);
            ChannelLogoUtils.storeChannelLogo(getContext(), channelId, bitmap);
        } catch (Exception e) {
            android.util.Log.w(TAG, "channel logo failed", e);
        }
    }

    /** The preview-program table can't be queried with a selection, so filter
     *  client-side; the provider only ever returns this app's own rows. */
    private void deleteChannelPrograms(long channelId) {
        try (Cursor cursor = getContext().getContentResolver()
                .query(
                        TvContractCompat.PreviewPrograms.CONTENT_URI,
                        new String[] {
                            TvContractCompat.PreviewPrograms._ID,
                            TvContractCompat.PreviewPrograms.COLUMN_CHANNEL_ID
                        },
                        null,
                        null,
                        null)) {
            if (cursor == null) return;
            while (cursor.moveToNext()) {
                if (cursor.getLong(1) != channelId) continue;
                getContext()
                        .getContentResolver()
                        .delete(TvContractCompat.buildPreviewProgramUri(cursor.getLong(0)), null, null);
            }
        }
    }

    private void insertProgram(long channelId, JSONObject program) throws org.json.JSONException {
        PreviewProgram.Builder builder = new PreviewProgram.Builder();
        builder
                .setChannelId(channelId)
                .setType(TvContractCompat.PreviewPrograms.TYPE_ALBUM)
                .setTitle(program.getString("title"))
                .setDescription(program.optString("subtitle", ""))
                .setIntentUri(launchIntentUri(program.optString("route", null)));
        String coverUrl = program.optString("coverUrl", "");
        if (!coverUrl.isEmpty()) {
            builder
                    .setPosterArtUri(Uri.parse(coverUrl))
                    .setPosterArtAspectRatio(TvContractCompat.PreviewPrograms.ASPECT_RATIO_1_1);
        }
        getContext()
                .getContentResolver()
                .insert(TvContractCompat.PreviewPrograms.CONTENT_URI, builder.build().toContentValues());
    }

    /** An intent URI that reopens (or foregrounds) the app from a launcher
     *  tile — the leanback launch intent on TV, falling back to the plain one.
     *  A non-null {@code route} rides along as an extra and is forwarded to
     *  the web app as a {@code deepLink} event on (re)launch. */
    private Uri launchIntentUri(String route) {
        String pkg = getContext().getPackageName();
        Intent launch = getContext().getPackageManager().getLeanbackLaunchIntentForPackage(pkg);
        if (launch == null) {
            launch = getContext().getPackageManager().getLaunchIntentForPackage(pkg);
        }
        if (launch == null) return null;
        if (route != null && !route.isEmpty()) {
            launch.putExtra(EXTRA_ROUTE, route);
        }
        return Uri.parse(launch.toUri(Intent.URI_INTENT_SCHEME));
    }
}
