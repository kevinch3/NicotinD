import type { Slskd } from '@nicotind/slskd-client';
import type { LidarrTrack } from '@nicotind/lidarr-client';
import { createLogger } from '@nicotind/core';

const log = createLogger('album-hunter');

const AUDIO_EXTENSIONS = new Set([
  '.mp3', '.flac', '.ogg', '.opus',
  '.m4a', '.aac', '.wav', '.aiff', '.wma', '.ape', '.wv',
]);

const POLL_INTERVAL_MS = 2_000;
const HUNT_TIMEOUT_MS = 30_000;

// Low server-side floor so we don't return hundreds of junk folders. All
// finer filtering (FLAC-only, live, higher match %) happens reactively on the
// client so the user can adjust without re-hitting the network.
const MIN_FLOOR_PCT = 10;

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
    const baseQueries = [
      `${artistName} ${albumTitle}`,
      `${artistName} - ${albumTitle}`,
    ];

    const base = await this.searchAndScore(baseQueries, canonicalTracks);

    // Soft-ban bypass: slskd/Soulseek silently returns zero responses for some
    // exact phrases (e.g. "The Artist - The Track") even when the files exist.
    // When the user opts in, retry with textually-skewed variants of the query
    // — only on an empty base result, so we don't add noise to a normal hunt.
    if (base.length === 0 && opts.skewSearch) {
      const skewed = buildSkewedQueries(artistName, albumTitle, baseQueries);
      if (skewed.length) return this.searchAndScore(skewed, canonicalTracks);
    }

    return base;
  }

  private async searchAndScore(
    queries: string[],
    canonicalTracks: LidarrTrack[],
  ): Promise<FolderCandidate[]> {
    // Fire all searches in parallel
    const searches = await Promise.all(
      queries.map((q) =>
        this.slskd.searches
          .create(q)
          .catch((err) => {
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

      const candidates: FolderCandidate[] = [];

      for (const [key, { username, files }] of folderMap) {
        const dir = key.slice(username.length + 2); // strip "username::"
        const normalizedFiles = files.map((f) => {
          const basename = f.filename
            .replace(/\\/g, '/')
            .split('/')
            .pop() ?? f.filename;
          const noExt = basename.slice(0, basename.lastIndexOf('.') || basename.length);
          return normalizeTitle(noExt);
        });

        let matched = 0;
        for (const canonicalTrack of normalizedCanonical) {
          if (normalizedFiles.some((fn) => titlesOverlap(canonicalTrack, fn))) {
            matched++;
          }
        }

        const totalTracks = canonicalTracks.length || 1;
        const matchPct = Math.round((matched / totalTracks) * 100);
        if (matchPct < MIN_FLOOR_PCT) continue;

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
      await Promise.all(
        searchIds.map((id) => this.slskd.searches.delete(id).catch(() => {})),
      );
    }
  }

  private async pollUntilDone(
    searchIds: string[],
  ): Promise<
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

// Build textually-skewed query variants to bypass slskd's soft phrase ban.
// why: the ban keys on the *exact* normalized phrase, so variants that reorder
// tokens, drop a leading "the", or trim to a subset still surface the same
// files while no longer matching the blocked string. Variants equal to a base
// query (or to each other) are dropped so we never re-run an already-banned one.
export function buildSkewedQueries(
  artistName: string,
  albumTitle: string,
  baseQueries: string[],
): string[] {
  const stripThe = (s: string) => s.replace(/^the\s+/i, '').trim();
  const firstWord = (s: string) => s.trim().split(/\s+/)[0] ?? '';

  const variants = [
    `${albumTitle} ${artistName}`, // reorder
    albumTitle, // album only
    `${stripThe(artistName)} ${stripThe(albumTitle)}`, // drop leading "the"
    `${artistName} ${firstWord(albumTitle)}`, // artist + first album word
  ];

  const seen = new Set(baseQueries.map((q) => q.toLowerCase().trim()));
  const out: string[] = [];
  for (const raw of variants) {
    const v = raw.trim();
    const key = v.toLowerCase();
    if (!v || seen.has(key)) continue;
    seen.add(key);
    out.push(v);
  }
  return out;
}

function extractDirectory(filename: string): string {
  // slskd filenames use backslashes on Windows peers
  const normalized = filename.replace(/\\/g, '/');
  const lastSlash = normalized.lastIndexOf('/');
  return lastSlash >= 0 ? normalized.slice(0, lastSlash) : '';
}

export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
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
