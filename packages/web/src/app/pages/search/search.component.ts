import { Component, inject, signal, computed, effect, OnInit, OnDestroy } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { ApiService, type CatalogAlbum, type CatalogSearchResult, type DiscographyAlbum } from '../../services/api.service';
import { SearchService, type NetworkResult } from '../../services/search.service';
import { TransferService } from '../../services/transfer.service';
import { getSingleDownloadLabel, getFolderDownloadLabel, isPathEffectivelyQueued, BUTTON_CLASSES } from '../../lib/download-status';
import { groupByDirectory, formatPeerInfo, type FolderGroup } from '../../lib/folder-utils';
import { FolderBrowserComponent } from '../../components/folder-browser/folder-browser.component';
import { AlbumHuntModalComponent } from '../../components/album-hunt-modal/album-hunt-modal.component';

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
  '.mp3', '.flac', '.ogg', '.opus',
  '.m4a', '.aac', '.wav', '.aiff', '.wma', '.ape', '.wv',
]);

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getHighlightTerms(query: string): string[] {
  return Array.from(
    new Set(query.trim().split(/\s+/).filter(Boolean)),
  ).sort((a, b) => b.length - a.length);
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
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ─── Component ──────────────────────────────────────────────────────

@Component({
  selector: 'app-search',
  imports: [FormsModule, FolderBrowserComponent, RouterLink, AlbumHuntModalComponent],
  templateUrl: './search.component.html',
  })
export class SearchComponent implements OnInit, OnDestroy {
  readonly router = inject(Router);
  private api = inject(ApiService);
  readonly search = inject(SearchService);
  private transfers = inject(TransferService);

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
  readonly resolvingAlbum = signal<string | null>(null); // foreignAlbumId being resolved
  readonly resolveError = signal<string | null>(null);
  readonly directSearchOpen = signal(false);
  readonly huntingAlbum = signal<DiscographyAlbum | null>(null);
  readonly huntingArtistName = signal('');

  readonly hasCatalog = computed(() => {
    const c = this.catalog();
    return !!c && (c.artists.length > 0 || c.albums.length > 0);
  });

  readonly flatNetwork = computed(() => flattenAndFilter(this.search.network()));
  readonly hasNetwork = computed(() => this.flatNetwork().length > 0);
  readonly highlightTerms = computed(() => getHighlightTerms(this.search.query()));
  readonly folderGroups = computed(() => groupByDirectory(this.flatNetwork()));

  private pollInterval: ReturnType<typeof setInterval> | null = null;

  private autoSearchEffect = effect(() => {
    if (this.search.autoSearch() && this.search.query().trim()) {
      this.search.setAutoSearch(false);
      this.executeSearch();
    }
  });

  ngOnInit(): void {
    firstValueFrom(this.api.getSoulseekStatus())
      .then(s => this.networkConnected.set(s.connected))
      .catch(() => this.networkConnected.set(false));
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
      await firstValueFrom(this.api.enqueueDownload(username, [file]));
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
        await firstValueFrom(this.api.enqueueDownload(username, files.map(f => ({ filename: f.filename, size: f.size }))));
      } catch (err) {
        for (const f of files) this.search.removeDownloading(`${username}:${f.filename}`);
        this.downloadError.set(err instanceof Error ? err.message : 'Download failed');
      }
    }
  }

  async downloadFolder(group: FolderGroup): Promise<void> {
    const validFiles = group.files.filter(f => f.size > 0);
    this.search.addDownloadedFolder(`${group.username}:${group.directory}`);
    for (const f of validFiles) this.search.addDownloading(`${group.username}:${f.filename}`);
    try {
      await firstValueFrom(this.api.enqueueDownload(group.username, validFiles.map(f => ({ filename: f.filename, size: f.size }))));
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
    const validFiles = event.files.filter(f => f.size > 0);
    const folderKey = event.path ? `${username}:${event.path}` : `${username}:${directory}`;
    this.search.addDownloadedFolder(folderKey);
    for (const f of validFiles) this.search.addDownloading(`${username}:${f.filename}`);
    try {
      await firstValueFrom(this.api.enqueueDownload(username, validFiles));
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

  // Re-run the search scoped to an artist so album.lookup surfaces their
  // releases (there is no discography page for non-library artists).
  searchArtist(name: string): void {
    this.search.setQuery(name);
    this.executeSearch();
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
      this.huntingArtistName.set(resolved.artistName || album.artistName);
      this.huntingAlbum.set({
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
      });
    } catch (err) {
      this.resolveError.set(err instanceof Error ? err.message : 'Failed to prepare album');
    } finally {
      this.resolvingAlbum.set(null);
    }
  }

  closeHunt(): void {
    this.huntingAlbum.set(null);
  }

  toggleDirectSearch(): void {
    this.directSearchOpen.update((v) => !v);
  }

  toggleBrowser(key: string): void {
    this.search.openBrowserKey.update(k => k === key ? null : key);
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
      .filter(f => f.size > 0)
      .map(f => ({ username: group.username, filename: f.filename }));
    const isFolderQueued = isPathEffectivelyQueued(group.username, group.directory, this.search.downloadedFolders());
    return getFolderDownloadLabel(folderFiles, isFolderQueued, (u, f) => this.transfers.getStatus(u, f));
  }

  getFolderValidFiles(group: FolderGroup) {
    return group.files.filter(f => f.size > 0);
  }

  getFolderBrowseFiles(group: FolderGroup) {
    return group.files.map(f => ({
      filename: f.filename,
      size: f.size,
      bitRate: f.bitRate,
      length: f.length,
    }));
  }

  getGroupFileBtn(
    group: FolderGroup,
    file: FolderGroup['files'][number],
  ) {
    const key = `${group.username}:${file.filename}`;
    return getSingleDownloadLabel(
      group.username,
      file.filename,
      this.search.downloading().has(key),
      (u, f) => this.transfers.getStatus(u, f),
    );
  }

  getGroupFileVariant(
    group: FolderGroup,
    file: FolderGroup['files'][number],
  ) {
    return this.getGroupFileBtn(group, file).variant;
  }

  getGroupFilePercent(
    group: FolderGroup,
    file: FolderGroup['files'][number],
  ) {
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

  // ─── Private ────────────────────────────────────────────────────

  private async executeSearch(): Promise<void> {
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
    this.catalog.set(null);
    this.catalogUnavailable.set(false);
    this.networkAvailable.set(true);

    // Fire metadata (catalog) + raw Soulseek search in parallel. Catalog is the
    // primary result; the raw search backs the always-available fallback section.
    const catalogPromise = firstValueFrom(this.api.catalogSearch(query))
      .then((res) => this.catalog.set(res))
      .catch(() => this.catalogUnavailable.set(true));

    try {
      const res = await firstValueFrom(this.api.search(query));
      this.searchId.set(res.searchId);
      this.errors.set(res.errors ?? []);
      this.networkAvailable.set(res.networkAvailable ?? false);
      this.search.setNetworkState(res.networkAvailable ? 'searching' : 'complete');
      if (res.networkAvailable) this.startPoll();
    } catch (err) {
      this.searchError.set(err instanceof Error ? err.message : 'Search failed');
    } finally {
      await catalogPromise;
      // Collapse the raw-search fallback when we have metadata hits; otherwise
      // (no hits, or Lidarr unavailable) open it so the user always has a path.
      this.directSearchOpen.set(!this.hasCatalog());
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
