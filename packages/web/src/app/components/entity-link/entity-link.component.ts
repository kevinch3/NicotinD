import { Component, computed, input, output } from '@angular/core';
import { RouterLink } from '@angular/router';
import { TvNavItemDirective } from '../../directives/tv-nav-item.directive';
import { isTvBuild, isTvUi } from '../../lib/platform';
import {
  resolveAlbumRoute,
  resolveArtistRoute,
  resolveGenreRoute,
  resolvePlaylistRoute,
} from '../../lib/route-utils';

export type EntityKind = 'album' | 'artist' | 'genre' | 'playlist';

const RESOLVERS: Record<EntityKind, (id: string) => string[]> = {
  album: resolveAlbumRoute,
  artist: resolveArtistRoute,
  genre: resolveGenreRoute,
  playlist: resolvePlaylistRoute,
};

/**
 * A rendered album/artist/genre/playlist name that links to its page. Falls back
 * to a plain `<span>` when there is no page to go to: no id, or an artist on TV
 * (the TV route tree has no artist route — see app.routes.ts). Both TV signals
 * are consulted so the e2e TV lane, which stamps the `tv-build` class on the
 * prod bundle, renders what a real TV build renders. → docs/web-ui.md "Track rows"
 */
@Component({
  selector: 'app-entity-link',
  standalone: true,
  imports: [RouterLink, TvNavItemDirective],
  template: `
    @if (route(); as target) {
      <a
        [routerLink]="target"
        appTvNavItem
        [attr.data-testid]="'entity-link-' + kind()"
        class="hover:underline"
        (click)="$event.stopPropagation(); followed.emit()"
        >{{ name() }}</a
      >
    } @else {
      <span>{{ name() }}</span>
    }
  `,
})
export class EntityLinkComponent {
  readonly kind = input<EntityKind>('album');
  readonly id = input<string | undefined>(undefined);
  readonly name = input('');
  /** Emitted when the link is followed — lets an overlay (sheet, now-playing) close. */
  readonly followed = output<void>();

  readonly route = computed<string[] | null>(() => {
    const id = this.id();
    if (!id) return null;
    if (this.kind() === 'artist' && (isTvBuild() || isTvUi())) return null;
    return RESOLVERS[this.kind()](id);
  });
}
