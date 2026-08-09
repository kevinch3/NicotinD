import { TestBed } from '@angular/core/testing';
import { Component, input, output, signal } from '@angular/core';
import { provideRouter } from '@angular/router';
import { of, throwError, Subject } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { LibraryFindComponent } from './library-find.component';
import { SearchApiService } from '../../services/api/search-api.service';
import { AuthService } from '../../services/auth.service';
import { PlayerService } from '../../services/player.service';
import { SongMenuService } from '../../services/song-menu.service';
import { TrackRowComponent } from '../../components/track-row/track-row.component';
import { LikeService } from '../../services/like.service';
import type { SearchResult } from '../../services/api/api-types';
import { setInputValue } from '../../../testing/signal-input';

type Local = SearchResult['local'];

const album = (id: string, name = id) => ({ id, name, artist: 'C. Tangana', year: 2021 });
const artist = (id: string, name = id) => ({ id, name });
const song = (id: string, title = id) => ({ id, title, artist: 'C. Tangana', album: 'Ídolo' });

function local(partial: Partial<Local> = {}): Local {
  return { albums: [], artists: [], songs: [], ...partial } as Local;
}

const authStub = () => ({
  token: signal('tok'),
  canCurate: () => false,
  canAcquire: () => true,
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
  readonly artists = input<unknown>();
  readonly duration = input<unknown>();
  readonly actions = input<unknown>();
  readonly play = output<void>();
}

function setup(result: Local | 'error' = local(), query = 'tangana') {
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
      { provide: AuthService, useValue: authStub() },
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
