import { Component, inject, signal, computed, effect, OnInit, OnDestroy } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { ApiService } from '../../services/api.service';
import { SearchService, type NetworkResult } from '../../services/search.service';
import { TransferService } from '../../services/transfer.service';
import { getSingleDownloadLabel, getFolderDownloadLabel, isPathEffectivelyQueued, BUTTON_CLASSES } from '../../lib/download-status';
import { groupByDirectory, type FolderGroup } from '../../lib/folder-utils';
import { FolderBrowserComponent } from '../../components/folder-browser/folder-browser.component';

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

const ALLOWED_EXTENSIONS = ['.mp3', '.ogg'];

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
      if (!ALLOWED_EXTENSIONS.includes(ext)) continue;
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
  return escapeHtml(text).replace(pattern, '<mark class="rounded bg-amber-400/20 px-0.5 text-zinc-100">$1</mark>');
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ─── Component ──────────────────────────────────────────────────────

@Component({
  selector: 'app-search',
  imports: [FormsModule, FolderBrowserComponent],
  template: `
    <div class="max-w-6xl mx-auto px-3 py-4 md:px-6 md:py-8">
      <!-- Search bar -->
      <form (submit)="handleSearch($event)" class="mb-4">
        <div class="relative">
          <input
            type="text"
            [ngModel]="search.query()"
            (ngModelChange)="search.setQuery($event)"
            (focus)="searchFocused.set(true)"
            (blur)="onSearchBlur()"
            placeholder="Search for music..."
            class="w-full px-5 py-4 text-lg rounded-xl bg-zinc-900 border border-zinc-800 text-zinc-100 placeholder-zinc-500 focus:outline-none focus:border-zinc-600 transition"
          />
          <button
            type="submit"
            [disabled]="loading()"
            class="absolute right-3 top-1/2 -translate-y-1/2 px-4 py-2 rounded-lg bg-zinc-700 text-zinc-200 text-sm font-medium hover:bg-zinc-600 transition disabled:opacity-50">
            {{ loading() ? 'Searching...' : 'Search' }}
          </button>

          @if (searchFocused() && search.history().length > 0 && !search.query()) {
            <div class="absolute top-full left-0 right-0 mt-1 bg-zinc-900 border border-zinc-800 rounded-xl overflow-hidden z-10">
              <div class="flex items-center justify-between px-4 py-2 border-b border-zinc-800">
                <span class="text-xs text-zinc-500 font-medium">Recent searches</span>
                <button (click)="search.clearHistory()" class="text-xs text-zinc-600 hover:text-zinc-400 transition">Clear all</button>
              </div>
              @for (h of search.history(); track h) {
                <button
                  (click)="navigateAndSearch(h)"
                  class="w-full text-left px-4 py-2.5 text-sm text-zinc-300 hover:bg-zinc-800 transition">
                  {{ h }}
                </button>
              }
            </div>
          }
        </div>
      </form>

      <!-- Network status indicator -->
      @if (networkConnected() !== null) {
        <div class="flex items-center gap-2 mb-6">
          <span [class]="'inline-block w-2 h-2 rounded-full ' + (networkConnected() ? 'bg-emerald-500' : 'bg-zinc-600')"></span>
          <span class="text-xs text-zinc-500">
            {{ networkConnected() ? 'Soulseek network available' : 'Soulseek unavailable' }}
          </span>
        </div>
      }

      <!-- Errors -->
      @if (searchError()) {
        <div class="mb-6 px-4 py-3 rounded-lg bg-red-950/50 border border-red-900/50">
          <p class="text-sm text-red-400">{{ searchError() }}</p>
        </div>
      }
      @if (downloadError()) {
        <div class="mb-6 px-4 py-3 rounded-lg bg-red-950/50 border border-red-900/50 flex items-center justify-between">
          <p class="text-sm text-red-400">{{ downloadError() }}</p>
          <button (click)="downloadError.set(null)" class="text-red-500 hover:text-red-300 text-lg font-medium">×</button>
        </div>
      }
      @if (errors().length > 0) {
        <div class="mb-6 px-4 py-3 rounded-lg bg-amber-950/50 border border-amber-900/50 space-y-1">
          @for (err of errors(); track $index) {
            <p class="text-sm text-amber-400">{{ err }}</p>
          }
        </div>
      }

      <!-- Loading spinner -->
      @if (loading()) {
        <div class="text-center py-12">
          <span class="inline-block w-5 h-5 border-2 border-zinc-600 border-t-zinc-300 rounded-full animate-spin"></span>
          <p class="text-zinc-500 text-sm mt-3">Searching...</p>
        </div>
      }

      <!-- No results -->
      @if (!loading() && !hasNetwork() && search.networkState() === 'complete' && search.query().trim()) {
        <div class="text-center py-12">
          <p class="text-zinc-500">No results found for "{{ search.query() }}"</p>
        </div>
      }

      <!-- Searching indicator -->
      @if (search.networkState() === 'searching' && !loading()) {
        <div class="flex items-center gap-2 px-1 py-2 text-xs text-zinc-500">
          <span class="inline-block w-3 h-3 border-2 border-zinc-600 border-t-zinc-300 rounded-full animate-spin"></span>
          Searching Soulseek...
          @if (flatNetwork().length > 0) {
            <span>{{ flatNetwork().length }} tracks</span>
          }
          <button (click)="handleStopSearch()" class="text-zinc-500 hover:text-zinc-300 transition">Stop</button>
        </div>
      }

      <!-- Network results -->
      @if (hasNetwork()) {
        <section>
          <div class="flex items-center justify-between mb-3">
            <div class="flex items-center gap-2">
              <button (click)="viewMode.set('tracks')"
                [class]="'px-3 py-1 rounded-md text-xs font-medium transition ' + (viewMode() === 'tracks' ? 'bg-zinc-700 text-zinc-200' : 'text-zinc-500 hover:text-zinc-300')">
                Tracks
              </button>
              <button (click)="viewMode.set('folders')"
                [class]="'px-3 py-1 rounded-md text-xs font-medium transition ' + (viewMode() === 'folders' ? 'bg-zinc-700 text-zinc-200' : 'text-zinc-500 hover:text-zinc-300')">
                Folders
              </button>
            </div>
            @if (viewMode() === 'tracks' && hasNetwork()) {
              <button (click)="downloadAll()"
                class="px-3 py-1 rounded-md text-xs font-medium bg-zinc-800 text-zinc-300 hover:bg-zinc-700 transition">
                Download all ({{ flatNetwork().length }})
              </button>
            }
          </div>

          <!-- Tracks view -->
          @if (viewMode() === 'tracks') {
            @for (file of flatNetwork(); track file.username + ':' + file.filename) {
              <div class="relative flex items-center gap-3 px-3 py-2.5 rounded-lg overflow-hidden transition"
                style="background: var(--theme-surface)">
                @if (getFileVariant(file) === 'progress') {
                  <div class="absolute inset-0 pointer-events-none rounded-lg transition-all duration-500"
                    [style.width.%]="getFilePercent(file)"
                    style="background: var(--theme-status-progress-bg)"></div>
                }
                @if (getFileVariant(file) === 'done') {
                  <div class="absolute inset-0 pointer-events-none rounded-lg"
                    style="background: var(--theme-status-done-bg)"></div>
                }

                <div class="relative flex-1 min-w-0">
                  <div class="flex items-start gap-3">
                    <div class="min-w-0 flex-1">
                      <p class="text-sm truncate" style="color: var(--theme-text-primary)"
                        [innerHTML]="highlightTitle(file)"></p>
                      @if (getSubtitle(file)) {
                        <p class="text-xs truncate" style="color: var(--theme-text-secondary)"
                          [innerHTML]="highlightSubtitle(file)"></p>
                      }
                    </div>
                    @if (file.length) {
                      <span class="shrink-0 pt-0.5 text-xs" style="color: var(--theme-text-muted)">
                        {{ formatDuration(file.length) }}
                      </span>
                    }
                  </div>
                  <p class="mt-1 text-xs truncate" style="color: var(--theme-text-muted)">
                    {{ file.bitRate ? file.bitRate + ' kbps' : 'Unknown bitrate' }}
                    · {{ formatSize(file.size) }}
                    · <span style="color: var(--theme-accent)">{{ formatSpeed(file.uploadSpeed) }}</span>
                    @if (file.queueLength != null && file.queueLength > 0) {
                      <span> · {{ file.queueLength }} queued</span>
                    }
                  </p>
                </div>

                <div class="relative flex items-center gap-1.5 shrink-0">
                  @if (getFileVariant(file) === 'done') {
                    <button (click)="router.navigate(['/library'])"
                      class="px-3 py-1 rounded-md text-xs font-semibold transition"
                      style="background: var(--theme-status-done-bg); color: var(--theme-status-done-text)">
                      ▶ Open in Library
                    </button>
                  } @else {
                    <button
                      (click)="handleDownload(file.username, { filename: file.filename, size: file.size })"
                      [disabled]="getFileBtn(file).disabled"
                      [class]="'px-3 py-1 rounded-md text-xs font-medium transition ' + (getFileBtn(file).disabled ? 'cursor-default' : '')"
                      [style]="getFileVariant(file) === 'progress' ? 'background: var(--theme-status-progress-bg); color: var(--theme-status-progress-text)' : ''">
                      {{ getFileVariant(file) === 'progress' ? getFileBtn(file).label : 'Download' }}
                    </button>
                  }
                </div>
              </div>
            }
          }

          <!-- Folders view -->
          @if (viewMode() === 'folders') {
            @for (group of folderGroups(); track group.username + '::' + group.directory) {
              <div class="mb-1">
                <div class="flex items-center gap-2 px-3 py-2 rounded-lg hover:bg-zinc-800/50 transition">
                  <div class="flex-1 min-w-0">
                    <p class="text-sm text-zinc-300 truncate">
                      <span class="cursor-pointer hover:underline hover:text-zinc-100 transition"
                        (click)="navigateAndSearch(getDirBasename(group))">
                        {{ getDirBasename(group) }}
                      </span>
                    </p>
                    <p class="text-xs text-zinc-600 truncate">
                      {{ group.username }}
                      {{ group.bitRate ? ' · ' + group.bitRate + ' kbps' : '' }}
                      · {{ group.files.length }} files
                    </p>
                  </div>
                  <button
                    (click)="downloadFolder(group)"
                    [disabled]="getFolderBtn(group).disabled || getFolderValidFiles(group).length === 0"
                    [class]="'px-2 py-1 rounded text-xs font-medium transition shrink-0 ' + btnClasses[getFolderBtn(group).variant] + (getFolderBtn(group).disabled ? ' cursor-default' : '')">
                    {{ getFolderBtn(group).label }}
                  </button>
                  @if (search.canBrowse()) {
                    <button
                      (click)="toggleBrowser(group.username + '::' + group.directory)"
                      class="px-2 py-1 rounded text-xs text-zinc-500 hover:text-zinc-300 transition shrink-0">
                      {{ openBrowserKey() === group.username + '::' + group.directory ? 'Close' : 'Browse library' }}
                    </button>
                  }
                </div>
                @if (openBrowserKey() === group.username + '::' + group.directory) {
                  <div class="mx-3 mb-2">
                    <app-folder-browser
                      [username]="group.username"
                      [matchedPath]="group.directory"
                      [fallbackFiles]="getFolderBrowseFiles(group)"
                      (download)="handleBrowserDownload(group.username, group.directory, $event)"
                      (downloadTrack)="handleDownload($event.username, $event.file)"
                    />
                  </div>
                }
              </div>
            }
          }
        </section>
      }

      <!-- Empty state -->
      @if (search.networkState() === 'idle' && !loading()) {
        <div class="text-center py-20">
          <p class="text-zinc-600 text-lg">Search for music to get started</p>
          <p class="text-zinc-700 text-sm mt-1">
            Results from the Soulseek network will appear here
          </p>
        </div>
      }
    </div>
  `,
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

  // Ephemeral state
  readonly loading = signal(false);
  readonly searchId = signal<string | null>(null);
  readonly errors = signal<string[]>([]);
  readonly networkAvailable = signal(true);
  readonly networkConnected = signal<boolean | null>(null);
  readonly searchError = signal<string | null>(null);
  readonly downloadError = signal<string | null>(null);
  readonly viewMode = signal<'tracks' | 'folders'>('tracks');
  readonly openBrowserKey = signal<string | null>(null);
  readonly searchFocused = signal(false);

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

  toggleBrowser(key: string): void {
    this.openBrowserKey.update(k => k === key ? null : key);
  }

  // ─── Template helpers ───────────────────────────────────────────

  getFileBtn(file: FlatFile) {
    const key = `${file.username}:${file.filename}`;
    return getSingleDownloadLabel(
      file.username,
      file.filename,
      this.search.downloading().has(key),
      (u, f) => this.transfers.getStatus(u, f),
    );
  }

  getFileVariant(file: FlatFile) {
    return this.getFileBtn(file).variant;
  }

  getFilePercent(file: FlatFile) {
    const entry = this.transfers.getStatus(file.username, file.filename);
    return entry?.percent ?? 0;
  }

  getSubtitle(file: FlatFile) {
    return getDisplaySubtitle(file);
  }

  highlightTitle(file: FlatFile): string {
    return highlightHtml(getDisplayTitle(file), this.highlightTerms());
  }

  highlightSubtitle(file: FlatFile): string {
    return highlightHtml(getDisplaySubtitle(file), this.highlightTerms());
  }

  getDirBasename(group: FolderGroup): string {
    return group.directory.split(/[\\/]/).at(-1) ?? group.directory;
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
    this.networkAvailable.set(true);

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
