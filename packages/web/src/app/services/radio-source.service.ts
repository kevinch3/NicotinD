import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { PlayerService, shuffleArray } from './player.service';
import { LibraryApiService } from './api/library-api.service';
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
 */
@Injectable({ providedIn: 'root' })
export class RadioSourceService {
  private readonly player = inject(PlayerService);
  private readonly api = inject(LibraryApiService);
  private installed = false;

  /** Idempotent: the initializer calls it once, and a second call is a no-op. */
  install(): void {
    if (this.installed) return;
    this.installed = true;
    // Radio source: metadata-aware track selection so playback continues with
    // musically similar tracks. Falls back to shuffled recent songs when no seed.
    this.player.setRadioProvider(async (seed) => {
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
          this.api.getFilterRadio(filter, exclude, 10, seed.strategy, { provenance: true }),
        );
        if (songs.length) return songs.map((s) => toTrack(s));
        // Filter exhausted → fall through to seed/shuffle so playback continues.
      }

      if (!seed.currentTrack) {
        const songs = await firstValueFrom(this.api.getAllSongs(200, 0, { sort: 'newest' }));
        return shuffleArray(songs.map((s) => toTrack(s)));
      }
      const songs = await firstValueFrom(
        this.api.getRadioNext(seed.currentTrack.id, exclude, 10, seed.strategy, {
          provenance: true,
        }),
      );
      return songs.map((s) => toTrack(s));
    });
  }
}
