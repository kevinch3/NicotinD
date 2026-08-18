import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { vi } from 'vitest';
import { Subject, of, throwError } from 'rxjs';
import { RecentlyPlayedComponent, shouldShowRecentSkeleton } from './recently-played.component';
import { AuthService } from '../../services/auth.service';
import { HistoryApiService } from '../../services/api/history-api.service';
import { PlayerService } from '../../services/player.service';
import type { RecentPlay } from '../../services/api/api-types';

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

function setup(rows: RecentPlay[] | 'error') {
  const playWithContext = vi.fn();
  TestBed.configureTestingModule({
    imports: [RecentlyPlayedComponent],
    providers: [
      {
        provide: HistoryApiService,
        useValue: {
          getRecentPlays: () => (rows === 'error' ? throwError(() => new Error('down')) : of(rows)),
        },
      },
      { provide: PlayerService, useValue: { playWithContext, currentTrack: signal(null) } },
      { provide: AuthService, useValue: { token: signal('test-token') } },
    ],
  });
  const fixture = TestBed.createComponent(RecentlyPlayedComponent);
  fixture.detectChanges();
  return { fixture, playWithContext };
}

describe('RecentlyPlayedComponent', () => {
  it('renders a tile per recent play', async () => {
    const { fixture } = setup([play({ songId: 'a' }), play({ songId: 'b' })]);
    await fixture.whenStable();
    fixture.detectChanges();

    const tiles = fixture.nativeElement.querySelectorAll('[data-testid="recently-played-item"]');
    expect(tiles).toHaveLength(2);
  });

  it('hides itself entirely when there is no history yet', async () => {
    const { fixture } = setup([]);
    await fixture.whenStable();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('[data-testid="recently-played"]')).toBeNull();
  });

  it('stays hidden when the history endpoint fails, rather than erroring the page', async () => {
    const { fixture } = setup('error');
    await fixture.whenStable();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('[data-testid="recently-played"]')).toBeNull();
  });

  it('plays the shelf as the queue, starting at the tapped tile', async () => {
    const { fixture, playWithContext } = setup([
      play({ songId: 'a' }),
      play({ songId: 'b' }),
      play({ songId: 'c' }),
    ]);
    await fixture.whenStable();
    fixture.detectChanges();

    const tiles = fixture.nativeElement.querySelectorAll('[data-testid="recently-played-item"]');
    tiles[1].click();

    // The whole shelf becomes the queue (issue #233): a context-less play would
    // leave an unrelated queue in place to resume afterwards.
    const [tracks, index, context] = playWithContext.mock.calls[0];
    expect(tracks.map((t: { id: string }) => t.id)).toEqual(['a', 'b', 'c']);
    expect(index).toBe(1);
    expect(context).toMatchObject({ type: 'adhoc' });
  });

  // Asserted on the method (not the child's rendered <img>): the JIT vitest
  // harness can't bind a child component's signal inputs — see cover-art's own
  // note on `input()` — so the DOM under <app-cover-art> is not reachable here.
  it('builds the standard /api/cover URL from the coverArt id (not a bare id, not none)', async () => {
    const { fixture } = setup([play({ coverArt: 'cov1' }), play({ songId: 'x', coverArt: null })]);
    await fixture.whenStable();

    const comp = fixture.componentInstance;
    expect(comp.coverSrc(play({ coverArt: 'cov1' }))).toBe(
      '/api/cover/cov1?size=300&token=test-token',
    );
    // No cover id → undefined, so <app-cover-art> renders its gradient placeholder.
    expect(comp.coverSrc(play({ coverArt: null }))).toBeUndefined();
  });

  it('threads the coverArt id onto the queued tracks so the player shows the cover', async () => {
    const { fixture, playWithContext } = setup([play({ coverArt: 'cov1' })]);
    await fixture.whenStable();
    fixture.detectChanges();

    fixture.nativeElement.querySelector('[data-testid="recently-played-item"]').click();
    expect(playWithContext.mock.calls[0][0][0]).toMatchObject({ coverArt: 'cov1' });
  });

  it('tolerates a play with no live metadata', async () => {
    const { fixture, playWithContext } = setup([
      play({ title: null, artist: null, album: null, duration: null }),
    ]);
    await fixture.whenStable();
    fixture.detectChanges();

    fixture.nativeElement.querySelector('[data-testid="recently-played-item"]').click();
    expect(playWithContext.mock.calls[0][0][0]).toMatchObject({ title: '', artist: '' });
  });
});

describe('shouldShowRecentSkeleton', () => {
  // The whole point of the gate: a fresh install must never flash a shelf it is
  // about to hide again. That is the first row.
  it('stays hidden while loading if the user has never played anything', () => {
    expect(shouldShowRecentSkeleton(true, false)).toBe(false);
  });

  it('shows while loading once there is evidence of past listening', () => {
    expect(shouldShowRecentSkeleton(true, true)).toBe(true);
  });

  it('never shows once loading has finished', () => {
    expect(shouldShowRecentSkeleton(false, true)).toBe(false);
    expect(shouldShowRecentSkeleton(false, false)).toBe(false);
  });
});

describe('RecentlyPlayedComponent — loading window', () => {
  /** Setup whose response is held open, so the loading state is observable. */
  function deferredSetup(hasPlayedBefore: boolean) {
    const subject = new Subject<RecentPlay[]>();
    TestBed.configureTestingModule({
      imports: [RecentlyPlayedComponent],
      providers: [
        { provide: HistoryApiService, useValue: { getRecentPlays: () => subject.asObservable() } },
        {
          provide: PlayerService,
          useValue: {
            playWithContext: vi.fn(),
            currentTrack: signal(hasPlayedBefore ? { id: 'x', title: 'X', artist: 'Y' } : null),
          },
        },
        { provide: AuthService, useValue: { token: signal('test-token') } },
      ],
    });
    const fixture = TestBed.createComponent(RecentlyPlayedComponent);
    fixture.detectChanges();
    const q = (sel: string) => fixture.nativeElement.querySelector(sel);
    return {
      fixture,
      subject,
      skeleton: () => q('[data-testid="recently-played-skeleton"]'),
      shelf: () => q('[data-testid="recently-played"]'),
    };
  }

  it('shows neither shelf nor skeleton on a fresh install', () => {
    const { skeleton, shelf } = deferredSetup(false);
    expect(skeleton()).toBeNull();
    expect(shelf()).toBeNull();
  });

  it('shows the skeleton in place of the shelf for a returning listener', () => {
    const { skeleton, shelf } = deferredSetup(true);
    expect(skeleton()).not.toBeNull();
    expect(shelf()).toBeNull();
  });

  it('swaps the skeleton for real tiles once rows land', async () => {
    const { fixture, subject, skeleton, shelf } = deferredSetup(true);
    subject.next([play({ songId: 'a' })]);
    subject.complete();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(skeleton()).toBeNull();
    expect(shelf()).not.toBeNull();
  });

  // The pre-existing "stays hidden on error" contract must survive the new flag:
  // a failed fetch has to clear `loading`, or the skeleton pulses forever.
  it('hides both when the endpoint fails, leaving no stuck skeleton', async () => {
    const { fixture, subject, skeleton, shelf } = deferredSetup(true);
    subject.next([]);
    subject.complete();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(skeleton()).toBeNull();
    expect(shelf()).toBeNull();
  });
});
