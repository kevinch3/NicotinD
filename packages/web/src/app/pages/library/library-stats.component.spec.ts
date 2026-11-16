import { TestBed } from '@angular/core/testing';
import { vi } from 'vitest';
import { of, throwError } from 'rxjs';
import { provideRouter } from '@angular/router';
import { LibraryStatsComponent } from './library-stats.component';
import { LibraryApiService } from '../../services/api/library-api.service';
import { PlayerService } from '../../services/player.service';
import { EntityMenuService } from '../../services/entity-menu.service';
import { HistoryApiService } from '../../services/api/history-api.service';
import { TranslateService, interpolate } from '../../services/translate.service';
import type { ListeningStats, StatsPeriod } from '../../services/api/api-types';
import EN from '../../../../public/i18n/en.json';

const CATALOG = EN as Record<string, string>;

function stats(over: Partial<ListeningStats> = {}): ListeningStats {
  return {
    period: '30d',
    from: 0,
    to: 1,
    totals: { plays: 12, distinctSongs: 5, distinctArtists: 3, msPlayed: 45_000_000 },
    topSongs: [{ songId: 's1', title: 'Track', artist: 'Artist', plays: 4 }],
    topArtists: [{ artist: 'Artist', plays: 7 }],
    topAlbums: [{ album: 'Album', artist: 'Artist', plays: 5 }],
    topGenres: [
      { genre: 'Cumbia', plays: 8 },
      { genre: 'Rock', plays: 4 },
    ],
    genreShare: {
      totalPlays: 12,
      slices: [
        { genre: 'Cumbia', plays: 6, share: 6 / 12 },
        { genre: 'Rock', plays: 3, share: 3 / 12 },
      ],
      other: { plays: 2, share: 2 / 12, genreCount: 2 },
      untagged: { plays: 1, share: 1 / 12 },
    },
    clock: Array.from({ length: 24 }, (_, h) => (h === 21 ? 6 : h === 9 ? 3 : 0)),
    ...over,
  };
}

const getSong = vi.fn((id: string) =>
  of({ id, title: 'Track', artist: 'Artist', album: 'Album', duration: 180 }),
);
const play = vi.fn();
const radioAction = vi.fn();
const build = vi.fn((_ref: unknown) => [
  { label: 'Start radio', labelKey: 'entityMenu.startRadio', action: radioAction },
  { label: 'Play', labelKey: 'entityMenu.play', action: vi.fn() },
]);

function setup(res: ListeningStats | 'error' = stats()) {
  for (const fn of [getSong, play, radioAction, build]) fn.mockClear();
  const getStats = vi.fn((_p: StatsPeriod, _limit?: number) =>
    res === 'error' ? throwError(() => new Error('down')) : of(res),
  );
  TestBed.configureTestingModule({
    imports: [LibraryStatsComponent],
    providers: [
      provideRouter([]),
      { provide: LibraryApiService, useValue: { getSong } },
      { provide: PlayerService, useValue: { play } },
      { provide: EntityMenuService, useValue: { build } },
      { provide: HistoryApiService, useValue: { getStats } },
      {
        provide: TranslateService,
        useValue: {
          t: (k: string, p?: Record<string, string | number>) => interpolate(CATALOG[k] ?? k, p),
          lang: () => 'en',
          revision: () => 0,
        },
      },
    ],
  });
  const fixture = TestBed.createComponent(LibraryStatsComponent);
  fixture.detectChanges();
  return { fixture, getStats, cmp: fixture.componentInstance };
}

async function settle(fixture: { whenStable: () => Promise<unknown>; detectChanges: () => void }) {
  await fixture.whenStable();
  fixture.detectChanges();
}

describe('LibraryStatsComponent', () => {
  it('loads the default period on init', async () => {
    const { fixture, getStats } = setup();
    await settle(fixture);
    expect(getStats).toHaveBeenCalledWith('30d', 10);
  });

  it('renders the headline totals', async () => {
    const { fixture } = setup();
    await settle(fixture);

    const totals = fixture.nativeElement.querySelector('[data-testid="stats-totals"]');
    expect(totals.textContent).toContain('12');
    // 45,000,000 ms = 12h 30m
    expect(totals.textContent).toContain('12h 30m');
  });

  it('switches period and refetches', async () => {
    const { fixture, getStats } = setup();
    await settle(fixture);

    const yearBtn = fixture.nativeElement.querySelector('[data-period="year"]');
    yearBtn.click();
    await settle(fixture);

    expect(getStats).toHaveBeenCalledWith('year', 10);
    expect(yearBtn.getAttribute('aria-pressed')).toBe('true');
  });

  it('does not refetch when the active period is re-tapped', async () => {
    const { fixture, getStats } = setup();
    await settle(fixture);
    fixture.nativeElement.querySelector('[data-period="30d"]').click();
    await settle(fixture);
    expect(getStats).toHaveBeenCalledTimes(1);
  });

  it('shows the empty state, and no blocks, for a user with no history', async () => {
    const { fixture } = setup(
      stats({
        totals: { plays: 0, distinctSongs: 0, distinctArtists: 0, msPlayed: 0 },
        topSongs: [],
        topArtists: [],
        topAlbums: [],
        topGenres: [],
        clock: new Array(24).fill(0),
      }),
    );
    await settle(fixture);

    expect(fixture.nativeElement.querySelector('[data-testid="stats-empty"]')).toBeTruthy();
    expect(fixture.nativeElement.querySelector('[data-testid="stats-totals"]')).toBeNull();
  });

  it('keeps the empty state rather than erroring when the request fails', async () => {
    const { fixture } = setup('error');
    await settle(fixture);
    expect(fixture.nativeElement.querySelector('[data-testid="stats-empty"]')).toBeTruthy();
  });

  it('never shows the empty state before the first response lands', () => {
    const { fixture } = setup();
    // No settle: still loading.
    expect(fixture.nativeElement.querySelector('[data-testid="stats-empty"]')).toBeNull();
  });

  it('renders one clock bar per hour, scaled to the busiest hour', async () => {
    const { fixture, cmp } = setup();
    await settle(fixture);

    const bars = fixture.nativeElement.querySelectorAll('[data-testid="stats-clock-bar"]');
    expect(bars).toHaveLength(24);
    // Percent of max, not of total — 24 shares of a total would be unreadable.
    expect(cmp.clockBars()[21].percent).toBe(100);
    expect(cmp.clockBars()[9].percent).toBe(50);
    expect(cmp.clockBars()[0].percent).toBe(0);
  });

  describe('genre share (#1670)', () => {
    const rows = (el: HTMLElement) =>
      Array.from(el.querySelectorAll('[data-testid="stats-genre-row"]')) as HTMLElement[];

    it('shows true shares of period plays — the top genre is not forced to 100', async () => {
      const { fixture, cmp } = setup();
      await settle(fixture);
      expect(cmp.genreRows().map((r) => r.percent)).toEqual([50, 25, 17, 8]);
      const first = rows(fixture.nativeElement)[0];
      expect(first.getAttribute('data-percent')).toBe('50');
      expect(first.querySelector('[data-testid="stats-genre-value"]')?.textContent?.trim()).toBe(
        '50% · 6 plays',
      );
    });

    it('two tied genres show equal sub-100 shares', async () => {
      const { fixture } = setup(
        stats({
          totals: { plays: 10, distinctSongs: 2, distinctArtists: 1, msPlayed: 1 },
          genreShare: {
            totalPlays: 10,
            slices: [
              { genre: 'A', plays: 5, share: 0.5 },
              { genre: 'B', plays: 5, share: 0.5 },
            ],
            other: { plays: 0, share: 0, genreCount: 0 },
            untagged: { plays: 0, share: 0 },
          },
        }),
      );
      await settle(fixture);
      const percents = rows(fixture.nativeElement).map((r) => r.getAttribute('data-percent'));
      expect(percents).toEqual(['50', '50']);
      expect(
        fixture.nativeElement.querySelector('[data-testid="stats-genre-tail-caption"]'),
      ).toBeNull();
    });

    it('captions the hidden tail and keeps Untagged visible', async () => {
      const { fixture } = setup();
      await settle(fixture);
      const el: HTMLElement = fixture.nativeElement;
      const tail = el.querySelector('[data-testid="stats-genre-tail-caption"]')?.textContent;
      expect(tail).toContain('+2');
      expect(tail).toContain('17%');
      const untagged = rows(el).find((r) => r.getAttribute('data-kind') === 'untagged');
      expect(untagged?.textContent).toContain('Untagged');
      expect(untagged?.hasAttribute('data-genre')).toBe(false);
      expect(untagged?.getAttribute('data-percent')).toBe('8');
      expect(el.querySelector('app-genre-distribution-strip')).toBeNull();
      expect(el.querySelector('app-genre-share-bar')).toBeTruthy();
    });

    it('secondary mode lists overlapping plays without percentages', async () => {
      const { fixture } = setup();
      await settle(fixture);
      const el: HTMLElement = fixture.nativeElement;
      const allBtn = el.querySelector(
        '[data-testid="stats-genre-mode"][data-mode="all"]',
      ) as HTMLButtonElement;
      allBtn.click();
      await settle(fixture);

      expect(allBtn.getAttribute('aria-pressed')).toBe('true');
      const all = Array.from(el.querySelectorAll('[data-testid="stats-genre-all-row"]'));
      expect(all.map((r) => r.textContent?.replace(/\s+/g, '').trim())).toEqual([
        '1Cumbia8plays',
        '2Rock4plays',
      ]);
      expect(el.querySelector('[data-testid="stats-top-genres"]')?.textContent).not.toContain('%');
      expect(rows(el)).toHaveLength(0);
    });

    it('falls back to the counts when an older server sends no genreShare', async () => {
      const legacy = stats();
      delete legacy.genreShare;
      const { fixture, cmp } = setup(legacy);
      await settle(fixture);
      const el: HTMLElement = fixture.nativeElement;

      expect(el.querySelector('[data-testid="stats-top-genres"]')).toBeTruthy();
      expect(cmp.effectiveGenreMode()).toBe('all');
      expect(el.querySelectorAll('[data-testid="stats-genre-all-row"]')).toHaveLength(2);
      expect(el.querySelector('[data-testid="stats-genre-mode"]')).toBeNull();
      expect(el.querySelector('app-genre-share-bar')).toBeNull();
      expect(el.querySelector('[data-testid="stats-top-genres"]')?.textContent).not.toContain('%');
    });
  });

  it('formats durations without a leading zero-hour', () => {
    const { cmp } = setup();
    expect(cmp.formatDuration(45_000_000)).toBe('12h 30m');
    expect(cmp.formatDuration(120_000)).toBe('2m');
    expect(cmp.formatDuration(0)).toBe('0m');
  });

  it('labels only every sixth hour, so the axis fits a phone', () => {
    const { cmp } = setup();
    expect(cmp.hourLabel(0)).toBe('0');
    expect(cmp.hourLabel(12)).toBe('12');
    expect(cmp.hourLabel(13)).toBe('');
  });

  it('renders the ranked lists', async () => {
    const { fixture } = setup();
    await settle(fixture);
    const el = fixture.nativeElement;
    expect(el.querySelectorAll('[data-testid="stats-top-song"]')).toHaveLength(1);
    expect(el.querySelectorAll('[data-testid="stats-top-artist"]')).toHaveLength(1);
    expect(el.querySelectorAll('[data-testid="stats-top-album"]')).toHaveLength(1);
    expect(el.querySelector('[data-testid="stats-top-genres"]')).toBeTruthy();
  });
});

// #1669: rows with a live library target are links with artwork; the rest are plain text.
describe('LibraryStatsComponent links and artwork (#1669)', () => {
  const LIVE = stats({
    topSongs: [
      {
        songId: 's1',
        title: 'Track',
        artist: 'Artist',
        plays: 4,
        live: true,
        albumId: 'al1',
        artistId: 'ar1',
        coverArt: 'cov1',
        coverRev: 2,
      },
      { songId: 'gone', title: 'Deleted', artist: 'Old Artist', plays: 2, live: false },
    ],
    topArtists: [
      {
        artist: 'Artist',
        plays: 7,
        artistId: 'ar1',
        coverArt: 'por1',
        coverRev: 3,
        coverKind: 'artist',
      },
      {
        artist: 'Borrowed',
        plays: 3,
        artistId: 'ar2',
        coverArt: 'cov9',
        coverRev: 0,
        coverKind: 'album',
      },
      { artist: 'Old Artist', plays: 2, artistId: null, coverArt: null, coverKind: null },
    ],
    topAlbums: [
      {
        album: 'Album',
        artist: 'Artist',
        plays: 5,
        albumId: 'al1',
        artistId: 'ar1',
        coverArt: 'cov1',
      },
      { album: 'Lost Album', artist: 'Old Artist', plays: 1, albumId: null, coverArt: null },
    ],
  });
  const q = (el: HTMLElement, sel: string) => Array.from(el.querySelectorAll<HTMLElement>(sel));

  it('a live artist and album are links to their pages', async () => {
    const { fixture } = setup(LIVE);
    await settle(fixture);
    const el = fixture.nativeElement as HTMLElement;
    expect(q(el, '[data-testid="stats-artist-link"]').map((a) => a.getAttribute('href'))).toEqual([
      '/library/artists/ar1',
      '/library/artists/ar2',
    ]);
    expect(q(el, '[data-testid="stats-album-link"]').map((a) => a.getAttribute('href'))).toEqual([
      '/library/albums/al1',
    ]);
    expect(q(el, '[data-testid="stats-song-artist"]').map((a) => a.getAttribute('href'))).toEqual([
      '/library/artists/ar1',
    ]);
  });

  it('a row whose target left the library is plain text: no link, no button', async () => {
    const { fixture } = setup(LIVE);
    await settle(fixture);
    const el = fixture.nativeElement as HTMLElement;
    for (const testid of ['stats-top-song', 'stats-top-artist', 'stats-top-album']) {
      const dead = q(el, `[data-testid="${testid}"][data-live="false"]`);
      expect(dead, testid).toHaveLength(1);
      expect(dead[0]!.querySelector('a, button'), testid).toBeNull();
      expect(dead[0]!.querySelector('[title]')?.getAttribute('title')).toBe(
        'No longer in your library',
      );
    }
  });

  it('tapping a song row plays that song', async () => {
    const { fixture } = setup(LIVE);
    await settle(fixture);
    const buttons = q(fixture.nativeElement, '[data-testid="stats-play-song"]');
    expect(buttons).toHaveLength(1);
    expect(buttons[0]!.getAttribute('aria-label')).toBe('Play Track');
    buttons[0]!.click();
    await settle(fixture);
    expect(getSong).toHaveBeenCalledWith('s1');
    expect(play).toHaveBeenCalledWith(expect.objectContaining({ id: 's1', title: 'Track' }));
  });

  it("one tap on an artist's Radio starts the radio its tile menu starts", async () => {
    const { fixture } = setup(LIVE);
    await settle(fixture);
    const radios = q(fixture.nativeElement, '[data-testid="stats-artist-radio"]');
    expect(radios).toHaveLength(2);
    radios[0]!.click();
    expect(build).toHaveBeenCalledWith({ kind: 'artist', id: 'ar1', name: 'Artist' });
    expect(radioAction).toHaveBeenCalledTimes(1);
  });

  it('builds cover URLs with the revision, and an album cover for an artist with no portrait', async () => {
    const { fixture, cmp } = setup(LIVE);
    await settle(fixture);
    const s = LIVE.topSongs[0]!;
    expect(cmp.songCoverSrc(s)).toContain('/api/cover/cov1?size=96&v=2');
    expect(cmp.artistCoverSrc(LIVE.topArtists[0]!)).toContain('/api/cover/por1?size=96&v=3');
    expect(cmp.artistCoverSrc(LIVE.topArtists[1]!)).toContain('/api/cover/cov9?size=96');
    expect(cmp.artistCoverSrc(LIVE.topArtists[2]!)).toBeUndefined();
    expect(cmp.songCoverSrc(LIVE.topSongs[1]!)).toBeUndefined();
  });

  it('a pre-#1669 server (names only) renders every row as plain text', async () => {
    const { fixture } = setup();
    await settle(fixture);
    const el = fixture.nativeElement as HTMLElement;
    expect(q(el, '[data-testid="stats-top-song"]')).toHaveLength(1);
    expect(el.querySelector('[data-testid="stats-play-song"]')).toBeNull();
    expect(el.querySelector('[data-testid="stats-artist-link"]')).toBeNull();
    expect(el.querySelector('[data-testid="stats-show-more"]')).toBeNull();
  });

  it('offers Show more only when a list came back full, and steps 10 to 25 to 50', async () => {
    const full = stats({
      topSongs: Array.from({ length: 10 }, (_, i) => ({
        songId: `s${i}`,
        title: `T${i}`,
        artist: 'A',
        plays: 1,
        live: true,
      })),
    });
    const { fixture, getStats, cmp } = setup(full);
    await settle(fixture);
    const more = () =>
      (fixture.nativeElement as HTMLElement).querySelector<HTMLElement>(
        '[data-testid="stats-show-more"]',
      );
    more()!.click();
    await settle(fixture);
    expect(getStats).toHaveBeenLastCalledWith('30d', 25);
    // The server still returned 10 rows, fewer than the 25 asked for: nothing more to show.
    expect(more()).toBeNull();
    await cmp.showMore();
    expect(getStats).toHaveBeenLastCalledWith('30d', 50);
    expect(cmp.canShowMore()).toBe(false);
  });
});
