import { catchError, firstValueFrom, map, of } from 'rxjs';
import type { LibraryApiService } from '../services/api/library-api.service';
import { VIBE_PRESETS, type VibePreset } from './vibe-presets';

/**
 * The vibe presets this library can actually play (#1739).
 *
 * Most vibes filter on moods or audio-feature buckets that only the analysis
 * sidecar produces. Without it, "Chill" or "Danceable" was a tile that started
 * nothing. Each preset is probed for a single matching song, using the same
 * filter the radio would use, so the answer is the library's own and not a
 * guess from configuration. A probe that fails keeps its vibe: a flaky request
 * should not hide a tile that would have worked, and tapping it still explains
 * itself with "No tracks match that vibe yet".
 */
export async function playableVibes(
  api: Pick<LibraryApiService, 'getAllSongs'>,
): Promise<VibePreset[]> {
  const playable = await Promise.all(
    VIBE_PRESETS.map((preset) =>
      firstValueFrom(
        api.getAllSongs(1, 0, { filter: preset.filter }).pipe(
          map((songs) => songs.length > 0),
          catchError(() => of(true)),
        ),
      ),
    ),
  );
  return VIBE_PRESETS.filter((_, i) => playable[i]);
}
