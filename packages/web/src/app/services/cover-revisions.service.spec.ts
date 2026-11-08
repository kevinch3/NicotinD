import { TestBed } from '@angular/core/testing';
import { computed } from '@angular/core';
import { describe, expect, it, beforeEach } from 'vitest';
import { CoverRevisionsService } from './cover-revisions.service';
import { artistCover, songCover } from '../lib/cover-url';

describe('CoverRevisionsService (#1666)', () => {
  let svc: CoverRevisionsService;
  beforeEach(() => {
    TestBed.resetTestingModule();
    svc = TestBed.inject(CoverRevisionsService);
  });

  it('the URL carries the DTO rev until a newer one is pushed', () => {
    const ref = artistCover({ id: 'ar1', coverArt: 'ar1', coverRev: 2 });
    expect(svc.url(ref, 160, 't')).toBe('/api/cover/ar1?size=160&v=2&token=t');
    svc.raise([{ kind: 'artist', id: 'ar1', rev: 5 }]);
    expect(svc.url(ref, 160, 't')).toBe('/api/cover/ar1?size=160&v=5&token=t');
  });

  it('a pushed rev older than the DTO never rewinds the URL', () => {
    svc.raise([{ kind: 'artist', id: 'ar1', rev: 1 }]);
    const ref = artistCover({ id: 'ar1', coverArt: 'ar1', coverRev: 4 });
    expect(svc.effective(ref!)).toBe(4);
  });

  it('a replayed older frame never rewinds the overlay', () => {
    svc.raise([{ kind: 'album', id: 'al1', rev: 3 }]);
    svc.raise([{ kind: 'album', id: 'al1', rev: 2 }]);
    expect(svc.live('album', 'al1')).toBe(3);
  });

  it('keys by kind: an album and an artist sharing an id are separate', () => {
    svc.raise([{ kind: 'album', id: 'x', rev: 7 }]);
    expect(svc.live('artist', 'x')).toBe(0);
  });

  // A snapshot (a queued Track) names its own song id as `coverArt` when the art
  // is embedded; the album's pushed rev must still reach it.
  it("an album's pushed rev reaches a song snapshot through its album id", () => {
    const track = songCover({ coverArt: 'song-9', albumId: 'al1' });
    svc.raise([{ kind: 'album', id: 'al1', rev: 2 }]);
    expect(svc.url(track, 80, 't')).toBe('/api/cover/song-9?size=80&v=2&token=t');
  });

  it('is reactive: a computed URL re-derives on a push', () => {
    const src = computed(() => svc.url(artistCover({ id: 'ar1', coverArt: 'ar1' }), 160, 't'));
    expect(src()).toBe('/api/cover/ar1?size=160&token=t');
    svc.raise([{ kind: 'artist', id: 'ar1', rev: 1 }]);
    expect(src()).toBe('/api/cover/ar1?size=160&v=1&token=t');
  });

  it('a push that moves nothing does not notify (no grid re-render)', () => {
    svc.raise([{ kind: 'artist', id: 'ar1', rev: 2 }]);
    let runs = 0;
    const src = computed(() => {
      runs++;
      return svc.live('artist', 'ar2');
    });
    src();
    svc.raise([{ kind: 'artist', id: 'ar1', rev: 2 }]);
    src();
    expect(runs).toBe(1);
  });

  it('no ref, no URL', () => {
    expect(svc.url(null, 160, 't')).toBeUndefined();
  });
});
