import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { RelatedArtistsComponent } from './related-artists.component';
import { setInputValue } from '../../../testing/signal-input';
import type { RelatedArtist } from '../../services/api/api-types';

const artist = (id: string, over: Partial<RelatedArtist> = {}): RelatedArtist => ({
  id,
  name: `Name ${id}`,
  coverArt: null,
  albumCount: 1,
  score: 0.9,
  signals: { audio: { cosine: 0.9, members: 5, coherence: 0.8 } },
  ...over,
});

describe('RelatedArtistsComponent', () => {
  function setup(artists: RelatedArtist[], token: string | null = 'tok') {
    TestBed.configureTestingModule({
      imports: [RelatedArtistsComponent],
      providers: [provideRouter([])],
    });
    const fixture = TestBed.createComponent(RelatedArtistsComponent);
    setInputValue(fixture.componentInstance.artists, artists);
    setInputValue(fixture.componentInstance.token, token);
    fixture.detectChanges();
    return fixture;
  }

  it('renders nothing for an empty list', () => {
    const fixture = setup([]);
    expect(fixture.nativeElement.querySelector('[data-testid="related-artists"]')).toBeNull();
  });

  it('renders one linked tile per artist, in order', () => {
    const fixture = setup([artist('a'), artist('b')]);
    const tiles = Array.from(
      fixture.nativeElement.querySelectorAll(
        '[data-testid="related-artist-tile"]',
      ) as NodeListOf<HTMLAnchorElement>,
    );
    expect(tiles.map((t) => t.querySelector(':scope > span')?.textContent?.trim())).toEqual([
      'Name a',
      'Name b',
    ]);
    expect(tiles[0]!.getAttribute('href')).toBe('/library/artists/a');
  });

  it('builds the cover URL with the media token, and none without cover art', () => {
    const fixture = setup([artist('a', { coverArt: 'ar-a' })]);
    const c = fixture.componentInstance;
    expect(c.coverSrc(artist('a', { coverArt: 'ar-a' }))).toBe(
      '/api/cover/ar-a?size=160&token=tok',
    );
    expect(c.coverSrc(artist('b'))).toBeUndefined();
  });
});
