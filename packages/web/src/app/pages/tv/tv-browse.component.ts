import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { catchError, firstValueFrom, of } from 'rxjs';
import type { Album } from '../../services/api/api-types';
import { LibraryApiService } from '../../services/api/library-api.service';
import { PlayerService } from '../../services/player.service';
import { AuthService } from '../../services/auth.service';
import { CoverArtComponent } from '../../components/cover-art/cover-art.component';
import { TvNavGroupDirective } from '../../directives/tv-nav-group.directive';
import { TvNavItemDirective } from '../../directives/tv-nav-item.directive';
import { TranslatePipe } from '../../pipes/translate.pipe';
import { toTrack } from '../../lib/track-utils';

type Tab = 'albums' | 'artists' | 'genres';

/**
 * Browse by grid — the only "find something" mechanism on TV.
 *
 * No search field, no filter panel, no sort control: each would be a native
 * form element, and a remote has no Tab to escape one with (issue #438). Sort
 * is fixed — newest albums, alphabetical artists — because a remote-shaped
 * sort control is a full-screen chooser and nothing yet suggests one is wanted.
 */
@Component({
  selector: 'app-tv-browse',
  standalone: true,
  imports: [CoverArtComponent, TvNavGroupDirective, TvNavItemDirective, TranslatePipe],
  templateUrl: './tv-browse.component.html',
})
export class TvBrowseComponent implements OnInit {
  private readonly api = inject(LibraryApiService);
  private readonly player = inject(PlayerService);
  readonly auth = inject(AuthService);
  private readonly router = inject(Router);

  readonly tabs: readonly { id: Tab; label: string }[] = [
    { id: 'albums', label: 'library.tab.albums' },
    { id: 'artists', label: 'library.tab.artists' },
    { id: 'genres', label: 'library.tab.genre' },
  ];
  readonly tab = signal<Tab>('albums');
  readonly loading = signal(true);

  readonly albums = signal<Album[]>([]);
  readonly artists = signal<{ id: string; name: string }[]>([]);
  readonly genres = signal<string[]>([]);

  readonly isEmpty = computed(() => {
    if (this.loading()) return false;
    return this.tab() === 'albums'
      ? this.albums().length === 0
      : this.tab() === 'artists'
        ? this.artists().length === 0
        : this.genres().length === 0;
  });

  ngOnInit(): void {
    void this.load('albums');
  }

  select(tab: Tab): void {
    this.tab.set(tab);
    void this.load(tab);
  }

  private async load(tab: Tab): Promise<void> {
    this.loading.set(true);
    try {
      if (tab === 'albums') {
        this.albums.set(
          await firstValueFrom(this.api.getAlbums('newest', 120).pipe(catchError(() => of([])))),
        );
      } else if (tab === 'artists') {
        const rows = await firstValueFrom(this.api.getArtists().pipe(catchError(() => of([]))));
        this.artists.set([...rows].sort((a, b) => a.name.localeCompare(b.name)));
      } else {
        const rows = await firstValueFrom(this.api.getGenres().pipe(catchError(() => of([]))));
        this.genres.set(rows.map((g) => g.value));
      }
    } finally {
      this.loading.set(false);
    }
  }

  openAlbum(album: Album): void {
    void this.router.navigate(['/library/albums', album.id]);
  }

  /** An artist tile plays that artist rather than opening a page a remote then
   *  has to navigate back out of — TV has no artist detail route. */
  async playArtist(artist: { id: string; name: string }): Promise<void> {
    const songs = await firstValueFrom(
      this.api.getArtistSongs(artist.id, 200, 0, { sort: 'title' }).pipe(catchError(() => of([]))),
    );
    if (!songs.length) return;
    this.player.playWithContext(
      songs.map((s) => toTrack(s)),
      0,
    );
    void this.router.navigate(['/player']);
  }

  async playGenre(genre: string): Promise<void> {
    const songs = await firstValueFrom(
      this.api.getSongsByGenre(genre, 100).pipe(catchError(() => of([]))),
    );
    if (!songs.length) return;
    this.player.playWithContext(
      songs.map((s) => toTrack(s)),
      0,
    );
    void this.router.navigate(['/player']);
  }
}
