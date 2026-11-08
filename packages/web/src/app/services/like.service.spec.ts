import { TestBed } from '@angular/core/testing';
import { vi } from 'vitest';
import { of, throwError } from 'rxjs';
import { LikeService } from './like.service';
import { LibraryApiService } from './api/library-api.service';
import { PlaylistService } from './playlist.service';
import { haptic } from '../lib/haptics';

vi.mock('../lib/haptics', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/haptics')>()),
  haptic: vi.fn(),
}));

function setup(api: Partial<LibraryApiService>) {
  TestBed.configureTestingModule({
    providers: [
      LikeService,
      { provide: LibraryApiService, useValue: api },
      { provide: PlaylistService, useValue: { refresh: vi.fn() } },
    ],
  });
  return TestBed.inject(LikeService);
}

describe('LikeService', () => {
  it('refresh() loads the liked-id set', async () => {
    const svc = setup({ getLikedIds: () => of({ ids: ['s1', 's2'] }) } as never);
    await svc.refresh();
    expect(svc.isLiked('s1')).toBe(true);
    expect(svc.isLiked('s3')).toBe(false);
    expect(svc.loaded()).toBe(true);
  });

  it('toggle() optimistically likes then persists', async () => {
    const likeSong = vi.fn(() => of({ liked: true }));
    const svc = setup({ getLikedIds: () => of({ ids: [] }), likeSong } as never);
    await svc.refresh();
    await svc.toggle('s1');
    expect(likeSong).toHaveBeenCalledWith('s1');
    expect(svc.isLiked('s1')).toBe(true);
  });

  it('toggle() unlikes an already-liked song', async () => {
    const unlikeSong = vi.fn(() => of({ liked: false }));
    const svc = setup({ getLikedIds: () => of({ ids: ['s1'] }), unlikeSong } as never);
    await svc.refresh();
    await svc.toggle('s1');
    expect(unlikeSong).toHaveBeenCalledWith('s1');
    expect(svc.isLiked('s1')).toBe(false);
  });

  it('toggle() reverts the optimistic flip when the request fails', async () => {
    const likeSong = vi.fn(() => throwError(() => new Error('boom')));
    const svc = setup({ getLikedIds: () => of({ ids: [] }), likeSong } as never);
    await svc.refresh();
    await svc.toggle('s1');
    expect(svc.isLiked('s1')).toBe(false); // reverted
  });

  it('toggle() ticks `success` on a like and `tap` on an unlike (#1659)', async () => {
    vi.mocked(haptic).mockClear();
    const svc = setup({
      getLikedIds: () => of({ ids: ['s1'] }),
      likeSong: () => of({ liked: true }),
      unlikeSong: () => of({ liked: false }),
    } as never);
    await svc.refresh();
    await svc.toggle('s2');
    await svc.toggle('s1');
    expect(vi.mocked(haptic).mock.calls).toEqual([['success'], ['tap']]);
  });

  it('a like the server rejects ticks `error` after the optimistic `success` (#1659)', async () => {
    vi.mocked(haptic).mockClear();
    const svc = setup({
      getLikedIds: () => of({ ids: [] }),
      likeSong: () => throwError(() => new Error('offline')),
    } as never);
    await svc.refresh();
    await svc.toggle('s1');
    expect(svc.isLiked('s1')).toBe(false);
    expect(vi.mocked(haptic).mock.calls).toEqual([['success'], ['error']]);
  });

  it('reset() clears state', async () => {
    const svc = setup({ getLikedIds: () => of({ ids: ['s1'] }) } as never);
    await svc.refresh();
    svc.reset();
    expect(svc.isLiked('s1')).toBe(false);
    expect(svc.loaded()).toBe(false);
  });
});
