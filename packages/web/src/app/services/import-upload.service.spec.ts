import { TestBed } from '@angular/core/testing';
import { vi } from 'vitest';
import { of, throwError } from 'rxjs';
import { ImportUploadService } from './import-upload.service';
import { ImportApiService } from './api/import-api.service';
import type { DroppedFile } from '../lib/upload-plan';

function file(path: string, size: number): DroppedFile {
  // `slice` is all the uploader uses, so a stub Blob keeps this out of jsdom's
  // partial File implementation.
  const blob = {
    size,
    slice: (start: number, end: number) => ({ size: end - start }) as Blob,
  } as unknown as File;
  return { path, size, blob };
}

function setup(overrides: Record<string, unknown> = {}) {
  const api = {
    createSession: vi.fn(() => of({ uploadId: 'up-1', skipped: [] as string[] })),
    // Typed args so `mock.calls[n][2]` (the offset) is reachable — vi.fn() with
    // no signature infers an empty tuple and the index assertion won't compile.
    putChunk: vi.fn((_id: string, _path: string, _offset: number, _blob: Blob) =>
      of({ received: 0 }),
    ),
    getSession: vi.fn(() =>
      of({
        state: 'open',
        chunkBytes: 10,
        files: [] as { path: string; size: number; received: number }[],
      }),
    ),
    commit: vi.fn(() => of({ jobId: 'job-1' })),
    abort: vi.fn(() => of({ ok: true })),
    ...overrides,
  };
  TestBed.configureTestingModule({ providers: [{ provide: ImportApiService, useValue: api }] });
  return { api, service: TestBed.inject(ImportUploadService) };
}

describe('ImportUploadService', () => {
  it('sends every chunk of every file, then commits', async () => {
    const { api, service } = setup();
    const jobId = await service.upload([file('a/01.flac', 25), file('a/02.flac', 4)]);

    // 25 bytes at the server's 10-byte chunk size = 3 chunks; 4 bytes = 1.
    expect(api.putChunk).toHaveBeenCalledTimes(4);
    expect(api.commit).toHaveBeenCalledWith('up-1');
    expect(jobId).toBe('job-1');
  });

  it('uses the server-reported chunk size rather than a client constant', async () => {
    const { api, service } = setup({
      getSession: vi.fn(() => of({ state: 'open', chunkBytes: 5, files: [] })),
    });
    await service.upload([file('a/01.flac', 10)]);
    expect(api.putChunk).toHaveBeenCalledTimes(2);
  });

  // Resume is the whole reason for chunking; a session that already holds bytes
  // must not re-send them.
  it('skips bytes the server already has', async () => {
    const { api, service } = setup({
      getSession: vi.fn(() =>
        of({
          state: 'open',
          chunkBytes: 10,
          files: [{ path: 'a/01.flac', size: 25, received: 20 }],
        }),
      ),
    });
    await service.upload([file('a/01.flac', 25)]);
    expect(api.putChunk).toHaveBeenCalledTimes(1);
    expect(api.putChunk.mock.calls[0]![2]).toBe(20);
  });

  it('reports bytes-weighted progress as chunks land', async () => {
    const { service } = setup();
    const seen: number[] = [];
    await service.upload([file('a/01.flac', 25)], { onProgress: (p) => seen.push(p) });
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[seen.length - 1]).toBeGreaterThan(0);
    // Never claims completion — the commit does that.
    expect(Math.max(...seen)).toBeLessThanOrEqual(99);
  });

  // A dropped connection mid-upload is the expected case, not the exceptional
  // one: retry the chunk rather than losing the whole transfer.
  it('retries a failed chunk before giving up', async () => {
    let calls = 0;
    const putChunk = vi.fn(() => {
      calls += 1;
      return calls === 1 ? throwError(() => new Error('network')) : of({ received: 10 });
    });
    const { service } = setup({ putChunk });
    await service.upload([file('a/01.flac', 10)]);
    expect(putChunk).toHaveBeenCalledTimes(2);
  });

  it('surfaces a chunk that keeps failing instead of committing a partial upload', async () => {
    const { api, service } = setup({
      putChunk: vi.fn(() => throwError(() => new Error('network'))),
    });
    await expect(service.upload([file('a/01.flac', 10)])).rejects.toThrow();
    expect(api.commit).not.toHaveBeenCalled();
  });

  it('refuses a drop with nothing uploadable, without opening a session', async () => {
    const { api, service } = setup();
    await expect(service.upload([file('a/readme.txt', 10)])).rejects.toThrow();
    expect(api.createSession).not.toHaveBeenCalled();
  });
});
