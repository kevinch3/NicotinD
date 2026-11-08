import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PreservedCoversService } from './preserved-covers.service';
import { CoverRevisionsService } from './cover-revisions.service';
import { NetworkStatusService } from './network-status.service';
import { OfflineModeService } from './offline-mode.service';
import { albumCover, artistCover, songCover } from '../lib/cover-url';
import { coverKeyOf, type PreservedCover } from '../lib/preserve-store';

// #1658: preserved covers were stored per track and never read — offline every
// cover was the placeholder. One cover per album now, served as an object URL.
describe('PreservedCoversService (#1658)', () => {
  const online = signal(true);
  let urls: string[];
  let revoked: string[];

  const cover = (key: string): PreservedCover => ({
    key,
    cover: new Blob(['x']),
    coverArt: key.slice('album:'.length),
    coverRev: 0,
  });

  beforeEach(() => {
    TestBed.resetTestingModule();
    online.set(true);
    urls = [];
    revoked = [];
    let n = 0;
    vi.spyOn(URL, 'createObjectURL').mockImplementation(() => {
      const u = `blob:test/${++n}`;
      urls.push(u);
      return u;
    });
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation((u: string) => void revoked.push(u));
    TestBed.configureTestingModule({
      providers: [{ provide: NetworkStatusService, useValue: { online } }],
    });
  });
  afterEach(() => vi.restoreAllMocks());

  it('maps each stored album cover to an object URL', async () => {
    const svc = TestBed.inject(PreservedCoversService);
    await svc.attach({ getAllCovers: async () => [cover('album:al1'), cover('album:al2')] });
    expect(svc.urlFor('album:al1')).toBe('blob:test/1');
    expect(svc.urlFor('album:al2')).toBe('blob:test/2');
    expect(svc.urlFor('album:nope')).toBeUndefined();
  });

  it('a refresh replaces the map and revokes the URLs it drops', async () => {
    const svc = TestBed.inject(PreservedCoversService);
    let stored = [cover('album:al1')];
    await svc.attach({ getAllCovers: async () => stored });
    stored = [];
    await svc.refresh();
    expect(svc.urlFor('album:al1')).toBeUndefined();
    expect(revoked).toEqual(['blob:test/1']);
  });

  it('a store that cannot be read leaves the network path alone', async () => {
    const svc = TestBed.inject(PreservedCoversService);
    await svc.attach({
      getAllCovers: async () => {
        throw new Error('no IndexedDB');
      },
    });
    expect(svc.urlFor('album:al1')).toBeUndefined();
  });

  it('offline follows device connectivity', () => {
    const svc = TestBed.inject(PreservedCoversService);
    expect(svc.offline()).toBe(false);
    online.set(false);
    expect(svc.offline()).toBe(true);
  });

  // #1751: a server that does not answer serves no covers either.
  it('offline also when the device is online but the server is unreachable', () => {
    const svc = TestBed.inject(PreservedCoversService);
    TestBed.inject(OfflineModeService).serverUnreachable.set(true);
    expect(svc.offline()).toBe(true);
  });

  describe('CoverRevisionsService.url', () => {
    async function setup() {
      const covers = TestBed.inject(PreservedCoversService);
      await covers.attach({ getAllCovers: async () => [cover('album:al1')] });
      return TestBed.inject(CoverRevisionsService);
    }

    it('offline, an album cover that is preserved comes from the device', async () => {
      const svc = await setup();
      online.set(false);
      expect(svc.url(albumCover({ id: 'al1', coverArt: 'al1', coverRev: 2 }), 160, 't')).toBe(
        'blob:test/1',
      );
      // A track of that album finds the same entry through its album id.
      expect(svc.url(songCover({ coverArt: 'al1', albumId: 'al1' }), 40, 't')).toBe('blob:test/1');
    });

    it('online, the network URL wins — a preserved copy can be older than the live rev', async () => {
      const svc = await setup();
      expect(svc.url(albumCover({ id: 'al1', coverArt: 'al1', coverRev: 2 }), 160, 't')).toBe(
        '/api/cover/al1?size=160&v=2&token=t',
      );
    });

    it('offline, an album that is not preserved and an artist keep the network URL', async () => {
      const svc = await setup();
      online.set(false);
      expect(svc.url(albumCover({ id: 'al9', coverArt: 'al9' }), 160, 't')).toBe(
        '/api/cover/al9?size=160&token=t',
      );
      expect(svc.url(artistCover({ id: 'al1', coverArt: 'al1' }), 160, 't')).toBe(
        '/api/cover/al1?size=160&token=t',
      );
    });
  });

  it('coverKeyOf names the album that owns the cover, as songCover does', () => {
    expect(coverKeyOf({ coverArt: 'al1', albumId: 'al1' })).toBe('album:al1');
    // A row preserved before #1666 had no album id: the cover id stands in.
    expect(coverKeyOf({ coverArt: 'al1' })).toBe('album:al1');
    // Embedded art: the song is its own cover id, the album still owns the key.
    expect(coverKeyOf({ coverArt: 's7', albumId: 'al1' })).toBe('album:al1');
    expect(coverKeyOf({})).toBeNull();
  });
});
