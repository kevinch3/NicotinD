import { Component, input, output, computed } from '@angular/core';
import { RouterLink } from '@angular/router';
import { CoverArtComponent } from '../cover-art/cover-art.component';
import { TvNavItemDirective } from '../../directives/tv-nav-item.directive';
import { resolveAlbumRoute } from '../../lib/route-utils';
import type { AlbumTile } from '../../lib/artist-album-tiles';

/**
 * One album in an artist's grid, in whichever of three states it is in.
 *
 * The artist page used to copy-paste this markup four times — once per tab, plus
 * again in the separate discography grid. Folding them into one component is what
 * lets an owned album and a missing one sit in the same grid without the two
 * drifting apart visually.
 *
 * **One `appTvNavItem` per grid cell.** The grid nav directive chunks the *album*
 * array into `role="row"` slices of `gridColumns()`, so a second nav item inside a
 * cell would desync the rows from the items. A partial tile's action button is
 * therefore a plain nested focusable, which `TvNavItemDirective` already handles.
 */
/** Inert placeholder so the input is optional — see the note on `tile` below. */
const EMPTY_TILE: AlbumTile = {
  key: '',
  title: '',
  year: null,
  status: 'owned',
  secondary: false,
};

@Component({
  selector: 'app-album-tile',
  standalone: true,
  imports: [RouterLink, CoverArtComponent, TvNavItemDirective],
  templateUrl: './album-tile.component.html',
})
export class AlbumTileComponent {
  // Deliberately NOT `input.required()`: the JIT vitest harness does not register
  // signal inputs on a *nested* component, so a required input throws NG0950 during
  // the HOST's change detection and takes the host's whole spec down with it.
  // See src/testing/signal-input.ts.
  readonly tile = input<AlbumTile>(EMPTY_TILE);
  readonly artistName = input('');
  /** Auth token for the local `/api/cover/<hash>` URL; absent on a missing tile. */
  readonly token = input<string | null>(null);
  /** A hunt is in flight for this album. */
  readonly busy = input(false);
  /** Hide both actions for a listener — the acquire routes 403 for them anyway. */
  readonly canAcquire = input(false);

  readonly acquire = output<void>();

  readonly route = computed(() => resolveAlbumRoute(this.tile().localAlbumId));

  /** Local art wins; a missing tile only ever has the remote Lidarr/MusicBrainz URL. */
  readonly coverSrc = computed<string | undefined>(() => {
    const tile = this.tile();
    if (tile.coverArt) return `/api/cover/${tile.coverArt}?size=300&token=${this.token() ?? ''}`;
    return tile.coverArtUrl;
  });

  /** `1969 · EP · 4/7 tracks`, skipping whatever this tile does not have. */
  readonly subtitle = computed(() => {
    const tile = this.tile();
    const parts: string[] = [];
    if (tile.year !== null) parts.push(String(tile.year));
    if (tile.kind) parts.push(tile.kind);
    if (tile.status === 'partial' && tile.totalTracks) {
      parts.push(`${tile.localTrackCount ?? 0}/${tile.totalTracks} tracks`);
    }
    return parts.join(' · ');
  });

  /** A complete album needs no action — the grid stays quiet where there is nothing to do. */
  readonly showAction = computed(() => this.canAcquire() && this.tile().status !== 'owned');

  readonly actionLabel = computed(() =>
    this.tile().status === 'partial' ? 'Complete album' : 'Get album',
  );
}
