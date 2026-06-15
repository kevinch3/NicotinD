import { fileExt, isLossless } from './song-results';

export interface BrowseFile {
  filename: string;
  size: number;
  bitRate?: number;
  length?: number;
}

export interface BrowseDir {
  name: string;
  fileCount: number;
  files: BrowseFile[];
}

export interface FolderGroup {
  username: string;
  uploadSpeed: number;
  queueLength?: number;
  freeUploadSlots?: number;
  directory: string;
  bitRate?: number;
  files: Array<{
    filename: string;
    size: number;
    bitRate?: number;
    length?: number;
    title?: string;
    artist?: string;
    album?: string;
    trackNumber?: string;
  }>;
}

// ── A7: folder ranking + format visibility ──────────────────────────────────
// The raw-network folder lane returns ~100 near-duplicate album folders in raw
// order with the format buried. These helpers surface the best copies (lossless,
// free slot, complete) and make the format legible. See §A7.

const AUDIO_EXT = new Set([
  'flac', 'wav', 'aiff', 'aif', 'ape', 'wv', 'alac', 'mp3', 'm4a', 'aac', 'ogg', 'opus', 'wma',
]);

export interface FolderFormat {
  /** Short badge, e.g. "FLAC" or "320k". */
  label: string;
  lossless: boolean;
}

/** Audio files in a folder (filters out cue/log/jpg/etc.). */
export function folderAudioFiles(g: Pick<FolderGroup, 'files'>): FolderGroup['files'] {
  return g.files.filter((f) => AUDIO_EXT.has(fileExt(f.filename)));
}

/** The dominant audio format of a folder, for a badge — null if no audio. */
export function folderFormat(g: Pick<FolderGroup, 'files'>): FolderFormat | null {
  const audio = folderAudioFiles(g);
  if (audio.length === 0) return null;
  const lossless = audio.find((f) => isLossless(f.filename));
  if (lossless) return { label: fileExt(lossless.filename).toUpperCase(), lossless: true };
  const maxBr = Math.max(0, ...audio.map((f) => f.bitRate ?? 0));
  return { label: maxBr ? `${maxBr}k` : 'MP3', lossless: false };
}

/** Per-file quality label — bitrate when known, else the format from the name
 *  (so a "…FLAC…" file no longer reads "Unknown bitrate"). See §A7. */
export function fileQualityLabel(file: { filename: string; bitRate?: number }): string {
  if (file.bitRate) return `${file.bitRate} kbps`;
  const ext = fileExt(file.filename);
  return ext ? ext.toUpperCase() : 'Unknown';
}

/**
 * Rank folder candidates so the best copies float to the top: a free upload slot
 * first (instant vs queued), then lossless, then more tracks (more complete),
 * then faster upload. Stable for equal keys. See §A7.
 */
export function rankFolders(groups: FolderGroup[]): FolderGroup[] {
  return [...groups].sort((a, b) => {
    const free = (g: FolderGroup) => ((g.freeUploadSlots ?? 0) > 0 ? 1 : 0);
    if (free(a) !== free(b)) return free(b) - free(a);
    const lossless = (g: FolderGroup) => (folderFormat(g)?.lossless ? 1 : 0);
    if (lossless(a) !== lossless(b)) return lossless(b) - lossless(a);
    const tracks = (g: FolderGroup) => folderAudioFiles(g).length;
    if (tracks(a) !== tracks(b)) return tracks(b) - tracks(a);
    return b.uploadSpeed - a.uploadSpeed;
  });
}

export interface FolderNode {
  segment: string;
  fullPath: string;
  dir: BrowseDir | null;
  children: FolderNode[];
}

export function extractDirectory(filepath: string): string {
  const lastSep = filepath.lastIndexOf('\\');
  return lastSep === -1 ? '' : filepath.slice(0, lastSep);
}

export function groupByDirectory(
  files: Array<{
    username: string;
    uploadSpeed: number;
    queueLength?: number;
    freeUploadSlots?: number;
    filename: string;
    size: number;
    bitRate?: number;
    length?: number;
    title?: string;
    artist?: string;
    album?: string;
    trackNumber?: string;
  }>,
): FolderGroup[] {
  const map = new Map<string, FolderGroup>();

  for (const file of files) {
    const dir = extractDirectory(file.filename);
    const key = `${file.username}::${dir}`;
    if (!map.has(key)) {
      map.set(key, {
        username: file.username,
        uploadSpeed: file.uploadSpeed,
        queueLength: file.queueLength,
        freeUploadSlots: file.freeUploadSlots,
        directory: dir,
        bitRate: file.bitRate,
        files: [],
      });
    }
    map.get(key)!.files.push({
      filename: file.filename,
      size: file.size,
      bitRate: file.bitRate,
      length: file.length,
      title: file.title,
      artist: file.artist,
      album: file.album,
      trackNumber: file.trackNumber,
    });
  }

  return Array.from(map.values());
}

export function formatPeerInfo(
  group: Pick<FolderGroup, 'uploadSpeed' | 'queueLength' | 'freeUploadSlots'>,
): string {
  const parts: string[] = [];
  const speed = group.uploadSpeed;
  if (speed >= 1_000_000) {
    parts.push(`↑ ${(speed / 1_000_000).toFixed(1)} MB/s`);
  } else {
    parts.push(`↑ ${(speed / 1_000).toFixed(0)} KB/s`);
  }
  if (group.queueLength && group.queueLength > 0) {
    parts.push(`${group.queueLength} queued`);
  }
  if (group.freeUploadSlots !== undefined) {
    parts.push(`${group.freeUploadSlots} slot${group.freeUploadSlots === 1 ? '' : 's'}`);
  }
  return parts.join(' · ');
}

export function buildFolderTree(dirs: BrowseDir[]): FolderNode[] {
  const root: FolderNode[] = [];

  for (const dir of dirs) {
    const segments = dir.name.split('\\');
    let currentLevel = root;
    let currentPath = '';

    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i];
      currentPath = currentPath ? `${currentPath}\\${segment}` : segment;

      let node = currentLevel.find((n) => n.segment === segment);
      if (!node) {
        node = { segment, fullPath: currentPath, dir: null, children: [] };
        currentLevel.push(node);
      }

      if (i === segments.length - 1) {
        node.dir = dir;
      }

      currentLevel = node.children;
    }
  }

  return root;
}

export function getDirectFiles(dirs: BrowseDir[], selectedPath: string): BrowseFile[] {
  const dir = dirs.find((d) => d.name === selectedPath);
  return dir?.files ?? [];
}
