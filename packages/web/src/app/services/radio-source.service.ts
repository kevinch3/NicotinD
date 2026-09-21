import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { PlayerService, shuffleArray } from './player.service';
import { LibraryApiService } from './api/library-api.service';
import { SystemApiService } from './api/system-api.service';
import { toTrack } from '../lib/track-utils';

/**
 * The library side of radio: what `PlayerService` calls when the queue drains.
 *
 * `PlayerService` is deliberately dependency-free, so something with library
 * access has to hand it a `RadioProvider`. That used to be `LayoutComponent`'s
 * `ngOnInit` — the **phone/desktop shell**. A TV build forks at the route level
 * (docs/tv-ux.md) and mounts `TvShellComponent` instead, so the call never ran
 * and `replenishRadio` returned on its first line for the whole life of the
 * app: every TV queue — album, artist, genre, even a vibe tile that sets
 * `radio = true` itself — ended in silence (#1127).
 *
 * It lives here, installed from the app initializer, because "a shell must
 * remember to register the radio source" is not a contract a shell can be
 * trusted with: forgetting it is silent, and the symptom (music stops, twenty
 * minutes later) points nowhere near the cause.
 *
 * `seed.count` is the queue's shortfall against its target depth, so every lane
 * asks for exactly that — normally one track, the replacement for the one just
 * played. The batch size used to be a `10` written here, which is how the depth
 * the listener saw and the depth an admin could set ended up in different files
 * (#1262).
 */
@Injectable({ providedIn: 'root' })
export class RadioSourceService {
  private readonly player = inject(PlayerService);
  private readonly api = inject(LibraryApiService);
  private readonly system = inject(SystemApiService);
  private installed = false;
  private queueTargetLoaded = false;

  /**
   * Read the admin's queue depth into the player, once.
   *
   * Kicked off at install and re-tried from the provider, because install runs
   * from the app initializer — which on a cold launch is before there is a
   * session to read it with. Latching only on success means a 401 there costs
   * one retry on the first replenish instead of the whole session's setting; a
   * server too old to have the field answers without one, which still counts as
   * an answer and the built-in default stands.
   */
  private async syncQueueTarget(): Promise<void> {
    if (this.queueTargetLoaded) return;
    try {
      const settings = await firstValueFrom(this.system.getRadioSettings());
      this.queueTargetLoaded = true;
      if (typeof settings.queueTarget === 'number') {
        this.player.radioQueueTarget.set(settings.queueTarget);
      }
    } catch {
      /* No session yet, or the server is unreachable — the default stands. */
    }
  }

  /** Idempotent: the initializer calls it once, and a second call is a no-op. */
  install(): void {
    if (this.installed) return;
    this.installed = true;
    void this.syncQueueTarget();
    // Radio source: metadata-aware track selection so playback continues with
    // musically similar tracks. Falls back to shuffled recent songs when no seed.
    this.player.setRadioProvider(async (seed) => {
      // Cheap after the first success; the retry only matters on a cold launch.
      await this.syncQueueTarget();
      const exclude = [
        seed.currentTrack?.id,
        ...this.player.queue().map((t) => t.id),
        ...this.player
          .history()
          .slice(-20)
          .map((t) => t.id),
      ].filter((id): id is string => !!id);

      // Filter "vibe" radio: keep pulling in-filter tracks so the mood holds.
      const filter = this.player.radioFilter();
      if (filter) {
        const songs = await firstValueFrom(
          // The player lane is the one that reports provenance (#1124) — the
          // chip describes the radio you are hearing, not a shelf's query.
          this.api.getFilterRadio(filter, exclude, seed.count, seed.strategy, { provenance: true }),
        );
        if (songs.length) return songs.map((s) => toTrack(s));
        // Filter exhausted → fall through to seed/shuffle so playback continues.
      }

      if (!seed.currentTrack) {
        // Cold start: nothing to be similar to, so shuffle the recent library and
        // hand back only the depth asked for. Once a track is playing the seed
        // lane below takes over, so this pool is drawn at most once per start.
        const songs = await firstValueFrom(this.api.getAllSongs(200, 0, { sort: 'newest' }));
        return shuffleArray(songs.map((s) => toTrack(s))).slice(0, seed.count);
      }
      const songs = await firstValueFrom(
        this.api.getRadioNext(seed.currentTrack.id, exclude, seed.count, seed.strategy, {
          provenance: true,
        }),
      );
      return songs.map((s) => toTrack(s));
    });
  }
}
