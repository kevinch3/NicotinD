import { TestBed } from '@angular/core/testing';
import { HttpClient } from '@angular/common/http';
import { of } from 'rxjs';
import { vi } from 'vitest';
import { WatchlistService, type WatchlistItem } from './watchlist.service';

function item(over: Partial<WatchlistItem>): WatchlistItem {
  return {
    id: 1,
    foreign_album_id: 'fa1',
    artist_mbid: 'mb1',
    artist_name: 'Soda Stereo',
    album_title: 'Canción Animal',
    lidarr_album_id: null,
    state: 'watching',
    last_checked_at: null,
    last_error: null,
    created_at: 0,
    ...over,
  };
}

describe('WatchlistService', () => {
  const get = vi.fn();
  const post = vi.fn();
  const del = vi.fn();
  let svc: WatchlistService;

  beforeEach(() => {
    get.mockReset();
    post.mockReset();
    del.mockReset();
    get.mockReturnValue(of({ items: [] }));
    post.mockReturnValue(of({ item: item({ id: 7 }) }));
    del.mockReturnValue(of({ ok: true }));

    TestBed.configureTestingModule({
      providers: [WatchlistService, { provide: HttpClient, useValue: { get, post, delete: del } }],
    });
    svc = TestBed.inject(WatchlistService);
  });

  it('refresh populates items and isWatched reflects them', async () => {
    get.mockReturnValue(of({ items: [item({ id: 1, foreign_album_id: 'fa1' })] }));
    await svc.refresh();
    expect(svc.items()).toHaveLength(1);
    expect(svc.isWatched('fa1')).toBe(true);
    expect(svc.isWatched('other')).toBe(false);
    expect(svc.isWatched(null)).toBe(false);
  });

  it('add optimistically inserts the returned item', async () => {
    await svc.add({ foreignAlbumId: 'fa7', artistName: 'A', albumTitle: 'B' });
    expect(post).toHaveBeenCalledWith(
      '/api/watchlist',
      expect.objectContaining({ foreignAlbumId: 'fa7' }),
    );
    expect(svc.items().some((i) => i.id === 7)).toBe(true);
  });

  it('toggle adds when not watched', async () => {
    await svc.toggle({ foreignAlbumId: 'fa9', artistMbid: 'm', artistName: 'A', title: 'B' });
    expect(post).toHaveBeenCalled();
    expect(del).not.toHaveBeenCalled();
  });

  it('toggle removes when already watched', async () => {
    get.mockReturnValue(of({ items: [item({ id: 5, foreign_album_id: 'fa5' })] }));
    await svc.refresh();

    await svc.toggle({
      foreignAlbumId: 'fa5',
      artistMbid: 'm',
      artistName: 'Soda Stereo',
      title: 'Canción Animal',
    });
    expect(del).toHaveBeenCalledWith('/api/watchlist/5');
    expect(post).not.toHaveBeenCalled();
    expect(svc.isWatched('fa5')).toBe(false);
  });
});
