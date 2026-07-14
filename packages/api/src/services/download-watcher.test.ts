import { describe, expect, it, beforeEach, mock, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { DownloadWatcher } from './download-watcher.js';
import { applySchema } from '../db.js';
import type { CompletedDownloadFile } from './path-inference.js';
import { createJob, getJob } from './acquisition-job-store.js';

type DownloadUser = {
  username: string;
  directories: {
    directory: string;
    fileCount: number;
    files: { filename: string; state: string }[];
  }[];
};

function makeSlskdMock() {
  return {
    transfers: {
      getDownloads: mock((): Promise<DownloadUser[]> => Promise.resolve([])),
    },
  };
}

// The real organizer moves files and mutates each file's relativePath to its
// post-move location; the watcher then feeds those paths to the native scanner.
function makeLibraryOrganizerMock() {
  return {
    organizeBatch: mock((files: CompletedDownloadFile[]) => {
      for (const f of files) f.relativePath = `Artist/Album/${f.filename}`;
      return Promise.resolve({ moved: files.length, skipped: 0, unsorted: 0, failed: 0 });
    }),
  };
}

describe('DownloadWatcher', () => {
  let slskdMock: ReturnType<typeof makeSlskdMock>;
  let libraryOrganizerMock: ReturnType<typeof makeLibraryOrganizerMock>;
  let scanMock: ReturnType<typeof mock>;
  let watcher: DownloadWatcher;

  beforeEach(() => {
    slskdMock = makeSlskdMock();
    libraryOrganizerMock = makeLibraryOrganizerMock();
    scanMock = mock((_relPaths: string[]) => Promise.resolve());

    // Use very small intervals for testing
    watcher = new DownloadWatcher(
      slskdMock as unknown as ConstructorParameters<typeof DownloadWatcher>[0],
      {
        intervalMs: 10,
        scanDebounceMs: 10,
        libraryOrganizer: libraryOrganizerMock,
        scan: scanMock,
      },
    );
  });

  afterEach(() => {
    watcher.stop();
  });

  it('detects a new completed download, organizes it, and scans after the debounce', async () => {
    slskdMock.transfers.getDownloads.mockReturnValue(
      Promise.resolve([
        {
          username: 'user1',
          directories: [
            {
              directory: 'dir1',
              fileCount: 1,
              files: [{ filename: 'song1.mp3', state: 'Completed, Succeeded' }],
            },
          ],
        },
      ]),
    );

    // Manually trigger check instead of waiting for setInterval
    await (watcher as unknown as { check(): Promise<void> }).check();

    // Scan is debounced — not called yet.
    expect(scanMock).not.toHaveBeenCalled();

    // Wait for debounce (10ms + buffer)
    await new Promise((r) => setTimeout(r, 50));

    expect(libraryOrganizerMock.organizeBatch).toHaveBeenCalledTimes(1);
    expect(scanMock).toHaveBeenCalledTimes(1);
    expect(scanMock).toHaveBeenCalledWith(['Artist/Album/song1.mp3']);
  });

  it('debounces multiple completions into a single scan', async () => {
    slskdMock.transfers.getDownloads.mockReturnValue(
      Promise.resolve([
        {
          username: 'user1',
          directories: [
            {
              directory: 'dir1',
              fileCount: 1,
              files: [{ filename: 'song1.mp3', state: 'Completed, Succeeded' }],
            },
          ],
        },
      ]),
    );

    await (watcher as unknown as { check(): Promise<void> }).check();
    await new Promise((r) => setTimeout(r, 5));
    expect(scanMock).not.toHaveBeenCalled();

    slskdMock.transfers.getDownloads.mockReturnValue(
      Promise.resolve([
        {
          username: 'user1',
          directories: [
            {
              directory: 'dir1',
              fileCount: 2,
              files: [
                { filename: 'song1.mp3', state: 'Completed, Succeeded' },
                { filename: 'song2.mp3', state: 'Completed, Succeeded' },
              ],
            },
          ],
        },
      ]),
    );
    await (watcher as unknown as { check(): Promise<void> }).check();

    await new Promise((r) => setTimeout(r, 8));
    expect(scanMock).not.toHaveBeenCalled();

    await new Promise((r) => setTimeout(r, 12));
    expect(scanMock).toHaveBeenCalledTimes(1);
  });

  it('passes all newly organized relative paths to the scan hook', async () => {
    slskdMock.transfers.getDownloads.mockReturnValue(
      Promise.resolve([
        {
          username: 'user1',
          directories: [
            {
              directory: 'Artist - Album',
              fileCount: 2,
              files: [
                { filename: 'a.mp3', state: 'Completed, Succeeded' },
                { filename: 'b.mp3', state: 'Completed, Succeeded' },
              ],
            },
          ],
        },
      ]),
    );

    await (watcher as unknown as { check(): Promise<void> }).check();
    await new Promise((r) => setTimeout(r, 50));

    expect(scanMock).toHaveBeenCalledTimes(1);
    expect(scanMock).toHaveBeenCalledWith(['Artist/Album/a.mp3', 'Artist/Album/b.mp3']);
  });

  it('does not re-process a transfer it has already completed (idempotent)', async () => {
    const completed = [
      {
        username: 'user1',
        directories: [
          {
            directory: 'dir1',
            fileCount: 1,
            files: [{ filename: 'song1.mp3', state: 'Completed, Succeeded' }],
          },
        ],
      },
    ];
    slskdMock.transfers.getDownloads.mockReturnValue(Promise.resolve(completed));

    // Same completed transfer seen on two consecutive checks (slskd keeps
    // reporting it until it drops off). It must organize exactly once.
    await (watcher as unknown as { check(): Promise<void> }).check();
    await (watcher as unknown as { check(): Promise<void> }).check();
    await new Promise((r) => setTimeout(r, 50));

    expect(libraryOrganizerMock.organizeBatch).toHaveBeenCalledTimes(1);
    expect(scanMock).toHaveBeenCalledTimes(1);
  });

  it('ignores transfers that are not "Completed, Succeeded"', async () => {
    slskdMock.transfers.getDownloads.mockReturnValue(
      Promise.resolve([
        {
          username: 'user1',
          directories: [
            {
              directory: 'dir1',
              fileCount: 2,
              files: [
                { filename: 'a.mp3', state: 'InProgress' },
                { filename: 'b.mp3', state: 'Completed, Errored' },
              ],
            },
          ],
        },
      ]),
    );

    await (watcher as unknown as { check(): Promise<void> }).check();
    await new Promise((r) => setTimeout(r, 50));

    expect(libraryOrganizerMock.organizeBatch).not.toHaveBeenCalled();
    expect(scanMock).not.toHaveBeenCalled();
  });

  it('flushes a still-pending debounced scan when stopped', async () => {
    const stopWatcher = new DownloadWatcher(
      slskdMock as unknown as ConstructorParameters<typeof DownloadWatcher>[0],
      {
        intervalMs: 10,
        scanDebounceMs: 10_000, // long enough that the debounce won't fire on its own
        libraryOrganizer: libraryOrganizerMock,
        scan: scanMock,
        db: (() => {
          const d = new Database(':memory:');
          applySchema(d);
          return d;
        })(),
      },
    );
    slskdMock.transfers.getDownloads.mockReturnValue(
      Promise.resolve([
        {
          username: 'user1',
          directories: [
            {
              directory: 'dir1',
              fileCount: 1,
              files: [{ filename: 'song1.mp3', state: 'Completed, Succeeded' }],
            },
          ],
        },
      ]),
    );

    await (stopWatcher as unknown as { check(): Promise<void> }).check();
    expect(scanMock).not.toHaveBeenCalled(); // still within the long debounce

    stopWatcher.stop(); // must flush the pending batch instead of dropping it
    await new Promise((r) => setTimeout(r, 20));
    expect(scanMock).toHaveBeenCalledWith(['Artist/Album/song1.mp3']);
  });

  it('drops completed_downloads rows for basenames auto-dedupe removed from disk', async () => {
    const db = new Database(':memory:');
    applySchema(db);
    // Organizer reports it deleted a duplicate file on disk.
    const dedupingOrganizer = {
      organizeBatch: mock((files: CompletedDownloadFile[]) => {
        for (const f of files) f.relativePath = `Artist/Album/${f.filename}`;
        return Promise.resolve({ dedupedBasenames: ['song1.mp3'] });
      }),
    };
    const dw = new DownloadWatcher(
      slskdMock as unknown as ConstructorParameters<typeof DownloadWatcher>[0],
      { intervalMs: 10, scanDebounceMs: 10, libraryOrganizer: dedupingOrganizer, scan: scanMock, db },
    );
    try {
      slskdMock.transfers.getDownloads.mockReturnValue(
        Promise.resolve([
          {
            username: 'user1',
            directories: [
              {
                directory: 'dir1',
                fileCount: 1,
                files: [{ filename: 'song1.mp3', state: 'Completed, Succeeded' }],
              },
            ],
          },
        ]),
      );

      await (dw as unknown as { check(): Promise<void> }).check();
      await new Promise((r) => setTimeout(r, 50));

      const remaining = db
        .query<{ c: number }, [string]>(
          'SELECT COUNT(*) AS c FROM completed_downloads WHERE basename = ?',
        )
        .get('song1.mp3')!.c;
      expect(remaining).toBe(0);
    } finally {
      dw.stop();
      db.close();
    }
  });

  it('records slskd acquisition provenance for each organized file', async () => {
    // Inject an isolated in-memory DB so this test doesn't race bun's concurrent
    // test files for the module-level getDatabase() singleton (project memory).
    const db = new Database(':memory:');
    applySchema(db);
    const dwWatcher = new DownloadWatcher(
      slskdMock as unknown as ConstructorParameters<typeof DownloadWatcher>[0],
      {
        intervalMs: 10,
        scanDebounceMs: 10,
        libraryOrganizer: libraryOrganizerMock,
        scan: scanMock,
        db,
      },
    );
    try {
      slskdMock.transfers.getDownloads.mockReturnValue(
        Promise.resolve([
          {
            username: 'peer42',
            directories: [
              {
                directory: 'Artist - Album',
                fileCount: 1,
                files: [{ filename: 'song1.mp3', state: 'Completed, Succeeded' }],
              },
            ],
          },
        ]),
      );

      await (dwWatcher as unknown as { check(): Promise<void> }).check();
      await new Promise((r) => setTimeout(r, 50));

      const row = db
        .query<
          { method: string; source_ref: string; stage: string },
          [string]
        >('SELECT method, source_ref, stage FROM acquisitions WHERE relative_path = ?')
        .get('Artist/Album/song1.mp3');
      expect(row).toEqual({ method: 'slskd', source_ref: 'peer42', stage: 'done' });
    } finally {
      dwWatcher.stop();
      db.close();
    }
  });

  it('tracks the acquisition job item through completed → organized → scanned', async () => {
    const db = new Database(':memory:');
    applySchema(db);
    // The scan hook stands in for the incremental scanner: it inserts the
    // library_songs row for the organized path (still quarantined).
    const scan = mock((relPaths: string[]) => {
      db.run(
        `INSERT OR IGNORE INTO library_albums (id, name, artist, artist_id, song_count, duration, synced_at)
         VALUES ('al', 'Album', 'Artist', 'art', 1, 0, 1)`,
      );
      for (const p of relPaths) {
        db.run(
          `INSERT INTO library_songs (id, album_id, title, artist, artist_id, duration, path, size, created, synced_at)
           VALUES ('s-song1', 'al', 'Song', 'Artist', 'art', 0, ?, 10, '2024-01-01', 1)`,
          [p],
        );
      }
      return Promise.resolve();
    });
    const organizer = makeLibraryOrganizerMock();
    const dwWatcher = new DownloadWatcher(
      slskdMock as unknown as ConstructorParameters<typeof DownloadWatcher>[0],
      {
        intervalMs: 10,
        scanDebounceMs: 10,
        musicDir: '/music',
        libraryOrganizer: organizer,
        scan,
        db,
      },
    );
    try {
      const jobId = createJob(db, {
        kind: 'album-hunt',
        method: 'slskd',
        artistName: 'Artist',
        albumTitle: 'Album',
        genres: ['Rock', 'Art Rock'],
        year: 2002,
        username: 'peer42',
        files: [{ filename: 'song1.mp3', trackTitle: 'Song' }],
      });
      slskdMock.transfers.getDownloads.mockReturnValue(
        Promise.resolve([
          {
            username: 'peer42',
            directories: [
              {
                directory: 'Artist - Album',
                fileCount: 1,
                files: [{ filename: 'song1.mp3', state: 'Completed, Succeeded' }],
              },
            ],
          },
        ]),
      );

      await (dwWatcher as unknown as { check(): Promise<void> }).check();
      // Completion + organize both happen inside check(); the organizer mock
      // rewrote relativePath, so the item should already be organized.
      const afterOrganize = getJob(db, jobId)!.items[0];
      expect(afterOrganize.state).toBe('organized');
      expect(afterOrganize.relativePath).toBe('Artist/Album/song1.mp3');

      // The organizer received the job metadata alongside the file.
      const [files] = organizer.organizeBatch.mock.calls[0] as [CompletedDownloadFile[]];
      expect(files[0].jobMeta?.jobId).toBe(jobId);
      expect(files[0].jobMeta?.artistName).toBe('Artist');

      await new Promise((r) => setTimeout(r, 50)); // debounce → scan
      const job = getJob(db, jobId)!;
      expect(job.items[0].state).toBe('scanned');
      expect(job.items[0].songId).toBe('s-song1');
      // Scanned but not landed → the job is in the processing stage.
      expect(job.stage).toBe('processing');

      // Metadata pre-fill: the hunt's Lidarr genres/year applied at scan time,
      // so the genre enrichment task has nothing left to derive for this song.
      const songMeta = db
        .query<{ genre: string | null; year: number | null }, [string]>(
          'SELECT genre, year FROM library_songs WHERE id = ?',
        )
        .get('s-song1');
      expect(songMeta).toEqual({ genre: 'Rock', year: 2002 });
    } finally {
      dwWatcher.stop();
      db.close();
    }
  });
});
