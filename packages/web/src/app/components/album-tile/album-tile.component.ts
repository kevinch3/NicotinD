import { Component, input, output, computed, Injector, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { CoverArtComponent } from '../cover-art/cover-art.component';
import { TvNavItemDirective } from '../../directives/tv-nav-item.directive';
import { EntityActionsDirective } from '../../directives/entity-actions.directive';
import { EntityMenuButtonComponent } from '../entity-menu-button/entity-menu-button.component';
import { EntityMenuService } from '../../services/entity-menu.service';
import type { TrackAction } from '../track-row/track-row.component';
import { resolveAlbumRoute } from '../../lib/route-utils';
import type { AlbumTile } from '../../lib/artist-album-tiles';
import { TranslateService } from '../../services/translate.service';
import { TranslatePipe } from '../../pipes/translate.pipe';
import { IDLE_HUNT, albumHuntLabel, type AlbumHuntStatus } from '../../lib/album-hunt-status';
import { OverflowRevealDirective } from '../../directives/overflow-reveal.directive';
import { albumCover } from '../../lib/cover-url';
import { CoverRevisionsService } from '../../services/cover-revisions.service';

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
  imports: [
    OverflowRevealDirective,
    RouterLink,
    CoverArtComponent,
    TvNavItemDirective,
    EntityActionsDirective,
    EntityMenuButtonComponent,
    TranslatePipe,
  ],
  templateUrl: './album-tile.component.html',
})
export class AlbumTileComponent {
  private readonly injector = inject(Injector);
  private readonly i18n = inject(TranslateService);
  private readonly coverRevisions = inject(CoverRevisionsService);
  /** The tile's menu (#1298): an owned or partial album is a library album. */
  readonly menuActions = (): TrackAction[] => {
    const t = this.tile();
    if (!t.localAlbumId) return [];
    return this.injector
      .get(EntityMenuService)
      .build({ kind: 'album', id: t.localAlbumId, name: t.title });
  };
  // Deliberately NOT `input.required()`: the JIT vitest harness does not register
  // signal inputs on a *nested* component, so a required input throws NG0950 during
  // the HOST's change detection and takes the host's whole spec down with it.
  // See src/testing/signal-input.ts.
  readonly tile = input<AlbumTile>(EMPTY_TILE);
  readonly artistName = input('');
  /** Auth token for the local `/api/cover/<hash>` URL; absent on a missing tile. */
  readonly token = input<string | null>(null);
  /** This album's own hunt — another album's hunt never disables this tile. */
  readonly status = input<AlbumHuntStatus>(IDLE_HUNT);
  /** Hide both actions for a listener — the acquire routes 403 for them anyway. */
  readonly canAcquire = input(false);

  readonly acquire = output<void>();

  readonly route = computed(() => resolveAlbumRoute(this.tile().localAlbumId));

  /** Local art wins; a missing tile only ever has the remote Lidarr/MusicBrainz URL. */
  readonly coverSrc = computed<string | undefined>(() => {
    const tile = this.tile();
    const ref = albumCover({ ...tile, id: tile.localAlbumId ?? tile.key });
    return ref ? this.coverRevisions.url(ref, 300, this.token()) : tile.coverArtUrl;
  });

  /** `1969 · EP · 4/7 tracks`, skipping whatever this tile does not have. */
  readonly subtitle = computed(() => {
    const tile = this.tile();
    const parts: string[] = [];
    if (tile.year !== null) parts.push(String(tile.year));
    if (tile.kind) parts.push(tile.kind);
    // An owned album whose tracklist matched nothing printed "0/11 tracks" for
    // music the user has (#1565): no matched count, no count.
    if (tile.status === 'partial' && tile.totalTracks && tile.localTrackCount) {
      parts.push(
        this.i18n.t('albumTile.tracks', { have: tile.localTrackCount, total: tile.totalTracks }),
      );
    }
    return parts.join(' · ');
  });

  /** A complete album needs no action — the grid stays quiet where there is nothing to do. */
  readonly showAction = computed(() => this.canAcquire() && this.tile().status !== 'owned');

  readonly actionLabelKey = computed(() =>
    this.tile().status === 'partial' ? 'albumTile.completeAlbum' : 'albumTile.getAlbum',
  );

  readonly busy = computed(() => this.status().phase !== 'idle');

  /** `Finding…` before a job exists, then the job's own stage, worded as on Downloads. */
  readonly busyLabel = computed(() => albumHuntLabel(this.status(), (key) => this.i18n.t(key)));
}
