import { TestBed } from '@angular/core/testing';
import { computed, signal } from '@angular/core';
import { provideRouter } from '@angular/router';
import { of } from 'rxjs';
import { vi } from 'vitest';
import type { LyricsDto } from '@nicotind/core';
import { LYRICS_CACHE_SIZE, LyricsService } from './lyrics.service';
import { LibraryApiService } from './api/library-api.service';
import { AuthService } from './auth.service';
import { LikeService } from './like.service';
import { TranslateService } from './translate.service';
import { ToastService } from './toast.service';
import { PluginService } from './plugin.service';
import { ConfirmService } from './confirm.service';
import { TrackInfoSheetComponent } from '../components/track-info-sheet/track-info-sheet.component';

/**
 * #1666 Shape B: the lyrics of one song used to be owned twice — by
 * `LyricsService` (Now Playing panel, phone karaoke, TV karaoke) and by the
 * Track-info sheet's own `lyrics` signal — and neither heard the other's
 * writes. The sheet now reads and writes through `LyricsService`.
 *
 * The API double is a stateful fake server, not a per-call stub: every write
 * lands in `rows` and every read serves from it, so a fix that writes through
 * and a fix that re-reads after a write both pass, and only a copy that never
 * learns of the write fails.
 */
function dto(plain: string, over: Partial<LyricsDto> = {}): LyricsDto {
  return {
    plain,
    synced: null,
    source: 'lrclib',
    customized: false,
    updatedAt: 0,
    offsetMs: 0,
    ...over,
  };
}

function setup() {
  const rows = new Map<string, LyricsDto>();
  /** What the lyrics source answers on the next fetch; null is a clean miss. */
  let sourceAnswer: LyricsDto | null = null;
  const api = {
    getLyrics: vi.fn((id: string) => of(rows.get(id) ?? null)),
    // Mirrors fetchSongLyrics: an unforced fetch serves a stored row; a hit is
    // persisted; a miss — forced or not — leaves any stored row in place and
    // answers null (the route's `no-match`).
    fetchLyrics: vi.fn((id: string, force = false) => {
      const stored = rows.get(id);
      if (stored && !force) return of(stored);
      if (sourceAnswer) rows.set(id, sourceAnswer);
      return of(sourceAnswer);
    }),
    saveLyrics: vi.fn((id: string, plain: string) => {
      const saved = dto(plain, { source: 'user', customized: true });
      rows.set(id, saved);
      return of(saved);
    }),
    deleteLyrics: vi.fn((id: string) => {
      rows.delete(id);
      return of({ ok: true });
    }),
    setLyricsOffset: vi.fn((id: string, offsetMs: number) => {
      const saved = { ...rows.get(id)!, offsetMs };
      rows.set(id, saved);
      return of(saved);
    }),
    // The sheet's other on-open reads, inert here.
    getSong: vi.fn(() => of({ id: 's1', path: 'a/s1.opus' } as never)),
    getSongProvenance: vi.fn(() => of([])),
    getSongAcquisition: vi.fn(() => of(null)),
    getIdentifyAvailable: vi.fn(() => of({ available: false })),
  };
  TestBed.configureTestingModule({
    imports: [TrackInfoSheetComponent],
    providers: [
      provideRouter([]),
      { provide: LibraryApiService, useValue: api },
      {
        provide: TranslateService,
        useValue: { t: (k: string) => k, lang: signal('en'), revision: signal(0) },
      },
      {
        provide: PluginService,
        useValue: { names: signal(new Map()), refresh: vi.fn().mockResolvedValue(undefined) },
      },
      {
        provide: AuthService,
        useValue: { role: signal('admin'), canCurate: computed(() => true) },
      },
      { provide: LikeService, useValue: { isLiked: () => false, toggle: vi.fn() } },
      { provide: ToastService, useValue: { show: vi.fn() } },
    ],
  });
  const svc = TestBed.inject(LyricsService);
  /** Open the Track-info sheet for `id` (as TrackInfoHost does) and run its on-open loads. */
  const mountSheet = (id: string) => {
    const fixture = TestBed.createComponent(TrackInfoSheetComponent);
    const sheet = fixture.componentInstance;
    // Signal inputs do not bind under the JIT harness (docs/web-ui.md); stub it.
    (sheet as unknown as { songId: () => string }).songId = () => id;
    sheet.ngOnInit();
    return { fixture, sheet };
  };
  const openSheet = (id: string) => mountSheet(id).sheet;
  return {
    api,
    rows,
    svc,
    openSheet,
    mountSheet,
    confirm: TestBed.inject(ConfirmService),
    setSourceAnswer: (l: LyricsDto | null) => (sourceAnswer = l),
  };
}

describe('lyrics have one owner (#1666 Shape B)', () => {
  it('control: a track change and back refreshes the player copy', () => {
    const { rows, svc, openSheet, setSourceAnswer } = setup();
    rows.set('s1', dto('old words'));
    svc.ensureLoaded('s1');
    setSourceAnswer(dto('new words'));
    openSheet('s1').fetchLyricsNow();

    svc.ensureLoaded('s2');
    svc.ensureLoaded('s1');

    expect(svc.plain()).toBe('new words');
  });

  it('a Re-fetch in the Track-info sheet reaches the Now Playing / karaoke copy without a track change', () => {
    const { rows, svc, openSheet, setSourceAnswer } = setup();
    rows.set('s1', dto('old words'));
    svc.ensureLoaded('s1'); // the Lyrics tab / karaoke is showing s1
    expect(svc.plain()).toBe('old words');

    setSourceAnswer(dto('new words'));
    const sheet = openSheet('s1');
    sheet.fetchLyricsNow();
    expect(sheet.lyricsText()).toBe('new words');

    // Close the sheet, open Now Playing → Lyrics: the panel asks again.
    svc.ensureLoaded('s1');
    expect(svc.plain()).toBe('new words');
  });

  it('a Re-fetch that brings timed lyrics reaches the karaoke lines', () => {
    const { rows, svc, openSheet, setSourceAnswer } = setup();
    rows.set('s1', dto('plain only'));
    svc.ensureLoaded('s1');
    expect(svc.lines()).toEqual([]);

    setSourceAnswer(dto('hello', { synced: '[00:01.00]hello' }));
    // Karaoke stays mounted under the sheet; nothing re-asks when it closes
    // (the panel's effect reruns only on a track or tab change), so the write
    // itself has to reach the shared copy.
    openSheet('s1').fetchLyricsNow();

    expect(svc.lines().map((l) => l.text)).toEqual(['hello']);
  });

  it('an Edit saved in the Track-info sheet reaches the player copy', () => {
    const { rows, svc, openSheet } = setup();
    rows.set('s1', dto('typo wrds'));
    svc.ensureLoaded('s1');

    const sheet = openSheet('s1');
    sheet.startEditLyrics();
    sheet.lyricsDraft.set('fixed words');
    sheet.saveLyricsNow();

    expect(svc.plain()).toBe('fixed words');
  });

  it('a Reset in the Track-info sheet reaches the player copy', () => {
    const { rows, svc, openSheet } = setup();
    rows.set('s1', dto('wrong song entirely'));
    svc.ensureLoaded('s1');
    expect(svc.hasLyricsFor('s1')).toBe(true);

    openSheet('s1').resetLyrics();

    expect(svc.plain()).toBe('');
    expect(svc.hasLyricsFor('s1')).toBe(false);
  });

  it('control: a sheet write for a song that is not playing leaves the player copy alone', () => {
    // Constrains the fix: the sheet opens for any song row, so routing its
    // writes through a single-slot "current track" store must not evict the
    // playing track's lyrics.
    const { rows, svc, openSheet } = setup();
    rows.set('playing', dto('playing words'));
    rows.set('other', dto('other words'));
    svc.ensureLoaded('playing');

    const sheet = openSheet('other');
    sheet.startEditLyrics();
    sheet.lyricsDraft.set('other, edited');
    sheet.saveLyricsNow();

    expect(sheet.lyricsText()).toBe('other, edited');
    expect(svc.loadedForId()).toBe('playing');
    expect(svc.plain()).toBe('playing words');
  });

  it('a Fetch lyrics from the Now Playing panel reaches an open Track-info sheet', () => {
    const { svc, openSheet, setSourceAnswer } = setup();
    svc.ensureLoaded('s1'); // clean miss: the panel shows the empty state
    const sheet = openSheet('s1');
    expect(sheet.lyricsText()).toBe('');

    setSourceAnswer(dto('found them'));
    svc.fetchManually('s1');

    expect(svc.plain()).toBe('found them');
    expect(sheet.lyricsText()).toBe('found them');
  });

  it('a forced Re-fetch that finds nothing keeps showing the row the server kept', () => {
    // fetchSongLyrics: "a forced fetch that finds nothing leaves any stored row
    // in place" — and the route answers null. The sheet took that null as the
    // new state and blanked text the library still holds.
    const { rows, svc, openSheet, setSourceAnswer } = setup();
    rows.set('s1', dto('still stored'));
    svc.ensureLoaded('s1');
    const sheet = openSheet('s1');

    setSourceAnswer(null);
    sheet.fetchLyricsNow();

    expect(rows.get('s1')?.plain).toBe('still stored');
    expect(sheet.lyricsText()).toBe('still stored');
    expect(svc.plain()).toBe('still stored');
  });

  it('a forced Re-fetch that finds nothing says so, next to the words it kept', () => {
    const { rows, mountSheet, setSourceAnswer } = setup();
    rows.set('s1', dto('still stored'));
    const { fixture, sheet } = mountSheet('s1');

    setSourceAnswer(null);
    sheet.fetchLyricsNow();
    fixture.detectChanges();

    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('[data-testid="lyrics-text"]')?.textContent).toContain('still stored');
    expect(el.querySelector('[data-testid="lyrics-no-new-found"]')?.textContent).toContain(
      'trackInfo.lyricsNoNewFound',
    );
  });

  it('a Re-fetch that does find lyrics shows no "nothing new" notice', () => {
    const { rows, mountSheet, setSourceAnswer } = setup();
    rows.set('s1', dto('old words'));
    const { fixture, sheet } = mountSheet('s1');

    setSourceAnswer(dto('new words'));
    sheet.fetchLyricsNow();
    fixture.detectChanges();

    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('[data-testid="lyrics-no-new-found"]')).toBeNull();
  });

  describe('a closed sheet releases its eviction guard', () => {
    function browsePastTheCache(svc: LyricsService) {
      for (let i = 0; i < LYRICS_CACHE_SIZE + 5; i++) svc.ensureEntry(`browse${i}`)();
    }

    it('closing the sheet lets its song be evicted like any other', () => {
      const { rows, svc, mountSheet } = setup();
      rows.set('x', dto('words of x'));
      const { fixture } = mountSheet('x');
      expect(svc.lyricsFor('x')?.plain).toBe('words of x');

      fixture.destroy();
      browsePastTheCache(svc);

      expect(svc.lyricsFor('x')).toBeNull();
    });

    it('control: a sheet still open keeps its song in the store', () => {
      const { rows, svc, mountSheet } = setup();
      rows.set('x', dto('words of x'));
      mountSheet('x');

      browsePastTheCache(svc);

      expect(svc.lyricsFor('x')?.plain).toBe('words of x');
    });
  });

  describe('an Edit of timed lyrics asks first, because saving removes the sync', () => {
    const SYNCED = '[00:01.00]hello';

    function editingTimed() {
      const s = setup();
      s.rows.set('s1', dto('hello', { synced: SYNCED }));
      s.svc.ensureLoaded('s1');
      const sheet = s.openSheet('s1');
      sheet.startEditLyrics();
      sheet.lyricsDraft.set('hello, edited');
      sheet.saveLyricsNow();
      return { ...s, sheet };
    }

    it('asks before writing anything', () => {
      const { api, confirm } = editingTimed();
      expect(confirm.request()?.message).toBe('trackInfo.lyricsEditDropsSync');
      expect(confirm.request()?.confirmLabel).toBe('trackInfo.lyricsEditDropsSyncConfirm');
      expect(api.saveLyrics).not.toHaveBeenCalled();
    });

    it('declining keeps the timings and the editor open', async () => {
      const { api, confirm, svc, sheet } = editingTimed();
      confirm.resolve(false);
      await Promise.resolve();

      expect(api.saveLyrics).not.toHaveBeenCalled();
      expect(svc.lines().map((l) => l.text)).toEqual(['hello']);
      expect(sheet.editingLyrics()).toBe(true);
    });

    it('confirming saves, and the karaoke view follows the server to plain text', async () => {
      const { api, confirm, svc, sheet } = editingTimed();
      confirm.resolve(true);
      await Promise.resolve();

      expect(api.saveLyrics).toHaveBeenCalledWith('s1', 'hello, edited');
      expect(svc.plain()).toBe('hello, edited');
      expect(svc.lines()).toEqual([]);
      expect(sheet.editingLyrics()).toBe(false);
    });

    it('an Edit of plain-only lyrics saves without asking', () => {
      const { rows, svc, openSheet, confirm, api } = setup();
      rows.set('s1', dto('typo wrds'));
      svc.ensureLoaded('s1');
      const sheet = openSheet('s1');
      sheet.startEditLyrics();
      sheet.lyricsDraft.set('fixed words');
      sheet.saveLyricsNow();

      expect(confirm.request()).toBeNull();
      expect(api.saveLyrics).toHaveBeenCalledWith('s1', 'fixed words');
    });
  });
});
