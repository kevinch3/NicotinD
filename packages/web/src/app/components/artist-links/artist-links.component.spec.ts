import { ɵSIGNAL as SIGNAL } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { ArtistLinksComponent } from './artist-links.component';
import type { ArtistCredit } from '../../services/api/api-types';

/**
 * The web JIT vitest harness can't drive Angular signal `input()`s the normal way
 * (see track-row.component.spec.ts for the full rationale). We write straight to the
 * signal node behind the `ɵSIGNAL` symbol — the same object Angular's compiled setter
 * would write to. Safe here because we read the pure `segments` computed directly,
 * never through a rendered fixture, so there's no stale-notification concern.
 */
function setInputValue<T>(inputSignal: () => T, value: T): void {
  (inputSignal as unknown as Record<typeof SIGNAL, { value: T }>)[SIGNAL].value = value;
}

function make(): ArtistLinksComponent {
  TestBed.configureTestingModule({
    imports: [ArtistLinksComponent],
    providers: [provideRouter([])],
  });
  return TestBed.createComponent(ArtistLinksComponent).componentInstance;
}

describe('ArtistLinksComponent segments', () => {
  it('renders a plain-text fallback when no id is given', () => {
    const c = make();
    setInputValue(c.fallbackArtist, 'Daft Punk');
    expect(c.segments()).toEqual([{ type: 'text', text: 'Daft Punk' }]);
  });

  it('renders a linked fallback when an id is given', () => {
    const c = make();
    setInputValue(c.fallbackArtist, 'Daft Punk');
    setInputValue(c.fallbackArtistId, 'a1');
    expect(c.segments()).toEqual([{ type: 'link', text: 'Daft Punk', id: 'a1' }]);
  });

  it('links each primary artist, joined with ", " and a final " & "', () => {
    const c = make();
    const artists: ArtistCredit[] = [
      { id: 'a1', name: 'Charly García', role: 'primary' },
      { id: 'a2', name: 'Spinetta', role: 'primary' },
    ];
    setInputValue(c.artists, artists);
    expect(c.segments()).toEqual([
      { type: 'link', text: 'Charly García', id: 'a1' },
      { type: 'text', text: ' & ' },
      { type: 'link', text: 'Spinetta', id: 'a2' },
    ]);
  });

  it('separates featuring credits with a " feat. " prefix', () => {
    const c = make();
    const artists: ArtistCredit[] = [
      { id: 'a1', name: 'Daft Punk', role: 'primary' },
      { id: 'a2', name: 'Pharrell', role: 'featuring' },
    ];
    setInputValue(c.artists, artists);
    expect(c.segments()).toEqual([
      { type: 'link', text: 'Daft Punk', id: 'a1' },
      { type: 'text', text: ' feat. ' },
      { type: 'link', text: 'Pharrell', id: 'a2' },
    ]);
  });

  it('returns no segments when nothing is provided', () => {
    const c = make();
    expect(c.segments()).toEqual([]);
  });
});
