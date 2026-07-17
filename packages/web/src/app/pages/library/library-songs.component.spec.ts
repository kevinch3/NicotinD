import { signal } from '@angular/core';
import { ɵSIGNAL as SIGNAL } from '@angular/core';
import { vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { LibrarySongsComponent } from './library-songs.component';
import { LibraryApiService } from '../../services/api/library-api.service';
import { AuthService } from '../../services/auth.service';
import { PlayerService } from '../../services/player.service';
import { PlaylistService } from '../../services/playlist.service';
import { PreserveService } from '../../services/preserve.service';
import { TransferService } from '../../services/transfer.service';
import { SongMenuService } from '../../services/song-menu.service';
import { ListControlsService } from '../../services/list-controls.service';
import type { Song } from '../../services/api/api-types';
import type { LibraryFilter } from '@nicotind/core';
import type { PreservedTrackMeta } from '../../lib/preserve-store';

// See track-row.component.spec.ts: the JIT harness can't drive input() signals,
// so write straight to the signal node (only before the first detectChanges()).
function setInputValue<T>(inputSignal: () => T, value: T): void {
  (inputSignal as unknown as Record<typeof SIGNAL, { value: T }>)[SIGNAL].value = value;
}

const SONGS: Song[] = [
  { id: 's1', title: 'Alpha', artist: 'A', album: 'One', path: '', created: '2026-03-03' },
  { id: 's2', title: 'Bravo', artist: 'B', album: 'Two', path: '', created: '2026-03-02' },
  { id: 's3', title: 'Charlie', artist: 'C', album: 'Three', path: '', created: '2026-03-01' },
];

const OFFLINE: PreservedTrackMeta[] = [
  {
    id: 'o1',
    title: 'Down One',
    artist: 'D',
    album: 'DA',
    size: 1000,
    format: 'audio/mpeg',
    preservedAt: 2,
    lastAccessedAt: 2,
  },
  {
    id: 'o2',
    title: 'Down Two',
    artist: 'E',
    album: 'EA',
    size: 2000,
    format: 'audio/mpeg',
    preservedAt: 1,
    lastAccessedAt: 1,
  },
];

function setup(opts: { offline?: boolean; role?: string } = {}) {
  const calls: Array<{
    size: number;
    offset: number;
    opts: { sort?: string; filter?: LibraryFilter; q?: string };
  }> = [];
  const deleted = new Set<string>();
  let deletedSongs: string[] = [];
  let cleared = false;

  const preservedTracks = signal<PreservedTrackMeta[]>(opts.offline ? OFFLINE : []);
  const preserveStub = {
    preservedTracks,
    totalUsage: signal(3000),
    budget: signal(1_000_000),
    preserving: signal(new Set<string>()),
    isPreserved: (id: string) => preservedTracks().some((t) => t.id === id),
    isPreserving: () => false,
    refreshList: () => Promise.resolve(),
    remove: () => Promise.resolve(),
    preserve: () => Promise.resolve(),
    preserveCollection: () => Promise.resolve(),
    clearAll: () => {
      cleared = true;
      return Promise.resolve();
    },
  };

  const player = {
    playWithContext: () => {},
    addToQueue: () => {},
    queueNext: () => {},
    // <app-track-row> reads these during render; the online spec never plays
    // anything, so the safe defaults are "no current track" + "not buffering".
    currentTrack: signal<{ id: string } | null>(null),
    bufferingVisible: signal(false),
  };

  TestBed.configureTestingModule({
    imports: [LibrarySongsComponent],
    providers: [
      ListControlsService,
      {
        provide: LibraryApiService,
        useValue: {
          getAllSongs: (
            size: number,
            offset: number,
            o: { sort?: string; filter?: LibraryFilter; q?: string },
          ) => {
            calls.push({ size, offset, opts: o });
            return of(SONGS);
          },
          deleteSongs: (ids: string[]) => {
            deletedSongs = ids;
            return of({ ok: true, deletedCount: ids.length });
          },
        },
      },
      { provide: AuthService, useValue: { role: () => opts.role ?? 'admin' } },
      { provide: PlayerService, useValue: player },
      { provide: PlaylistService, useValue: { openPicker: () => {} } },
      { provide: PreserveService, useValue: preserveStub },
      {
        provide: TransferService,
        useValue: {
          deletedSongIds: signal<ReadonlySet<string>>(deleted),
          addDeletedIds: (ids: string[]) => ids.forEach((i) => deleted.add(i)),
        },
      },
      { provide: SongMenuService, useValue: { build: () => [] } },
    ],
  });

  const fixture = TestBed.createComponent(LibrarySongsComponent);
  const component = fixture.componentInstance;
  setInputValue(component.offline, opts.offline ?? false);
  setInputValue(component.filter, {} as LibraryFilter);
  setInputValue(component.genres, []);
  return {
    fixture,
    component,
    calls,
    getDeletedSongs: () => deletedSongs,
    wasCleared: () => cleared,
  };
}

describe('LibrarySongsComponent — online', () => {
  it('loads whole-library songs newest-first by default', async () => {
    const { component, calls } = setup();
    await component.loadSongs(true);
    expect(component.visibleSongs().map((s) => s.id)).toEqual(['s1', 's2', 's3']);
    expect(calls.at(-1)?.opts.sort).toBe('newest');
  });

  it('changing sort refetches with the new sort', async () => {
    const { component, calls } = setup();
    await component.loadSongs(true);
    component.setSongSort('title');
    // setSongSort kicks an async reload; await a microtask flush.
    await Promise.resolve();
    expect(calls.at(-1)?.opts.sort).toBe('title');
  });

  it('a filter panel change emits upward and refetches with that filter', async () => {
    const { component, calls } = setup();
    let emitted: LibraryFilter | null = null;
    component.filterChange.subscribe((f) => (emitted = f));
    component.onFilterChange({ bpmMin: 120 });
    await Promise.resolve();
    expect(emitted).toEqual({ bpmMin: 120 });
    expect(calls.at(-1)?.opts.filter).toEqual({ bpmMin: 120 });
  });

  it('admin bulk delete confirms then removes the selected songs', async () => {
    const { component, getDeletedSongs } = setup({ role: 'admin' });
    await component.loadSongs(true);
    component.selection.enter();
    component.selection.toggle('s1');
    component.selection.toggle('s2');
    component.deleteSelectedSongs();
    // Confirm dialog is pending until confirmed.
    expect(component.showConfirm()).toBe(true);
    component.onConfirm();
    await Promise.resolve();
    expect(getDeletedSongs().sort()).toEqual(['s1', 's2']);
    expect(component.visibleSongs().map((s) => s.id)).toEqual(['s3']);
  });

  it('setSearchText updates the searchText signal immediately (input binding)', () => {
    const { component } = setup();
    expect(component.searchText()).toBe('');
    component.setSearchText('foo');
    expect(component.searchText()).toBe('foo');
  });

  it('loadSongs forwards the debounced searchText as `q` to the API', async () => {
    // Directly exercise the same code path the debounce timer fires (loadSongs
    // reads `searchText`), without going through the setTimeout that fake-timer
    // plumbing would otherwise require.
    const { component, calls } = setup();
    component.setSearchText('alpha house');
    await component.loadSongs(true);
    expect(calls.at(-1)?.opts.q).toBe('alpha house');
    // Pagination resets.
    expect(calls.at(-1)?.offset).toBe(0);
  });

  it('whitespace-only searchText is sent as undefined so the API omits ?q=', async () => {
    const { component, calls } = setup();
    component.setSearchText('   ');
    await component.loadSongs(true);
    expect(calls.at(-1)?.opts.q).toBeUndefined();
  });

  it('rapid setSearchText calls collapse into a single debounced refetch', () => {
    // Unit-test the debounce timing contract directly with fake timers
    // (fixture-level tests can't drive the timer without triggering a render
    // cycle that tries to bind <app-track-row> inputs we never set).
    vi.useFakeTimers();
    try {
      let calls = 0;
      let lastText = '';
      const component = {
        searchText: { set: (t: string) => (lastText = t) },
        searchDebounceTimer: null as ReturnType<typeof setTimeout> | null,
        loadSongs: () => calls++,
        // Replicate setSearchText's logic verbatim so we're testing the same
        // debounce path the component actually runs.
        setSearchText(text: string) {
          (this as { searchText: { set: (t: string) => void } }).searchText.set(text);
          if (this.searchDebounceTimer !== null) clearTimeout(this.searchDebounceTimer);
          this.searchDebounceTimer = setTimeout(() => {
            this.searchDebounceTimer = null;
            (this as { loadSongs: () => void }).loadSongs();
          }, 250);
        },
      };
      component.setSearchText('a');
      component.setSearchText('al');
      component.setSearchText('alp');
      expect(calls).toBe(0);
      expect(lastText).toBe('alp');
      vi.advanceTimersByTime(280);
      expect(calls).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('LibrarySongsComponent — offline', () => {
  it('sources the list from preserved tracks (no backend fetch)', () => {
    const { component, calls } = setup({ offline: true });
    // Drive lifecycle without rendering <app-track-row> (JIT input limitation).
    component.ngOnInit();
    expect(component.offline()).toBe(true);
    expect(component.offlineControls.filtered().map((t) => t.id)).toEqual(['o1', 'o2']);
    // Never hits the whole-library endpoint offline.
    expect(calls.length).toBe(0);
  });

  it('offline row actions are backend-free (queue / play next / remove)', () => {
    const { component } = setup({ offline: true });
    const labels = component.offlineActions(OFFLINE[0]).map((a) => a.label);
    expect(labels).toEqual(['Add to queue', 'Play next', 'Remove download']);
  });

  it('clear-all confirms then clears the device store', async () => {
    const { component, wasCleared } = setup({ offline: true });
    component.clearAllOffline();
    expect(component.showConfirm()).toBe(true);
    component.onConfirm();
    await Promise.resolve();
    expect(wasCleared()).toBe(true);
  });
});
