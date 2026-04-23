import { describe, expect, it, beforeEach, mock, afterEach } from 'bun:test';
import { DownloadWatcher } from './download-watcher.js';

describe('DownloadWatcher', () => {
  let slskdMock: any;
  let navidromeMock: any;
  let metadataFixerMock: any;
  let autoPlaylistMock: any;
  let watcher: DownloadWatcher;

  beforeEach(() => {
    slskdMock = {
      transfers: {
        getDownloads: mock(() => Promise.resolve([])),
      },
    };

    navidromeMock = {
      system: {
        startScan: mock(() => Promise.resolve()),
      },
    };

    metadataFixerMock = {
      processCompletedDownloads: mock(() => Promise.resolve()),
    };

    autoPlaylistMock = {
      processBatch: mock(() => Promise.resolve()),
    };

    // Use very small intervals for testing
    watcher = new DownloadWatcher(slskdMock, navidromeMock, {
      intervalMs: 10,
      scanDebounceMs: 10,
      metadataFixer: metadataFixerMock,
      autoPlaylist: autoPlaylistMock,
    });
  });

  afterEach(() => {
    watcher.stop();
  });

  it('detects a new completed download and triggers a scan', async () => {
    slskdMock.transfers.getDownloads.mockReturnValue(
      Promise.resolve([
        {
          username: 'user1',
          directories: [
            {
              directory: 'dir1',
              files: [{ filename: 'song1.mp3', state: 'Completed, Succeeded' }],
            },
          ],
        },
      ]),
    );

    // Manually trigger check instead of waiting for setInterval
    await (watcher as any).check();

    // Scan should be debounced. Should NOT have been called yet.
    expect(navidromeMock.system.startScan).not.toHaveBeenCalled();

    // Wait for debounce (10ms + buffer)
    await new Promise((r) => setTimeout(r, 50));

    expect(metadataFixerMock.processCompletedDownloads).toHaveBeenCalledTimes(1);
    expect(metadataFixerMock.processCompletedDownloads).toHaveBeenCalledWith([
      {
        username: 'user1',
        directory: 'dir1',
        filename: 'song1.mp3',
      },
    ]);
    expect(navidromeMock.system.startScan).toHaveBeenCalledTimes(1);
  });

  it('debounces multiple completions', async () => {
    slskdMock.transfers.getDownloads.mockReturnValue(
      Promise.resolve([
        {
          username: 'user1',
          directories: [
            {
              directory: 'dir1',
              files: [{ filename: 'song1.mp3', state: 'Completed, Succeeded' }],
            },
          ],
        },
      ]),
    );

    // First completion
    await (watcher as any).check();

    // Wait a bit but less than debounce
    await new Promise((r) => setTimeout(r, 5));
    expect(navidromeMock.system.startScan).not.toHaveBeenCalled();

    // Second completion (different file)
    slskdMock.transfers.getDownloads.mockReturnValue(
      Promise.resolve([
        {
          username: 'user1',
          directories: [
            {
              directory: 'dir1',
              files: [
                { filename: 'song1.mp3', state: 'Completed, Succeeded' },
                { filename: 'song2.mp3', state: 'Completed, Succeeded' },
              ],
            },
          ],
        },
      ]),
    );
    await (watcher as any).check();

    // Wait 8ms (total 13ms since first, 8ms since second).
    // Debounce is 10ms, but it should have been reset by the second check.
    await new Promise((r) => setTimeout(r, 8));
    expect(navidromeMock.system.startScan).not.toHaveBeenCalled();

    // Wait for the new debounce to expire
    await new Promise((r) => setTimeout(r, 10));
    expect(navidromeMock.system.startScan).toHaveBeenCalledTimes(1);
  });

  it('calls autoPlaylist.processBatch with completed files after scan debounce', async () => {
    slskdMock.transfers.getDownloads.mockReturnValue(
      Promise.resolve([
        {
          username: 'user1',
          directories: [
            {
              directory: 'Artist - Album',
              files: [
                { filename: 'a.mp3', state: 'Completed, Succeeded' },
                { filename: 'b.mp3', state: 'Completed, Succeeded' },
              ],
            },
          ],
        },
      ]),
    );

    await (watcher as any).check();
    await new Promise((r) => setTimeout(r, 50)); // wait for debounce

    expect(autoPlaylistMock.processBatch).toHaveBeenCalledTimes(1);
    expect(autoPlaylistMock.processBatch).toHaveBeenCalledWith([
      { username: 'user1', directory: 'Artist - Album', filename: 'a.mp3' },
      { username: 'user1', directory: 'Artist - Album', filename: 'b.mp3' },
    ]);
  });
});
