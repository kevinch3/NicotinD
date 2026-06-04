import { Component, inject, signal, computed, OnInit } from '@angular/core';
import { Router, ActivatedRoute, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { ApiService, type Song } from '../../services/api.service';
import { AuthService } from '../../services/auth.service';
import { PlayerService, type Track } from '../../services/player.service';
import { TransferService } from '../../services/transfer.service';
import {
  TrackRowComponent,
  type TrackAction,
} from '../../components/track-row/track-row.component';
import { ConfirmDialogComponent } from '../../components/confirm-dialog/confirm-dialog.component';
import { toTrack, offlineTrackAction } from '../../lib/track-utils';
import { resolveArtistRoute } from '../../lib/route-utils';
import { PreserveService } from '../../services/preserve.service';

@Component({
  selector: 'app-genre-detail',
  imports: [TrackRowComponent, ConfirmDialogComponent, RouterLink],
  templateUrl: './genre-detail.component.html',
})
export class GenreDetailComponent implements OnInit {
  private api = inject(ApiService);
  readonly auth = inject(AuthService);
  readonly player = inject(PlayerService);
  private transferService = inject(TransferService);
  readonly preserve = inject(PreserveService);
  private router = inject(Router);
  private route = inject(ActivatedRoute);

  readonly loadingGenreSongs = signal(true);
  readonly genreSlug = signal<string | null>(null);
  readonly genreSongs = signal<Song[]>([]);
  readonly deleteError = signal<string | null>(null);

  readonly filteredGenreSongs = computed(() => {
    const deleted = this.transferService.deletedSongIds();
    return this.genreSongs().filter((s) => !deleted.has(s.id));
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
    const slug = this.route.snapshot.paramMap.get('slug');
    if (slug) {
      this.genreSlug.set(slug);
      try {
        // Fetch the full genre (not just the default page) so "Download" can
        // preserve the whole list up to the storage cap.
        const songs = await firstValueFrom(this.api.getSongsByGenre(slug, 5000));
        this.genreSongs.set(songs);
      } catch {
        /* ignore */
      } finally {
        this.loadingGenreSongs.set(false);
      }
    } else {
      this.loadingGenreSongs.set(false);
    }
  }

  // ─── Genre methods ────────────────────────────────────────────────
  playGenre(): void {
    const genre = this.genreSlug();
    const songs = this.genreSongs();
    if (!genre || !songs.length) return;
    const tracks = songs.map((s) => toTrack(s));
    this.player.playWithContext(tracks, 0, { type: 'adhoc', name: genre });
  }

  protected toTrackFn = toTrack;

  // ─── Offline download ─────────────────────────────────────────────
  readonly genreTrackIds = computed(() => this.filteredGenreSongs().map((s) => s.id));
  readonly genreDownloaded = computed(() =>
    this.preserve.isCollectionPreserved(this.genreTrackIds()),
  );

  toggleDownloadGenre(): void {
    const genre = this.genreSlug();
    if (!genre) return;
    if (this.genreDownloaded()) {
      void this.preserve.removeMany(this.genreTrackIds());
    } else {
      void this.preserve.preserveCollection(
        genre,
        this.filteredGenreSongs().map((s) => toTrack(s)),
      );
    }
  }

  genreTrackActions(song: Song): TrackAction[] {
    return [
      offlineTrackAction(this.preserve, toTrack(song)),
      ...(song.artistId
        ? [
            {
              label: 'Go to artist',
              action: () => {
                void this.router.navigate(resolveArtistRoute(song.artistId));
              },
            },
          ]
        : []),
      ...(this.auth.role() === 'admin'
        ? [
            {
              label: 'Remove',
              destructive: true,
              action: () =>
                this.askConfirm(`Remove "${song.title}" from library?`, async () => {
                  this.deleteError.set(null);
                  try {
                    await firstValueFrom(this.api.deleteSongs([song.id]));
                    this.transferService.addDeletedIds([song.id]);
                    this.genreSongs.update((s) => s.filter((x) => x.id !== song.id));
                  } catch {
                    this.deleteError.set(`Failed to remove "${song.title}".`);
                  }
                }),
            },
          ]
        : []),
    ];
  }
}
