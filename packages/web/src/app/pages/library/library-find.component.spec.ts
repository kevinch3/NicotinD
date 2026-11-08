import { TestBed } from '@angular/core/testing';
import { Component, input, output, signal } from '@angular/core';
import { Router, provideRouter } from '@angular/router';
import { of, throwError, Subject } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { LibraryFindComponent } from './library-find.component';
import { SearchApiService } from '../../services/api/search-api.service';
import { AuthService } from '../../services/auth.service';
import { PlayerService } from '../../services/player.service';
import { SongMenuService } from '../../services/song-menu.service';
import { TrackRowComponent } from '../../components/track-row/track-row.component';
import { LikeService } from '../../services/like.service';
import { SearchService } from '../../services/search.service';
import type { SearchResult } from '../../services/api/api-types';
import { setInputValue } from '../../../testing/signal-input';
import { LibraryEventsService } from '../../services/library-events.service';

type Local = SearchResult['local'];

const album = (id: string, name = id) => ({ id, name, artist: 'C. Tangana', year: 2021 });
const artist = (id: string, name = id) => ({ id, name });
const song = (id: string, title = id) => ({ id, title, artist: 'C. Tangana', album: 'Ídolo' });

function local(partial: Partial<Local> = {}): Local {
  return { albums: [], artists: [], songs: [], ...partial } as Local;
}

const authStub = (canAcquire = true) => ({
  token: signal('tok'),
  mediaToken: signal('tok'),
  canCurate: () => false,
  canAcquire: () => canAcquire,
  isAdmin: () => false,
});

const playerStub = (playWithContext: ReturnType<typeof vi.fn>) => ({
  playWithContext,
  currentTrack: signal(null),
  bufferingVisible: signal(false),
  isPlaying: signal(false),
});

// TrackRowComponent declares `track` as input.required, and this JIT harness
// doesn't register inputs on a *nested* component — so rendering the real row
// throws NG0950 during change detection (see src/testing/signal-input.ts,
// landmine 1). The row is covered by its own spec; here we only care that the
// Songs group renders one row per result.
@Component({ selector: 'app-track-row', standalone: true, template: '<div class="row"></div>' })
class TrackRowStub {
  readonly track = input<unknown>();
  readonly indexLabel = input<unknown>();
  readonly subtitle = input<unknown>();
  readonly album = input<unknown>();
  readonly artists = input<unknown>();
  readonly duration = input<unknown>();
  readonly actions = input<unknown>();
  readonly play = output<void>();
}

function setup(result: Local | 'error' = local(), query = 'tangana', canAcquire = true) {
  const search = vi
    .fn()
    .mockReturnValue(
      result === 'error' ? throwError(() => new Error('boom')) : of({ local: result }),
    );
  const playWithContext = vi.fn();

  TestBed.configureTestingModule({
    imports: [LibraryFindComponent],
    providers: [
      provideRouter([]),
      { provide: SearchApiService, useValue: { search } },
      { provide: AuthService, useValue: authStub(canAcquire) },
      { provide: PlayerService, useValue: playerStub(playWithContext) },
      { provide: SongMenuService, useValue: { build: () => [] } },
      { provide: LikeService, useValue: { isLiked: () => false, toggle: vi.fn() } },
    ],
  });

  TestBed.overrideComponent(LibraryFindComponent, {
    remove: { imports: [TrackRowComponent] },
    add: { imports: [TrackRowStub] },
  });

  const fixture = TestBed.createComponent(LibraryFindComponent);
  // setInput() is a silent no-op under the JIT vitest harness — see
  // src/testing/signal-input.ts. Must land before the first detectChanges().
  setInputValue(fixture.componentInstance.query, query);
  fixture.detectChanges();
  return { fixture, search, playWithContext };
}

const html = (f: { nativeElement: HTMLElement }) => f.nativeElement;
const has = (f: { nativeElement: HTMLElement }, testid: string) =>
  html(f).querySelector(`[data-testid="${testid}"]`) !== null;

describe('LibraryFindComponent', () => {
  it('surfaces an album card for an artist+title query', async () => {
    // The literal feedback-log #7 regression: every track was present, the
    // album row was clean, but no album card ever reached the user.
    const { fixture } = setup(local({ albums: [album('a1', 'Ídolo')], songs: [song('s1')] }));
    await fixture.whenStable();
    fixture.detectChanges();

    expect(has(fixture, 'library-find-albums')).toBe(true);
    expect(html(fixture).querySelector('[data-album-id="a1"]')).toBeTruthy();
  });

  it('renders all three groups when all match', async () => {
    const { fixture } = setup(
      local({ albums: [album('a1')], artists: [artist('r1')], songs: [song('s1')] }),
    );
    await fixture.whenStable();
    fixture.detectChanges();

    expect(has(fixture, 'library-find-albums')).toBe(true);
    expect(has(fixture, 'library-find-artists')).toBe(true);
    expect(has(fixture, 'library-find-songs')).toBe(true);
  });

  it('omits a group entirely when it has no matches', async () => {
    const { fixture } = setup(local({ songs: [song('s1')] }));
    await fixture.whenStable();
    fixture.detectChanges();

    expect(has(fixture, 'library-find-songs')).toBe(true);
    expect(has(fixture, 'library-find-albums')).toBe(false);
    expect(has(fixture, 'library-find-artists')).toBe(false);
  });

  it('shows the empty state when nothing in the library matches', async () => {
    const { fixture } = setup(local());
    await fixture.whenStable();
    fixture.detectChanges();

    expect(has(fixture, 'library-find-empty')).toBe(true);
  });

  // #1663: an empty find hands the query to Get → Add, prefilled, unsearched.
  it('offers to get what the library lacks, prefilling Get → Add', async () => {
    const { fixture } = setup(local(), '  rosalía motomami ');
    await fixture.whenStable();
    fixture.detectChanges();
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    const search = TestBed.inject(SearchService);

    html(fixture).querySelector<HTMLButtonElement>('[data-testid="library-find-get"]')!.click();

    expect(search.query()).toBe('rosalía motomami');
    expect(search.autoSearch()).toBe(false);
    expect(navigate).toHaveBeenCalledWith(['/get'], { queryParams: { tab: 'add' } });
  });

  it('offers no Get it to a listener', async () => {
    const { fixture } = setup(local(), 'tangana', false);
    await fixture.whenStable();
    fixture.detectChanges();
    expect(has(fixture, 'library-find-empty')).toBe(true);
    expect(has(fixture, 'library-find-get')).toBe(false);
  });

  it('reports a failed search distinctly from an empty one', async () => {
    // "your library has nothing" and "the request broke" are different facts;
    // collapsing them tells the user they don't own music they do own.
    const { fixture } = setup('error');
    await fixture.whenStable();
    fixture.detectChanges();

    expect(has(fixture, 'library-find-error')).toBe(true);
    expect(has(fixture, 'library-find-empty')).toBe(false);
  });

  it('does not hit the API for a blank query', async () => {
    const { search } = setup(local(), '   ');
    await Promise.resolve();
    expect(search).not.toHaveBeenCalled();
  });

  it('plays a clicked song in the context of the result list', async () => {
    const { fixture, playWithContext } = setup(
      local({ songs: [song('s1'), song('s2'), song('s3')] }),
    );
    await fixture.whenStable();
    fixture.detectChanges();

    fixture.componentInstance.playSong(1);
    expect(playWithContext).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ id: 's2' })]),
      1,
      expect.objectContaining({ type: 'adhoc' }),
    );
  });

  it('ignores a stale response that resolves after a newer query', async () => {
    // Typing races the network; a slow first request must not overwrite the
    // results of the query the user actually settled on, nor clear the spinner
    // the newer request owns.
    const slow = new Subject<{ local: Local }>();
    const search = vi
      .fn()
      .mockReturnValueOnce(slow.asObservable())
      .mockReturnValueOnce(of({ local: local({ albums: [album('new', 'New')] }) }));

    const { fixture } = setup(local(), '');
    // setup()'s empty query never calls the API, so these are calls 1 and 2.
    (fixture.componentInstance as unknown as { api: { search: unknown } }).api.search = search;

    const stalePromise = fixture.componentInstance.run('slow');
    await fixture.componentInstance.run('fast');

    slow.next({ local: local({ albums: [album('stale', 'Stale')] }) });
    slow.complete();
    await stalePromise;

    expect(fixture.componentInstance.results().albums.map((a) => a.id)).toEqual(['new']);
    expect(fixture.componentInstance.loading()).toBe(false);
  });
});

// #1666: search hits are snapshots like any other DTO, so their covers read the
// live overlay — a portrait or album cover replaced elsewhere re-keys here too.
describe('LibraryFindComponent — covers carry the cover rev (#1666)', () => {
  it('builds both covers through the helper, at the DTO rev', () => {
    const { fixture } = setup();
    const c = fixture.componentInstance;
    expect(c.artistCoverSrc({ id: 'r1', name: 'R', coverRev: 2 })).toBe(
      '/api/cover/r1?size=300&v=2&token=tok',
    );
    expect(c.albumCoverSrc({ ...album('a1'), coverArt: 'a1' })).toBe(
      '/api/cover/a1?size=300&token=tok',
    );
    expect(c.albumCoverSrc(album('a2'))).toBeUndefined();
  });

  it('a pushed artwork.changed re-keys the matching hit', () => {
    const { fixture } = setup();
    const c = fixture.componentInstance;
    TestBed.inject(LibraryEventsService).apply(
      {
        type: 'artwork.changed',
        changes: [
          { kind: 'artist', id: 'r1', rev: 5 },
          { kind: 'album', id: 'a1', rev: 3 },
        ],
      },
      1,
    );
    expect(c.artistCoverSrc({ id: 'r1', name: 'R' })).toBe('/api/cover/r1?size=300&v=5&token=tok');
    expect(c.albumCoverSrc({ ...album('a1'), coverArt: 'a1' })).toBe(
      '/api/cover/a1?size=300&v=3&token=tok',
    );
  });
});
