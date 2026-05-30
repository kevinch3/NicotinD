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
}

export class AlbumHunterService {
  constructor(private slskd: Slskd) {}

  async hunt(
    artistName: string,
    albumTitle: string,
    canonicalTracks: LidarrTrack[],
  ): Promise<FolderCandidate[]> {
    const queries = [
      `${artistName} ${albumTitle}`,
      `${artistName} - ${albumTitle}`,
    ];

    // Fire both searches in parallel
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

      for (const response of allResponses) {
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
        });
      }

      // Sort: match % desc, then FLAC before others, then size desc
      candidates.sort((a, b) => {
        if (b.matchPct !== a.matchPct) return b.matchPct - a.matchPct;
        if (a.format === 'FLAC' && b.format !== 'FLAC') return -1;
        if (b.format === 'FLAC' && a.format !== 'FLAC') return 1;
        return b.estimatedSizeMb - a.estimatedSizeMb;
      });

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
  ): Promise<Array<{ username: string; files: Array<{ filename: string; size: number; bitRate?: number }> }>> {
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

function extractDirectory(filename: string): string {
  // slskd filenames use backslashes on Windows peers
  const normalized = filename.replace(/\\/g, '/');
  const lastSlash = normalized.lastIndexOf('/');
  return lastSlash >= 0 ? normalized.slice(0, lastSlash) : '';
}

function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/^\d+[\s.\-]+/, '') // strip leading track numbers
    .replace(/[^\w\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function titlesOverlap(canonical: string, filename: string): boolean {
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
