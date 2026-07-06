import { Component, inject, signal, computed, effect, OnInit, OnDestroy } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink, ActivatedRoute } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { SearchApiService } from '../../services/api/search-api.service';
import { DownloadsApiService } from '../../services/api/downloads-api.service';
import { LibraryApiService } from '../../services/api/library-api.service';
import { SystemApiService } from '../../services/api/system-api.service';
import type {
  CatalogAlbum,
  CatalogArtist,
  CatalogSearchResult,
  DiscographyAlbum,
} from '../../services/api/api-types';
import { SearchService, type NetworkResult } from '../../services/search.service';
import { TransferService } from '../../services/transfer.service';
import { AcquireService } from '../../services/acquire.service';
import { WatchlistService } from '../../services/watchlist.service';
import { PluginService } from '../../services/plugin.service';
import { PlayerService } from '../../services/player.service';
import { PlaylistService } from '../../services/playlist.service';
import { AutoHuntService } from '../../services/auto-hunt.service';
import type { TrackAction } from '../../components/track-row/track-row.component';
import {
  getSingleDownloadLabel,
  getFolderDownloadLabel,
  isPathEffectivelyQueued,
  BUTTON_CLASSES,
} from '../../lib/download-status';
import {
  groupByDirectory,
  formatPeerInfo,
  rankFolders,
  dedupeFolders,
  folderFormat,
  fileQualityLabel,
  type FolderGroup,
} from '../../lib/folder-utils';
import { groupBySong, formatBadge, type SongResult } from '../../lib/song-results';
import {
  songResultToCandidate,
  archiveToCandidate,
  spotifyToCandidate,
  mergeAndRank,
  type BlendedCandidate,
} from '../../lib/acquisition-candidate';
import { FolderBrowserComponent } from '../../components/folder-browser/folder-browser.component';
import { AlbumHuntModalComponent } from '../../components/album-hunt-modal/album-hunt-modal.component';
import { TrackRowComponent } from '../../components/track-row/track-row.component';
import { SourceChipComponent } from '../../components/source-chip/source-chip.component';
import { toTrack, addToPlaylistAction } from '../../lib/track-utils';
import { extractSharedUrl } from '../../lib/share-url';
import { httpErrorMessage, httpErrorCode } from '../../lib/http-error';
import {
  shouldOpenDirectSearch,
  discographyFallbackNote,
  scopedArtistMbid,
  applyDiscography,
} from '../../lib/catalog-display';

/** Lighter song shape returned by the unified search's local results. */
interface LibrarySong {
  id: string;
  title: string;
  artist: string;
  artistId?: string;
  artists?: Array<{ id: string; name: string; role: 'primary' | 'featuring' }>;
  album: string;
  duration?: number;
  coverArt?: string;
  track?: number;
}

// ─── Helpers ────────────────────────────────────────────────────────

interface FlatFile {
  username: string;
  freeUploadSlots: number;
  uploadSpeed: number;
  queueLength?: number;
  filename: string;
  size: number;
  bitRate?: number;
  length?: number;
  title?: string;
  artist?: string;
  album?: string;
  trackNumber?: string;
}

const ALLOWED_EXTENSIONS = new Set([
  '.mp3',
  '.flac',
  '.ogg',
  '.opus',
  '.m4a',
  '.aac',
  '.wav',
  '.aiff',
  '.wma',
  '.ape',
  '.wv',
]);

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getHighlightTerms(query: string): string[] {
  return Array.from(new Set(query.trim().split(/\s+/).filter(Boolean))).sort(
    (a, b) => b.length - a.length,
  );
}

function extractName(filepath: string) {
  const parts = filepath.split(/[\\/]/);
  return parts[parts.length - 1];
}

function getFilenameStem(filepath: string) {
  return extractName(filepath).replace(/\.[^/.]+$/, '');
}

function getDisplayTitle(file: Pick<FlatFile, 'filename' | 'title'>) {
  return file.title ?? getFilenameStem(file.filename);
}

function getDisplaySubtitle(file: Pick<FlatFile, 'artist' | 'album'>) {
  const parts = [file.artist, file.album].filter(Boolean);
  return parts.length > 0 ? parts.join(' · ') : '';
}

function flattenAndFilter(results: NetworkResult[]): FlatFile[] {
  const flat: FlatFile[] = [];
  for (const result of results) {
    for (const file of result.files) {
      if (file.size === 0) continue;
      const ext = file.filename.slice(file.filename.lastIndexOf('.')).toLowerCase();
      if (!ALLOWED_EXTENSIONS.has(ext)) continue;
      flat.push({
        username: result.username,
        freeUploadSlots: result.freeUploadSlots,
        uploadSpeed: result.uploadSpeed,
        queueLength: result.queueLength,
        filename: file.filename,
        size: file.size,
        bitRate: file.bitRate,
        length: file.length,
        title: file.title,
        artist: file.artist,
        album: file.album,
        trackNumber: file.trackNumber,
      });
    }
  }
  flat.sort(
    (a, b) =>
      b.uploadSpeed - a.uploadSpeed ||
      (a.queueLength ?? 0) - (b.queueLength ?? 0) ||
      getDisplayTitle(a).localeCompare(getDisplayTitle(b)) ||
      a.filename.localeCompare(b.filename),
  );
  return flat;
}

function formatDuration(seconds?: number) {
  if (!seconds) return '';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function formatSize(bytes: number) {
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  return `${(bytes / 1_000).toFixed(0)} KB`;
}

function formatSpeed(bytesPerSec: number) {
  if (bytesPerSec >= 1_000_000) return `${(bytesPerSec / 1_000_000).toFixed(1)} MB/s`;
  return `${(bytesPerSec / 1_000).toFixed(0)} KB/s`;
}

function highlightHtml(text: string, terms: string[]): string {
  if (!terms.length) return escapeHtml(text);
  const pattern = new RegExp(`(${terms.map(escapeRegExp).join('|')})`, 'gi');
  return escapeHtml(text).replace(pattern, '<mark class="search-highlight">$1</mark>');
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ─── Component ──────────────────────────────────────────────────────

@Component({
  selector: 'app-search',
  imports: [
    FormsModule,
    FolderBrowserComponent,
    RouterLink,
    AlbumHuntModalComponent,
    TrackRowComponent,
    SourceChipComponent,
  ],
  templateUrl: './search.component.html',
})
export class SearchComponent implements OnInit, OnDestroy {
  readonly router = inject(Router);
  private route = inject(ActivatedRoute);
  private api = inject(SearchApiService);
  private downloadsApi = inject(DownloadsApiService);
  private libraryApi = inject(LibraryApiService);
  private systemApi = inject(SystemApiService);
  readonly search = inject(SearchService);
  private transfers = inject(TransferService);
  readonly acquire = inject(AcquireService);
  readonly watchlist = inject(WatchlistService);
  readonly plugins = inject(PluginService);
  private player = inject(PlayerService);
  private playlists = inject(PlaylistService);
  private autoHunt = inject(AutoHuntService);

  readonly btnClasses = BUTTON_CLASSES;
  readonly formatDuration = formatDuration;
  readonly formatSize = formatSize;
  readonly formatSpeed = formatSpeed;
  readonly formatPeerInfo = formatPeerInfo;

  // Ephemeral state
  readonly loading = signal(false);
  readonly searchId = signal<string | null>(null);
  readonly errors = signal<string[]>([]);
  readonly networkAvailable = signal(true);
  readonly networkConnected = signal<boolean | null>(null);
  readonly searchError = signal<string | null>(null);
  readonly downloadError = signal<string | null>(null);
  readonly searchFocused = signal(false);

  // Metadata-driven (catalog) search state. The catalog lookup is the primary
  // result; the raw Soulseek search below is the always-available fallback.
  readonly catalog = signal<CatalogSearchResult | null>(null);
  readonly catalogUnavailable = signal(false); // Lidarr not configured / lookup failed
  // Local library songs (the "Songs" section) from the unified search.
  readonly librarySongs = signal<LibrarySong[]>([]);
  readonly resolvingAlbum = signal<string | null>(null); // foreignAlbumId being resolved
  readonly resolveError = signal<string | null>(null);
  readonly directSearchOpen = signal(false);
  // Set when a catalog album can't be resolved (not in Lidarr) and we fall back to
  // a raw network search — explains why the results switched to the network lane.
  readonly rawFallbackNote = signal<string | null>(null);
  readonly huntingAlbum = signal<DiscographyAlbum | null>(null);
  readonly huntingArtistName = signal('');

  // URL acquisition (yt-dlp / spotdl)
  acquireUrl = '';
  readonly acquireSubmitting = signal(false);
  readonly acquireError = signal<string | null>(null);

  readonly hasCatalog = computed(() => {
    const c = this.catalog();
    return !!c && (c.artists.length > 0 || c.albums.length > 0);
  });
  // Explains why we dropped to the network lane when an artist matched but the
  // catalog had none of their albums (§A6). Null when there's nothing to say.
  readonly discographyNote = computed(() => discographyFallbackNote(this.catalog()));
  // The §A6 deep fix: offer to load the matched artist's real discography on
  // demand (adds them to Lidarr) when the catalog couldn't surface their albums.
  readonly canLoadDiscography = computed(
    () => !!this.catalog()?.discographyUnavailable && scopedArtistMbid(this.catalog()) !== null,
  );
  readonly loadingDiscography = signal(false);

  readonly flatNetwork = computed(() => flattenAndFilter(this.search.network()));
  readonly hasNetwork = computed(() => this.flatNetwork().length > 0);
  readonly highlightTerms = computed(() => getHighlightTerms(this.search.query()));
  // Ranked so the best copies (free slot, lossless, complete, fast) lead, then
  // deduped so the ~100 near-identical album folders collapse to one card per
  // distinct copy (distinct editions/formats survive). See §A7.
  readonly folderGroups = computed(() =>
    dedupeFolders(rankFolders(groupByDirectory(this.flatNetwork()))),
  );
  // Template helpers for folder format badge + per-file quality label (§A7).
  readonly folderFormat = folderFormat;
  readonly fileQualityLabel = fileQualityLabel;
  // Song-first view of the network results: one row per song (deduped across
  // peers, best copy auto-picked) so finding a single track is one click. The
  // folder view stays available for whole-album grabs. See §F1.
  readonly networkView = signal<'songs' | 'folders'>('songs');
  readonly songResults = computed(() => groupBySong(this.flatNetwork(), this.search.query()));

  // ─── Source-agnostic blended results ────────────────────────────────
  // One ranked list across every enabled source (Soulseek peer files +
  // archive.org + Spotify), each row chip-labelled with a single Get action.
  // Replaces the old "primary network + Also-on-X lanes" hierarchy. See
  // docs/source-agnostic-acquisition.md.
  readonly blendedResults = computed<BlendedCandidate[]>(() =>
    mergeAndRank(
      this.songResults().map(songResultToCandidate),
      this.search.archive().map(archiveToCandidate),
      this.search.spotify().map(spotifyToCandidate),
    ),
  );
  readonly hasBlendedResults = computed(() => this.blendedResults().length > 0);
  // Sources that contributed (or are still searching) — drives the neutral
  // "Soulseek · Internet Archive · Spotify" availability line.
  readonly availableSources = computed(() => {
    const names: string[] = [];
    if (this.networkConnected()) names.push('Soulseek');
    if (this.plugins.hasArchive()) names.push('Internet Archive');
    if (this.plugins.hasSpotify()) names.push('Spotify');
    return names;
  });

  private pollInterval: ReturnType<typeof setInterval> | null = null;

  private autoSearchEffect = effect(() => {
    if (this.search.autoSearch() && this.search.query().trim()) {
      this.search.setAutoSearch(false);
      this.executeSearch();
    }
  });

  ngOnInit(): void {
    firstValueFrom(this.systemApi.getSoulseekStatus())
      .then((s) => this.networkConnected.set(s.connected))
      .catch(() => this.networkConnected.set(false));
    void this.acquire.refresh();
    void this.watchlist.refresh();
    void this.plugins.refresh();

    // PWA share-target: a link shared from another app lands here as ?url=/?text=.
    // Auto-start an acquisition job for it so "Share → NicotinD" just works.
    const qp = this.route.snapshot.queryParamMap;
    const shared = extractSharedUrl(qp.get('url'), qp.get('text'), qp.get('title'));
    if (shared) {
      void this.startAcquire(shared);
      // Drop the share params so a refresh doesn't re-submit.
      void this.router.navigate([], { queryParams: {}, replaceUrl: true });
    }
  }

  // Star/unstar a catalog album so the watchlist poller auto-acquires it when a
  // complete folder appears. Stops propagation so it doesn't trigger the card's
  // hunt-now action.
  async toggleWatch(album: CatalogAlbum, e: Event): Promise<void> {
    e.stopPropagation();
    try {
      await this.watchlist.toggle({
        foreignAlbumId: album.foreignAlbumId,
        artistMbid: album.artistMbid,
        artistName: album.artistName,
        title: album.title,
      });
    } catch {
      // Non-fatal (e.g. watchlist route unavailable); ignore.
    }
  }

  ngOnDestroy(): void {
    this.stopPoll();
    const id = this.searchId();
    if (id) this.cleanupSearch(id);
  }

  onSearchBlur(): void {
    setTimeout(() => this.searchFocused.set(false), 150);
  }

  handleSearch(e: Event): void {
    e.preventDefault();
    this.executeSearch();
  }

  handleStopSearch(): void {
    const id = this.searchId();
    if (id) this.cleanupSearch(id);
    this.search.setNetworkState('complete');
    this.stopPoll();
  }

  async handleDownload(username: string, file: { filename: string; size: number }): Promise<void> {
    if (file.size === 0) return;
    const key = `${username}:${file.filename}`;
    this.search.addDownloading(key);
    try {
      await firstValueFrom(this.downloadsApi.enqueueDownload(username, [file]));
      this.downloadError.set(null);
    } catch (err) {
      this.search.removeDownloading(key);
      this.downloadError.set(err instanceof Error ? err.message : 'Download failed');
    }
  }

  async downloadAll(): Promise<void> {
    const flat = this.flatNetwork();
    const byUser = new Map<string, FlatFile[]>();
    for (const f of flat) {
      if (!byUser.has(f.username)) byUser.set(f.username, []);
      byUser.get(f.username)!.push(f);
    }
    for (const [username, files] of byUser.entries()) {
      for (const f of files) this.search.addDownloading(`${username}:${f.filename}`);
      try {
        await firstValueFrom(
          this.downloadsApi.enqueueDownload(
            username,
            files.map((f) => ({ filename: f.filename, size: f.size })),
          ),
        );
      } catch (err) {
        for (const f of files) this.search.removeDownloading(`${username}:${f.filename}`);
        this.downloadError.set(err instanceof Error ? err.message : 'Download failed');
      }
    }
  }

  async downloadFolder(group: FolderGroup): Promise<void> {
    const validFiles = group.files.filter((f) => f.size > 0);
    this.search.addDownloadedFolder(`${group.username}:${group.directory}`);
    for (const f of validFiles) this.search.addDownloading(`${group.username}:${f.filename}`);
    try {
      await firstValueFrom(
        this.downloadsApi.enqueueDownload(
          group.username,
          validFiles.map((f) => ({ filename: f.filename, size: f.size })),
        ),
      );
      this.downloadError.set(null);
    } catch (err) {
      for (const f of validFiles) this.search.removeDownloading(`${group.username}:${f.filename}`);
      this.downloadError.set(err instanceof Error ? err.message : 'Folder download failed');
    }
  }

  async handleBrowserDownload(
    username: string,
    directory: string,
    event: { files: Array<{ filename: string; size: number }>; path?: string },
  ): Promise<void> {
    const validFiles = event.files.filter((f) => f.size > 0);
    const folderKey = event.path ? `${username}:${event.path}` : `${username}:${directory}`;
    this.search.addDownloadedFolder(folderKey);
    for (const f of validFiles) this.search.addDownloading(`${username}:${f.filename}`);
    try {
      await firstValueFrom(this.downloadsApi.enqueueDownload(username, validFiles));
      this.downloadError.set(null);
    } catch (err) {
      for (const f of validFiles) this.search.removeDownloading(`${username}:${f.filename}`);
      this.downloadError.set(err instanceof Error ? err.message : 'Download failed');
    }
  }

  navigateAndSearch(query: string): void {
    this.search.setQuery(query);
    this.search.setAutoSearch(true);
    this.router.navigate(['/']);
  }

  // ─── Catalog (metadata) results ─────────────────────────────────

  // Artist pill click: navigate to the local library page if this artist is
  // already downloaded, otherwise load their full Lidarr discography as album
  // cards — much more useful than re-running the same search query.
  async activateArtist(artist: CatalogArtist): Promise<void> {
    const localId = await firstValueFrom(this.libraryApi.resolveArtistIdByName(artist.name));
    if (localId) {
      void this.router.navigate(['/library/artists', localId]);
      return;
    }
    await this.doLoadDiscography(artist.mbid, artist.name);
  }

  // §A6 deep fix: load the matched artist's real discography on demand. The
  // global album.lookup surfaced none of their albums, so this adds the artist to
  // Lidarr and lists their releases as real, resolvable cards.
  async loadDiscography(): Promise<void> {
    const cat = this.catalog();
    const mbid = scopedArtistMbid(cat);
    if (!cat?.scopedArtist || mbid === null) return;
    await this.doLoadDiscography(mbid, cat.scopedArtist);
  }

  private async doLoadDiscography(mbid: string, artistName: string): Promise<void> {
    if (this.loadingDiscography()) return;
    this.loadingDiscography.set(true);
    this.resolveError.set(null);
    try {
      const loaded = await firstValueFrom(this.api.catalogDiscography(mbid, artistName));
      const cat = this.catalog();
      this.catalog.set(cat ? applyDiscography(cat, loaded) : loaded);
      this.directSearchOpen.set(shouldOpenDirectSearch(this.catalog()));
    } catch (err) {
      this.resolveError.set(httpErrorMessage(err, "Couldn't load the artist's discography"));
    } finally {
      this.loadingDiscography.set(false);
    }
  }

  // Resolve a searched album into a real Lidarr album, then open the same
  // album-hunt modal used by the discography flow.
  async huntCatalogAlbum(album: CatalogAlbum): Promise<void> {
    if (this.resolvingAlbum()) return;
    this.resolveError.set(null);
    this.resolvingAlbum.set(album.foreignAlbumId);
    try {
      const resolved = await firstValueFrom(
        this.api.catalogResolve({
          foreignAlbumId: album.foreignAlbumId,
          artistMbid: album.artistMbid,
          artistName: album.artistName,
          albumTitle: album.title,
        }),
      );
      const discAlbum: DiscographyAlbum = {
        lidarrId: resolved.lidarrAlbumId,
        foreignAlbumId: album.foreignAlbumId,
        title: resolved.title || album.title,
        releaseDate: album.year,
        albumType: album.albumType,
        secondaryTypes: album.secondaryTypes,
        totalTracks: resolved.totalTracks || album.trackCount,
        localTrackCount: 0,
        status: 'missing',
        coverArtUrl: album.coverUrl,
        tracks: [],
      };
      const artistName = resolved.artistName || album.artistName;
      this.huntingArtistName.set(artistName);
      this.autoHunt.hunt(discAlbum, artistName, () => this.huntingAlbum.set(discAlbum));
    } catch (err) {
      // A compilation/best-of that exists globally but not in the artist's Lidarr
      // discography can't be hunted the guided way. Rather than dead-end, auto-fall
      // back to a raw Soulseek search for "<artist> <album>" (user-chosen behavior)
      // so the network lane still surfaces downloadable folder candidates.
      if (httpErrorCode(err) === 'ALBUM_NOT_IN_LIDARR') {
        this.rawHuntFallback(album);
        return;
      }
      // Surface the server's reason (e.g. a transient Lidarr metadata outage)
      // instead of a generic fallback — HttpErrorResponse isn't an Error, so we
      // must read its `{ error }` body.
      this.resolveError.set(httpErrorMessage(err, 'Failed to prepare album'));
    } finally {
      this.resolvingAlbum.set(null);
    }
  }

  // Raw-string network fallback for an album missing from Lidarr's discography:
  // search Soulseek for "<artist> <album>" and open the network lane so the user
  // gets folder candidates to download. Also loads the artist's full discography
  // so real album cards reappear alongside the network results.
  private rawHuntFallback(album: CatalogAlbum): void {
    this.resolvingAlbum.set(null);
    this.search.setQuery(`${album.artistName} ${album.title}`.trim());
    // executeSearch runs its synchronous reset (clearing the note) before its first
    // await, so set the note *after* kicking it off and it survives the run.
    // After the search settles, reload the artist's full discography so album cards
    // appear alongside the network results.
    void this.executeSearch({ forceDirectOpen: true }).then(() => {
      void this.doLoadDiscography(album.artistMbid, album.artistName);
    });
    this.rawFallbackNote.set(
      `"${album.title}" isn't in ${album.artistName}'s Lidarr catalog — showing network results and their full discography below.`,
    );
  }

  closeHunt(): void {
    this.huntingAlbum.set(null);
  }

  // Play a library song from the Songs section, queuing the rest of the results.
  playLibrarySong(index: number): void {
    const tracks = this.librarySongs().map((s) => toTrack(s));
    if (!tracks.length) return;
    this.player.playWithContext(tracks, index, { type: 'adhoc', name: 'Search' });
  }

  songActions(songId: string): TrackAction[] {
    return [addToPlaylistAction(this.playlists, songId)];
  }

  toTrack = toTrack;

  async submitAcquireUrl(e: Event): Promise<void> {
    e.preventDefault();
    await this.startAcquire(this.acquireUrl.trim());
  }

  private async startAcquire(url: string): Promise<void> {
    if (!url) return;
    this.acquireError.set(null);
    this.acquireSubmitting.set(true);
    try {
      await this.acquire.submit(url);
      this.acquireUrl = '';
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to start download';
      this.acquireError.set(msg);
    } finally {
      this.acquireSubmitting.set(false);
    }
  }

  async cancelAcquireJob(jobId: string): Promise<void> {
    await this.acquire.cancel(jobId).catch(() => {});
  }

  // archive.org search lane — fired in parallel with the network search. Gated on
  // the archive plugin; failures degrade silently to an empty section.
  private async searchArchive(query: string): Promise<void> {
    if (!this.plugins.hasArchive()) return;
    this.search.setArchiveState('searching');
    try {
      const res = await firstValueFrom(this.api.archiveSearch(query));
      this.search.setArchive(res.candidates);
    } catch {
      // Non-fatal — leave the section empty.
    } finally {
      this.search.setArchiveState('complete');
    }
  }

  // Spotify metadata fallback lane — fired in parallel with the network search.
  // Gated on the spotify plugin; failures degrade silently to an empty section.
  private async searchSpotify(query: string): Promise<void> {
    if (!this.plugins.hasSpotify()) return;
    this.search.setSpotifyState('searching');
    try {
      const res = await firstValueFrom(this.api.spotifySearch(query));
      this.search.setSpotify(res.candidates);
    } catch {
      // Non-fatal — leave the section empty.
    } finally {
      this.search.setSpotifyState('complete');
    }
  }

  // ─── Blended candidate dispatch ─────────────────────────────────────
  // Single Get for any source: a peer file is enqueued; a url (archive/Spotify)
  // is handed to the acquire pipeline. State is tracked per candidate id.
  readonly blendedAcquired = signal<Set<string>>(new Set());

  async getBlended(c: BlendedCandidate): Promise<void> {
    if (c.acquire.via === 'enqueue') {
      // Reuse the network download path (downloading-state keyed on username:file).
      await this.handleDownload(c.acquire.username, c.acquire.file);
      return;
    }
    // Spotify gives metadata only — without spotDL there's nothing to resolve the
    // URL, so open it in Spotify instead of queuing a doomed acquire job.
    if (c.source === 'spotify' && !this.plugins.hasSpotdl()) {
      window.open(c.acquire.url, '_blank', 'noopener');
      return;
    }
    this.blendedAcquired.update((s) => new Set(s).add(c.id));
    try {
      await this.acquire.submit(c.acquire.url);
    } catch {
      this.blendedAcquired.update((s) => {
        const next = new Set(s);
        next.delete(c.id);
        return next;
      });
    }
  }

  /** Get-button label/state for a blended candidate (reuses per-source state). */
  blendedState(c: BlendedCandidate): 'idle' | 'working' | 'done' {
    if (c.acquire.via === 'enqueue') {
      const key = `${c.acquire.username}:${c.acquire.file.filename}`;
      const status = this.transfers.getStatus(c.acquire.username, c.acquire.file.filename);
      if (status?.percent === 100) return 'done';
      if (this.search.downloading().has(key) || status) return 'working';
      return 'idle';
    }
    return this.blendedAcquired().has(c.id) ? 'done' : 'idle';
  }

  blendedPercent(c: BlendedCandidate): number {
    if (c.acquire.via !== 'enqueue') return 0;
    return this.transfers.getStatus(c.acquire.username, c.acquire.file.filename)?.percent ?? 0;
  }

  toggleDirectSearch(): void {
    this.directSearchOpen.update((v) => !v);
  }

  toggleBrowser(key: string): void {
    this.search.openBrowserKey.update((k) => (k === key ? null : key));
  }

  // ─── Template helpers ───────────────────────────────────────────

  getDirBasename(group: FolderGroup): string {
    return group.directory.split(/[\\/]/).at(-1) ?? group.directory;
  }

  getFolderKey(group: FolderGroup): string {
    return `${group.username}::${group.directory}`;
  }

  getFolderBtn(group: FolderGroup) {
    const folderFiles = group.files
      .filter((f) => f.size > 0)
      .map((f) => ({ username: group.username, filename: f.filename }));
    const isFolderQueued = isPathEffectivelyQueued(
      group.username,
      group.directory,
      this.search.downloadedFolders(),
    );
    return getFolderDownloadLabel(folderFiles, isFolderQueued, (u, f) =>
      this.transfers.getStatus(u, f),
    );
  }

  getFolderValidFiles(group: FolderGroup) {
    return group.files.filter((f) => f.size > 0);
  }

  getFolderBrowseFiles(group: FolderGroup) {
    return group.files.map((f) => ({
      filename: f.filename,
      size: f.size,
      bitRate: f.bitRate,
      length: f.length,
    }));
  }

  getGroupFileBtn(group: FolderGroup, file: FolderGroup['files'][number]) {
    const key = `${group.username}:${file.filename}`;
    return getSingleDownloadLabel(
      group.username,
      file.filename,
      this.search.downloading().has(key),
      (u, f) => this.transfers.getStatus(u, f),
    );
  }

  getGroupFileVariant(group: FolderGroup, file: FolderGroup['files'][number]) {
    return this.getGroupFileBtn(group, file).variant;
  }

  getGroupFilePercent(group: FolderGroup, file: FolderGroup['files'][number]) {
    const entry = this.transfers.getStatus(group.username, file.filename);
    return entry?.percent ?? 0;
  }

  getGroupFileSubtitle(file: FolderGroup['files'][number]) {
    return getDisplaySubtitle(file);
  }

  highlightGroupFileTitle(file: FolderGroup['files'][number]): string {
    return highlightHtml(getDisplayTitle(file), this.highlightTerms());
  }

  highlightGroupFileSubtitle(file: FolderGroup['files'][number]): string {
    return highlightHtml(getDisplaySubtitle(file), this.highlightTerms());
  }

  // ─── Songs view (network results, song-first) ───────────────────

  setNetworkView(view: 'songs' | 'folders'): void {
    this.networkView.set(view);
  }

  // Download the best copy of a deduped song in one click.
  downloadSong(song: SongResult): Promise<void> {
    return this.handleDownload(song.best.username, {
      filename: song.best.filename,
      size: song.best.size,
    });
  }

  getSongBtn(song: SongResult) {
    const key = `${song.best.username}:${song.best.filename}`;
    return getSingleDownloadLabel(
      song.best.username,
      song.best.filename,
      this.search.downloading().has(key),
      (u, f) => this.transfers.getStatus(u, f),
    );
  }

  getSongVariant(song: SongResult) {
    return this.getSongBtn(song).variant;
  }

  getSongPercent(song: SongResult): number {
    return this.transfers.getStatus(song.best.username, song.best.filename)?.percent ?? 0;
  }

  songFormatBadge(song: SongResult): string {
    return formatBadge(song.best);
  }

  highlightSongTitle(song: SongResult): string {
    return highlightHtml(song.title, this.highlightTerms());
  }

  highlightSongArtist(song: SongResult): string {
    return highlightHtml(song.artist, this.highlightTerms());
  }

  // ─── Private ────────────────────────────────────────────────────

  private async executeSearch(opts?: { forceDirectOpen?: boolean }): Promise<void> {
    const query = this.search.query().trim();
    if (!query) return;

    this.search.addToHistory(query);

    const prevId = this.searchId();
    if (prevId) this.cleanupSearch(prevId);
    this.stopPoll();

    this.loading.set(true);
    this.search.reset();
    this.errors.set([]);
    this.searchError.set(null);
    this.downloadError.set(null);
    this.resolveError.set(null);
    // A raw fallback re-sets this note right after kicking off the search; a normal
    // user-initiated search clears it here so it never lingers.
    this.rawFallbackNote.set(null);
    this.catalog.set(null);
    this.catalogUnavailable.set(false);
    this.librarySongs.set([]);
    this.networkAvailable.set(true);

    // Fire metadata (catalog) + raw Soulseek search in parallel. Catalog is the
    // primary result; the raw search backs the always-available fallback section.
    const catalogPromise = firstValueFrom(this.api.catalogSearch(query))
      .then((res) => this.catalog.set(res))
      .catch(() => this.catalogUnavailable.set(true));

    // archive.org runs in parallel as a third lane (only when the plugin is on).
    void this.searchArchive(query);
    // Spotify metadata fallback runs in parallel too (only when its plugin is on).
    void this.searchSpotify(query);

    try {
      const res = await firstValueFrom(this.api.search(query));
      this.searchId.set(res.searchId);
      this.librarySongs.set(res.local?.songs ?? []);
      this.errors.set(res.errors ?? []);
      this.networkAvailable.set(res.networkAvailable ?? false);
      this.search.setNetworkState(res.networkAvailable ? 'searching' : 'complete');
      if (res.networkAvailable) this.startPoll();
    } catch (err) {
      this.searchError.set(err instanceof Error ? err.message : 'Search failed');
      this.search.setNetworkState('complete');
    } finally {
      await catalogPromise;
      // Open the raw-search fallback whenever the guided path has no actionable
      // album cards — no catalog, or an artist matched but their discography
      // wasn't available (§A6). Artist pills alone don't keep it closed.
      this.directSearchOpen.set(opts?.forceDirectOpen || shouldOpenDirectSearch(this.catalog()));
      this.loading.set(false);
    }
  }

  private startPoll(): void {
    this.stopPoll();
    this.pollInterval = setInterval(async () => {
      const id = this.searchId();
      if (!id || this.search.networkState() === 'complete' || !this.networkAvailable()) {
        this.stopPoll();
        return;
      }
      try {
        const res = await firstValueFrom(this.api.pollNetwork(id));
        this.search.setNetwork(res.results);
        this.search.setNetworkResponseCount(res.responseCount ?? 0);
        if (res.canBrowse !== undefined) this.search.setCanBrowse(res.canBrowse);
        if (res.state === 'complete') {
          this.search.setNetworkState('complete');
          this.stopPoll();
        }
      } catch {
        this.search.setNetworkState('complete');
        this.stopPoll();
      }
    }, 2000);
  }

  private stopPoll(): void {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
  }

  private cleanupSearch(id: string): void {
    firstValueFrom(this.api.cancelSearch(id)).catch(() => {});
    firstValueFrom(this.api.deleteSearch(id)).catch(() => {});
  }
}
