import {
  Component,
  inject,
  signal,
  computed,
  effect,
  ElementRef,
  viewChild,
  OnInit,
  OnDestroy,
} from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { LibraryApiService } from '../../services/api/library-api.service';
import { DownloadsApiService } from '../../services/api/downloads-api.service';
import type {
  Album,
  Song,
  DiscographyAlbum,
  DiscographyResult,
} from '../../services/api/api-types';
import { AuthService } from '../../services/auth.service';
import { PlayerService } from '../../services/player.service';
import { PlaylistService } from '../../services/playlist.service';
import { PreserveService } from '../../services/preserve.service';
import { TransferService } from '../../services/transfer.service';
import { AlbumHuntModalComponent } from '../../components/album-hunt-modal/album-hunt-modal.component';
import { CoverArtComponent } from '../../components/cover-art/cover-art.component';
import { IconComponent } from '../../components/icon/icon.component';
import { TrackRowComponent, type TrackAction } from '../../components/track-row/track-row.component';
import { SelectionBarComponent } from '../../components/selection-bar/selection-bar.component';
import { MenuPanelComponent } from '../../components/menu-panel/menu-panel.component';
import { ConfirmDialogComponent } from '../../components/confirm-dialog/confirm-dialog.component';
import { createSelection } from '../../lib/selection';
import { toTrack, offlineTrackAction, addToPlaylistAction } from '../../lib/track-utils';
import { appendUnique } from '../../lib/append-unique';
import { resolveAlbumRoute } from '../../lib/route-utils';
import { NavigationService } from '../../services/navigation.service';
import { AutoHuntService } from '../../services/auto-hunt.service';

export type ArtistTab = 'albums' | 'singles' | 'appears-on' | 'songs';
export type SongSort = 'newest' | 'title' | 'album';
const SONGS_PAGE_SIZE = 60;

@Component({
  selector: 'app-artist-detail',
  standalone: true,
  imports: [
    RouterLink,
    AlbumHuntModalComponent,
    CoverArtComponent,
    IconComponent,
    TrackRowComponent,
    SelectionBarComponent,
    MenuPanelComponent,
    ConfirmDialogComponent,
  ],
  templateUrl: './artist-detail.component.html',
})
export class ArtistDetailComponent implements OnInit, OnDestroy {
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private api = inject(LibraryApiService);
  private downloadsApi = inject(DownloadsApiService);
  readonly auth = inject(AuthService);
  private player = inject(PlayerService);
  private playlists = inject(PlaylistService);
  readonly preserve = inject(PreserveService);
  private transferService = inject(TransferService);
  private nav = inject(NavigationService);
  protected autoHunt = inject(AutoHuntService);

  // Return to the previous in-app view, falling back to the library grid.
  goBack(): void {
    this.nav.back(['/library']);
  }

  readonly loading = signal(true);
  readonly playingAll = signal(false);
  readonly artist = signal<{
    id: string;
    name: string;
    albumCount: number;
    coverArt?: string;
  } | null>(null);
  readonly albums = signal<Album[]>([]);
  readonly singlesAndEps = signal<Album[]>([]);
  readonly appearsOn = signal<Album[]>([]);

  // ─── Artist image override (admin: upload / pick-from-album / reset) ───────
  readonly imageBusy = signal(false);
  // Bumped after any image change to bust the browser cache for the (otherwise
  // identical) cover URL so the new portrait shows without a hard refresh.
  readonly imageVersion = signal(0);
  readonly albumPickerOpen = signal(false);
  readonly imageMenu = viewChild<MenuPanelComponent>('imageMenu');
  readonly imageFileInput = viewChild<ElementRef<HTMLInputElement>>('imageFileInput');

  /** The portrait src, cache-busted after an override change. */
  readonly artistImageSrc = computed<string | undefined>(() => {
    const a = this.artist();
    if (!a?.coverArt) return undefined;
    const v = this.imageVersion();
    return `/api/cover/${a.coverArt}?size=200&token=${this.auth.token()}${v ? `&v=${v}` : ''}`;
  });

  /** Albums the user can copy a cover from (regular albums + singles/EPs). */
  readonly pickableAlbums = computed<Album[]>(() => [...this.albums(), ...this.singlesAndEps()]);

  private closeImageMenu(): void {
    this.imageMenu()?.open.set(false);
  }

  /** Open the OS file picker (wired to the hidden input). */
  triggerImageUpload(): void {
    this.closeImageMenu();
    this.imageFileInput()?.nativeElement.click();
  }

  async onImageFileSelected(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = ''; // allow re-selecting the same file later
    if (!file) return;
    await this.runImageChange(() => firstValueFrom(this.api.uploadArtistImage(this.artistId, file)));
  }

  openAlbumPicker(): void {
    this.closeImageMenu();
    this.albumPickerOpen.set(true);
  }

  closeAlbumPicker(): void {
    this.albumPickerOpen.set(false);
  }

  async pickAlbumCover(albumId: string): Promise<void> {
    this.albumPickerOpen.set(false);
    await this.runImageChange(() =>
      firstValueFrom(this.api.setArtistImageFromAlbum(this.artistId, albumId)),
    );
  }

  async resetImage(): Promise<void> {
    this.closeImageMenu();
    await this.runImageChange(() => firstValueFrom(this.api.resetArtistImage(this.artistId)));
  }

  /** Shared busy-guard + cache-bust for the three image-change actions. */
  private async runImageChange(action: () => Promise<unknown>): Promise<void> {
    if (this.imageBusy()) return;
    this.imageBusy.set(true);
    try {
      await action();
      this.imageVersion.update((v) => v + 1);
    } catch {
      /* best-effort; the tile simply keeps its prior image */
    } finally {
      this.imageBusy.set(false);
    }
  }

  // ─── Tabs ─────────────────────────────────────────────────────────
  readonly activeTab = signal<ArtistTab>('albums');
  // Which tabs to show: Albums/Singles only when populated; Songs is always
  // available (an artist with any release has songs). Computed so the bar and
  // the default-tab pick stay in sync.
  readonly visibleTabs = computed<ArtistTab[]>(() => {
    const tabs: ArtistTab[] = [];
    if (this.albums().length > 0) tabs.push('albums');
    if (this.singlesAndEps().length > 0) tabs.push('singles');
    if (this.appearsOn().length > 0) tabs.push('appears-on');
    tabs.push('songs');
    return tabs;
  });

  setTab(tab: ArtistTab): void {
    this.activeTab.set(tab);
    if (tab === 'songs' && !this.songsLoaded()) void this.loadSongs(true);
  }

  // ─── Songs tab (lazy, filtered, multi-select) ─────────────────────
  readonly songs = signal<Song[]>([]);
  readonly songsLoaded = signal(false);
  readonly songsLoadingMore = signal(false);
  readonly songsDone = signal(false);
  readonly songSort = signal<SongSort>('newest');
  readonly songsStarredOnly = signal(false);
  private songsOffset = 0;
  private artistId = '';

  readonly generating = signal(false);

  /** Generate a playlist seeded on this artist (Radio scorer), then open it. */
  async generatePlaylist(): Promise<void> {
    if (this.generating() || !this.artistId) return;
    this.generating.set(true);
    try {
      const playlist = await this.playlists.generate({ artistId: this.artistId });
      await this.router.navigate(['/library/playlists', playlist.id]);
    } catch {
      // Non-fatal — stay on the artist page.
    } finally {
      this.generating.set(false);
    }
  }

  readonly songsSentinel = viewChild<ElementRef<HTMLElement>>('songsSentinel');
  private songsObserver?: IntersectionObserver;

  readonly selection = createSelection();
  readonly songOrderedIds = computed(() => this.songs().map((s) => s.id));
  private selectedSongs(): Song[] {
    return this.songs().filter((s) => this.selection.isSelected(s.id));
  }

  readonly sortOptions: { value: SongSort; label: string }[] = [
    { value: 'newest', label: 'Recently added' },
    { value: 'title', label: 'Title' },
    { value: 'album', label: 'Album' },
  ];
  readonly activeSongFilterCount = computed(() => (this.songsStarredOnly() ? 1 : 0));

  setSongSort(sort: SongSort): void {
    if (sort === this.songSort()) return;
    this.songSort.set(sort);
    void this.loadSongs(true);
  }

  toggleStarredOnly(): void {
    this.songsStarredOnly.update((v) => !v);
    void this.loadSongs(true);
  }

  // Lazy page loader — mirrors the library grid (offset + appendUnique + done).
  // `reset` re-fetches from the top after a filter/sort change.
  async loadSongs(reset = false): Promise<void> {
    if (reset) {
      this.songsOffset = 0;
      this.songs.set([]);
      this.songsDone.set(false);
      this.selection.exit();
    }
    if (this.songsLoadingMore() || (this.songsDone() && !reset)) return;
    this.songsLoadingMore.set(true);
    try {
      const page = await firstValueFrom(
        this.api.getArtistSongs(this.artistId, SONGS_PAGE_SIZE, this.songsOffset, {
          sort: this.songSort(),
          starred: this.songsStarredOnly(),
        }),
      );
      this.songs.update((existing) => appendUnique(existing, page));
      this.songsOffset += page.length;
      if (page.length < SONGS_PAGE_SIZE) this.songsDone.set(true);
    } catch {
      this.songsDone.set(true);
    } finally {
      this.songsLoaded.set(true);
      this.songsLoadingMore.set(false);
    }
  }

  playSong(index: number): void {
    const tracks = this.songs().map((s) => toTrack(s));
    if (!tracks.length) return;
    this.player.playWithContext(tracks, index, {
      type: 'adhoc',
      name: this.artist()?.name,
    });
  }

  songSubtitle(song: Song): string {
    return song.album || song.artist;
  }

  // ─── Bulk actions on the selected songs ───────────────────────────
  playSelected(): void {
    const tracks = this.selectedSongs().map((s) => toTrack(s));
    if (!tracks.length) return;
    this.player.playWithContext(tracks, 0, { type: 'adhoc', name: this.artist()?.name });
    this.selection.exit();
  }

  queueSelected(): void {
    for (const s of this.selectedSongs()) this.player.addToQueue(toTrack(s));
    this.selection.exit();
  }

  addSelectedToPlaylist(): void {
    const ids = [...this.selection.ids()];
    if (!ids.length) return;
    this.playlists.openPicker(ids);
    this.selection.exit();
  }

  downloadSelected(): void {
    const tracks = this.selectedSongs().map((s) => toTrack(s));
    if (!tracks.length) return;
    void this.preserve.preserveCollection(
      `artist-${this.artistId}`,
      `${this.artist()?.name ?? 'Artist'} (selection)`,
      tracks,
    );
    this.selection.exit();
  }

  selectAllSongs(): void {
    this.selection.selectAll(this.songs().map((s) => s.id));
  }

  // ─── Delete (admin only) ──────────────────────────────────────────
  // The Songs tab is the ONLY view that surfaces albumless files, so it must
  // offer removal too — parity with album/genre detail. Backend delete routes
  // are hard-gated to admins; the UI mirrors that gate.
  readonly deleteError = signal<string | null>(null);
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

  private pruneSongs(ids: string[]): void {
    const gone = new Set(ids);
    this.songs.update((s) => s.filter((x) => !gone.has(x.id)));
  }

  deleteSelectedSongs(): void {
    const ids = [...this.selection.ids()];
    if (ids.length === 0) return;
    this.askConfirm(
      `Remove ${ids.length} song${ids.length !== 1 ? 's' : ''} from library?`,
      async () => {
        this.deleteError.set(null);
        try {
          const result = await firstValueFrom(this.api.deleteSongs(ids));
          this.transferService.addDeletedIds(ids);
          this.pruneSongs(ids);
          this.selection.exit();
          if (result.deletedCount < ids.length) {
            this.deleteError.set(
              `Removed ${result.deletedCount} of ${ids.length} songs. ${ids.length - result.deletedCount} could not be removed.`,
            );
          }
        } catch {
          this.deleteError.set('Failed to remove the selected songs.');
        }
      },
    );
  }

  artistTrackActions(song: Song): TrackAction[] {
    return [
      offlineTrackAction(this.preserve, toTrack(song)),
      addToPlaylistAction(this.playlists, song.id),
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
                    this.pruneSongs([song.id]);
                  } catch {
                    this.deleteError.set(`Failed to remove "${song.title}".`);
                  }
                }),
            },
          ]
        : []),
    ];
  }

  readonly discography = signal<DiscographyResult | null>(null);
  readonly discographyLoading = signal(false);
  readonly huntingAlbum = signal<DiscographyAlbum | null>(null);

  // Group the flat discography by release type for the template's sectioned grid.
  // Order: Albums → EPs → Singles → everything else; chronological within a group.
  private readonly typeOrder = ['Album', 'EP', 'Single'];
  readonly discographyGroups = computed<{ label: string; albums: DiscographyAlbum[] }[]>(() => {
    const disc = this.discography();
    if (!disc) return [];
    const buckets = new Map<string, DiscographyAlbum[]>();
    for (const album of disc.albums) {
      const key = album.albumType || 'Other';
      const bucket = buckets.get(key) ?? buckets.set(key, []).get(key)!;
      bucket.push(album);
    }
    const rank = (type: string): number => {
      const i = this.typeOrder.indexOf(type);
      return i === -1 ? this.typeOrder.length : i;
    };
    return [...buckets.entries()]
      .sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))
      .map(([label, albums]) => ({
        label,
        albums: [...albums].sort((x, y) =>
          (x.releaseDate ?? '').localeCompare(y.releaseDate ?? ''),
        ),
      }));
  });

  // Lazy-load the next song page when the sentinel scrolls into view, but only
  // while the Songs tab is active (mirrors the library grid's observer).
  private songsObserverEffect = effect(() => {
    const sentinel = this.songsSentinel();
    const onSongs = this.activeTab() === 'songs';
    this.songsObserver?.disconnect();
    if (!sentinel || !onSongs) return;
    this.songsObserver = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) void this.loadSongs();
      },
      { rootMargin: '400px 0px' },
    );
    this.songsObserver.observe(sentinel.nativeElement);
  });

  async ngOnInit(): Promise<void> {
    const id = this.route.snapshot.paramMap.get('id') ?? '';
    this.artistId = id;
    try {
      const data = await firstValueFrom(this.api.getArtist(id));
      this.artist.set(data.artist);
      this.albums.set(data.albums);
      this.singlesAndEps.set(data.singlesAndEps ?? []);
      // Default to the first populated tab (Albums → Singles → Songs).
      this.activeTab.set(this.visibleTabs()[0]);
    } catch {
      /* ignore */
    } finally {
      this.loading.set(false);
    }

    // Load "appears on" compilations and discography in background
    this.loadAppearsOn(id);
    this.loadDiscography(id);
  }

  ngOnDestroy(): void {
    this.songsObserver?.disconnect();
  }

  private async loadAppearsOn(artistId: string): Promise<void> {
    try {
      const data = await firstValueFrom(this.api.getArtistAppearsOn(artistId));
      this.appearsOn.set(data);
    } catch {
      /* no-op — compilations may not exist for this artist */
    }
  }

  private async loadDiscography(artistId: string): Promise<void> {
    this.discographyLoading.set(true);
    try {
      const result = await firstValueFrom(this.downloadsApi.getArtistDiscography(artistId));
      this.discography.set(result);
    } catch {
      // Lidarr not configured or artist not found — no discography shown
    } finally {
      this.discographyLoading.set(false);
    }
  }

  openHunt(album: DiscographyAlbum): void {
    const artistName = this.artist()?.name ?? '';
    this.autoHunt.hunt(album, artistName, () => this.huntingAlbum.set(album));
  }

  closeHunt(): void {
    this.huntingAlbum.set(null);
  }

  statusIcon(status: 'present' | 'partial' | 'missing'): string {
    if (status === 'present') return '✓';
    if (status === 'partial') return '◑';
    return '○';
  }

  statusClass(status: 'present' | 'partial' | 'missing'): string {
    if (status === 'present') return 'text-green-400';
    if (status === 'partial') return 'text-yellow-400';
    return 'text-zinc-500';
  }

  countByStatus(albums: DiscographyAlbum[], status: 'present' | 'partial' | 'missing'): number {
    return albums.filter((a) => a.status === status).length;
  }

  async playAll(): Promise<void> {
    const artistName = this.artist()?.name;
    const albums = this.albums();
    if (!albums.length) return;
    this.playingAll.set(true);
    try {
      const details = await Promise.all(albums.map((a) => firstValueFrom(this.api.getAlbum(a.id))));
      const tracks = details.flatMap((detail) => detail.song.map((s) => toTrack(s, detail.name)));
      if (tracks.length) {
        this.player.playWithContext(tracks, 0, { type: 'adhoc', name: artistName });
      }
    } catch {
      /* ignore */
    } finally {
      this.playingAll.set(false);
    }
  }

  getAlbumLink(id: string) {
    return resolveAlbumRoute(id);
  }

  readonly toTrack = toTrack;
}
