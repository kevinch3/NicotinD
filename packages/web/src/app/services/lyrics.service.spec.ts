import { TestBed } from '@angular/core/testing';
import { Subject, of, throwError, type Observable } from 'rxjs';
import { vi } from 'vitest';
import type { LyricsDto } from '@nicotind/core';
import { LYRICS_CACHE_SIZE, LyricsService } from './lyrics.service';
import { LibraryApiService } from './api/library-api.service';
import { NetworkStatusService } from './network-status.service';
import { PRESERVE_STORE } from './preserve-store.token';
import { signal } from '@angular/core';

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
    saveLyrics: vi.fn<(id: string, plain: string) => Observable<LyricsDto>>((_id, plain) =>
      of(dto({ plain, source: 'user', customized: true })),
    ),
    deleteLyrics: vi.fn<(id: string) => Observable<{ ok: boolean }>>(() => of({ ok: true })),
  };
  // The preserved copies (#1751): an in-memory map holding only preserved ids.
  const preservedIds = new Set<string>();
  const copies = new Map<string, LyricsDto>();
  const store = {
    getLyrics: vi.fn(async (id: string) => copies.get(id) ?? null),
    refreshLyrics: vi.fn(async (id: string, d: LyricsDto | null) => {
      if (!preservedIds.has(id)) return false;
      if (d) copies.set(id, d);
      else copies.delete(id);
      return true;
    }),
  };
  const online = signal(true);
  TestBed.configureTestingModule({
    providers: [
      { provide: LibraryApiService, useValue: api },
      { provide: PRESERVE_STORE, useValue: store },
      { provide: NetworkStatusService, useValue: { online } },
    ],
  });
  return {
    api,
    lyrics: TestBed.inject(LyricsService),
    store,
    online,
    preserve(id: string, copy?: LyricsDto) {
      preservedIds.add(id);
      if (copy) copies.set(id, copy);
    },
    copies,
  };
}

/** Let the store's promises (and the settles they schedule) run. */
const drain = () => new Promise((r) => setTimeout(r, 0));

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

/** #1666 review: a read sent while a write is in flight was sent before the
 *  write was stored, so it answers the old row. It must not supersede the
 *  write, whose answer is the newer one. */
describe('LyricsService a read never overrides a write in flight (#1666)', () => {
  it('a Fetch lyrics from the player, then the Track-info sheet opens: the fetch lands', () => {
    const { api, lyrics } = setup();
    lyrics.ensureLoaded('s1'); // clean miss
    const fetch = new Subject<LyricsDto | null>();
    api.fetchLyrics.mockReturnValue(fetch);
    const read = new Subject<LyricsDto | null>();
    api.getLyrics.mockReturnValue(read);

    lyrics.fetchManually('s1'); // the source POST takes seconds…
    lyrics.ensureEntry('s1'); // …and the sheet opens for the same song
    fetch.next(dto({ plain: 'found' }));
    fetch.complete();
    read.next(null);
    read.complete();

    expect(lyrics.plain()).toBe('found');
    expect(lyrics.lyricsFor('s1')?.plain).toBe('found');
    expect(lyrics.fetching()).toBe(false);
  });

  it('a Reset, then the track comes back: the deleted words stay gone', () => {
    const { api, lyrics } = setup();
    api.getLyrics.mockImplementation((id) => of(dto({ plain: `words of ${id}` })));
    lyrics.ensureLoaded('x');
    lyrics.ensureLoaded('y');
    const del = new Subject<{ ok: boolean }>();
    api.deleteLyrics.mockReturnValue(del);
    const reread = new Subject<LyricsDto | null>();
    api.getLyrics.mockReturnValue(reread);

    lyrics.remove('x').subscribe();
    lyrics.ensureLoaded('x');
    del.next({ ok: true });
    del.complete();
    reread.next(dto({ plain: 'words of x' }));
    reread.complete();

    expect(lyrics.lyricsFor('x')).toBeNull();
    expect(lyrics.plain()).toBe('');
  });

  it('an Edit, then that song becomes the current track with no row yet: the edit lands', () => {
    const { api, lyrics } = setup();
    const saved = new Subject<LyricsDto>();
    api.saveLyrics.mockReturnValue(saved);

    lyrics.save('n', 'typed by hand').subscribe();
    lyrics.ensureLoaded('n');
    saved.next(dto({ plain: 'typed by hand' }));
    saved.complete();

    expect(lyrics.plain()).toBe('typed by hand');
    expect(api.fetchLyrics).not.toHaveBeenCalled();
  });

  it('a write in flight is not shown as a first load', () => {
    const { api, lyrics } = setup();
    api.fetchLyrics.mockReturnValue(new Subject());

    lyrics.fetchManually('s1');

    expect(lyrics.fetching()).toBe(true);
    expect(lyrics.loading()).toBe(false);
  });

  it('a write that fails frees the entry, so the next read runs', () => {
    const { api, lyrics } = setup();
    api.saveLyrics.mockReturnValue(throwError(() => new Error('500')));
    lyrics.save('s1', 'x').subscribe({ error: () => undefined });
    api.getLyrics.mockReturnValue(of(dto({ plain: 'stored' })));

    lyrics.ensureEntry('s1');

    expect(lyrics.lyricsFor('s1')?.plain).toBe('stored');
  });

  it('a write abandoned before it answers frees the entry, so the next read runs', () => {
    const { api, lyrics } = setup();
    api.saveLyrics.mockReturnValue(new Subject());
    lyrics.save('s1', 'x').subscribe().unsubscribe();
    api.getLyrics.mockReturnValue(of(dto({ plain: 'stored' })));

    lyrics.ensureEntry('s1');

    expect(lyrics.lyricsFor('s1')?.plain).toBe('stored');
  });
});

/**
 * #1656: rapid nudges issue several writes. The last tap must win — on screen
 * and on the server — whatever order the requests are served or answered in.
 * The fake server applies a write when it serves it, so out-of-order serving
 * is modelled, not only out-of-order answers.
 */
describe('LyricsService sync offset: the last tap wins (#1656)', () => {
  const SYNCED = '[00:01.00]one\n[00:03.00]two';

  function loadedWithServer() {
    const s = setup();
    s.api.getLyrics.mockReturnValue(of(dto({ synced: SYNCED })));
    s.lyrics.ensureLoaded('s1');
    let stored = 0;
    const calls: Array<{ ms: number; res: Subject<LyricsDto> }> = [];
    const sent: number[] = [];
    s.api.setLyricsOffset.mockImplementation((_id, ms) => {
      const res = new Subject<LyricsDto>();
      calls.push({ ms, res });
      sent.push(ms);
      return res;
    });
    const serve = (i: number, ok = true) => {
      const [c] = calls.splice(i, 1);
      if (!ok) return c!.res.error({ status: 500 });
      stored = c!.ms;
      c!.res.next(dto({ synced: SYNCED, offsetMs: c!.ms }));
      c!.res.complete();
    };
    const drainNewestFirst = () => {
      while (calls.length) serve(calls.length - 1);
    };
    return { ...s, calls, sent, serve, drainNewestFirst, stored: () => stored };
  }

  it('rapid taps end with the server and the entry on the last tap, whatever the serving order', () => {
    const { lyrics, drainNewestFirst, stored } = loadedWithServer();
    lyrics.nudgeOffset(100);
    lyrics.nudgeOffset(100);
    lyrics.nudgeOffset(100);
    expect(lyrics.offsetMs()).toBe(300);

    drainNewestFirst();

    expect(stored()).toBe(300);
    expect(lyrics.offsetMs()).toBe(300);
    expect(lyrics.lyricsFor('s1')?.offsetMs).toBe(300);
  });

  it('one write per song is in flight; taps made meanwhile coalesce into one write of the latest', () => {
    const { lyrics, calls, sent, serve } = loadedWithServer();
    lyrics.nudgeOffset(100);
    lyrics.nudgeOffset(100);
    lyrics.nudgeOffset(100);
    expect(calls).toHaveLength(1);

    serve(0);
    serve(0);

    expect(sent).toEqual([100, 300]);
    expect(calls).toHaveLength(0);
  });

  it('the first answer landing while a newer tap is queued does not rewind the value', () => {
    const { lyrics, serve } = loadedWithServer();
    lyrics.nudgeOffset(250);
    lyrics.nudgeOffset(250);

    serve(0); // answers 250

    expect(lyrics.offsetMs()).toBe(500);
  });

  it('a failed write with a newer tap queued does not revert; the queued tap still lands', () => {
    const { lyrics, serve, stored } = loadedWithServer();
    lyrics.nudgeOffset(250);
    lyrics.nudgeOffset(250);

    serve(0, false);
    expect(lyrics.offsetMs()).toBe(500);
    serve(0);

    expect(stored()).toBe(500);
    expect(lyrics.offsetMs()).toBe(500);
  });

  it('a failed last write reverts to the last value the server confirmed, not the pre-burst one', () => {
    const { lyrics, serve } = loadedWithServer();
    lyrics.nudgeOffset(250);
    lyrics.nudgeOffset(250);

    serve(0); // 250 confirmed
    serve(0, false); // 500 refused

    expect(lyrics.offsetMs()).toBe(250);
  });

  it('a failed write leaves nothing stuck: the next tap writes again', () => {
    const { lyrics, sent, serve } = loadedWithServer();
    lyrics.nudgeOffset(250);
    serve(0, false);
    expect(lyrics.offsetMs()).toBe(0);

    lyrics.nudgeOffset(500);

    expect(sent).toEqual([250, 500]);
    expect(lyrics.offsetMs()).toBe(500);
  });

  it('a re-read landing mid-write keeps the tapped value, and the write still lands', () => {
    const { api, lyrics, serve } = loadedWithServer();
    lyrics.nudgeOffset(250);

    // The Track-info sheet opens: its read may be served before the PATCH.
    api.getLyrics.mockReturnValue(of(dto({ synced: SYNCED, offsetMs: 0 })));
    lyrics.ensureEntry('s1');
    expect(lyrics.offsetMs()).toBe(250);

    serve(0);
    expect(lyrics.offsetMs()).toBe(250);
  });

  it('a read started before the tap and answered after its write finished keeps the tapped value', () => {
    const { api, lyrics } = setup();
    api.getLyrics.mockReturnValue(of(dto({ synced: SYNCED })));
    lyrics.ensureLoaded('s1');

    const read = new Subject<LyricsDto | null>();
    api.getLyrics.mockReturnValue(read);
    lyrics.ensureEntry('s1');
    lyrics.nudgeOffset(250); // the default fake answers the PATCH at once

    read.next(dto({ synced: SYNCED, offsetMs: 0 }));
    read.complete();

    expect(lyrics.offsetMs()).toBe(250);
  });
});

/**
 * #1656 review: a Re-fetch, Edit or Delete replaces the row (the server's
 * `setLyrics` resets the offset to 0). A tap measured against the old LRC must
 * not be written onto, or shown on, the new one.
 */
describe('LyricsService sync offset vs a whole-row write (#1656)', () => {
  const OLD = '[00:01.00]a\n[00:03.00]b';
  const NEW = '[00:02.00]b';

  function burstWithServer() {
    const s = setup();
    s.api.getLyrics.mockReturnValue(of(dto({ synced: OLD })));
    s.lyrics.ensureLoaded('s1');
    const calls: Array<{ ms: number; res: Subject<LyricsDto> }> = [];
    const sent: number[] = [];
    s.api.setLyricsOffset.mockImplementation((_id, ms) => {
      const res = new Subject<LyricsDto>();
      calls.push({ ms, res });
      sent.push(ms);
      return res;
    });
    const serve = (ok = true) => {
      const c = calls.shift()!;
      if (!ok) return c.res.error({ status: 500 });
      c.res.next(dto({ synced: OLD, offsetMs: c.ms }));
      c.res.complete();
    };
    return { ...s, calls, sent, serve };
  }

  it('a Re-fetch that replaces the row drops the queued tap; the stale answer does not land', () => {
    const { api, lyrics, sent, serve } = burstWithServer();
    lyrics.nudgeOffset(250);
    lyrics.nudgeOffset(250); // 500 queued behind PATCH 250

    api.fetchLyrics.mockReturnValue(of(dto({ synced: NEW, offsetMs: 0 })));
    lyrics.fetchFor('s1', true).subscribe();
    serve(); // PATCH 250 answers after the re-fetch

    expect(sent).toEqual([250]);
    expect(lyrics.offsetMs()).toBe(0);
    expect(lyrics.lyrics()?.synced).toBe(NEW);
  });

  it('a queued tap is not sent while a Re-fetch is outstanding, then dropped when it replaces the row', () => {
    const { api, lyrics, calls, sent, serve } = burstWithServer();
    lyrics.nudgeOffset(250);
    lyrics.nudgeOffset(250);
    const fetched = new Subject<LyricsDto | null>();
    api.fetchLyrics.mockReturnValue(fetched);
    lyrics.fetchFor('s1', true).subscribe();

    serve(); // PATCH 250 answers first; 500 must wait behind the re-fetch
    expect(calls).toHaveLength(0);

    fetched.next(dto({ synced: NEW, offsetMs: 0 }));
    fetched.complete();

    expect(sent).toEqual([250]);
    expect(lyrics.offsetMs()).toBe(0);
  });

  it('an in-flight write answering after the Re-fetch landed does not put its value on the new row', () => {
    const { api, lyrics, serve } = burstWithServer();
    lyrics.nudgeOffset(250);

    api.fetchLyrics.mockReturnValue(of(dto({ synced: NEW, offsetMs: 0 })));
    lyrics.fetchFor('s1', true).subscribe();
    serve();

    expect(lyrics.offsetMs()).toBe(0);
  });

  it('an in-flight write failing after the Re-fetch landed does not revert the new row', () => {
    const { api, lyrics, serve } = burstWithServer();
    lyrics.nudgeOffset(250);
    api.fetchLyrics.mockReturnValue(of(dto({ synced: NEW, offsetMs: 120 })));
    lyrics.fetchFor('s1', true).subscribe();

    serve(false);

    expect(lyrics.offsetMs()).toBe(120);
  });

  it('a Re-fetch that finds nothing keeps the row, so the queued tap still goes out', () => {
    const { api, lyrics, sent, serve } = burstWithServer();
    lyrics.nudgeOffset(250);
    lyrics.nudgeOffset(250);
    api.fetchLyrics.mockReturnValue(of(null));
    lyrics.fetchFor('s1', true).subscribe();

    serve();
    serve();

    expect(sent).toEqual([250, 500]);
    expect(lyrics.offsetMs()).toBe(500);
  });

  it('an Edit that replaces the row drops the queued tap', () => {
    const { api, lyrics, sent, serve } = burstWithServer();
    lyrics.nudgeOffset(250);
    lyrics.nudgeOffset(250);
    api.saveLyrics.mockReturnValue(of(dto({ plain: 'edited', offsetMs: 0 })));
    lyrics.save('s1', 'edited').subscribe();

    serve();

    expect(sent).toEqual([250]);
    expect(lyrics.offsetMs()).toBe(0);
  });

  it('a tap after the replacing write landed is written, and a failure reverts to the new row', () => {
    const { api, lyrics, sent, serve } = burstWithServer();
    lyrics.nudgeOffset(250);
    api.fetchLyrics.mockReturnValue(of(dto({ synced: NEW, offsetMs: 0 })));
    lyrics.fetchFor('s1', true).subscribe();
    lyrics.nudgeOffset(-100); // measured against the new row, queued behind PATCH 250

    serve(); // stale
    expect(lyrics.offsetMs()).toBe(-100);
    serve(false);

    expect(sent).toEqual([250, -100]);
    expect(lyrics.offsetMs()).toBe(0);
  });
});

describe('LyricsService preserved copies (#1751)', () => {
  const synced = '[00:01.00]hello\n[00:03.00]world';

  it('offline, the player reads the preserved copy and asks nobody', async () => {
    const { api, lyrics, online, preserve } = setup();
    preserve('s1', dto({ synced, offsetMs: 250 }));
    online.set(false);

    lyrics.ensureLoaded('s1');
    await drain();

    expect(api.getLyrics).not.toHaveBeenCalled();
    expect(api.fetchLyrics).not.toHaveBeenCalled();
    expect(lyrics.lines().map((l) => l.text)).toEqual(['hello', 'world']);
    expect(lyrics.offsetMs()).toBe(250);
    expect(lyrics.loading()).toBe(false);
  });

  it('a failed server read (online but unreachable) falls back to the copy', async () => {
    const { api, lyrics, preserve } = setup();
    preserve('s1', dto({ synced }));
    api.getLyrics.mockReturnValue(throwError(() => new Error('502')));

    lyrics.ensureLoaded('s1');
    await drain();

    expect(lyrics.hasLyricsFor('s1')).toBe(true);
    expect(api.fetchLyrics).not.toHaveBeenCalled();
  });

  it('offline with no copy: no lyrics, not stuck loading', async () => {
    const { lyrics, online } = setup();
    online.set(false);
    lyrics.ensureLoaded('s1');
    await drain();
    expect(lyrics.hasLyricsFor('s1')).toBe(false);
    expect(lyrics.loading()).toBe(false);
  });

  it('every server answer keeps a preserved copy current — read, change event, save, delete', async () => {
    const { api, lyrics, preserve, copies } = setup();
    preserve('s1', dto({ plain: 'old' }));
    api.getLyrics.mockReturnValue(of(dto({ plain: 'fresh' })));

    lyrics.ensureLoaded('s1');
    await drain();
    expect(copies.get('s1')?.plain).toBe('fresh');

    api.getLyrics.mockReturnValue(of(dto({ plain: 'from another device' })));
    lyrics.invalidate(['s1']);
    await drain();
    expect(copies.get('s1')?.plain).toBe('from another device');

    lyrics.save('s1', 'edited').subscribe();
    await drain();
    expect(copies.get('s1')?.plain).toBe('edited');

    lyrics.remove('s1').subscribe();
    await drain();
    expect(copies.has('s1')).toBe(false);
  });

  it('a confirmed sync offset reaches the copy', async () => {
    const { api, lyrics, preserve, copies } = setup();
    preserve('s1');
    api.getLyrics.mockReturnValue(of(dto({ synced })));
    lyrics.ensureLoaded('s1');
    lyrics.nudgeOffset(100);
    await drain();
    expect(copies.get('s1')?.offsetMs).toBe(100);
  });

  it('a song that is not preserved stores nothing', async () => {
    const { api, lyrics, store, copies } = setup();
    api.getLyrics.mockReturnValue(of(dto()));
    lyrics.ensureLoaded('s1');
    await drain();
    expect(store.refreshLyrics).toHaveBeenCalledWith('s1', expect.anything());
    expect(copies.size).toBe(0);
  });

  it('topUpPreserved: stores the row for a preserved track with no copy, once', async () => {
    const { api, lyrics, preserve, copies } = setup();
    preserve('s1');
    api.getLyrics.mockReturnValue(of(dto({ plain: 'later' })));
    await lyrics.topUpPreserved('s1');
    expect(copies.get('s1')?.plain).toBe('later');

    api.getLyrics.mockClear();
    await lyrics.topUpPreserved('s1');
    expect(api.getLyrics).not.toHaveBeenCalled();
    expect(api.fetchLyrics).not.toHaveBeenCalled();
  });

  it('snapshot: the held entry, else the stored row — never the sources', async () => {
    const { api, lyrics } = setup();
    api.getLyrics.mockReturnValue(of(dto({ plain: 'held' })));
    lyrics.ensureLoaded('s1');
    expect((await lyrics.snapshot('s1'))?.plain).toBe('held');

    api.getLyrics.mockClear();
    api.getLyrics.mockReturnValue(of(dto({ plain: 'stored' })));
    expect((await lyrics.snapshot('s2'))?.plain).toBe('stored');
    expect(api.getLyrics).toHaveBeenCalledWith('s2');

    api.getLyrics.mockReturnValue(throwError(() => new Error('offline')));
    expect(await lyrics.snapshot('s3')).toBeNull();
    expect(api.fetchLyrics).not.toHaveBeenCalled();
  });
});
