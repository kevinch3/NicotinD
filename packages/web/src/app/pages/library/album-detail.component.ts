import { Component, inject, signal, computed, OnInit } from '@angular/core';
import { Router, ActivatedRoute, RouterLink } from '@angular/router';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { LibraryApiService } from '../../services/api/library-api.service';
import type { AlbumDetail } from '../../services/api/api-types';
import { LICENCE_LABELS, type LicenceCode } from '@nicotind/core';
import { AuthService } from '../../services/auth.service';
import { PlayerService, type Track } from '../../services/player.service';
import { PlaylistService } from '../../services/playlist.service';
import { TransferService } from '../../services/transfer.service';
import { SongMenuService } from '../../services/song-menu.service';
import { ListControlsService, type SortOption } from '../../services/list-controls.service';
import { TrackRowComponent } from '../../components/track-row/track-row.component';
import { ConfirmDialogComponent } from '../../components/confirm-dialog/confirm-dialog.component';
import { CoverArtComponent } from '../../components/cover-art/cover-art.component';
import { toTrack } from '../../lib/track-utils';
import { resolveArtistRoute, resolveAlbumRoute } from '../../lib/route-utils';
import { createSelection } from '../../lib/selection';
import { SelectionBarComponent } from '../../components/selection-bar/selection-bar.component';
import { IconComponent } from '../../components/icon/icon.component';
import { MetadataFixModalComponent } from '../../components/metadata-fix-modal/metadata-fix-modal.component';
import { ArtistLinksComponent } from '../../components/artist-links/artist-links.component';
import { NavigationService } from '../../services/navigation.service';
import { PreserveService } from '../../services/preserve.service';

@Component({
  selector: 'app-album-detail',
  imports: [
    TrackRowComponent,
    ConfirmDialogComponent,
    RouterLink,
    CoverArtComponent,
    SelectionBarComponent,
    IconComponent,
    MetadataFixModalComponent,
    ArtistLinksComponent,
  ],
  templateUrl: './album-detail.component.html',
})
export class AlbumDetailComponent implements OnInit {
  private api = inject(LibraryApiService);
  readonly auth = inject(AuthService);
  readonly player = inject(PlayerService);
  private playlists = inject(PlaylistService);
  private transferService = inject(TransferService);
  readonly songMenu = inject(SongMenuService);
  private listControls = inject(ListControlsService);
  private router = inject(Router);
  private route = inject(ActivatedRoute);
  private http = inject(HttpClient);
  private nav = inject(NavigationService);
  readonly preserve = inject(PreserveService);
  readonly shareCopied = signal(false);

  /** Human label for a licence code (badge on the album header). */
  licenceLabel(code: string): string {
    return LICENCE_LABELS[code as LicenceCode] ?? code;
  }

  // Return to the previous in-app view (e.g. the artist page we came from),
  // falling back to this album's artist or the library on a fresh deep-link.
  goBack(): void {
    const artistId = this.selectedAlbum()?.artistId;
    this.nav.back(artistId ? resolveArtistRoute(artistId) : ['/library']);
  }

  readonly loadingAlbum = signal(true);
  readonly selectedAlbum = signal<AlbumDetail | null>(null);
  readonly deleting = signal(false);
  readonly deleteError = signal<string | null>(null);

  readonly detailSongs = computed(() => {
    const deleted = this.transferService.deletedSongIds();
    return (this.selectedAlbum()?.song ?? []).filter((s) => !deleted.has(s.id));
  });

  readonly detailSortOptions: SortOption[] = [
    { field: 'track', label: 'Track #' },
    { field: 'title', label: 'Title' },
    { field: 'artist', label: 'Artist' },
  ];

  readonly detailControls = this.listControls.connect({
    pageKey: 'library-album',
    items: this.detailSongs,
    searchFields: ['title', 'artist'] as const,
    sortOptions: this.detailSortOptions,
    defaultSort: 'track',
  });

  // ─── Confirm dialog ───────────────────────────────────────────────
  readonly confirmMessage = signal('');
  readonly confirmCallback = signal<(() => void | Promise<void>) | null>(null);
  readonly showConfirm = computed(() => this.confirmCallback() !== null);

  private askConfirm(message: string, cb: () => void | Promise<void>): void {
    this.confirmMessage.set(message);
    this.confirmCallback.set(cb);
  }

  onConfirm(): void {
    const cb = this.confirmCallback();
    this.confirmCallback.set(null);
    Promise.resolve(cb?.()).catch(() => {
      /* ignore */
    });
  }

  onCancelConfirm(): void {
    this.confirmCallback.set(null);
  }

  // ─── Lifecycle ────────────────────────────────────────────────────
  async ngOnInit(): Promise<void> {
    const albumId = this.route.snapshot.paramMap.get('id');
    if (albumId) {
      try {
        const detail = await firstValueFrom(this.api.getAlbum(albumId));
        this.selectedAlbum.set(detail);
      } catch {
        /* ignore */
      } finally {
        this.loadingAlbum.set(false);
      }
    } else {
      this.loadingAlbum.set(false);
    }
  }

  // ─── Albums methods ───────────────────────────────────────────────
  playSong(song: {
    id: string;
    title: string;
    artist: string;
    duration?: number;
    track?: number;
    coverArt?: string;
  }): void {
    this.player.play(toTrack(song, this.selectedAlbum()?.name));
  }

  private albumTracks(): Track[] {
    const album = this.selectedAlbum();
    if (!album?.song?.length) return [];
    return album.song.map(
      (s): Track => ({
        id: s.id,
        title: s.title,
        artist: s.artist,
        album: album.name,
        coverArt: s.coverArt,
        duration: s.duration,
      }),
    );
  }

  playAlbum(): void {
    const album = this.selectedAlbum();
    const tracks = this.albumTracks();
    if (!album || !tracks.length) return;
    this.player.playWithContext(tracks, 0, { type: 'album', id: album.id, name: album.name });
  }

  // ─── Multi-select ─────────────────────────────────────────────────
  readonly selection = createSelection();

  selectAllSongs(): void {
    this.selection.selectAll(this.detailControls.filtered().map((s) => s.id));
  }

  addSelectedToPlaylist(): void {
    const ids = [...this.selection.ids()];
    if (ids.length === 0) return;
    this.playlists.openPicker(ids);
    this.selection.exit();
  }

  readonly albumOrderedIds = computed(() => this.detailControls.filtered().map((s) => s.id));

  deleteSelectedSongs(): void {
    const ids = [...this.selection.ids()];
    if (ids.length === 0) return;
    this.askConfirm(`Remove ${ids.length} song${ids.length !== 1 ? 's' : ''} from library?`, async () => {
      this.deleteError.set(null);
      try {
        const result = await firstValueFrom(this.api.deleteSongs(ids));
        this.transferService.addDeletedIds(ids);
        this.selectedAlbum.update((a) =>
          a ? { ...a, song: a.song.filter((s) => !ids.includes(s.id)) } : null,
        );
        this.selection.exit();
        if (result.deletedCount < ids.length) {
          this.deleteError.set(
            `Removed ${result.deletedCount} of ${ids.length} songs. ${ids.length - result.deletedCount} could not be removed.`,
          );
        }
      } catch {
        this.deleteError.set('Failed to remove the selected songs.');
      }
    });
  }

  // ─── Offline download ─────────────────────────────────────────────
  readonly albumTrackIds = computed(() => this.detailSongs().map((s) => s.id));
  readonly albumDownloaded = computed(() =>
    this.preserve.isCollectionPreserved(this.albumTrackIds()),
  );

  toggleDownloadAlbum(): void {
    const album = this.selectedAlbum();
    if (!album) return;
    if (this.albumDownloaded()) {
      void this.preserve.removeMany(this.albumTrackIds());
    } else {
      void this.preserve.preserveCollection(album.id, album.name, this.albumTracks());
    }
  }

  toTrackFromSong(song: {
    id: string;
    title: string;
    artist: string;
    duration?: number;
    coverArt?: string;
    bitRate?: number;
  }): Track {
    return toTrack(song, this.selectedAlbum()?.name);
  }

  removeAlbum(): void {
    const album = this.selectedAlbum();
    if (!album) return;
    this.askConfirm(`Remove all tracks in "${album.name}"?`, async () => {
      this.deleteError.set(null);
      this.deleting.set(true);
      try {
        const result = await firstValueFrom(this.api.deleteAlbum(album.id));
        this.deleting.set(false);
        if (result.failedCount === 0) {
          void this.router.navigate(['/library']);
        } else {
          // The backend always removes the album from the canonical library
          // tables; a non-zero failedCount means some files couldn't be deleted
          // from disk and may need manual cleanup.
          const allIds = (album.song ?? []).map((s) => s.id);
          const failedSet = new Set(result.failed.map((f) => f.id));
          this.transferService.addDeletedIds(allIds.filter((id) => !failedSet.has(id)));
          this.deleteError.set(
            `Album removed, but ${result.failedCount} file(s) couldn't be deleted from disk and may need manual cleanup.`,
          );
        }
      } catch {
        this.deleting.set(false);
        this.deleteError.set('Failed to remove album. Please try again.');
      }
    });
  }

  // ─── Fix metadata (admin) ─────────────────────────────────────────
  readonly showMetadataFix = signal(false);
  /** Bumped after a fix so the cover URL busts its cache. */
  readonly coverBust = signal(0);

  openMetadataFix(): void {
    if (this.selectedAlbum()) this.showMetadataFix.set(true);
  }

  closeMetadataFix(): void {
    this.showMetadataFix.set(false);
  }

  /**
   * A correction was applied. The corrected album may live under a new id (the
   * artist/title changed → new deterministic id). Re-fetch by the returned id and
   * update the view in place — a param-only route change reuses this component and
   * would NOT re-run ngOnInit, so we can't rely on navigation to reload the data.
   * Then sync the URL so refresh/back resolve the corrected album.
   */
  async onMetadataApplied(result: { albumId: string }): Promise<void> {
    this.showMetadataFix.set(false);
    try {
      const detail = await firstValueFrom(this.api.getAlbum(result.albumId));
      this.selectedAlbum.set(detail);
      this.coverBust.update((v) => v + 1);
    } catch {
      /* ignore */
    }
    if (result.albumId !== this.route.snapshot.paramMap.get('id')) {
      await this.router.navigate(resolveAlbumRoute(result.albumId));
    }
  }

  /**
   * Cover-only change applied from the fix modal: the album id is unchanged, so
   * just refetch in place and bump the cache-bust token. The modal stays open.
   */
  async onCoverChanged(): Promise<void> {
    const id = this.selectedAlbum()?.id;
    if (!id) return;
    try {
      const detail = await firstValueFrom(this.api.getAlbum(id));
      this.selectedAlbum.set(detail);
    } catch {
      /* ignore */
    }
    this.coverBust.update((v) => v + 1);
  }

  getArtistLink(id: string | undefined): string[] {
    return resolveArtistRoute(id);
  }

  /** Shape an album track into `BaseSong` for `SongMenuService.build()` — album
   * tracks don't individually carry albumId/album, so borrow it from the page. */
  toSong(s: {
    id: string;
    title: string;
    artist: string;
    artistId?: string;
    coverArt?: string;
    duration?: number;
    bitRate?: number;
  }) {
    return { ...s, albumId: this.selectedAlbum()?.id, album: this.selectedAlbum()?.name };
  }

  shareAlbum(): void {
    const album = this.selectedAlbum();
    if (!album) return;
    this.http
      .post<{ url: string }>('/api/share', { resourceType: 'album', resourceId: album.id })
      .subscribe({
        next: ({ url }) => {
          navigator.clipboard.writeText(url).catch(() => {});
          this.shareCopied.set(true);
          setTimeout(() => this.shareCopied.set(false), 3000);
        },
      });
  }
}
