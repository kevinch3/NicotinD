// Song-first view of raw Soulseek network results.
//
// The network search returns individual files; the folder view groups them by
// peer directory, which is great for grabbing a whole album but poor for the
// "I just want this one song" case (a user hunting "Toxic" must eyeball dozens of
// peer folders). `groupBySong` collapses the flat file list into one row per song
// — deduped across peers by (artist, title) — and picks the best available copy
// (FLAC > other lossless > highest-bitrate lossy, then the most available peer) so
// a single click downloads the right file. See docs/e2e-playground-findings §F1.

export interface SongVersion {
  username: string;
  filename: string;
  size: number;
  bitRate?: number;
  length?: number;
  title?: string;
  artist?: string;
  album?: string;
  freeUploadSlots?: number;
  uploadSpeed?: number;
  queueLength?: number;
}

export interface SongResult {
  /** Normalized dedupe key (artist + title). */
  key: string;
  /** Display title (from the best version). */
  title: string;
  /** Display artist (from the best version; may be ''). */
  artist: string;
  /** The auto-selected best copy across all peers. */
  best: SongVersion;
  /** Every copy, best-first — backs an optional "N versions" affordance. */
  versions: SongVersion[];
}

const LOSSLESS = new Set(['flac', 'wav', 'aiff', 'aif', 'ape', 'wv', 'alac']);

export function fileExt(filename: string): string {
  const m = filename.toLowerCase().match(/\.([a-z0-9]+)$/);
  return m ? m[1] : '';
}

/** True when the file's extension is a lossless audio format. */
export function isLossless(filename: string): boolean {
  return LOSSLESS.has(fileExt(filename));
}

function formatRank(ext: string): number {
  if (ext === 'flac') return 3;
  if (LOSSLESS.has(ext)) return 2;
  return 1; // lossy
}

// Lossless files carry no meaningful bitrate to compare, so treat them as
// effectively maximal when ranking within the same format tier.
function effectiveBitrate(f: SongVersion): number {
  return f.bitRate ?? (LOSSLESS.has(fileExt(f.filename)) ? 9999 : 0);
}

function hasFreeSlot(f: SongVersion): boolean {
  return (f.freeUploadSlots ?? 0) > 0;
}

/**
 * Comparator (best-first): format tier, then bitrate, then peer availability
 * (free slot, shorter queue, faster upload), then size, then a stable filename
 * tiebreak.
 */
export function compareVersions(a: SongVersion, b: SongVersion): number {
  const fr = formatRank(fileExt(b.filename)) - formatRank(fileExt(a.filename));
  if (fr) return fr;
  const br = effectiveBitrate(b) - effectiveBitrate(a);
  if (br) return br;
  const slot = (hasFreeSlot(b) ? 1 : 0) - (hasFreeSlot(a) ? 1 : 0);
  if (slot) return slot;
  const queue = (a.queueLength ?? 0) - (b.queueLength ?? 0);
  if (queue) return queue;
  const speed = (b.uploadSpeed ?? 0) - (a.uploadSpeed ?? 0);
  if (speed) return speed;
  const size = (b.size ?? 0) - (a.size ?? 0);
  if (size) return size;
  return a.filename.localeCompare(b.filename);
}

function baseName(filepath: string): string {
  const parts = filepath.split(/[\\/]/);
  return parts[parts.length - 1] ?? filepath;
}

/** Title to display/group on: tag title if present, else the filename stem with a
 * leading track number stripped ("03 - Toxic.flac" → "Toxic"). */
export function songTitle(f: SongVersion): string {
  const tagged = f.title?.trim();
  if (tagged) return tagged;
  return baseName(f.filename)
    .replace(/\.[^/.]+$/, '') // extension
    .replace(/^\d{1,3}[\s.\-_]+/, '') // leading track number
    .trim();
}

function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\w\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Dedupe key. Artist scopes the title so two different "Intro" tracks don't
 * merge; when the artist is unknown we key on title alone (best effort). */
export function songKey(artist: string, title: string): string {
  const t = normalize(title.replace(/^\d{1,3}[\s.\-_]+/, ''));
  const a = normalize(artist);
  if (!t) return '';
  return a ? `${a}␟${t}` : t;
}

function queryTerms(query?: string): string[] {
  if (!query) return [];
  return normalize(query)
    .split(' ')
    .filter((t) => t.length > 1);
}

function relevance(r: SongResult, terms: string[]): number {
  if (!terms.length) return 0;
  const hay = normalize(`${r.artist} ${r.title}`);
  return terms.reduce((n, t) => (hay.includes(t) ? n + 1 : n), 0);
}

/**
 * Collapse flat network files into one row per song, best copy first, ordered by
 * how well each matches the query (so the searched song surfaces at the top) then
 * by the quality of its best copy.
 */
export function groupBySong(files: SongVersion[], query?: string): SongResult[] {
  const map = new Map<string, SongVersion[]>();
  for (const f of files) {
    if (!f.size) continue;
    const key = songKey(f.artist?.trim() ?? '', songTitle(f));
    if (!key) continue;
    const bucket = map.get(key);
    if (bucket) bucket.push(f);
    else map.set(key, [f]);
  }

  const results: SongResult[] = [];
  for (const [key, versions] of map) {
    versions.sort(compareVersions);
    const best = versions[0];
    results.push({ key, title: songTitle(best), artist: best.artist?.trim() ?? '', best, versions });
  }

  const terms = queryTerms(query);
  results.sort(
    (a, b) => relevance(b, terms) - relevance(a, terms) || compareVersions(a.best, b.best),
  );
  return results;
}

/** Short format badge for a version, e.g. "FLAC" or "320k MP3". */
export function formatBadge(f: SongVersion): string {
  const ext = fileExt(f.filename).toUpperCase();
  if (LOSSLESS.has(fileExt(f.filename))) return ext || 'AUDIO';
  return f.bitRate ? `${f.bitRate}k ${ext}` : ext || 'AUDIO';
}
