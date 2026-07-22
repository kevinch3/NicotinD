import { ɵSIGNAL as SIGNAL } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import type { LibraryFilter } from '@nicotind/core';
import { LibraryFilterPanelComponent } from './library-filter-panel.component';

/** Sanctioned JIT escape hatch for signal inputs (see track-row.component.spec.ts). */
function setInputValue<T>(inputSignal: () => T, value: T): void {
  (inputSignal as unknown as Record<typeof SIGNAL, { value: T }>)[SIGNAL].value = value;
}

function setup(filter: LibraryFilter = {}, extraCount = 0) {
  // Inputs must be set before the first read: the SIGNAL escape hatch writes
  // the value without bumping the version, so computeds would keep a stale cache.
  TestBed.configureTestingModule({ imports: [LibraryFilterPanelComponent] });
  const fixture = TestBed.createComponent(LibraryFilterPanelComponent);
  setInputValue(fixture.componentInstance.filter, filter);
  setInputValue(fixture.componentInstance.extraCount, extraCount);
  fixture.detectChanges();
  return fixture;
}

function lastEmitted(fixture: ReturnType<typeof setup>): () => LibraryFilter | undefined {
  let last: LibraryFilter | undefined;
  fixture.componentInstance.filterChange.subscribe((f) => (last = f));
  return () => last;
}

describe('LibraryFilterPanelComponent', () => {
  it('shows no badge for an empty filter', () => {
    const empty = setup();
    expect(empty.debugElement.query(By.css('[data-testid="library-filter-count"]'))).toBeNull();
  });

  it('badges one count per active property group', () => {
    const active = setup({ starred: true, bpmMin: 120, buckets: { energy: ['high'] } });
    const badge = active.debugElement.query(By.css('[data-testid="library-filter-count"]'));
    expect(badge.nativeElement.textContent.trim()).toBe('3');
  });

  it('adds page-specific extraCount into the badge', () => {
    const fixture = setup({ starred: true }, 2);
    const badge = fixture.debugElement.query(By.css('[data-testid="library-filter-count"]'));
    expect(badge.nativeElement.textContent.trim()).toBe('3');
  });

  it('toggles moods immutably, computing from the input state (host owns it)', () => {
    const fixture = setup({ moods: ['happy'] });
    const emitted = lastEmitted(fixture);
    fixture.componentInstance.toggleMood('party');
    expect(emitted()?.moods).toEqual(['happy', 'party']);
    // The input hasn't changed, so a second toggle still derives from it.
    fixture.componentInstance.toggleMood('sad');
    expect(emitted()?.moods).toEqual(['happy', 'sad']);
  });

  it('removes a mood (and the key entirely when the list empties)', () => {
    const fixture = setup({ moods: ['happy'] });
    const emitted = lastEmitted(fixture);
    fixture.componentInstance.toggleMood('happy');
    expect(emitted()).toEqual({});
  });

  it('toggles perceptual buckets per axis', () => {
    const fixture = setup({ buckets: { energy: ['low'] } });
    const emitted = lastEmitted(fixture);
    fixture.componentInstance.toggleBucket('energy', 'high');
    expect(emitted()?.buckets).toEqual({ energy: ['low', 'high'] });
    fixture.componentInstance.toggleBucket('valence', 'mid');
    expect(emitted()?.buckets).toEqual({ energy: ['low'], valence: ['mid'] });
  });

  it('drops an axis when its last bucket is deselected', () => {
    const fixture = setup({ buckets: { energy: ['low'] }, starred: true });
    const emitted = lastEmitted(fixture);
    fixture.componentInstance.toggleBucket('energy', 'low');
    expect(emitted()).toEqual({ starred: true });
  });

  it('toggles Camelot keys and genres', () => {
    const fixture = setup();
    const emitted = lastEmitted(fixture);
    fixture.componentInstance.toggleKey('8A');
    expect(emitted()?.keys).toEqual(['8A']);
    fixture.componentInstance.toggleGenre('Rock');
    expect(emitted()?.genres).toEqual(['Rock']);
  });

  it('toggles licences immutably from the input, dropping the key when it empties', () => {
    const fixture = setup({ licences: ['public-domain'] });
    const emitted = lastEmitted(fixture);
    fixture.componentInstance.toggleLicence('cc-by');
    expect(emitted()?.licences).toEqual(['public-domain', 'cc-by']);
    // Same input each time (the host owns it): toggling the existing code removes it.
    fixture.componentInstance.toggleLicence('public-domain');
    expect(emitted()).toEqual({});
  });

  it('counts an active licence group in the badge', () => {
    const fixture = setup({ licences: ['public-domain'] });
    const badge = fixture.debugElement.query(By.css('[data-testid="library-filter-count"]'));
    expect(badge.nativeElement.textContent.trim()).toBe('1');
  });

  it('parses numeric range inputs, dropping empty/garbage values', () => {
    const fixture = setup();
    const emitted = lastEmitted(fixture);
    fixture.componentInstance.setNumber('bpmMin', '120');
    expect(emitted()).toEqual({ bpmMin: 120 });
    fixture.componentInstance.setNumber('bpmMin', '');
    expect(emitted()).toEqual({});
    fixture.componentInstance.setNumber('yearMax', 'abc');
    expect(emitted()).toEqual({});
  });

  it('converts duration inputs from minutes to seconds', () => {
    const fixture = setup();
    const emitted = lastEmitted(fixture);
    fixture.componentInstance.setDurationMinutes('durationMin', '2');
    expect(emitted()).toEqual({ durationMin: 120 });
    expect(fixture.componentInstance.durationMinutes('durationMin')).toBe('');
  });

  it('displays stored duration seconds as minutes', () => {
    const fixture = setup({ durationMax: 360 });
    expect(fixture.componentInstance.durationMinutes('durationMax')).toBe('6');
  });

  it('toggles starred and clears everything', () => {
    const fixture = setup({ starred: true, moods: ['sad'], yearMin: 1990 });
    const emitted = lastEmitted(fixture);
    fixture.componentInstance.toggleStarred();
    expect(emitted()).toEqual({ moods: ['sad'], yearMin: 1990 });
    fixture.componentInstance.clearAll();
    expect(emitted()).toEqual({});
  });

  // Visual-contract assertions: pin the panel's outer/idle styling so a refactor
  // can't silently regress the toolbar-height unification (see plan §B).
  describe('visual contract', () => {
    function cls(el: { nativeElement: { className: string } } | null): string {
      return el?.nativeElement.className ?? '';
    }

    /** Open the popover so the [menuPanel] content actually renders. */
    function openPanel(fixture: ReturnType<typeof setup>): void {
      const menuPanel = fixture.debugElement.children[0]?.componentInstance as {
        open: { set: (v: boolean) => void };
      } | null;
      menuPanel?.open.set(true);
      fixture.detectChanges();
    }

    it('outer Filters trigger uses the shared focus ring', () => {
      const fixture = setup();
      const trigger = fixture.debugElement.query(By.css('[data-testid="library-filters"]'));
      expect(cls(trigger)).toContain('focus:ring-[var(--theme-accent)]');
      expect(cls(trigger)).toContain('bg-theme-surface-2');
    });

    it('a Camelot cell matches the mood/licence chip shape (rounded-full, px-2)', () => {
      const fixture = setup();
      openPanel(fixture);
      const keyBtn = fixture.debugElement.query(By.css('[data-testid="library-filter-key-8A"]'));
      const moodBtn = fixture.debugElement.query(By.css('[data-testid="library-filter-mood-happy"]'));
      expect(cls(keyBtn)).toContain('rounded-full');
      expect(cls(keyBtn)).toContain('px-2');
      // Mood chips are the established baseline.
      expect(cls(moodBtn)).toContain('rounded-full');
      expect(cls(moodBtn)).toContain('px-2');
    });

    it('checkboxes are themed (accent-theme rounded) so they match every other checkbox in the app', () => {
      const fixture = setup({ starred: true }, 0);
      openPanel(fixture);
      const starred = fixture.debugElement.query(By.css('[data-testid="library-filter-starred"]'));
      expect(cls(starred)).toContain('accent-theme');
      expect(cls(starred)).toContain('rounded');
    });

    it('badge uses the tightened leading-4 line height', () => {
      const fixture = setup({ starred: true });
      const badge = fixture.debugElement.query(By.css('[data-testid="library-filter-count"]'));
      expect(cls(badge)).toContain('leading-4');
      expect(cls(badge)).not.toContain('leading-5');
    });
  });
});
