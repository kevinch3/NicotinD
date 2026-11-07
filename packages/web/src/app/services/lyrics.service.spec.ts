import { TestBed } from '@angular/core/testing';
import { Subject, of, throwError, type Observable } from 'rxjs';
import { vi } from 'vitest';
import type { LyricsDto } from '@nicotind/core';
import { LYRICS_CACHE_SIZE, LyricsService } from './lyrics.service';
import { LibraryApiService } from './api/library-api.service';

function dto(over: Partial<LyricsDto> = {}): LyricsDto {
  return {
    plain: 'la la',
    synced: null,
    source: 'lrclib',
    customized: false,
    updatedAt: 0,
    offsetMs: 0,
    ...over,
  };
}

function setup() {
  const api = {
    getLyrics: vi.fn<(id: string) => Observable<LyricsDto | null>>(() => of(null)),
    fetchLyrics: vi.fn<(id: string, force?: boolean) => Observable<LyricsDto | null>>(() =>
      of(null),
    ),
    setLyricsOffset: vi.fn<(id: string, offsetMs: number) => Observable<LyricsDto>>((_id, ms) =>
      of(dto({ offsetMs: ms })),
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

/**
 * The sync correction, from the view's side. A nudge is judged by ear against
 * the music, so the highlight has to move on the tap — but the library must
 * never keep a correction the server refused.
 */
describe('LyricsService sync offset', () => {
  const SYNCED = '[00:01.00]one\n[00:03.00]two';

  function loaded() {
    const s = setup();
    s.api.getLyrics.mockReturnValue(of(dto({ synced: SYNCED })));
    // The real route returns the whole row, text included — it only ever writes
    // the offset column. A stub that dropped `synced` would be testing a server
    // that does not exist.
    s.api.setLyricsOffset.mockImplementation((_id, ms) =>
      of(dto({ synced: SYNCED, offsetMs: ms })),
    );
    s.lyrics.ensureLoaded('s1');
    return s;
  }

  it('shifts the rendered lines without touching the stored text', () => {
    const { lyrics } = loaded();
    lyrics.nudgeOffset(500);

    expect(lyrics.offsetMs()).toBe(500);
    expect(lyrics.lines().map((l) => l.timeMs)).toEqual([1_500, 3_500]);
    // The words the source sent are still exactly the words we hold.
    expect(lyrics.lyrics()?.synced).toBe(SYNCED);
  });

  it('moves the highlight — the whole reason to nudge by ear', () => {
    const { lyrics } = loaded();
    expect(lyrics.activeLineAt(1_500)).toBe(0);
    lyrics.nudgeOffset(1_000);
    expect(lyrics.activeLineAt(1_500)).toBe(-1);
  });

  it('accumulates nudges and persists the absolute value', () => {
    const { api, lyrics } = loaded();
    lyrics.nudgeOffset(250);
    lyrics.nudgeOffset(250);
    expect(lyrics.offsetMs()).toBe(500);
    expect(api.setLyricsOffset).toHaveBeenLastCalledWith('s1', 500);
  });

  it('applies before the round-trip, so the highlight does not wait', () => {
    const { api, lyrics } = loaded();
    const pending = new Subject<LyricsDto>();
    api.setLyricsOffset.mockReturnValue(pending);

    lyrics.nudgeOffset(750);
    expect(lyrics.offsetMs()).toBe(750);

    pending.next(dto({ synced: SYNCED, offsetMs: 750 }));
    pending.complete();
    expect(lyrics.offsetMs()).toBe(750);
  });

  it('reverts when the write fails — the view never keeps what the library refused', () => {
    const { api, lyrics } = loaded();
    api.setLyricsOffset.mockReturnValue(throwError(() => ({ status: 403 })));

    lyrics.nudgeOffset(750);

    expect(lyrics.offsetMs()).toBe(0);
    expect(lyrics.lines().map((l) => l.timeMs)).toEqual([1_000, 3_000]);
  });

  it('trusts the server’s clamp over its own optimism', () => {
    const { api, lyrics } = loaded();
    api.setLyricsOffset.mockReturnValue(of(dto({ synced: SYNCED, offsetMs: 30_000 })));
    lyrics.nudgeOffset(30_000);
    expect(lyrics.offsetMs()).toBe(30_000);
  });

  it('resets to zero, restoring the source timings exactly', () => {
    const { api, lyrics } = loaded();
    lyrics.nudgeOffset(1_000);
    lyrics.resetOffset();
    expect(lyrics.offsetMs()).toBe(0);
    expect(api.setLyricsOffset).toHaveBeenLastCalledWith('s1', 0);
    expect(lyrics.lines().map((l) => l.timeMs)).toEqual([1_000, 3_000]);
  });

  it('does nothing when no track is loaded', () => {
    const { api, lyrics } = setup();
    lyrics.nudgeOffset(500);
    expect(api.setLyricsOffset).not.toHaveBeenCalled();
  });

  it('does not write when the value would not change', () => {
    const { api, lyrics } = loaded();
    lyrics.resetOffset();
    expect(api.setLyricsOffset).not.toHaveBeenCalled();
  });
});

/**
 * #1666: a response for a request the player has since superseded — an older
 * track — must land in that track's entry, never on the current one.
 */
describe('LyricsService stale responses (#1666)', () => {
  it('a slow load for the previous track does not overwrite the current track', () => {
    const { api, lyrics } = setup();
    const forA = new Subject<LyricsDto | null>();
    const forB = new Subject<LyricsDto | null>();
    api.getLyrics.mockImplementation((id) => (id === 'a' ? forA : forB));

    lyrics.ensureLoaded('a'); // Lyrics tab open on track a…
    lyrics.ensureLoaded('b'); // …skip to b before a answered
    forB.next(dto({ plain: 'words of b' }));
    forB.complete();
    forA.next(dto({ plain: 'words of a' }));
    forA.complete();

    expect(lyrics.plain()).toBe('words of b');
    expect(lyrics.loadedForId()).toBe('b');
  });

  it('a manual fetch for the previous track does not overwrite the current track', () => {
    const { api, lyrics } = setup();
    const manualA = new Subject<LyricsDto | null>();
    api.fetchLyrics.mockImplementation((id, force) => (id === 'a' && force ? manualA : of(null)));
    api.getLyrics.mockImplementation((id) => of(id === 'b' ? dto({ plain: 'words of b' }) : null));

    lyrics.fetchManually('a');
    lyrics.ensureLoaded('b');
    manualA.next(dto({ plain: 'words of a' }));
    manualA.complete();

    expect(lyrics.plain()).toBe('words of b');
    expect(lyrics.loadedForId()).toBe('b');
  });
});

/** #1666: the store is keyed by song id, so a surface other than the player can
 *  read one song without touching the track the player shows. */
describe('LyricsService keyed entries (#1666)', () => {
  it('a sheet read never moves the current track, and never asks the sources', () => {
    const { api, lyrics } = setup();
    api.getLyrics.mockImplementation((id) => of(dto({ plain: `words of ${id}` })));
    lyrics.ensureLoaded('playing');

    lyrics.ensureEntry('other');

    expect(lyrics.lyricsFor('other')?.plain).toBe('words of other');
    expect(lyrics.loadedForId()).toBe('playing');
    expect(lyrics.plain()).toBe('words of playing');
    api.getLyrics.mockReturnValue(of(null));
    lyrics.ensureEntry('missing');
    expect(api.fetchLyrics).not.toHaveBeenCalled();
  });

  it('a re-read keeps the words on screen until it answers — karaoke never blanks mid-song', () => {
    const { api, lyrics } = setup();
    api.getLyrics.mockReturnValue(of(dto({ synced: '[00:01.00]one' })));
    lyrics.ensureLoaded('s1');
    const reread = new Subject<LyricsDto | null>();
    api.getLyrics.mockReturnValue(reread);

    lyrics.ensureEntry('s1'); // the sheet opens on the playing track

    expect(lyrics.lines().map((l) => l.text)).toEqual(['one']);
    expect(lyrics.loading()).toBe(false);
    reread.next(dto({ synced: '[00:01.00]one, fixed' }));
    reread.complete();
    expect(lyrics.lines().map((l) => l.text)).toEqual(['one, fixed']);
  });

  it('a track coming back shows its cached words at once and re-reads behind them', () => {
    const { api, lyrics } = setup();
    api.getLyrics.mockImplementation((id) => of(dto({ plain: `words of ${id}` })));
    lyrics.ensureLoaded('a');
    lyrics.ensureLoaded('b');
    const reread = new Subject<LyricsDto | null>();
    api.getLyrics.mockReturnValue(reread);

    lyrics.ensureLoaded('a');

    expect(lyrics.plain()).toBe('words of a');
    expect(lyrics.loadedForId()).toBe('a');
    reread.next(dto({ plain: 'words of a, edited elsewhere' }));
    reread.complete();
    expect(lyrics.plain()).toBe('words of a, edited elsewhere');
  });

  it('a miss is not cached: the player asking again retries the sources', () => {
    const { api, lyrics } = setup();
    lyrics.ensureLoaded('s1');
    api.fetchLyrics.mockReturnValue(of(dto({ plain: 'found later' })));

    lyrics.ensureLoaded('s1');

    expect(api.fetchLyrics).toHaveBeenCalledTimes(2);
    expect(lyrics.plain()).toBe('found later');
  });

  it('is bounded, but never evicts the current track or an id a sheet is bound to', () => {
    const { api, lyrics } = setup();
    api.getLyrics.mockImplementation((id) => of(dto({ plain: `words of ${id}` })));
    const release = lyrics.ensureEntry('in-sheet');
    for (let i = 0; i < LYRICS_CACHE_SIZE + 5; i++) lyrics.ensureLoaded(`t${i}`);
    lyrics.ensureLoaded('t0'); // back to the first track: it is current again
    for (let i = 0; i < LYRICS_CACHE_SIZE + 5; i++) lyrics.ensureEntry(`browse${i}`)();

    expect(lyrics.lyricsFor('in-sheet')?.plain).toBe('words of in-sheet');
    expect(lyrics.lyricsFor('t0')?.plain).toBe('words of t0');
    expect(lyrics.lyricsFor('t1')).toBeNull();

    release();
    for (let i = 0; i < LYRICS_CACHE_SIZE + 5; i++) lyrics.ensureEntry(`more${i}`)();
    expect(lyrics.lyricsFor('in-sheet')).toBeNull();
  });
});
