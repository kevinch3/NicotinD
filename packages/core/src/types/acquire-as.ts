/**
 * What an acquire submission should tell its downloader the URL *is*.
 *
 * The classification itself (`classifyAcquireUrl`) predates the addon split and
 * was only ever consumed inside `AcquireWatcher` — the in-process engine, which
 * no longer runs now that yt-dlp and spotDL are external addons. The verdict
 * was therefore stranded on a dead path and the addon was told nothing: a
 * Spotify or YouTube playlist URL reached it with `as: undefined`, indistinguishable
 * from a single track. Shared here so both lanes read one precedence.
 */
import { classifyAcquireUrl } from './classify-acquire-url.js';

/** The hint an addon receives (`AddonJobRequest.as`). */
export type AcquireAs = 'playlist' | 'album' | 'single';

/**
 * Resolve the hint for `url`, honouring an explicit caller override.
 *
 * Precedence (unchanged from the in-process engine, so the two can't drift):
 * Spotify/YouTube playlist URLs auto-detect; archive.org items default to
 * `album` and the submitter opts into `playlist` via the link-intent toggle;
 * the override is honoured for anything the classifier does not recognize (a
 * custom share link the user knows is a playlist), and `album` explicitly
 * downgrades a recognized playlist URL to a single-item acquire.
 */
export function resolveAcquireAs(
  url: string,
  override?: 'playlist' | 'album' | null,
): AcquireAs | undefined {
  const { kind } = classifyAcquireUrl(url);
  if (kind === 'playlist') return override === 'album' ? 'album' : 'playlist';
  if (override === 'playlist') return 'playlist';
  if (override === 'album') return 'album';
  if (kind === 'album') return 'album';
  if (kind === 'track') return 'single';
  // `unknown` stays undefined: saying nothing is honest, and lets the addon
  // apply its own default rather than being told a guess.
  return undefined;
}
