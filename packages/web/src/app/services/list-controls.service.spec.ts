import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { ListControlsService } from './list-controls.service';

interface Item {
  id: string;
  name: string;
  created: string;
  songCount?: number;
}

const ITEMS: Item[] = [
  { id: '1', name: 'Alpha', created: '2024-01-01' },
  { id: '2', name: 'Beta',  created: '2024-03-01' },
  { id: '3', name: 'Gamma', created: '2024-02-01' },
];

// Mirrors the playlist grid config: defaultSort='created', defaultDirection='desc'
const PLAYLISTS: Item[] = [
  { id: 'p1', name: 'Chill',    created: '2024-01-10', songCount: 5 },
  { id: 'p2', name: 'Workout',  created: '2024-06-01', songCount: 12 },
  { id: 'p3', name: 'Road trip',created: '2024-03-15', songCount: 8 },
];

const PLAYLIST_SORT_OPTIONS = [
  { field: 'name',      label: 'Name' },
  { field: 'created',   label: 'Date created' },
  { field: 'songCount', label: 'Track count' },
];

const SORT_OPTIONS = [
  { field: 'name',    label: 'Name' },
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
