package ar.kevinroberts.nicotind.tvchannels;

import android.app.SearchManager;
import android.app.UiModeManager;
import android.content.Context;
import android.content.Intent;
import android.content.res.Configuration;
import android.net.Uri;
import android.provider.MediaStore;

import androidx.tvprovider.media.tv.TvContractCompat;
import androidx.tvprovider.media.tv.WatchNextProgram;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Android TV launcher integration (Play-Next-only scope):
 *
 * - {@code publishPlayNext}/{@code clearPlayNext} maintain ONE "Continue
 *   listening" entry in the Google TV Watch Next row for the current track.
 *   Everything is gated on {@link UiModeManager} reporting a television, so
 *   the same APK no-ops cleanly on phones. The previous entry's id is kept in
 *   SharedPreferences so each publish replaces rather than accumulates.
 *
 * - The Google Assistant's {@code MEDIA_PLAY_FROM_SEARCH} intent (voice: "play
 *   X on NicotinD") is forwarded to the web app as a {@code playFromSearch}
 *   event. {@code notifyListeners(..., true)} retains the event until the
 *   first listener attaches, covering the cold-start race where the intent
 *   arrives before the web layer is listening.
 */
@CapacitorPlugin(name = "NicotindTvChannels")
public class NicotindTvChannelsPlugin extends Plugin {
    private static final String PREFS = "nicotind_tv_channels";
    private static final String KEY_PROGRAM_ID = "watch_next_program_id";

    @Override
    public void load() {
        if (getActivity() != null) {
            maybeForwardSearchIntent(getActivity().getIntent());
        }
    }

    @Override
    protected void handleOnNewIntent(Intent intent) {
        super.handleOnNewIntent(intent);
        maybeForwardSearchIntent(intent);
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
                    .setIntentUri(launchIntentUri());
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
            android.util.Log.w("NicotindTvChannels", "publishPlayNext failed", e);
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

    /** An intent URI that reopens (or foregrounds) the app from the Play Next
     *  tile — the leanback launch intent on TV, falling back to the plain one. */
    private Uri launchIntentUri() {
        String pkg = getContext().getPackageName();
        Intent launch = getContext().getPackageManager().getLeanbackLaunchIntentForPackage(pkg);
        if (launch == null) {
            launch = getContext().getPackageManager().getLaunchIntentForPackage(pkg);
        }
        if (launch == null) return null;
        return Uri.parse(launch.toUri(Intent.URI_INTENT_SCHEME));
    }
}
