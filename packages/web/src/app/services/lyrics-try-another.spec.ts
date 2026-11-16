import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { HttpErrorResponse } from '@angular/common/http';
import { Subject, of, throwError, type Observable } from 'rxjs';
import { vi } from 'vitest';
import type { LyricsDto, LyricsNextDto } from '@nicotind/core';
import { LyricsService } from './lyrics.service';
import { LibraryApiService } from './api/library-api.service';
import { NetworkStatusService } from './network-status.service';
import { PRESERVE_STORE } from './preserve-store.token';

const row = (over: Partial<LyricsDto> = {}): LyricsDto => ({
  plain: 'la la',
  synced: '[00:01.00]la la',
  source: 'lrclib',
  customized: false,
  updatedAt: 0,
  offsetMs: 0,
  ...over,
});

const applied = (index: number, total: number, plain: string): LyricsNextDto => ({
  outcome: 'applied',
  lyrics: row({ plain, walk: { index, total } }),
  applied: { source: 'lrclib', sourceTrackId: '7', candidateKey: '7', index, total, timed: true },
});

const customized = () =>
  throwError(() => new HttpErrorResponse({ status: 409, error: { code: 'lyrics-customized' } }));

function setup(stored: LyricsDto | null = row({ plain: 'first' })) {
  const api = {
    getLyrics: vi.fn(() => of(stored)),
    fetchLyrics: vi.fn(() => of(null)),
    nextLyrics: vi.fn<(id: string, confirm?: boolean) => Observable<LyricsNextDto>>(),
  };
  TestBed.configureTestingModule({
    providers: [
      { provide: LibraryApiService, useValue: api },
      {
        provide: PRESERVE_STORE,
        useValue: { getLyrics: async () => null, refreshLyrics: async () => false },
      },
      { provide: NetworkStatusService, useValue: { online: signal(true) } },
    ],
  });
  const lyrics = TestBed.inject(LyricsService);
  lyrics.ensureLoaded('s1');
  return { api, lyrics };
}

describe('LyricsService.tryAnother (#1674)', () => {
  const never = () => Promise.reject(new Error('confirm must not be asked'));

  it('applies the next candidate: the entry follows the server and the result says what was applied', () => {
    const { api, lyrics } = setup();
    api.nextLyrics.mockReturnValue(of(applied(2, 3, 'second')));
    lyrics.tryAnother('s1', never);
    expect(api.nextLyrics).toHaveBeenCalledWith('s1', false);
    expect(lyrics.lyrics()?.plain).toBe('second');
    expect(lyrics.lyrics()?.walk).toEqual({ index: 2, total: 3 });
    expect(lyrics.tryResult()).toMatchObject({ kind: 'applied', applied: { index: 2, total: 3 } });
    expect(lyrics.trying()).toBe(false);
  });

  it('is busy while the request is out, and ignores a second press', () => {
    const { api, lyrics } = setup();
    const pending = new Subject<LyricsNextDto>();
    api.nextLyrics.mockReturnValue(pending);
    lyrics.tryAnother('s1', never);
    lyrics.tryAnother('s1', never);
    expect(lyrics.trying()).toBe(true);
    expect(api.nextLyrics).toHaveBeenCalledTimes(1);
    pending.next(applied(1, 2, 'x'));
    pending.complete();
    expect(lyrics.trying()).toBe(false);
  });

  it('keeps the words on only-one and no-match, and reports which', () => {
    const { api, lyrics } = setup();
    api.nextLyrics.mockReturnValue(of({ outcome: 'only-one', lyrics: row(), applied: null }));
    lyrics.tryAnother('s1', never);
    expect(lyrics.lyrics()?.plain).toBe('first');
    expect(lyrics.tryResult()?.kind).toBe('only-one');

    api.nextLyrics.mockReturnValue(of({ outcome: 'no-match', lyrics: null, applied: null }));
    lyrics.tryAnother('s1', never);
    expect(lyrics.lyrics()?.plain).toBe('first');
    expect(lyrics.tryResult()?.kind).toBe('no-match');
  });

  it('asks before replacing an edit, and retries with the confirmation', async () => {
    const { api, lyrics } = setup(row({ plain: 'my edit', customized: true, source: 'user' }));
    api.nextLyrics.mockImplementation((_id, confirmed) =>
      confirmed ? of(applied(1, 2, 'from source')) : customized(),
    );
    const ask = vi.fn(async () => true);
    lyrics.tryAnother('s1', ask);
    await Promise.resolve();
    await Promise.resolve();
    expect(ask).toHaveBeenCalledTimes(1);
    expect(api.nextLyrics.mock.calls.map((c) => c[1])).toEqual([false, true]);
    expect(lyrics.lyrics()?.plain).toBe('from source');
  });

  it('leaves the edit and reports nothing when the listener declines', async () => {
    const { api, lyrics } = setup(row({ plain: 'my edit', customized: true, source: 'user' }));
    api.nextLyrics.mockImplementation(() => customized());
    lyrics.tryAnother('s1', async () => false);
    await Promise.resolve();
    await Promise.resolve();
    expect(api.nextLyrics).toHaveBeenCalledTimes(1);
    expect(lyrics.lyrics()?.plain).toBe('my edit');
    expect(lyrics.tryResult()).toBeNull();
    expect(lyrics.trying()).toBe(false);
  });

  it('reports an error for any other failure, without asking', () => {
    const { api, lyrics } = setup();
    api.nextLyrics.mockReturnValue(throwError(() => new HttpErrorResponse({ status: 502 })));
    lyrics.tryAnother('s1', never);
    expect(lyrics.tryResult()?.kind).toBe('error');
    expect(lyrics.lyrics()?.plain).toBe('first');
  });

  it('shows a result only for the track it was about', () => {
    const { api, lyrics } = setup();
    api.nextLyrics.mockReturnValue(of(applied(2, 3, 'second')));
    lyrics.tryAnother('s1', never);
    lyrics.ensureLoaded('s2');
    expect(lyrics.tryResult()).toBeNull();
    expect(lyrics.trying()).toBe(false);
  });
});
