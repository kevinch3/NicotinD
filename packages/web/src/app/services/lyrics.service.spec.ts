import { TestBed } from '@angular/core/testing';
import { Subject, of, throwError, type Observable } from 'rxjs';
import { vi } from 'vitest';
import type { LyricsDto } from '@nicotind/core';
import { LyricsService } from './lyrics.service';
import { LibraryApiService } from './api/library-api.service';

function dto(over: Partial<LyricsDto> = {}): LyricsDto {
  return {
    plain: 'la la',
    synced: null,
    source: 'lrclib',
    customized: false,
    updatedAt: 0,
    ...over,
  };
}

function setup() {
  const api = {
    getLyrics: vi.fn<(id: string) => Observable<LyricsDto | null>>(() => of(null)),
    fetchLyrics: vi.fn<(id: string, force?: boolean) => Observable<LyricsDto | null>>(() =>
      of(null),
    ),
  };
  TestBed.configureTestingModule({ providers: [{ provide: LibraryApiService, useValue: api }] });
  return { api, lyrics: TestBed.inject(LyricsService) };
}

describe('LyricsService (#1134)', () => {
  it('serves a stored row without asking the sources', () => {
    const { api, lyrics } = setup();
    api.getLyrics.mockReturnValue(of(dto({ synced: '[00:01.00]hello\n[00:03.00]world' })));

    lyrics.ensureLoaded('s1');

    expect(lyrics.lines().map((l) => l.text)).toEqual(['hello', 'world']);
    expect(lyrics.loadedForId()).toBe('s1');
    expect(lyrics.hasLyricsFor('s1')).toBe(true);
    expect(api.fetchLyrics).not.toHaveBeenCalled();
  });

  it('falls back to a source fetch on a DB miss, caching the id only on a hit', () => {
    const { api, lyrics } = setup();
    api.fetchLyrics.mockReturnValue(of(null));

    lyrics.ensureLoaded('s1');

    expect(api.fetchLyrics).toHaveBeenCalledWith('s1');
    expect(lyrics.loadedForId()).toBeNull();
    expect(lyrics.hasLyricsFor('s1')).toBe(false);
    expect(lyrics.loading()).toBe(false);
  });

  it('tells a source failure apart from a confident no-match', () => {
    const { api, lyrics } = setup();
    api.fetchLyrics.mockReturnValue(throwError(() => new Error('502')));

    lyrics.ensureLoaded('s1');

    expect(lyrics.error()).toBe(true);
    expect(lyrics.loading()).toBe(false);
  });

  it('asks once per track — a second surface asking mid-flight does not double-load', () => {
    const { api, lyrics } = setup();
    api.getLyrics.mockReturnValue(new Subject());

    lyrics.ensureLoaded('s1');
    lyrics.ensureLoaded('s1');

    expect(api.getLyrics).toHaveBeenCalledTimes(1);
    expect(lyrics.loading()).toBe(true);
  });

  it('is a no-op for the track already loaded, and reloads for a new one', () => {
    const { api, lyrics } = setup();
    api.getLyrics.mockReturnValue(of(dto()));

    lyrics.ensureLoaded('s1');
    lyrics.ensureLoaded('s1');
    expect(api.getLyrics).toHaveBeenCalledTimes(1);

    lyrics.ensureLoaded('s2');
    expect(api.getLyrics).toHaveBeenCalledTimes(2);
    expect(lyrics.loadedForId()).toBe('s2');
  });

  it('never reports lyrics for a track other than the one it loaded', () => {
    // The stale-positive that used to light the tab-switcher dot after a
    // track change with the panel closed.
    const { api, lyrics } = setup();
    api.getLyrics.mockReturnValue(of(dto()));
    lyrics.ensureLoaded('s1');

    expect(lyrics.hasLyricsFor('s2')).toBe(false);
    expect(lyrics.hasLyricsFor(null)).toBe(false);
  });

  describe('fetchManually', () => {
    it('force-fetches and populates on success', () => {
      const { api, lyrics } = setup();
      api.fetchLyrics.mockReturnValue(of(dto({ plain: 'found' })));

      lyrics.fetchManually('s1');

      expect(api.fetchLyrics).toHaveBeenCalledWith('s1', true);
      expect(lyrics.plain()).toBe('found');
      expect(lyrics.loadedForId()).toBe('s1');
      expect(lyrics.fetching()).toBe(false);
      expect(lyrics.error()).toBe(false);
    });

    it('flags an error and clears the busy state on failure', () => {
      const { api, lyrics } = setup();
      api.fetchLyrics.mockReturnValue(throwError(() => new Error('502')));

      lyrics.fetchManually('s1');

      expect(lyrics.error()).toBe(true);
      expect(lyrics.fetching()).toBe(false);
      expect(lyrics.lyrics()).toBeNull();
    });

    it('ignores a second press while one is in flight, and a missing id', () => {
      const { api, lyrics } = setup();
      api.fetchLyrics.mockReturnValue(new Subject());

      lyrics.fetchManually('s1');
      lyrics.fetchManually('s1');
      lyrics.fetchManually(null);

      expect(api.fetchLyrics).toHaveBeenCalledTimes(1);
      expect(lyrics.fetching()).toBe(true);
    });
  });

  it('answers the active line for a playhead position', () => {
    const { api, lyrics } = setup();
    api.getLyrics.mockReturnValue(of(dto({ synced: '[00:01.00]one\n[00:03.00]two' })));
    lyrics.ensureLoaded('s1');

    expect(lyrics.activeLineAt(0)).toBe(-1);
    expect(lyrics.activeLineAt(1500)).toBe(0);
    expect(lyrics.activeLineAt(3500)).toBe(1);
  });
});
