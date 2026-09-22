/**
 * Spaced Vorbis comment names, and the canonical names readers actually use.
 *
 * ffmpeg names a Vorbis comment after an ID3 `TXXX` description, uppercased
 * with its spaces intact — `TXXX:MusicBrainz Artist Id` becomes
 * `MUSICBRAINZ ARTIST ID`. Other taggers write spaced names of their own
 * (`ALBUM ARTIST`). Readers look for `MUSICBRAINZ_ARTISTID` and `ALBUMARTIST`.
 *
 * Measured on prod after the full-library conversion (#1250, #1231): 74 of 400
 * sampled `.opus` files carried at least one spaced key. The table below is
 * every one of those that has a canonical name music-metadata's Vorbis mapper
 * reads — the long tail (`RIP DATE`, `AB:HI:*`, `ENCODED BY`) has no reader
 * either way and is left alone.
 */

/**
 * The frames ffmpeg **keeps but renames wrong** during an ID3 → Vorbis encode,
 * for the three ids `AudioTags` models.
 *
 * | ID3 TXXX description | ffmpeg writes | anyone reads |
 * | --- | --- | --- |
 * | `Acoustid Id` | `ACOUSTID ID` | `ACOUSTID_ID` |
 * | `MusicBrainz Track Id` | `MUSICBRAINZ TRACK ID` | `MUSICBRAINZ_TRACKID` |
 * | `MusicBrainz Album Id` | `MUSICBRAINZ ALBUM ID` | `MUSICBRAINZ_ALBUMID` |
 *
 * This is worse than a dropped frame, because the value is still *in* the
 * file — so a "did the data survive?" check says yes while every reader sees
 * nothing. `acoustIdId` doubles as the "already fingerprinted" marker; the two
 * MusicBrainz ids are what match a file back to a release.
 */
export const ID3_TXXX_FFMPEG_MISNAMES = [
  { field: 'acoustIdId', description: 'Acoustid Id', vorbis: 'ACOUSTID_ID' },
  { field: 'mbRecordingId', description: 'MusicBrainz Track Id', vorbis: 'MUSICBRAINZ_TRACKID' },
  { field: 'mbReleaseId', description: 'MusicBrainz Album Id', vorbis: 'MUSICBRAINZ_ALBUMID' },
] as const;

export interface SpacedVorbisKey {
  /** Uppercased, as ffmpeg and music-metadata surface it. */
  spaced: string;
  /** The name music-metadata's Vorbis mapper reads. */
  canonical: string;
  /**
   * The `-metadata` key that produces `canonical`. Differs only for the album
   * artist: ffmpeg's generic name is `album_artist`, and writing the Vorbis
   * spelling adds a second comment beside it instead of replacing it (#914).
   */
  ffmpegKey: string;
}

/**
 * Spaced names for fields `AudioTags` does **not** model. Carried through
 * without the app learning them (#1250) — nothing here reads a release group
 * id, but another player importing the file should.
 */
export const UNMODELLED_SPACED_KEYS: readonly SpacedVorbisKey[] = [
  { spaced: 'ALBUM ARTIST', canonical: 'ALBUMARTIST', ffmpegKey: 'album_artist' },
  ...(
    [
      ['MUSICBRAINZ ARTIST ID', 'MUSICBRAINZ_ARTISTID'],
      ['MUSICBRAINZ ALBUM ARTIST ID', 'MUSICBRAINZ_ALBUMARTISTID'],
      ['MUSICBRAINZ RELEASE GROUP ID', 'MUSICBRAINZ_RELEASEGROUPID'],
      ['MUSICBRAINZ RELEASE TRACK ID', 'MUSICBRAINZ_RELEASETRACKID'],
      ['MUSICBRAINZ WORK ID', 'MUSICBRAINZ_WORKID'],
      ['MUSICBRAINZ ALBUM TYPE', 'RELEASETYPE'],
      ['MUSICBRAINZ ALBUM STATUS', 'RELEASESTATUS'],
      ['MUSICBRAINZ ALBUM RELEASE COUNTRY', 'RELEASECOUNTRY'],
      ['RELEASE TYPE', 'RELEASETYPE'],
    ] as const
  ).map(([spaced, canonical]) => ({ spaced, canonical, ffmpegKey: canonical })),
];

/** Every spaced name a rewrite heals: the modelled three and the rest. */
export const ALL_SPACED_KEYS: readonly SpacedVorbisKey[] = [
  ...ID3_TXXX_FFMPEG_MISNAMES.map((m) => ({
    spaced: m.description.toUpperCase(),
    canonical: m.vorbis,
    ffmpegKey: m.vorbis,
  })),
  ...UNMODELLED_SPACED_KEYS,
];

export interface VorbisComment {
  id: string;
  value: unknown;
}

export interface VorbisKeyPlan {
  /** `KEY=VALUE` strings for `-metadata`; an empty value deletes the key. */
  metadata: string[];
  /** Spaced keys left alone because their canonical twin disagrees. */
  conflicts: Array<{ spaced: string; canonical: string }>;
}

/**
 * What to change so each spaced key in `comments` ends up under its canonical
 * name, once. Pure.
 *
 * - canonical absent → move the value across and delete the spaced key;
 * - canonical present with the same value → delete the spaced key;
 * - canonical present with a **different** value → change nothing and report
 *   it. music-metadata maps `ALBUM ARTIST` too, so the spaced value may be the
 *   one the app reads today; picking a winner is a curation decision, not a
 *   rename (1 of 19 `ALBUM ARTIST` pairs disagreed on prod);
 * - `written` names a canonical key this write sets explicitly → delete the
 *   spaced key regardless, because the caller's value supersedes both.
 *
 * A multi-valued spaced key with no canonical twin is also reported, since one
 * `-metadata` value cannot carry several.
 */
export function planVorbisKeyFixes(
  comments: readonly VorbisComment[],
  opts: { written?: ReadonlySet<string>; keys?: readonly SpacedVorbisKey[] } = {},
): VorbisKeyPlan {
  const written = opts.written ?? new Set<string>();
  const byKey = new Map<string, string[]>();
  for (const c of comments) {
    if (typeof c.value !== 'string') continue;
    const k = c.id.toUpperCase();
    const list = byKey.get(k);
    if (list) list.push(c.value);
    else byKey.set(k, [c.value]);
  }

  const plan: VorbisKeyPlan = { metadata: [], conflicts: [] };
  // Two spaced names can share a canonical one (`RELEASE TYPE`, `MUSICBRAINZ
  // ALBUM TYPE`); the second compares against what the first moved across.
  const moved = new Map<string, string>();
  for (const key of opts.keys ?? ALL_SPACED_KEYS) {
    const spacedValues = byKey.get(key.spaced);
    if (!spacedValues) continue;
    const blank = `${key.spaced}=`;
    if (written.has(key.canonical) || written.has(key.ffmpegKey.toUpperCase())) {
      plan.metadata.push(blank);
      continue;
    }
    const movedValue = moved.get(key.canonical);
    const canonicalValues =
      byKey.get(key.canonical) ?? (movedValue !== undefined ? [movedValue] : undefined);
    if (!canonicalValues) {
      if (spacedValues.length !== 1) {
        plan.conflicts.push({ spaced: key.spaced, canonical: key.canonical });
        continue;
      }
      plan.metadata.push(`${key.ffmpegKey}=${spacedValues[0]}`, blank);
      moved.set(key.canonical, spacedValues[0]!);
      continue;
    }
    const agrees =
      spacedValues.length === 1 &&
      canonicalValues.length === 1 &&
      canonicalValues[0]!.trim() === spacedValues[0]!.trim();
    if (agrees) plan.metadata.push(blank);
    else plan.conflicts.push({ spaced: key.spaced, canonical: key.canonical });
  }
  return plan;
}
