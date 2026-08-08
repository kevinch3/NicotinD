import { Component, OnInit, inject, signal } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { catchError, firstValueFrom, of } from 'rxjs';
import type { AlbumDetail } from '../../services/api/api-types';
import { LibraryApiService } from '../../services/api/library-api.service';
import { PlayerService } from '../../services/player.service';
import { AuthService } from '../../services/auth.service';
import { CoverArtComponent } from '../../components/cover-art/cover-art.component';
import { TvNavGroupDirective } from '../../directives/tv-nav-group.directive';
import { TvNavItemDirective } from '../../directives/tv-nav-item.directive';
import { TranslatePipe } from '../../pipes/translate.pipe';
import { toTrack } from '../../lib/track-utils';

/**
 * Cover, title, artist, Play, tracklist. That is the whole screen.
 *
 * Dropped from the phone version and why: the track filter and sort `<select>`
 * are native controls a remote cannot escape (#438); Select/multi-select,
 * Download, Share and Fix metadata are curation, not listening; and **Remove
 * album** is a destructive filesystem operation that should not sit one press
 * away on a device where focus can land somewhere unexpected.
 */
@Component({
  selector: 'app-tv-album',
  standalone: true,
  imports: [CoverArtComponent, TvNavGroupDirective, TvNavItemDirective, TranslatePipe],
  templateUrl: './tv-album.component.html',
})
export class TvAlbumComponent implements OnInit {
  private readonly route = inject(ActivatedRoute);
  private readonly api = inject(LibraryApiService);
  private readonly player = inject(PlayerService);
  readonly auth = inject(AuthService);
  private readonly router = inject(Router);

  readonly album = signal<AlbumDetail | null>(null);
  readonly songs = signal<AlbumDetail['song']>([]);
  readonly loading = signal(true);

  async ngOnInit(): Promise<void> {
    const id = this.route.snapshot.paramMap.get('id');
    if (!id) return;
    const detail = await firstValueFrom(this.api.getAlbum(id).pipe(catchError(() => of(null))));
    this.album.set(detail);
    this.songs.set(detail?.song ?? []);
    this.loading.set(false);
  }

  play(startIndex = 0): void {
    const songs = this.songs();
    if (!songs.length) return;
    const album = this.album();
    this.player.playWithContext(
      songs.map((s) => toTrack(s, album?.name)),
      startIndex,
      { type: 'album', id: album?.id, name: album?.name },
    );
    // Navigate explicitly. `playWithContext` does not touch `nowPlayingOpen`
    // (that flag is the phone sheet's, and only some callers set it), so the
    // shell's adapter effect would never fire for this path — relying on it
    // here is what left every player spec staring at an empty route.
    void this.router.navigate(['/player']);
  }
}
