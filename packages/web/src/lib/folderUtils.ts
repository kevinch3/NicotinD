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

export interface FolderNode {
  segment: string;   // just this level's name, e.g. "Album"
  fullPath: string;  // e.g. "Music\\Artist\\Album"
  dir: BrowseDir | null;
  children: FolderNode[];
}

/** Strips the basename to get the directory portion of a backslash-separated path */
export function extractDirectory(filepath: string): string {
  const lastSep = filepath.lastIndexOf('\\');
  return lastSep === -1 ? '' : filepath.slice(0, lastSep);
}

/** Groups a flat list of network result files by their directory path */
export function groupByDirectory(
  files: Array<{
    username: string;
    uploadSpeed: number;
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

/** Builds a nested FolderNode tree from a flat BrowseDir[] list */
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
        node = {
          segment,
          fullPath: currentPath,
          dir: null,
          children: [],
        };
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

/** Returns the files directly in the given directory path (non-recursive) */
export function getDirectFiles(dirs: BrowseDir[], selectedPath: string): BrowseFile[] {
  const dir = dirs.find((d) => d.name === selectedPath);
  return dir?.files ?? [];
}
