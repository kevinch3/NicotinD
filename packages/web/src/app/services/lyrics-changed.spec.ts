import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { Subject, of, type Observable } from 'rxjs';
import { vi } from 'vitest';
import type { LyricsDto } from '@nicotind/core';
import { LyricsService } from './lyrics.service';
import { LibraryApiService } from './api/library-api.service';
import { LibraryEventsService } from './library-events.service';
import { AuthService } from './auth.service';
import { ServerConfigService } from './server-config.service';
import { SetupService } from './setup.service';

/**
 * #1666 B3: a lyrics change made on another device (a phone editing what the
 * TV's karaoke shows) or by the MCP curator reaches this client as a
 * `lyrics.changed` library event, which re-reads the entries on screen.
 *
 * The API double is a stateful fake server: `rows` is the library, and a write
 * "from elsewhere" is a change to `rows` the client did not make. Reads are
 * snapshots taken when the request is served, and can be held to land later.
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
  /** Reads served but not yet answered, when `holdReads` is on. */
  const heldReads: Array<() => void> = [];
  let holdReads = false;
  const api = {
    getLyrics: vi.fn((id: string): Observable<LyricsDto | null> => {
      const snapshot = rows.get(id) ?? null;
      if (!holdReads) return of(snapshot);
      const answer = new Subject<LyricsDto | null>();
      heldReads.push(() => {
        answer.next(snapshot);
        answer.complete();
      });
      return answer;
    }),
    fetchLyrics: vi.fn((id: string) => of(rows.get(id) ?? null)),
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
    invalidateLibraryReads: vi.fn(),
  };
  TestBed.configureTestingModule({
    providers: [
      { provide: LibraryApiService, useValue: api },
      { provide: AuthService, useValue: { token: () => null } },
      { provide: ServerConfigService, useValue: { sseUrl: (p: string) => p } },
      { provide: SetupService, useValue: { isOffline: signal(false) } },
    ],
  });
  const events = TestBed.inject(LibraryEventsService);
  const svc = TestBed.inject(LyricsService);
  let seq = 0;
  /** The server announcing a change, delivered the way the SSE stream delivers it. */
  const changed = (...songIds: string[]) =>
    events.apply({ type: 'lyrics.changed', songIds }, ++seq);
  return {
    api,
    rows,
    svc,
    events,
    changed,
    hold: (on: boolean) => (holdReads = on),
    releaseReads: () => heldReads.splice(0).forEach((answer) => answer()),
  };
}

describe('lyrics.changed reaches the lyrics on screen (#1666 B3)', () => {
  it('a phone edit reaches the karaoke a TV is showing, with no track change', () => {
    const { rows, svc, changed } = setup();
    rows.set('s1', dto('old words', { synced: '[00:01.00]old words' }));
    svc.ensureLoaded('s1');
    expect(svc.lines().map((l) => l.text)).toEqual(['old words']);

    rows.set('s1', dto('new words', { synced: '[00:01.00]new words' })); // the phone's Re-fetch
    changed('s1');

    expect(svc.lines().map((l) => l.text)).toEqual(['new words']);
  });

  it('a Reset on another device empties the karaoke here', () => {
    const { rows, svc, changed } = setup();
    rows.set('s1', dto('wrong song'));
    svc.ensureLoaded('s1');

    rows.delete('s1');
    changed('s1');

    expect(svc.plain()).toBe('');
    expect(svc.hasLyricsFor('s1')).toBe(false);
  });

  it('lyrics found elsewhere for a track showing "no lyrics" appear', () => {
    const { rows, svc, changed } = setup();
    svc.ensureLoaded('s1'); // a clean miss
    expect(svc.hasLyricsFor('s1')).toBe(false);

    rows.set('s1', dto('found them'));
    changed('s1');

    expect(svc.hasLyricsFor('s1')).toBe(true);
    expect(svc.plain()).toBe('found them');
  });

  it('an MCP re-time (sync_song_lyrics) moves the lines here', () => {
    const { rows, svc, changed } = setup();
    rows.set('s1', dto('hi', { synced: '[00:01.00]hi' }));
    svc.ensureLoaded('s1');

    rows.set('s1', { ...rows.get('s1')!, offsetMs: 1_500 });
    changed('s1');

    expect(svc.offsetMs()).toBe(1_500);
    expect(svc.lines()[0]!.timeMs).toBe(2_500);
  });

  it('reaches an open Track-info sheet for a song that is not playing', () => {
    const { rows, svc, changed } = setup();
    rows.set('playing', dto('playing words'));
    rows.set('other', dto('other words'));
    svc.ensureLoaded('playing');
    svc.ensureEntry('other');

    rows.set('other', dto('other, edited'));
    changed('other');

    expect(svc.lyricsFor('other')?.plain).toBe('other, edited');
    expect(svc.plain()).toBe('playing words');
  });

  it('asks nothing for a song no surface is showing', () => {
    const { api, rows, svc, changed } = setup();
    rows.set('a', dto('a'));
    rows.set('b', dto('b'));
    svc.ensureEntry('a')(); // looked at, then the sheet closed
    svc.ensureLoaded('b');
    api.getLyrics.mockClear();

    changed('a', 'never-seen');

    expect(api.getLyrics).not.toHaveBeenCalled();
  });

  it('keeps the words on screen while it re-reads — no karaoke flash mid-song', () => {
    const { rows, svc, changed, hold, releaseReads } = setup();
    rows.set('s1', dto('old words'));
    svc.ensureLoaded('s1');

    hold(true);
    rows.set('s1', dto('new words'));
    changed('s1');
    expect(svc.loading()).toBe(false);
    expect(svc.plain()).toBe('old words');

    releaseReads();
    expect(svc.plain()).toBe('new words');
  });

  it('supersedes a read that was served before the change', () => {
    const { rows, svc, changed, hold, releaseReads } = setup();
    rows.set('s1', dto('v1'));
    svc.ensureLoaded('s1');
    svc.ensureLoaded('s2');
    hold(true);
    svc.ensureLoaded('s1'); // coming back: shows v1 and re-reads behind it

    rows.set('s1', dto('v2'));
    changed('s1');
    releaseReads(); // the first read's v1 lands after the second read's v2

    expect(svc.plain()).toBe('v2');
  });

  it('never cuts into a write still in flight: it re-reads once the write answers', () => {
    const { api, rows, svc, changed } = setup();
    rows.set('s1', dto('mine'));
    svc.ensureLoaded('s1');
    const answer = new Subject<LyricsDto>();
    api.saveLyrics.mockImplementationOnce((id: string, plain: string) => {
      rows.set(id, dto(plain, { customized: true }));
      return answer;
    });
    svc.save('s1', 'my edit').subscribe();
    api.getLyrics.mockClear();

    // Another device writes after this one's save reached the server.
    rows.set('s1', dto('their edit'));
    changed('s1');
    expect(api.getLyrics).not.toHaveBeenCalled();

    answer.next(dto('my edit', { customized: true }));
    answer.complete();

    expect(api.getLyrics).toHaveBeenCalledTimes(1);
    expect(svc.plain()).toBe('their edit');
  });

  it('a change during the first load re-reads after it, not over it', () => {
    const { api, rows, svc, changed } = setup();
    const first = new Subject<LyricsDto | null>();
    api.getLyrics.mockReturnValueOnce(first);
    svc.ensureLoaded('s1');

    rows.set('s1', dto('stored meanwhile'));
    changed('s1');
    expect(api.getLyrics).toHaveBeenCalledTimes(1);

    first.next(dto('stale'));
    first.complete();

    expect(svc.plain()).toBe('stored meanwhile');
  });

  it('an echo of this tab’s own sync nudge never rewinds a later tap (#1656)', () => {
    const { api, rows, svc, changed } = setup();
    rows.set('s1', dto('hi', { synced: '[00:01.00]hi' }));
    svc.ensureLoaded('s1');
    const patch = new Subject<LyricsDto>();
    api.setLyricsOffset.mockImplementationOnce((id: string, ms: number) => {
      rows.set(id, { ...rows.get(id)!, offsetMs: ms });
      return patch;
    });

    svc.nudgeOffset(250); // PATCH 250 out, unanswered
    changed('s1'); // its echo: the server row says 250
    svc.nudgeOffset(250); // a tap queued behind it, at 500

    expect(svc.offsetMs()).toBe(500);
    patch.next({ ...rows.get('s1')! });
    patch.complete();
    expect(svc.offsetMs()).toBe(500);
    expect(rows.get('s1')?.offsetMs).toBe(500);
  });

  it('after a gap in the stream, re-reads everything on screen and nothing else', () => {
    const { api, rows, svc, events } = setup();
    for (const id of ['playing', 'sheet', 'cached']) rows.set(id, dto(`${id} v1`));
    svc.ensureEntry('cached')();
    svc.ensureEntry('sheet');
    svc.ensureLoaded('playing');
    for (const id of ['playing', 'sheet', 'cached']) rows.set(id, dto(`${id} v2`));
    api.getLyrics.mockClear();

    const receive = (seq: number) =>
      (events as unknown as { onLibraryEvent(e: MessageEvent<string>): void }).onLibraryEvent({
        data: JSON.stringify({ seq, at: 0, event: { type: 'job.changed', jobId: 'j' } }),
      } as MessageEvent<string>);
    receive(1);
    expect(api.getLyrics).not.toHaveBeenCalled();
    receive(9); // seq 1 → 9: the events between were lost.

    expect(api.getLyrics.mock.calls.map(([id]) => id).sort()).toEqual(['playing', 'sheet']);
    expect(svc.plain()).toBe('playing v2');
    expect(svc.lyricsFor('sheet')?.plain).toBe('sheet v2');
  });
});
