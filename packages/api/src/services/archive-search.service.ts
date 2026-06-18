import { createLogger, ServiceUnavailableError, type ArchiveCandidate } from '@nicotind/core';

const log = createLogger('archive-search');

const ADVANCED_SEARCH = 'https://archive.org/advancedsearch.php';
const METADATA_BASE = 'https://archive.org/metadata';
const DEFAULT_ROWS = 20;
// archive.org occasionally rate-limits or blips; one immediate retry recovers
// transient failures so a flaky response doesn't masquerade as "no results".
const MAX_RETRIES = 1;

// archive.org collections that are `mediatype:audio` but **not music** —
// audiobooks, spoken word, old-time radio, podcasts, sermons. A bare
// title/creator phrase match otherwise surfaces these (e.g. a LibriVox
// "Patchwork Girl of Oz" ranks for the query "Shaggy"), and downloading one
// ingests a multi-chapter audiobook as a bogus album. Excluding the collections
// keeps the lane musical. See docs/e2e-playground-findings-2026-06.md §B1.
const NON_MUSIC_COLLECTIONS = [
  'librivoxaudio',
  'audiobooksandpoetry', // umbrella over librivox/books/poetry — catches non-librivox audiobooks
  'audio_bookspoetry',
  'oldtimeradio',
  'radioprograms',
  'radio', // umbrella radio collection
  'podcasts',
  'audio_religion',
  'audio_news',
  'audio_tech', // lectures / tech talks
  'gratefuldead', // live-tape archive that floods "best of" queries (not studio music)
  'etree', // live concert recordings archive — same flooding problem
];

// Cap how many deduped items we enrich with a per-item metadata lookup (track
// count). archive.org's metadata endpoint is one request per item, fired in
// parallel; this keeps a search to a bounded fan-out.
const MAX_ENRICH = 16;

/** A single file the metadata API reports for an item. */
interface MetaFile {
  name: string;
  format?: string;
}

const AUDIO_EXTS = new Set(['.mp3', '.flac', '.ogg', '.opus', '.m4a', '.wav', '.aac', '.wma']);

/**
 * Count the audio tracks an item would yield: group audio files by format and
 * return the largest group's size (mirrors the archive plugin's single-format
 * selection, so a FLAC+MP3 dual-encoded album counts once, not twice). Pure.
 */
export function countArchiveTracks(files: MetaFile[]): number {
  const byFormat = new Map<string, number>();
  for (const f of files) {
    const ext = f.name.slice(f.name.lastIndexOf('.')).toLowerCase();
    if (!AUDIO_EXTS.has(ext)) continue;
    const key = (f.format ?? ext).toLowerCase();
    byFormat.set(key, (byFormat.get(key) ?? 0) + 1);
  }
  return byFormat.size ? Math.max(...byFormat.values()) : 0;
}

interface ArchiveDoc {
  identifier: string;
  title?: string | string[];
  creator?: string | string[];
  year?: string | number;
}

interface AdvancedSearchResponse {
  response?: { docs?: ArchiveDoc[] };
}

const first = (v: string | string[] | undefined): string =>
  Array.isArray(v) ? (v[0] ?? '') : (v ?? '');

/** Quote a term as a Lucene phrase, escaping embedded quotes/backslashes. */
const phrase = (term: string): string => `"${term.replace(/[\\"]/g, '\\$&')}"`;

// Noise tokens stripped before deduping so format/quality/year variants of the
// same release collapse to one key.
const FORMAT_NOISE =
  /\b(flac|mp3|320|256|192|128|kbps|vbr|cbr|aac|ogg|opus|wav|m4a|24 ?bit|16 ?bit|hi ?res|lossless|remaster(ed)?|deluxe|edition)\b/g;

/**
 * Normalized dedupe key for an item: diacritic-folded, bracket/format/year noise
 * removed, reduced to a sorted set of tokens drawn from creator + title. This
 * collapses obvious variants of the same release — e.g.
 * `Porfiado · El Cuarteto De Nos` and `El Cuarteto de Nos - Porfiado (2012) [FLAC]`
 * both reduce to `cuarteto de el nos porfiado`. See findings §H4.
 */
export function archiveDedupeKey(c: { creator: string; title: string }): string {
  const raw = `${c.creator} ${c.title}`
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\[[^\]]*\]|\([^)]*\)|\{[^}]*\}/g, ' ') // drop bracketed tags
    .replace(/\b(19|20)\d{2}\b/g, ' ') // drop years
    .replace(FORMAT_NOISE, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  return [...new Set(raw.split(' ').filter(Boolean))].sort().join(' ');
}

/**
 * Read-only metadata lane over archive.org's `advancedsearch.php`. Turns a free
 * text query (unified search) or an artist+album pair (hunt modal) into a list of
 * downloadable item candidates. It never downloads — the client hands a
 * candidate's `detailsUrl` to `/api/acquire`, which the `archive` plugin resolves.
 *
 * Queries are **field-targeted and phrase-quoted** (`title:`/`creator:`) rather
 * than a bare full-text match: an unscoped `(terms) AND mediatype:audio` matched
 * any audio item that merely *mentioned* the words (radio shows, mixtapes), which
 * buried real albums. See docs/e2e-playground-findings-2026-06.md §B.
 */
export class ArchiveSearchService {
  constructor(private readonly fetchFn: typeof fetch = fetch) {}

  /** Free-text search (used by the main unified-search page). */
  async search(query: string, rows = DEFAULT_ROWS): Promise<ArchiveCandidate[]> {
    const terms = query.trim();
    if (!terms) return [];
    // Match the phrase against the music-relevant fields, not the full text.
    return this.run(`(title:(${phrase(terms)}) OR creator:(${phrase(terms)}))`, rows);
  }

  /** Targeted artist + album search (used by the album-hunt modal). */
  async searchAlbum(
    artist: string,
    album: string,
    rows = DEFAULT_ROWS,
  ): Promise<ArchiveCandidate[]> {
    const clauses: string[] = [];
    if (artist.trim()) clauses.push(`creator:(${phrase(artist.trim())})`);
    if (album.trim()) clauses.push(`title:(${phrase(album.trim())})`);
    if (clauses.length === 0) return [];
    return this.run(clauses.join(' AND '), rows);
  }

  private async run(expr: string, rows: number): Promise<ArchiveCandidate[]> {
    // Constrain to music: audio mediatype, minus the spoken-word/radio
    // collections that otherwise drown real albums (see NON_MUSIC_COLLECTIONS).
    const exclude = `-collection:(${NON_MUSIC_COLLECTIONS.join(' OR ')})`;
    const q = `${expr} AND mediatype:audio AND ${exclude}`;
    const params = new URLSearchParams({ q, rows: String(rows), page: '1', output: 'json' });
    for (const fl of ['identifier', 'title', 'creator', 'year']) params.append('fl[]', fl);
    // Rank by popularity so real, widely-downloaded music floats above obscure
    // mashups/uploads of unknown provenance.
    params.append('sort[]', 'downloads desc');
    const url = `${ADVANCED_SEARCH}?${params.toString()}`;

    const res = await this.fetchWithRetry(url);
    const body = (await res.json()) as AdvancedSearchResponse;
    const docs = body.response?.docs ?? [];
    const candidates = docs
      .filter((d) => d.identifier)
      .map((d) => ({
        identifier: d.identifier,
        title: first(d.title) || d.identifier,
        creator: first(d.creator),
        year: d.year != null ? String(d.year) : null,
        detailsUrl: `https://archive.org/details/${encodeURIComponent(d.identifier)}`,
      }));
    // Collapse format/quality/year variants of the same release. Results are
    // popularity-sorted, so keeping the first occurrence keeps the best copy.
    const seen = new Set<string>();
    const deduped = candidates.filter((c) => {
      const key = archiveDedupeKey(c);
      if (!key) return true;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    return this.enrichTrackCounts(deduped);
  }

  /**
   * Annotate each candidate with its audio track count + kind (album/single) via a
   * bounded, parallel per-item metadata lookup. Items the lookup proves have **no
   * audio files** are dropped (more non-music junk removed); a failed/absent lookup
   * leaves `trackCount`/`kind` null so the item still shows (degrades gracefully).
   */
  private async enrichTrackCounts(candidates: ArchiveCandidate[]): Promise<ArchiveCandidate[]> {
    const head = candidates.slice(0, MAX_ENRICH);
    const tail = candidates.slice(MAX_ENRICH);

    const enriched = await Promise.all(
      head.map(async (c): Promise<ArchiveCandidate | null> => {
        const count = await this.fetchTrackCount(c.identifier);
        if (count === null) return { ...c, trackCount: null, kind: null };
        if (count === 0) return null; // metadata-only / non-audio item — drop it
        return { ...c, trackCount: count, kind: count === 1 ? 'single' : 'album' };
      }),
    );

    return [...enriched.filter((c): c is ArchiveCandidate => c !== null), ...tail];
  }

  /** Audio track count for an item, or null when its metadata is unavailable. */
  private async fetchTrackCount(identifier: string): Promise<number | null> {
    try {
      const res = await this.fetchFn(`${METADATA_BASE}/${encodeURIComponent(identifier)}`);
      if (!res.ok) return null;
      const body = (await res.json()) as { files?: MetaFile[] };
      return countArchiveTracks(body.files ?? []);
    } catch {
      return null;
    }
  }

  /**
   * Fetch with one retry. Throws `ServiceUnavailableError` when archive.org is
   * unreachable or returns a non-OK status, so the caller can surface "archive.org
   * unavailable" instead of an empty result set (which means "no matches"). A
   * genuinely-empty `docs` array still resolves successfully.
   */
  private async fetchWithRetry(url: string): Promise<Response> {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const res = await this.fetchFn(url);
        if (res.ok) return res;
        lastErr = new Error(`archive.org returned HTTP ${res.status}`);
      } catch (err) {
        lastErr = err;
      }
    }
    log.warn({ err: lastErr }, 'archive.org search request failed after retry');
    throw new ServiceUnavailableError('archive.org');
  }
}
