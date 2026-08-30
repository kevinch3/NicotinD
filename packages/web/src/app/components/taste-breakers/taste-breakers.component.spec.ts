import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { vi } from 'vitest';
import { of, throwError } from 'rxjs';
import { TasteBreakersComponent } from './taste-breakers.component';
import { AuthService } from '../../services/auth.service';
import { LibraryApiService } from '../../services/api/library-api.service';
import { PlayerService } from '../../services/player.service';
import { setInputValue } from '../../../testing/signal-input';
import type { RecentPlay, Song } from '../../services/api/api-types';

function play(over: Partial<RecentPlay> = {}): RecentPlay {
  return {
    songId: 's1',
    title: 'Track',
    artist: 'Artist',
    album: 'Album',
    duration: 180,
    coverArt: 'cov1',
    playedAt: 1_700_000_000_000,
    ...over,
  };
}

function song(over: Partial<Song> = {}): Song {
  return {
    id: 'r1',
    title: 'Deep cut',
    album: 'Album',
    albumId: 'a1',
    artist: 'Forgotten Artist',
    artistId: 'ar1',
    coverArt: 'cov-r1',
    size: 0,
    contentType: 'audio/mpeg',
    suffix: 'mp3',
    duration: 200,
    bitRate: 320,
    path: '/m/r1.mp3',
    created: '2024-01-01',
    ...over,
  } as Song;
}

function setup(pool: Song[] | 'error', seeds: RecentPlay[] = []) {
  const getRandomSongs = vi.fn(() =>
    pool === 'error' ? throwError(() => new Error('down')) : of(pool),
  );
  const startRadio = vi.fn();
  TestBed.configureTestingModule({
    imports: [TasteBreakersComponent],
    providers: [
      { provide: LibraryApiService, useValue: { getRandomSongs } },
      { provide: PlayerService, useValue: { startRadio } },
      { provide: AuthService, useValue: { token: signal('test-token') } },
    ],
  });
  const fixture = TestBed.createComponent(TasteBreakersComponent);
  // setInput() is a silent no-op for signal inputs on this harness — see
  // testing/signal-input.ts. Raw write before the first detectChanges.
  setInputValue(fixture.componentInstance.seeds, seeds);
  fixture.detectChanges();
  return { fixture, getRandomSongs, startRadio };
}

const items = (fixture: { nativeElement: HTMLElement }) =>
  Array.from(
    (fixture.nativeElement as HTMLElement).querySelectorAll('[data-testid="taste-breakers-item"]'),
  );

describe('TasteBreakersComponent', () => {
  it('renders a tile per random pick', async () => {
    const { fixture, getRandomSongs } = setup([song({ id: 'r1' }), song({ id: 'r2' })]);
    await fixture.whenStable();
    fixture.detectChanges();

    expect(getRandomSongs).toHaveBeenCalledTimes(1);
    expect(items(fixture)).toHaveLength(2);
  });

  it('fetches even with no listening history — random needs no seeds', async () => {
    // The distinguishing rule vs. KeepVibeComponent: a fresh install has zero
    // recent plays, and this shelf must still populate.
    const { fixture, getRandomSongs } = setup([song({ id: 'r1' })], []);
    await fixture.whenStable();
    fixture.detectChanges();

    expect(getRandomSongs).toHaveBeenCalledTimes(1);
    expect(items(fixture)).toHaveLength(1);
  });

  it('sinks recently-played songs to the back of the shelf', async () => {
    const { fixture } = setup(
      [song({ id: 'r1' }), song({ id: 'r2' }), song({ id: 'r3' })],
      [play({ songId: 'r2' })],
    );
    await fixture.whenStable();
    fixture.detectChanges();

    const ids = items(fixture).map((el) => el.getAttribute('data-song-id'));
    expect(ids).toEqual(['r1', 'r3', 'r2']);
  });

  it('backfills from the reserve without a second request', async () => {
    // The pool is fetched once and `picks` is a computed over `seeds`, so a
    // late-arriving history filters in place. Asserted on the computed rather
    // than through a re-render: a second raw write to an input signal never
    // invalidates readers that already read it (testing/signal-input.ts,
    // landmine 2), so a rendered assertion here would check the stale value.
    const { fixture, getRandomSongs } = setup(
      [song({ id: 'r1' }), song({ id: 'r2' })],
      [play({ songId: 'r1' })],
    );
    await fixture.whenStable();

    expect(fixture.componentInstance.picks().map((s) => s.id)).toEqual(['r2', 'r1']);
    expect(fixture.componentInstance.pool()).toHaveLength(2);
    expect(getRandomSongs).toHaveBeenCalledTimes(1);
  });

  it('caps the shelf at 10 even though the pool is over-fetched', async () => {
    const pool = Array.from({ length: 24 }, (_, i) => song({ id: `r${i}` }));
    const { fixture } = setup(pool);
    await fixture.whenStable();
    fixture.detectChanges();

    expect(items(fixture)).toHaveLength(10);
  });

  it('starts a radio seeded from the tapped track', async () => {
    const { fixture, startRadio } = setup([song({ id: 'r1', coverArt: 'cov-r1' })]);
    await fixture.whenStable();
    fixture.detectChanges();

    (items(fixture)[0] as HTMLButtonElement).click();

    expect(startRadio).toHaveBeenCalledTimes(1);
    expect(startRadio.mock.calls[0]![0]).toMatchObject({ id: 'r1', coverArt: 'cov-r1' });
  });

  it('hides the shelf when the library endpoint is unreachable', async () => {
    const { fixture } = setup('error');
    await fixture.whenStable();
    fixture.detectChanges();

    expect(items(fixture)).toHaveLength(0);
    expect(
      (fixture.nativeElement as HTMLElement).querySelector('[data-testid="taste-breakers"]'),
    ).toBeNull();
  });

  it('still shows a shelf when every random pick was recently played', async () => {
    // Demotion, never exclusion: a small library where all 10 songs are in the
    // last 20 plays must not lose the shelf entirely.
    const { fixture } = setup(
      [song({ id: 'r1' }), song({ id: 'r2' })],
      [play({ songId: 'r1' }), play({ songId: 'r2' })],
    );
    await fixture.whenStable();
    fixture.detectChanges();

    expect(items(fixture)).toHaveLength(2);
  });

  it('hides the shelf only when the library itself returns nothing', async () => {
    const { fixture } = setup([]);
    await fixture.whenStable();
    fixture.detectChanges();

    expect(
      (fixture.nativeElement as HTMLElement).querySelector('[data-testid="taste-breakers"]'),
    ).toBeNull();
  });
});
