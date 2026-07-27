import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { ArtistLinksComponent } from './artist-links.component';
import type { ArtistCredit } from '../../services/api/api-types';
import { setInputValue } from '../../../testing/signal-input';

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
