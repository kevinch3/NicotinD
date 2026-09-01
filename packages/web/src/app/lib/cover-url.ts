/**
 * The `/api/cover/:id` URL, spelled once.
 *
 * `coverArt` on a Song, Track or RecentPlay is a cover *id*, never a URL —
 * putting the raw id in an `<img src>` 404s into the letter placeholder while
 * the player, building the URL properly, shows the real cover. That exact bug
 * shipped once on the landing's resume block.
 *
 * The result is deliberately RELATIVE. Run it through
 * `ServerConfigService.apiUrl()` before it reaches the DOM — the native shell
 * talks to a configured remote base, and a relative cover URL there resolves
 * against the app's own origin and fails. `<app-cover-art>` does this in its
 * `resolvedSrc` computed; callers that bypass the component must do it too.
 */
export function coverUrl(coverArt: string, size: number, token: string | null): string {
  return `/api/cover/${coverArt}?size=${size}&token=${token ?? ''}`;
}

/**
 * Snap a rendered box size to a served cover size, so a 64px tile does not pull
 * a 256px JPEG. The buckets match what the cover route's downscale cache
 * already holds for other call sites; an unbucketed size would miss the cache
 * on every distinct tile size the mosaic produces.
 */
export function coverSizeBucket(px: number): 96 | 160 | 256 {
  if (px <= 96) return 96;
  if (px <= 160) return 160;
  return 256;
}
