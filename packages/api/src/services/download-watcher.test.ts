import { describe, expect, it, beforeEach, mock, afterEach } from 'bun:test';
import { DownloadWatcher } from './download-watcher.js';
import type { CompletedDownloadFile } from './path-inference.js';

type DownloadUser = { username: string; directories: { directory: string; fileCount: number; files: { filename: string; state: string }[] }[] };

function makeSlskdMock() {
  return {
    transfers: {
      getDownloads: mock((): Promise<DownloadUser[]> => Promise.resolve([])),
    },
  };
}
function makeNavidromeMock() {
  return {
    system: {
      startScan: mock(() => Promise.resolve()),
    },
  };
}
function makeCompilationTaggerMock() {
  return {
    tagCompletedFolders: mock((_files: CompletedDownloadFile[]) => Promise.resolve()),
  };
}
function makeAutoPlaylistMock() {
  return {
    processBatch: mock((_files: CompletedDownloadFile[]) => Promise.resolve()),
  };
}

describe('DownloadWatcher', () => {
  let slskdMock: ReturnType<typeof makeSlskdMock>;
  let navidromeMock: ReturnType<typeof makeNavidromeMock>;
  let compilationTaggerMock: ReturnType<typeof makeCompilationTaggerMock>;
  let autoPlaylistMock: ReturnType<typeof makeAutoPlaylistMock>;
  let watcher: DownloadWatcher;

  beforeEach(() => {
    slskdMock = makeSlskdMock();
    navidromeMock = makeNavidromeMock();
    compilationTaggerMock = makeCompilationTaggerMock();
    autoPlaylistMock = makeAutoPlaylistMock();

    // Use very small intervals for testing
    watcher = new DownloadWatcher(
      slskdMock as unknown as ConstructorParameters<typeof DownloadWatcher>[0],
      navidromeMock as unknown as ConstructorParameters<typeof DownloadWatcher>[1],
      {
        intervalMs: 10,
        scanDebounceMs: 10,
        compilationTagger: compilationTaggerMock,
        autoPlaylist: autoPlaylistMock,
      },
    );
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
              fileCount: 1,
              files: [{ filename: 'song1.mp3', state: 'Completed, Succeeded' }],
            },
          ],
        },
      ]),
    );

    // Manually trigger check instead of waiting for setInterval
    await (watcher as unknown as { check(): Promise<void> }).check();

    // Scan should be debounced. Should NOT have been called yet.
    expect(navidromeMock.system.startScan).not.toHaveBeenCalled();

    // Wait for debounce (10ms + buffer)
    await new Promise((r) => setTimeout(r, 50));

    expect(compilationTaggerMock.tagCompletedFolders).toHaveBeenCalledTimes(1);
    expect(compilationTaggerMock.tagCompletedFolders).toHaveBeenCalledWith([
      {
        username: 'user1',
        directory: 'dir1',
        filename: 'song1.mp3',
        relativePath: null,
        directoryFileCount: 1,
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
              fileCount: 1,
              files: [{ filename: 'song1.mp3', state: 'Completed, Succeeded' }],
            },
          ],
        },
      ]),
    );

    // First completion
    await (watcher as unknown as { check(): Promise<void> }).check();

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
    await new Promise((r) => setTimeout(r, 50)); // wait for debounce

    expect(autoPlaylistMock.processBatch).toHaveBeenCalledTimes(1);
    expect(autoPlaylistMock.processBatch).toHaveBeenCalledWith([
      {
        username: 'user1',
        directory: 'Artist - Album',
        filename: 'a.mp3',
        relativePath: null,
        directoryFileCount: 2,
      },
      {
        username: 'user1',
        directory: 'Artist - Album',
        filename: 'b.mp3',
        relativePath: null,
        directoryFileCount: 2,
      },
    ]);
  });
});
