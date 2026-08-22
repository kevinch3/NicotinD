import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { vi } from 'vitest';
import { of, throwError } from 'rxjs';
import { KeepVibeComponent } from './keep-vibe.component';
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
    title: 'Variation',
    album: 'Album',
    albumId: 'a1',
    artist: 'Other Artist',
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

function setup(recs: Song[] | 'error', seeds: RecentPlay[]) {
  const getListRadio = vi.fn(() =>
    recs === 'error' ? throwError(() => new Error('down')) : of(recs),
  );
  const startRadio = vi.fn();
  TestBed.configureTestingModule({
    imports: [KeepVibeComponent],
    providers: [
      { provide: LibraryApiService, useValue: { getListRadio } },
      { provide: PlayerService, useValue: { startRadio } },
      { provide: AuthService, useValue: { token: signal('test-token') } },
    ],
  });
  const fixture = TestBed.createComponent(KeepVibeComponent);
  // setInput() is a silent no-op for signal inputs on this harness — see
  // testing/signal-input.ts. Raw write before the first detectChanges.
  setInputValue(fixture.componentInstance.seeds, seeds);
  fixture.detectChanges();
  return { fixture, getListRadio, startRadio };
}

describe('KeepVibeComponent', () => {
  it('asks for ONE list-seeded generation with the deduped seed ids and renders a tile per rec', async () => {
    const { fixture, getListRadio } = setup(
      [song({ id: 'r1' }), song({ id: 'r2' })],
      // A repeat play must not become a duplicate seed.
      [play({ songId: 'a' }), play({ songId: 'b' }), play({ songId: 'a' })],
    );
    await fixture.whenStable();
    fixture.detectChanges();

    expect(getListRadio).toHaveBeenCalledTimes(1);
    expect(getListRadio).toHaveBeenCalledWith(['a', 'b'], 10);
    const tiles = fixture.nativeElement.querySelectorAll('[data-testid="keep-vibe-item"]');
    expect(tiles).toHaveLength(2);
  });

  it('renders nothing and never calls the API without seeds', async () => {
    const { fixture, getListRadio } = setup([song()], []);
    await fixture.whenStable();
    fixture.detectChanges();

    expect(getListRadio).not.toHaveBeenCalled();
    expect(fixture.nativeElement.querySelector('[data-testid="keep-vibe"]')).toBeNull();
    expect(fixture.nativeElement.querySelector('[data-testid="keep-vibe-skeleton"]')).toBeNull();
  });

  it('stays hidden when the radio endpoint fails, rather than erroring the page', async () => {
    const { fixture } = setup('error', [play()]);
    await fixture.whenStable();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('[data-testid="keep-vibe"]')).toBeNull();
    // The failure must clear `loading`, or the skeleton pulses forever.
    expect(fixture.nativeElement.querySelector('[data-testid="keep-vibe-skeleton"]')).toBeNull();
  });

  it('hides itself when the generation comes back empty', async () => {
    const { fixture } = setup([], [play()]);
    await fixture.whenStable();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('[data-testid="keep-vibe"]')).toBeNull();
  });

  it('tapping a tile starts a radio seeded from that recommendation', async () => {
    const { fixture, startRadio } = setup([song({ id: 'r1', coverArt: 'cov-r1' })], [play()]);
    await fixture.whenStable();
    fixture.detectChanges();

    fixture.nativeElement.querySelector('[data-testid="keep-vibe-item"]').click();
    expect(startRadio).toHaveBeenCalledTimes(1);
    // The cover id must thread onto the track so the player shows the cover.
    expect(startRadio.mock.calls[0]![0]).toMatchObject({ id: 'r1', coverArt: 'cov-r1' });
  });

  // Driven through maybeGenerate directly: the harness can't deliver a second
  // input write (testing/signal-input.ts landmine #2), but the guard is the
  // contract — a seeds re-emit must not regenerate the shelf mid-browse.
  it('generates once per visit — a seeds re-emit must not churn the shelf', async () => {
    const { fixture, getListRadio } = setup([song()], [play({ songId: 'a' })]);
    await fixture.whenStable();

    fixture.componentInstance.maybeGenerate([play({ songId: 'a' }), play({ songId: 'b' })]);
    await fixture.whenStable();

    expect(getListRadio).toHaveBeenCalledTimes(1);
  });

  // Asserted on the method (not the child's rendered <img>): the JIT vitest
  // harness can't bind a child component's signal inputs — see cover-art's own
  // note on `input()`.
  it('builds the standard /api/cover URL from the coverArt id (not a bare id, not none)', async () => {
    const { fixture } = setup([song()], [play()]);
    await fixture.whenStable();

    const comp = fixture.componentInstance;
    expect(comp.coverSrc(song({ coverArt: 'cov-r1' }))).toBe(
      '/api/cover/cov-r1?size=300&token=test-token',
    );
    expect(comp.coverSrc(song({ coverArt: undefined }))).toBeUndefined();
  });
});
