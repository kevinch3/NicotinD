import { Injectable, Injector, NgZone, effect, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { getCapacitorPlugin, getPlatform, isNativePlatform } from '../../lib/platform';
import { rankPlayFromSearch } from '../../lib/play-from-search';
import { PlayerService } from '../player.service';
import { AuthService } from '../auth.service';
import { ServerConfigService } from '../server-config.service';
import { LibraryApiService } from '../api/library-api.service';

/** `@nicotind/capacitor-tv-channels`' native plugin, reached through the
 *  Capacitor global (native-capabilities pattern — no `@capacitor/*` import
 *  in the web bundle). Android-only; every method no-ops off TV natively. */
interface TvChannelsPlugin {
  publishPlayNext(options: { title: string; artist: string; coverUrl?: string }): Promise<void>;
  clearPlayNext(): Promise<void>;
  addListener(event: 'playFromSearch', cb: (data: { query: string }) => void): unknown;
}

/**
 * Google TV launcher integration (Play-Next-only scope): keeps the current
 * track published as the launcher's "Continue listening" Watch Next entry,
 * and answers the Assistant's "play X on NicotinD" voice intent by searching
 * the library (`rankPlayFromSearch`) and starting the best match. The native
 * side gates on UiModeManager, so phones carry the code inert.
 */
@Injectable({ providedIn: 'root' })
export class TvChannelsService {
  private readonly player = inject(PlayerService);
  private readonly auth = inject(AuthService);
  private readonly server = inject(ServerConfigService);
  private readonly api = inject(LibraryApiService);
  private readonly zone = inject(NgZone);
  private readonly injector = inject(Injector);

  initialize(): void {
    if (!isNativePlatform() || getPlatform() !== 'android') return;
    const plugin = getCapacitorPlugin<TvChannelsPlugin>('NicotindTvChannels');
    if (!plugin) return;

    // Retained-event listener: the plugin buffers a cold-start intent until
    // this attaches, so a voice launch still plays.
    plugin.addListener('playFromSearch', ({ query }) =>
      this.zone.run(() => void this.playFromSearch(query)),
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
