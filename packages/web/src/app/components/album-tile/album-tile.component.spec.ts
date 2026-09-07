import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { AlbumTileComponent } from './album-tile.component';
import { ServerConfigService } from '../../services/server-config.service';
import { setInputValue } from '../../../testing/signal-input';
import type { AlbumTile } from '../../lib/artist-album-tiles';

const tile = (over: Partial<AlbumTile> & Pick<AlbumTile, 'status'>): AlbumTile => ({
  key: 'k',
  title: 'Meddle',
  year: 1971,
  secondary: false,
  ...over,
});

function render(t: AlbumTile, inputs: Partial<{ canAcquire: boolean; busy: boolean }> = {}) {
  // One fresh component per scenario (signal-input.ts landmine 2), which means a
  // reset — TestBed refuses to be reconfigured once it has been instantiated.
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    imports: [AlbumTileComponent],
    providers: [
      provideRouter([]),
      { provide: ServerConfigService, useValue: { apiUrl: (u: string) => u } },
    ],
  });
  const fixture = TestBed.createComponent(AlbumTileComponent);
  const c = fixture.componentInstance;
  // Every write lands BEFORE the first detectChanges: the raw signal write
  // bypasses signalSetFn, so a consumer that already read keeps the stale value.
  setInputValue(c.tile, t);
  setInputValue(c.artistName, 'Pink Floyd');
  setInputValue(c.token, 'tok');
  setInputValue(c.canAcquire, inputs.canAcquire ?? true);
  setInputValue(c.busy, inputs.busy ?? false);
  fixture.detectChanges();
  return fixture;
}

const el = (fixture: ReturnType<typeof render>, sel: string): HTMLElement | null =>
  fixture.nativeElement.querySelector(sel);

describe('AlbumTileComponent', () => {
  it('an owned album navigates to its album page and offers no action', () => {
    const fixture = render(tile({ status: 'owned', localAlbumId: 'a1', coverArt: 'hash' }));
    const root = el(fixture, '[data-testid="album-tile"]')!;

    expect(root.tagName).toBe('A');
    expect(root.getAttribute('href')).toBe('/library/albums/a1');
    // The whole point of the merge: a complete album is quiet.
    expect(el(fixture, '[data-testid="album-tile-action"]')).toBeNull();
  });

  it('a partial album still navigates, and shows its gap plus Complete album', () => {
    const fixture = render(
      tile({ status: 'partial', localAlbumId: 'a2', localTrackCount: 4, totalTracks: 7 }),
    );
    const root = el(fixture, '[data-testid="album-tile"]')!;

    // Owned means playable — a partial tile is a link, not a dead cell.
    expect(root.tagName).toBe('A');
    expect(root.textContent).toContain('4/7 tracks');
    expect(el(fixture, '[data-testid="album-tile-action"]')!.textContent!.trim()).toBe(
      'Complete album',
    );
  });

  it('a missing album does not navigate and offers Get album', () => {
    const fixture = render(
      tile({ status: 'missing', title: 'Atom Heart Mother', year: 1970, totalTracks: 5 }),
    );
    const root = el(fixture, '[data-testid="album-tile"]')!;

    expect(root.tagName).not.toBe('A');
    expect(root.getAttribute('href')).toBeNull();
    expect(el(fixture, '[data-testid="album-tile-action"]')!.textContent!.trim()).toBe('Get album');
    // No track count on something we do not have — "0/5" would read as a real album.
    expect(root.textContent).not.toContain('tracks');
  });

  it('hides both actions from a listener who cannot acquire', () => {
    for (const status of ['partial', 'missing'] as const) {
      const fixture = render(tile({ status, localAlbumId: 'a3', totalTracks: 7 }), {
        canAcquire: false,
      });
      // Today a listener sees a button that 403s on click.
      expect(el(fixture, '[data-testid="album-tile-action"]')).toBeNull();
    }
  });

  it('disables the action and says Finding… while a hunt is in flight', () => {
    const fixture = render(tile({ status: 'missing' }), { busy: true });
    const button = el(fixture, '[data-testid="album-tile-action"]') as HTMLButtonElement;

    expect(button.disabled).toBe(true);
    expect(button.textContent).toContain('Finding…');
  });

  it('prefers the local cover over the remote one, and falls back to remote when unowned', () => {
    const owned = render(
      tile({
        status: 'owned',
        localAlbumId: 'a',
        coverArt: 'hash',
        coverArtUrl: 'https://mb/x.jpg',
      }),
    );
    expect(owned.componentInstance.coverSrc()).toBe('/api/cover/hash?size=300&token=tok');

    const missing = render(tile({ status: 'missing', coverArtUrl: 'https://mb/x.jpg' }));
    expect(missing.componentInstance.coverSrc()).toBe('https://mb/x.jpg');
  });

  it('builds a subtitle from only the parts a tile actually has', () => {
    const bare = render(tile({ status: 'owned', localAlbumId: 'a', year: null }));
    expect(bare.componentInstance.subtitle()).toBe('');

    const ep = render(tile({ status: 'owned', localAlbumId: 'a', year: 1969, kind: 'EP' }));
    expect(ep.componentInstance.subtitle()).toBe('1969 · EP');
  });
});
