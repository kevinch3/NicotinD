import { ɵSIGNAL as SIGNAL } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import { vi } from 'vitest';
import { SongPickerComponent } from './song-picker.component';
import { LibraryApiService } from '../../services/api/library-api.service';
import type { Song } from '../../services/api/api-types';

// The web JIT vitest harness can't drive signal input()s the normal way
// (componentRef.setInput silently no-ops) — see track-row.component.spec.ts's
// comment / project memory "Web JIT vitest can't drive input() signals".
// Write straight to the signal node instead, before the first detectChanges().
function setInputValue<T>(inputSignal: () => T, value: T): void {
  (inputSignal as unknown as Record<typeof SIGNAL, { value: T }>)[SIGNAL].value = value;
}

const SONG = (id: string, title = id): Song => ({
  id,
  title,
  artist: 'Artist',
  album: 'Album',
  albumId: 'al1',
  path: '',
  bitRate: 320,
  size: 1000,
  created: '2024-01-01',
});

function setup(excludeIds: string[] = []) {
  const searchSongsAutocomplete = vi.fn();

  TestBed.configureTestingModule({
    imports: [SongPickerComponent],
    providers: [{ provide: LibraryApiService, useValue: { searchSongsAutocomplete } }],
  });

  const fixture = TestBed.createComponent(SongPickerComponent);
  setInputValue(fixture.componentInstance.excludeIds, excludeIds);
  fixture.detectChanges();
  return { component: fixture.componentInstance, searchSongsAutocomplete, fixture };
}

describe('SongPickerComponent', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not search while the query is below 2 characters', () => {
    const { component, searchSongsAutocomplete } = setup();
    component.onQueryChange('a');
    vi.advanceTimersByTime(500);
    expect(searchSongsAutocomplete).not.toHaveBeenCalled();
    expect(component.results()).toEqual([]);
  });

  it('clears results immediately when the query drops below 2 characters', () => {
    const { component } = setup();
    component.results.set([SONG('s1')]);
    component.onQueryChange('a');
    expect(component.results()).toEqual([]);
  });

  it('debounces search by 250ms and resets the timer on a new keystroke', () => {
    const { component, searchSongsAutocomplete } = setup();
    searchSongsAutocomplete.mockReturnValue(of([SONG('s1')]));

    component.onQueryChange('ab');
    vi.advanceTimersByTime(200);
    expect(searchSongsAutocomplete).not.toHaveBeenCalled();

    // A new keystroke before the 250ms elapses resets the timer.
    component.onQueryChange('abc');
    vi.advanceTimersByTime(200);
    expect(searchSongsAutocomplete).not.toHaveBeenCalled();

    vi.advanceTimersByTime(50);
    expect(searchSongsAutocomplete).toHaveBeenCalledTimes(1);
    expect(searchSongsAutocomplete).toHaveBeenCalledWith('abc', 8);
  });

  it('filters results against excludeIds', async () => {
    const { component, searchSongsAutocomplete } = setup(['s2']);
    searchSongsAutocomplete.mockReturnValue(of([SONG('s1'), SONG('s2')]));

    component.onQueryChange('abc');
    vi.advanceTimersByTime(250);
    await Promise.resolve();
    await Promise.resolve();

    expect(component.results().map((s) => s.id)).toEqual(['s1']);
  });

  it('resolves results to [] when the API call rejects', async () => {
    const { component, searchSongsAutocomplete } = setup();
    searchSongsAutocomplete.mockReturnValue(throwError(() => new Error('boom')));

    component.onQueryChange('abc');
    vi.advanceTimersByTime(250);
    await Promise.resolve();
    await Promise.resolve();

    expect(component.results()).toEqual([]);
    expect(component.searching()).toBe(false);
  });

  it('pick() emits add and removes the picked song from results', async () => {
    const { component, searchSongsAutocomplete } = setup();
    searchSongsAutocomplete.mockReturnValue(of([SONG('s1'), SONG('s2')]));

    component.onQueryChange('abc');
    vi.advanceTimersByTime(250);
    await Promise.resolve();
    await Promise.resolve();

    const emitted: Song[] = [];
    component.add.subscribe((s) => emitted.push(s));

    component.pick(SONG('s1'));

    expect(emitted.map((s) => s.id)).toEqual(['s1']);
    expect(component.results().map((s) => s.id)).toEqual(['s2']);
  });
});
