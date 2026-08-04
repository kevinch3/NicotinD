import { Injectable, Injector, NgZone, effect, inject } from '@angular/core';
import { Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { getCapacitorPlugin, getPlatform, isNativePlatform } from '../../lib/platform';
import { rankPlayFromSearch } from '../../lib/play-from-search';
import { sanitizeReturnUrl } from '../../lib/return-url';
import { PlayerService } from '../player.service';
import { AuthService } from '../auth.service';
import { ServerConfigService } from '../server-config.service';
import { LibraryApiService } from '../api/library-api.service';
import { TranslateService } from '../translate.service';

/** One tile in the launcher channel row. */
interface ChannelProgram {
  title: string;
  subtitle: string;
  coverUrl?: string;
  route: string;
}

/** `@nicotind/capacitor-tv-channels`' native plugin, reached through the
 *  Capacitor global (native-capabilities pattern — no `@capacitor/*` import
 *  in the web bundle). Android-only; every method no-ops off TV natively. */
interface TvChannelsPlugin {
  publishPlayNext(options: { title: string; artist: string; coverUrl?: string }): Promise<void>;
  clearPlayNext(): Promise<void>;
  publishChannel(options: { title: string; programs: ChannelProgram[] }): Promise<void>;
  clearChannel(): Promise<void>;
  addListener(event: 'playFromSearch', cb: (data: { query: string }) => void): unknown;
  addListener(event: 'deepLink', cb: (data: { route: string }) => void): unknown;
}

/**
 * Google TV launcher integration: keeps the current track published as the
 * launcher's "Continue listening" Watch Next entry, maintains a "Recently
 * added" preview-channel row of the newest albums whose tiles deep-link back
 * into the app (issue #395), and answers the Assistant's "play X on NicotinD"
 * voice intent by searching the library (`rankPlayFromSearch`) and starting
 * the best match. The native side gates on UiModeManager, so phones carry the
 * code inert.
 */
@Injectable({ providedIn: 'root' })
export class TvChannelsService {
  private readonly player = inject(PlayerService);
  private readonly auth = inject(AuthService);
  private readonly server = inject(ServerConfigService);
  private readonly api = inject(LibraryApiService);
  private readonly i18n = inject(TranslateService);
  private readonly router = inject(Router);
  private readonly zone = inject(NgZone);
  private readonly injector = inject(Injector);

  private plugin: TvChannelsPlugin | null = null;
  private lastChannelSyncKey: string | null = null;

  initialize(): void {
    if (!isNativePlatform() || getPlatform() !== 'android') return;
    const plugin = getCapacitorPlugin<TvChannelsPlugin>('NicotindTvChannels');
    if (!plugin) return;
    this.plugin = plugin;

    // Retained-event listener: the plugin buffers a cold-start intent until
    // this attaches, so a voice launch still plays.
    plugin.addListener('playFromSearch', ({ query }) =>
      this.zone.run(() => void this.playFromSearch(query)),
    );

    // A channel-tile click reopens the app with the tile's route in an intent
    // extra; any app on the device can craft that extra, so it gets the same
    // in-app-path-only sanitization as a returnUrl (issue #231).
    plugin.addListener('deepLink', ({ route }) =>
      this.zone.run(() => void this.router.navigateByUrl(sanitizeReturnUrl(route))),
    );

    // Keep the launcher channel row in sync with auth + language: publish on
    // sign-in (and language switch — the row title is translated), clear on
    // sign-out. The i18n `ready` gate keeps a raw key out of the launcher.
    effect(
      () => {
        const token = this.auth.token();
        if (token && !this.i18n.ready()) return;
        const key = token ? `${token}:${this.i18n.lang()}` : null;
        if (key === this.lastChannelSyncKey) return;
        this.lastChannelSyncKey = key;
        void this.syncChannel();
      },
      { injector: this.injector },
    );

    // Publish/clear the Play Next entry as the current track changes — same
    // absolute-URL + token recipe as the MediaSession artwork.
    effect(
      () => {
        const track = this.player.currentTrack();
        if (!track) {
          void plugin.clearPlayNext().catch(() => {});
          return;
        }
        const token = this.auth.token();
        void plugin
          .publishPlayNext({
            title: track.title,
            artist: track.artist,
            coverUrl: track.coverArt
              ? this.server.apiUrl(`/api/cover/${track.coverArt}?size=600&token=${token}`)
              : undefined,
          })
          .catch(() => {});
      },
      { injector: this.injector },
    );
  }

  /** Publish the newest albums as the launcher's channel row (issue #395);
   *  signed out, clear the row instead. Best-effort like Play Next. */
  async syncChannel(): Promise<void> {
    const plugin = this.plugin;
    if (!plugin) return;
    const token = this.auth.token();
    if (!token) {
      await plugin.clearChannel().catch(() => {});
      return;
    }
    try {
      const albums = await firstValueFrom(this.api.getAlbums('newest', 12));
      await plugin.publishChannel({
        title: this.i18n.t('tv.channelRecentlyAdded'),
        programs: albums.map((album) => ({
          title: album.name,
          subtitle: album.artist,
          ...(album.coverArt
            ? {
                coverUrl: this.server.apiUrl(
                  `/api/cover/${album.coverArt}?size=600&token=${token}`,
                ),
              }
            : {}),
          route: `/library/albums/${album.id}`,
        })),
      });
    } catch {
      // Library unreachable — the launcher keeps the previous row.
    }
  }

  /** Voice query → best library match → play (exposed for tests). */
  async playFromSearch(query: string): Promise<void> {
    try {
      const songs = await firstValueFrom(this.api.getAllSongs(50, 0, { q: query }));
      const best = rankPlayFromSearch(query, songs);
      if (best) this.player.playSingle(best as (typeof songs)[number]);
    } catch {
      // Library unreachable — keep whatever is playing.
    }
  }
}
