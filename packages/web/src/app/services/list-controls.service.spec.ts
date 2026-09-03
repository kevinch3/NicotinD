import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { vi } from 'vitest';
import { ListControlsService } from './list-controls.service';

interface Item {
  id: string;
  name: string;
  created: string;
  songCount?: number;
}

const ITEMS: Item[] = [
  { id: '1', name: 'Alpha', created: '2024-01-01' },
  { id: '2', name: 'Beta', created: '2024-03-01' },
  { id: '3', name: 'Gamma', created: '2024-02-01' },
];

// Mirrors the playlist grid config: defaultSort='created', defaultDirection='desc'
const PLAYLISTS: Item[] = [
  { id: 'p1', name: 'Chill', created: '2024-01-10', songCount: 5 },
  { id: 'p2', name: 'Workout', created: '2024-06-01', songCount: 12 },
  { id: 'p3', name: 'Road trip', created: '2024-03-15', songCount: 8 },
];

const PLAYLIST_SORT_OPTIONS = [
  { field: 'name', label: 'Name' },
  { field: 'created', label: 'Date created' },
  { field: 'songCount', label: 'Track count' },
];

const SORT_OPTIONS = [
  { field: 'name', label: 'Name' },
  { field: 'created', label: 'Date' },
];

describe('ListControlsService', () => {
  let service: ListControlsService;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    service = TestBed.inject(ListControlsService);
  });

  describe('defaultDirection', () => {
    it('applies desc direction on first connect', () => {
      const items = signal(ITEMS);
      const controls = service.connect({
        pageKey: 'test-desc',
        items,
        searchFields: ['name'],
        sortOptions: SORT_OPTIONS,
        defaultSort: 'created',
        defaultDirection: 'desc',
      });

      expect(controls.sortDirection()).toBe('desc');
    });

    it('sorts items newest-first when defaultDirection is desc', () => {
      const items = signal(ITEMS);
      const controls = service.connect({
        pageKey: 'test-sort-desc',
        items,
        searchFields: ['name'],
        sortOptions: SORT_OPTIONS,
        defaultSort: 'created',
        defaultDirection: 'desc',
      });

      const sorted = controls.filtered();
      expect(sorted[0].created).toBe('2024-03-01'); // newest first
      expect(sorted[1].created).toBe('2024-02-01');
      expect(sorted[2].created).toBe('2024-01-01'); // oldest last
    });

    it('defaults to asc when defaultDirection is not provided', () => {
      const items = signal(ITEMS);
      const controls = service.connect({
        pageKey: 'test-asc-default',
        items,
        searchFields: ['name'],
        sortOptions: SORT_OPTIONS,
        defaultSort: 'name',
      });

      expect(controls.sortDirection()).toBe('asc');
    });

    it('preserves user direction preference on reconnect (does not override with default)', () => {
      const items = signal(ITEMS);
      // First connect — applies default desc
      const c1 = service.connect({
        pageKey: 'test-preserve',
        items,
        searchFields: ['name'],
        sortOptions: SORT_OPTIONS,
        defaultSort: 'created',
        defaultDirection: 'desc',
      });

      expect(c1.sortDirection()).toBe('desc');

      // User toggles to asc
      c1.toggleSortDirection();
      expect(c1.sortDirection()).toBe('asc');

      // Second connect with same key — should NOT reset to desc
      service.connect({
        pageKey: 'test-preserve',
        items,
        searchFields: ['name'],
        sortOptions: SORT_OPTIONS,
        defaultSort: 'created',
        defaultDirection: 'desc',
      });

      expect(c1.sortDirection()).toBe('asc');
    });
  });

  describe('search debounce', () => {
    it('exposes the typed text immediately but debounces the filtered result', () => {
      vi.useFakeTimers();
      try {
        const items = signal(ITEMS);
        const controls = service.connect({
          pageKey: 'test-debounce',
          items,
          searchFields: ['name'],
          sortOptions: SORT_OPTIONS,
          defaultSort: 'name',
        });

        controls.setSearchText('Beta');
        // The input binding reflects the keystroke immediately...
        expect(controls.searchText()).toBe('Beta');
        // ...but the expensive filter has not applied yet (still all 3 items).
        expect(controls.filtered()).toHaveLength(3);

        vi.advanceTimersByTime(300);
        // After the debounce window the filter applies.
        expect(controls.filtered().map((i) => i.name)).toEqual(['Beta']);
      } finally {
        vi.useRealTimers();
      }
    });

    it('collapses a burst of keystrokes into a single filter application', () => {
      vi.useFakeTimers();
      try {
        const items = signal(ITEMS);
        const controls = service.connect({
          pageKey: 'test-debounce-burst',
          items,
          searchFields: ['name'],
          sortOptions: SORT_OPTIONS,
          defaultSort: 'name',
        });

        controls.setSearchText('G');
        vi.advanceTimersByTime(50);
        controls.setSearchText('Ga');
        vi.advanceTimersByTime(50);
        controls.setSearchText('Gamma');
        // Still within the debounce window since the last keystroke — no filter yet.
        expect(controls.filtered()).toHaveLength(3);

        vi.advanceTimersByTime(300);
        expect(controls.filtered().map((i) => i.name)).toEqual(['Gamma']);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('playlists grid (defaultSort=created, defaultDirection=desc)', () => {
    it('shows newest playlist first on first visit', () => {
      const items = signal(PLAYLISTS);
      const controls = service.connect({
        pageKey: 'playlists',
        items,
        searchFields: ['name'],
        sortOptions: PLAYLIST_SORT_OPTIONS,
        defaultSort: 'created',
        defaultDirection: 'desc',
      });

      const sorted = controls.filtered();
      expect(sorted[0].id).toBe('p2'); // 2024-06-01 — newest
      expect(sorted[1].id).toBe('p3'); // 2024-03-15
      expect(sorted[2].id).toBe('p1'); // 2024-01-10 — oldest
    });

    it('sortDirection is desc on first visit', () => {
      const items = signal(PLAYLISTS);
      const controls = service.connect({
        pageKey: 'playlists-dir',
        items,
        searchFields: ['name'],
        sortOptions: PLAYLIST_SORT_OPTIONS,
        defaultSort: 'created',
        defaultDirection: 'desc',
      });

      expect(controls.sortDirection()).toBe('desc');
    });
  });
});

/**
 * Issue #747. Some fields are not one column. On a multi-disc album "Track #"
 * means `(disc, track)`, and the generic single-key sort interleaves the discs.
 * A page can hand `connect` a comparator for such a field instead of forking
 * the service or relying on `Array.sort` stability to preserve a pre-sort.
 */
describe('ListControlsService — composite sort fields', () => {
  interface Song {
    id: string;
    disc?: number;
    track?: number;
  }

  const SONGS: Song[] = [
    { id: 'd2t1', disc: 2, track: 1 },
    { id: 'd1t2', disc: 1, track: 2 },
    { id: 'd1t1', disc: 1, track: 1 },
  ];

  function connect(comparators?: Record<string, (a: Song, b: Song) => number>) {
    const service = TestBed.inject(ListControlsService);
    return service.connect<Song>({
      pageKey: `disc-${Math.random()}`,
      items: signal(SONGS),
      searchFields: ['id'] as const,
      sortOptions: [{ field: 'track', label: 'Track #' }],
      defaultSort: 'track',
      comparators,
    });
  }

  beforeEach(() => TestBed.configureTestingModule({}));

  it('uses a supplied comparator for that field', () => {
    const byDiscThenTrack = (a: Song, b: Song) =>
      (a.disc ?? 1) - (b.disc ?? 1) || (a.track ?? 0) - (b.track ?? 0);
    const controls = connect({ track: byDiscThenTrack });
    expect(controls.filtered().map((s) => s.id)).toEqual(['d1t1', 'd1t2', 'd2t1']);
  });

  it('still honours the sort direction', () => {
    const byDiscThenTrack = (a: Song, b: Song) =>
      (a.disc ?? 1) - (b.disc ?? 1) || (a.track ?? 0) - (b.track ?? 0);
    const controls = connect({ track: byDiscThenTrack });
    controls.toggleSortDirection();
    expect(controls.filtered().map((s) => s.id)).toEqual(['d2t1', 'd1t2', 'd1t1']);
  });

  it('falls back to the generic single-key sort when no comparator is given', () => {
    // Unchanged behaviour for every other page that calls connect() — and a
    // compact demonstration of why the album page needs a comparator at all:
    // keyed on `track` alone, disc 2's track 1 sorts ahead of disc 1's.
    const controls = connect();
    expect(controls.filtered().map((s) => s.id)).toEqual(['d2t1', 'd1t1', 'd1t2']);
  });
});
