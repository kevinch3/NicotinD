import type { Slskd } from '@nicotind/slskd-client';
import type { LidarrTrack } from '@nicotind/lidarr-client';
import {
  createLogger,
  fold,
  baseQueries,
  buildSkewedQueries,
  stripTitleQualifiers,
} from '@nicotind/core';

// Re-export the shared query builders so existing importers (track-pick, tests,
// callers) keep their `./album-hunter.service` import path — the canonical source
// is now @nicotind/core/hunt-queries.
export { buildSkewedQueries, stripTitleQualifiers, baseQueries } from '@nicotind/core';

const log = createLogger('album-hunter');

const AUDIO_EXTENSIONS = new Set([
  '.mp3',
  '.flac',
  '.ogg',
  '.opus',
  '.m4a',
  '.aac',
  '.wav',
  '.aiff',
  '.wma',
  '.ape',
  '.wv',
]);

const POLL_INTERVAL_MS = 2_000;
// 45s (was 30s): Soulseek peers — especially the slow/queued ones common for
// Latin-American material — often only respond late in the window; cutting off
// at 30s dropped otherwise-complete folders before they could be scored.
const HUNT_TIMEOUT_MS = 45_000;

// Low server-side floor so we don't return hundreds of junk folders. All
// finer filtering (FLAC-only, live, higher match %) happens reactively on the
// client so the user can adjust without re-hitting the network.
const MIN_FLOOR_PCT = 10;

// When the best base-query candidate scores below this, fire the skew-search
// variants too (and merge the results). why: skew only used to run on a *totally
// empty* base, but MIN_FLOOR_PCT is so low that one junk partial folder keeps the
// base non-empty and suppressed skew entirely — exactly the "partial match" case
// (common for accented Latin titles) where the soft-banned exact phrase hides a
// complete folder that a skewed variant surfaces. A confidently-complete base
// (>= this) adds zero extra searches.
const SKEW_TRIGGER_PCT = 67;

// Match strength for a single (1-track hunt) whose Lidarr title carries a
// qualifier — "(feat …)"/"(Remix)" — that the peer omitted from the filename, so
// the full titles don't overlap but their qualifier-stripped cores do. We still
// surface it (above MIN_FLOOR_PCT) but rank it below an exact hit. why: a single
// is otherwise all-or-nothing (matched/1 → 0% or 100%), so any near miss is
// silently dropped — common for remixes/typos/featured-artist spellings.
const SINGLE_PARTIAL_PCT = 50;

export interface HuntFile {
  filename: string;
  size: number;
  bitRate?: number;
}

interface PeerHealth {
  freeUploadSlots: number;
  queueLength: number;
  uploadSpeed: number;
}

// Match% is bucketed (rounded to the nearest 20) before comparison so a
// marginally-higher match doesn't force us onto a dead peer — e.g. a healthy
// 90%-match peer with free slots out-ranks a dead 100%-match peer (both land in
// the same bucket). Auto-retry + cross-peer fallback backstop the missing
// tracks. Within a bucket we prefer a peer with free upload slots, then a
// shorter queue, then FLAC, then faster upload speed, then a larger total size.
const MATCH_BUCKET = 20;

function compareCandidates(a: FolderCandidate, b: FolderCandidate): number {
  const aBucket = Math.round(a.matchPct / MATCH_BUCKET);
  const bBucket = Math.round(b.matchPct / MATCH_BUCKET);
  if (aBucket !== bBucket) return bBucket - aBucket;

  const aHasSlot = a.freeUploadSlots > 0 ? 1 : 0;
  const bHasSlot = b.freeUploadSlots > 0 ? 1 : 0;
  if (aHasSlot !== bHasSlot) return bHasSlot - aHasSlot;

  if (a.queueLength !== b.queueLength) return a.queueLength - b.queueLength;

  if (a.format === 'FLAC' && b.format !== 'FLAC') return -1;
  if (b.format === 'FLAC' && a.format !== 'FLAC') return 1;

  if (a.uploadSpeed !== b.uploadSpeed) return b.uploadSpeed - a.uploadSpeed;

  return b.estimatedSizeMb - a.estimatedSizeMb;
}

export interface FolderCandidate {
  directory: string;
  username: string;
  files: HuntFile[];
  matchedTracks: number;
  totalTracks: number;
  matchPct: number;
  format: string; // dominant format: "FLAC", "MP3", "Mixed", etc.
  estimatedSizeMb: number;
  isLive: boolean;
  // Peer health (from the slskd search response). Used to rank candidates so
  // we don't commit a whole album to an overloaded/slow peer that truncates.
  freeUploadSlots: number;
  queueLength: number;
  uploadSpeed: number;
}

export class AlbumHunterService {
  constructor(private slskd: Slskd) {}

  async hunt(
    artistName: string,
    albumTitle: string,
    canonicalTracks: LidarrTrack[],
    opts: { skewSearch?: boolean } = {},
  ): Promise<FolderCandidate[]> {
    const baseQs = baseQueries(artistName, albumTitle);

    const base = await this.searchAndScore(baseQs, canonicalTracks);

    // Soft-ban bypass: slskd/Soulseek silently returns zero responses for some
    // exact phrases (e.g. "The Artist - The Track") even when the files exist.
    // When the user opts in, also run textually-skewed variants of the query and
    // merge the results — not only when the base is empty, but whenever no base
    // candidate is confidently complete (best match < SKEW_TRIGGER_PCT). A junk
    // partial folder would otherwise keep the base non-empty and hide a complete
    // folder reachable only via a skewed phrase. A strong base adds no searches.
    const bestBasePct = base.length ? base[0].matchPct : 0;
    if (opts.skewSearch && bestBasePct < SKEW_TRIGGER_PCT) {
      const skewed = buildSkewedQueries(artistName, albumTitle, baseQs);
      if (skewed.length) {
        const extra = await this.searchAndScore(skewed, canonicalTracks);
        return mergeCandidates(base, extra);
      }
    }

    return base;
  }

  // Phase-1 of a two-phase hunt: run base queries only and report whether skew
  // is needed (so the frontend can highlight the query list in real time).
  async huntBase(
    artistName: string,
    albumTitle: string,
    canonicalTracks: LidarrTrack[],
    opts: { skewSearch?: boolean } = {},
  ): Promise<{ candidates: FolderCandidate[]; skewNeeded: boolean }> {
    const baseQs = baseQueries(artistName, albumTitle);
    const candidates = await this.searchAndScore(baseQs, canonicalTracks);
    const bestBasePct = candidates.length ? candidates[0].matchPct : 0;
    const skewNeeded = opts.skewSearch !== false && bestBasePct < SKEW_TRIGGER_PCT;
    return { candidates, skewNeeded };
  }

  // Phase-2 of a two-phase hunt: run skew-variant queries and return their
  // candidates independently. The caller (frontend) merges with base results.
  async huntSkew(
    artistName: string,
    albumTitle: string,
    canonicalTracks: LidarrTrack[],
  ): Promise<FolderCandidate[]> {
    const baseQs = baseQueries(artistName, albumTitle);
    const skewed = buildSkewedQueries(artistName, albumTitle, baseQs);
    if (!skewed.length) return [];
    return this.searchAndScore(skewed, canonicalTracks);
  }

  private async searchAndScore(
    queries: string[],
    canonicalTracks: LidarrTrack[],
  ): Promise<FolderCandidate[]> {
    // Fire all searches in parallel
    const searches = await Promise.all(
      queries.map((q) =>
        this.slskd.searches.create(q).catch((err) => {
          log.warn({ q, err }, 'Search create failed');
          return null;
        }),
      ),
    );

    const searchIds = searches.filter(Boolean).map((s) => s!.id);
    if (!searchIds.length) return [];

    try {
      // Poll until all searches complete or timeout
      const allResponses = await this.pollUntilDone(searchIds);

      // Group files by directory+username (a unique "folder")
      const folderMap = new Map<string, { username: string; files: HuntFile[] }>();

      // Per-peer health, merged across the two parallel searches. A peer's
      // free-slot count fluctuates between responses; keep the best-seen so a
      // momentarily-busy snapshot doesn't permanently sink an otherwise-good peer.
      const peerHealth = new Map<string, PeerHealth>();

      for (const response of allResponses) {
        const prev = peerHealth.get(response.username);
        peerHealth.set(response.username, {
          freeUploadSlots: Math.max(prev?.freeUploadSlots ?? 0, response.freeUploadSlots ?? 0),
          // Queue length: keep the smallest (most favorable) seen.
          queueLength: Math.min(prev?.queueLength ?? Infinity, response.queueLength ?? 0),
          uploadSpeed: Math.max(prev?.uploadSpeed ?? 0, response.uploadSpeed ?? 0),
        });

        for (const file of response.files) {
          const ext = file.filename.slice(file.filename.lastIndexOf('.')).toLowerCase();
          if (!AUDIO_EXTENSIONS.has(ext)) continue;

          const dir = extractDirectory(file.filename);
          const key = `${response.username}::${dir}`;

          if (!folderMap.has(key)) {
            folderMap.set(key, { username: response.username, files: [] });
          }
          const folder = folderMap.get(key)!;
          // Dedupe: the two parallel queries ("Artist Album" / "Artist - Album")
          // frequently surface the same file from the same peer.
          if (folder.files.some((existing) => existing.filename === file.filename)) {
            continue;
          }
          folder.files.push({
            filename: file.filename,
            size: file.size,
            bitRate: file.bitRate,
          });
        }
      }

      // Score each folder against canonical tracklist
      const normalizedCanonical = canonicalTracks.map((t) => normalizeTitle(t.title));
      // A single (exactly 1 canonical track) is scored with the qualifier-aware
      // strength (see SINGLE_PARTIAL_PCT) instead of the all-or-nothing matched/1
      // formula, keeping both the full and the qualifier-stripped "core" form.
      const single =
        canonicalTracks.length === 1
          ? {
              full: normalizeTitle(canonicalTracks[0].title),
              core: normalizeTitle(stripTitleQualifiers(canonicalTracks[0].title)),
            }
          : null;

      const candidates: FolderCandidate[] = [];

      for (const [key, { username, files }] of folderMap) {
        const dir = key.slice(username.length + 2); // strip "username::"
        const baseNames = files.map((f) => {
          const basename = f.filename.replace(/\\/g, '/').split('/').pop() ?? f.filename;
          return basename.slice(0, basename.lastIndexOf('.') || basename.length);
        });

        let matched: number;
        let matchPct: number;
        if (single) {
          const strength = baseNames.reduce(
            (best, n) =>
              Math.max(
                best,
                singleMatchStrength(
                  single.full,
                  single.core,
                  normalizeTitle(n),
                  normalizeTitle(stripTitleQualifiers(n)),
                ),
              ),
            0,
          );
          matched = strength > 0 ? 1 : 0;
          matchPct = strength;
        } else {
          const normalizedFiles = baseNames.map(normalizeTitle);
          let m = 0;
          for (const canonicalTrack of normalizedCanonical) {
            if (normalizedFiles.some((fn) => titlesOverlap(canonicalTrack, fn))) {
              m++;
            }
          }
          matched = m;
          matchPct = Math.round((m / (canonicalTracks.length || 1)) * 100);
        }
        if (matchPct < MIN_FLOOR_PCT) continue;

        const totalTracks = canonicalTracks.length || 1;
        const format = detectFormat(files);
        const estimatedSizeMb = files.reduce((acc, f) => acc + f.size, 0) / (1024 * 1024);
        const health = peerHealth.get(username);

        candidates.push({
          directory: dir,
          username,
          files,
          matchedTracks: matched,
          totalTracks,
          matchPct,
          format,
          estimatedSizeMb: Math.round(estimatedSizeMb * 10) / 10,
          isLive: isLiveFolder(dir),
          freeUploadSlots: health?.freeUploadSlots ?? 0,
          queueLength: Number.isFinite(health?.queueLength) ? health!.queueLength : 0,
          uploadSpeed: health?.uploadSpeed ?? 0,
        });
      }

      candidates.sort(compareCandidates);

      return candidates.slice(0, 20);
    } finally {
      // Clean up searches
      await Promise.all(searchIds.map((id) => this.slskd.searches.delete(id).catch(() => {})));
    }
  }

  private async pollUntilDone(searchIds: string[]): Promise<
    Array<{
      username: string;
      freeUploadSlots: number;
      queueLength: number;
      uploadSpeed: number;
      files: Array<{ filename: string; size: number; bitRate?: number }>;
    }>
  > {
    const deadline = Date.now() + HUNT_TIMEOUT_MS;

    while (Date.now() < deadline) {
      const states = await Promise.all(
        searchIds.map((id) => this.slskd.searches.get(id).catch(() => null)),
      );

      const allDone = states.every((s) => !s || s.state !== 'InProgress');
      if (allDone) break;

      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }

    // Gather all responses from all searches
    const responseSets = await Promise.all(
      searchIds.map((id) => this.slskd.searches.getResponses(id).catch(() => [])),
    );

    return responseSets.flat();
  }
}

// Merge two candidate lists (base + skewed), de-duplicating by the unique
// folder key (username::directory) and keeping the higher-scoring instance, then
// re-rank with the shared comparator. why: the same peer folder can surface from
// both the base and a skewed query; without de-duping it would appear twice.
function mergeCandidates(base: FolderCandidate[], extra: FolderCandidate[]): FolderCandidate[] {
  const byKey = new Map<string, FolderCandidate>();
  for (const c of [...base, ...extra]) {
    const key = `${c.username}::${c.directory}`;
    const prev = byKey.get(key);
    if (!prev || c.matchPct > prev.matchPct) byKey.set(key, c);
  }
  return [...byKey.values()].sort(compareCandidates).slice(0, 20);
}

function extractDirectory(filename: string): string {
  // slskd filenames use backslashes on Windows peers
  const normalized = filename.replace(/\\/g, '/');
  const lastSlash = normalized.lastIndexOf('/');
  return lastSlash >= 0 ? normalized.slice(0, lastSlash) : '';
}

export function normalizeTitle(title: string): string {
  // Diacritics are folded (via the shared `fold`) *before* the ASCII-only
  // `[^\w\s]` strip, so an accented "canción" and a peer's unaccented "cancion"
  // both reduce to the same string — critical for this Latin-American-heavy
  // library. `fold` already lowercases + NFD-strips combining marks.
  return fold(title)
    .replace(/^\d+[\s.\-]+/, '') // strip leading track numbers
    .replace(/[^\w\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function titlesOverlap(canonical: string, filename: string): boolean {
  if (canonical === filename) return true;
  // Check if the canonical words are mostly in the filename
  const cWords = canonical.split(' ').filter(Boolean);
  const fWords = new Set(filename.split(' ').filter(Boolean));
  const overlap = cWords.filter((w) => fWords.has(w)).length;
  return cWords.length > 0 && overlap / cWords.length >= 0.7;
}

// Strength of a single (1-track) hunt match: 100 when the full normalized titles
// overlap, SINGLE_PARTIAL_PCT when only their qualifier-stripped cores overlap
// (ranked below an exact hit, still above MIN_FLOOR_PCT), 0 otherwise.
export function singleMatchStrength(
  canonicalFull: string,
  canonicalCore: string,
  fileFull: string,
  fileCore: string,
): number {
  if (titlesOverlap(canonicalFull, fileFull)) return 100;
  if (canonicalCore && fileCore && titlesOverlap(canonicalCore, fileCore)) {
    return SINGLE_PARTIAL_PCT;
  }
  return 0;
}

function isLiveFolder(dir: string): boolean {
  const lower = dir.toLowerCase();
  return /\blive\b|\bconcert\b|\bin concert\b/.test(lower);
}

function detectFormat(files: HuntFile[]): string {
  const extensions = files.map((f) => f.filename.slice(f.filename.lastIndexOf('.')).toLowerCase());
  const counts = new Map<string, number>();
  for (const ext of extensions) counts.set(ext, (counts.get(ext) ?? 0) + 1);

  const dominant = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  if (!dominant) return 'Unknown';

  if (dominant[0] === '.flac') return 'FLAC';
  if (dominant[0] === '.mp3') {
    // Try to infer bitrate from the most common bitRate value
    const bitRates = files.map((f) => f.bitRate).filter(Boolean) as number[];
    if (bitRates.length) {
      const avgBitRate = Math.round(bitRates.reduce((a, b) => a + b, 0) / bitRates.length);
      return `MP3 ${avgBitRate}kbps`;
    }
    return 'MP3';
  }
  if (dominant[0] === '.opus') return 'Opus';
  if (dominant[0] === '.ogg') return 'Ogg';
  if (counts.size > 1) return 'Mixed';
  return dominant[0].slice(1).toUpperCase();
}
