import { createLogger } from '@nicotind/core';
import type { Slskd } from '@nicotind/slskd-client';
import type { Navidrome } from '@nicotind/navidrome-client';

const log = createLogger('download-watcher');

interface PendingPlaylist {
  directoryName: string;
  fileCount: number;
  completedFiles: Set<string>;
}

/** Extract a human-readable album name from a Soulseek directory path. */
export function extractAlbumName(directory: string): string {
  // Soulseek paths use backslashes: @@user\Music\Artist\Album or @@user\Music\Artist - Album
  const segments = directory.split('\\').filter(Boolean);
  // Last segment is usually the album folder
  return segments[segments.length - 1] ?? directory;
}

export class DownloadWatcher {
  private slskd: Slskd;
  private navidrome: Navidrome;
  private intervalMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private knownCompleted = new Set<string>();
  private scanDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private scanDebounceMs: number;

  /** Directories where all files are done, waiting for scan + playlist creation. */
  private pendingPlaylists = new Map<string, PendingPlaylist>();
  /** Avoid creating duplicate playlists for the same directory. */
  private createdPlaylists = new Set<string>();

  constructor(
    slskd: Slskd,
    navidrome: Navidrome,
    options: { intervalMs?: number; scanDebounceMs?: number } = {},
  ) {
    this.slskd = slskd;
    this.navidrome = navidrome;
    this.intervalMs = options.intervalMs ?? 5_000;
    this.scanDebounceMs = options.scanDebounceMs ?? 10_000;
  }

  start(): void {
    if (this.timer) return;
    log.info({ intervalMs: this.intervalMs }, 'Starting download watcher');

    this.timer = setInterval(() => this.check(), this.intervalMs);
    // Run immediately on start
    this.check();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.scanDebounceTimer) {
      clearTimeout(this.scanDebounceTimer);
      this.scanDebounceTimer = null;
    }
    log.info('Download watcher stopped');
  }

  private async check(): Promise<void> {
    try {
      const downloads = await this.slskd.transfers.getDownloads();
      let newCompletions = false;

      for (const group of downloads) {
        for (const dir of group.directories) {
          const dirKey = `${group.username}:${dir.directory}`;

          for (const file of dir.files) {
            const fileKey = `${group.username}:${file.filename}`;
            if (file.state === 'Completed, Succeeded' && !this.knownCompleted.has(fileKey)) {
              this.knownCompleted.add(fileKey);
              newCompletions = true;
              log.info({ username: group.username, filename: file.filename }, 'Download completed');
            }
          }

          // Check if entire directory is done (all files succeeded)
          const allSucceeded = dir.files.length > 0 &&
            dir.files.every(f => f.state === 'Completed, Succeeded');

          if (allSucceeded && !this.createdPlaylists.has(dirKey) && !this.pendingPlaylists.has(dirKey)) {
            const albumName = extractAlbumName(dir.directory);
            log.info({ dirKey, albumName, fileCount: dir.files.length }, 'Directory complete, queuing playlist creation');
            this.pendingPlaylists.set(dirKey, {
              directoryName: albumName,
              fileCount: dir.files.length,
              completedFiles: new Set(dir.files.map(f => f.filename)),
            });
          }
        }
      }

      if (newCompletions) {
        this.debouncedScan();
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : '';
      if (msg.includes('Unable to connect') || msg.includes('ConnectionRefused')) {
        log.debug('slskd not reachable, skipping download check');
      } else {
        log.error({ err }, 'Error checking downloads');
      }
    }
  }

  private debouncedScan(): void {
    if (this.scanDebounceTimer) {
      clearTimeout(this.scanDebounceTimer);
    }

    this.scanDebounceTimer = setTimeout(async () => {
      try {
        log.info('Triggering Navidrome library scan');
        await this.navidrome.system.startScan();

        // If there are pending playlists, wait for scan then create them
        if (this.pendingPlaylists.size > 0) {
          await this.waitForScanAndCreatePlaylists();
        }
      } catch (err) {
        log.error({ err }, 'Failed to trigger scan');
      }
    }, this.scanDebounceMs);
  }

  private async waitForScanAndCreatePlaylists(): Promise<void> {
    // Poll scan status until complete (max 60s)
    const maxWait = 60_000;
    const pollInterval = 3_000;
    const start = Date.now();

    while (Date.now() - start < maxWait) {
      try {
        const status = await this.navidrome.system.getScanStatus();
        if (!status.scanning) break;
      } catch {
        log.debug('Failed to check scan status, retrying...');
      }
      await new Promise(r => setTimeout(r, pollInterval));
    }

    // Process each pending playlist
    for (const [dirKey, pending] of this.pendingPlaylists) {
      try {
        await this.createPlaylistForDirectory(dirKey, pending);
      } catch (err) {
        log.error({ err, dirKey, albumName: pending.directoryName }, 'Failed to create playlist');
      }
    }
  }

  private async createPlaylistForDirectory(dirKey: string, pending: PendingPlaylist): Promise<void> {
    const { directoryName } = pending;

    // Search Navidrome for the album
    const searchResults = await this.navidrome.search.search3(directoryName, { albumCount: 5 });
    let songIds: string[] = [];

    if (searchResults.album.length > 0) {
      // Find best matching album by name
      const match = searchResults.album.find(
        a => a.name.toLowerCase() === directoryName.toLowerCase()
          || directoryName.toLowerCase().includes(a.name.toLowerCase()),
      ) ?? searchResults.album[0];

      const { songs } = await this.navidrome.browsing.getAlbum(match.id);
      songIds = songs.map(s => s.id);
      log.info({ albumName: match.name, songCount: songIds.length }, 'Matched album in Navidrome');
    }

    // Fallback: check newest albums
    if (songIds.length === 0) {
      const newest = await this.navidrome.browsing.getAlbumList('newest', 10);
      const match = newest.find(
        a => a.name.toLowerCase() === directoryName.toLowerCase()
          || directoryName.toLowerCase().includes(a.name.toLowerCase()),
      );

      if (match) {
        const { songs } = await this.navidrome.browsing.getAlbum(match.id);
        songIds = songs.map(s => s.id);
        log.info({ albumName: match.name, songCount: songIds.length }, 'Matched album via newest list');
      }
    }

    if (songIds.length === 0) {
      log.warn({ directoryName }, 'Could not match downloaded directory to Navidrome album, skipping playlist');
      this.pendingPlaylists.delete(dirKey);
      return;
    }

    // Create the playlist
    const playlist = await this.navidrome.playlists.create(directoryName, songIds);
    log.info({ playlistId: playlist.id, name: directoryName, songCount: songIds.length }, 'Auto-created playlist');

    this.createdPlaylists.add(dirKey);
    this.pendingPlaylists.delete(dirKey);
  }
}
