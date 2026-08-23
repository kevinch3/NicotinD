/**
 * Waveform artifact served by `GET /api/peaks/:id` (issue #643): the min/max
 * envelope the Now Playing strip draws and a coarse six-band energy timeline
 * the karaoke VFX animates against `currentTime`. Produced by
 * `services/waveform-reduce.ts` (api) from one ffmpeg decode — no sidecar —
 * and cached on disk, content-addressed (docs/cache-invalidation.md).
 */
export interface WaveformData {
  /** Bumped with the reducer's definition; the cache key includes it. */
  version: number;
  /** Seconds, from the decoded sample count. */
  duration: number;
  /** Interleaved [min, max, min, max, …] in -1..1 (≤ 600 pairs). */
  peaks: number[];
  /** Band frames per second. */
  frameRate: number;
  /**
   * One row per frame: six levels 0..1 relative to the track's loudest
   * frame-band, ordered sub_bass 20–60 Hz, bass 60–250, low_mid 250–500,
   * mid 500–2k, high_mid 2k–6k, high 6k–16k.
   */
  bands: number[][];
}
