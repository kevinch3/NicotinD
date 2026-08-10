import { TestBed } from '@angular/core/testing';
import { vi } from 'vitest';
import { of, throwError } from 'rxjs';
import { RecentlyPlayedComponent } from './recently-played.component';
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
      { provide: PlayerService, useValue: { playWithContext } },
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
