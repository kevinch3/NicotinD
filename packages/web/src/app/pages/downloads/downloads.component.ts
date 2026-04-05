import { Component, inject, signal, computed, effect, OnInit, OnDestroy } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { ApiService, type Song, type Playlist } from '../../services/api.service';
import { PlayerService, type Track } from '../../services/player.service';
import { TransferService } from '../../services/transfer.service';
import { ListControlsService, type SortOption } from '../../services/list-controls.service';
import { ListToolbarComponent } from '../../components/list-toolbar/list-toolbar.component';
import type { SlskdUserTransferGroup } from '@nicotind/core';

// ─── Types ──────────────────────────────────────────────────────────

interface AlbumGroup {
  key: string;
  name: string;
  username: string;
  fileIds: string[];
  totalFiles: number;
  completedFiles: number;
  overallPercent: number;
  state: 'downloading' | 'queued' | 'done' | 'error';
}

interface PlaylistOption {
  id: string;
  name: string;
  songCount: number;
}

type NormState = 'pending' | 'running' | 'fixed' | 'skipped' | 'failed';

type DateGroup = 'Today' | 'Yesterday' | 'This week' | 'Older';

interface SongDateGroup {
  label: DateGroup;
  songs: Song[];
}

// ─── Helpers ────────────────────────────────────────────────────────

function extractAlbumName(directory: string): string {
  const segments = directory.split('\\').filter(Boolean);
  return segments[segments.length - 1] ?? directory;
}

function groupByAlbum(downloads: SlskdUserTransferGroup[]): AlbumGroup[] {
  const groups: AlbumGroup[] = [];
  for (const transfer of downloads) {
    for (const dir of transfer.directories) {
      const name = extractAlbumName(dir.directory);
      const key = `${transfer.username}:${dir.directory}`;
      const files = dir.files;
      const completed = files.filter(f => f.state.includes('Succeeded')).length;
      const active = files.filter(f => f.state === 'InProgress').length;
      const errored = files.filter(f => f.state.includes('Errored') || f.state.includes('Cancelled')).length;
      const totalBytes = files.reduce((s, f) => s + f.size, 0);
      const transferredBytes = files.reduce((s, f) => s + f.bytesTransferred, 0);
      const overallPercent = totalBytes > 0 ? Math.round((transferredBytes / totalBytes) * 100) : 0;

      let state: AlbumGroup['state'] = 'queued';
      if (completed === files.length) state = 'done';
      else if (active > 0) state = 'downloading';
      else if (errored > 0 && completed + errored === files.length) state = 'error';

      groups.push({ key, name, username: transfer.username, fileIds: files.map(f => f.id), totalFiles: files.length, completedFiles: completed, overallPercent, state });
    }
  }
  const order: Record<string, number> = { downloading: 0, queued: 1, error: 2, done: 3 };
  return groups.sort((a, b) => order[a.state] - order[b.state]);
}

function formatDuration(seconds?: number) {
  if (!seconds) return '';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function formatSize(bytes: number) {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'Yesterday';
  return `${days}d ago`;
}

function groupRecentSongsByDate(songs: Song[]): SongDateGroup[] {
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterdayStart = new Date(todayStart.getTime() - 86_400_000);
  const weekStart = new Date(todayStart.getTime() - 6 * 86_400_000);

  const buckets: Record<DateGroup, Song[]> = { 'Today': [], 'Yesterday': [], 'This week': [], 'Older': [] };
  for (const song of songs) {
    const d = new Date(song.created).getTime();
    if (d >= todayStart.getTime()) buckets['Today'].push(song);
    else if (d >= yesterdayStart.getTime()) buckets['Yesterday'].push(song);
    else if (d >= weekStart.getTime()) buckets['This week'].push(song);
    else buckets['Older'].push(song);
  }

  const order: DateGroup[] = ['Today', 'Yesterday', 'This week', 'Older'];
  return order.filter(label => buckets[label].length > 0).map(label => ({ label, songs: buckets[label] }));
}

// ─── Component ──────────────────────────────────────────────────────

@Component({
  selector: 'app-downloads',
  imports: [NgTemplateOutlet, FormsModule, ListToolbarComponent],
  template: `
    <div class="max-w-5xl mx-auto px-4 py-5 md:px-6 md:py-8">
      <!-- Header -->
      <div class="flex items-center justify-between gap-3 mb-6 flex-wrap">
        <h1 class="text-lg font-semibold text-theme-primary">Downloads</h1>
        <div class="flex items-center gap-2">
          <button (click)="triggerScan()" [disabled]="scanning()"
            class="inline-flex items-center gap-2 rounded-full border border-theme bg-theme-base/40 px-3 py-1.5 text-xs font-medium text-theme-muted transition hover:border-theme hover:text-theme-secondary disabled:cursor-wait disabled:opacity-50"
            title="Trigger a library rescan">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
              [class]="scanning() ? 'animate-spin' : ''">
              <path d="M21 12a9 9 0 1 1-3-6.7" /><polyline points="21 3 21 9 15 9" />
            </svg>
            <span>{{ scanning() ? 'Scanning' : 'Scan library' }}</span>
          </button>
          @if (recentSongs().length > 0) {
            <button (click)="handlePlayAll()"
              class="px-4 py-1.5 rounded-lg bg-theme-surface-2 text-theme-secondary text-sm font-medium hover:bg-theme-hover transition">
              {{ selected().size > 0 ? 'Play ' + selected().size + ' selected' : 'Play all' }}
            </button>
          }
        </div>
      </div>

      <!-- Active Downloads -->
      @if (inProgressGroups().length > 0 || errorGroups().length > 0 || doneGroups().length > 0) {
        <section class="mb-8">
          <div class="flex items-center justify-between mb-3">
            <h2 class="text-xs font-semibold uppercase tracking-wider text-theme-muted">
              Downloads
              @if (inProgressGroups().length > 0) {
                <span class="ml-2 text-blue-400 normal-case font-normal">
                  {{ inProgressGroups().length }} in progress
                </span>
              }
            </h2>
            <div class="flex items-center gap-3">
              @if (inProgressGroups().length > 0) {
                <button (click)="cancelAll()" class="text-xs text-red-500/70 hover:text-red-400 transition">Cancel all</button>
              }
              @if (clearableGroups().length > 0) {
                <button (click)="clearAllFinished()" class="text-xs text-theme-muted hover:text-theme-secondary transition">Clear all finished</button>
              }
            </div>
          </div>
          <div class="grid gap-2">
            <!-- In progress -->
            @for (group of inProgressGroups(); track group.key) {
              <div class="flex items-center gap-3 md:gap-4 px-3 md:px-4 py-3 rounded-lg bg-theme-surface/50 border border-theme min-w-0">
                <div class="flex-1 min-w-0">
                  <p class="text-sm text-theme-primary truncate w-full">{{ group.name }}</p>
                  <p class="text-xs text-theme-muted mt-0.5 truncate w-full">{{ group.completedFiles }} of {{ group.totalFiles }} tracks</p>
                </div>
                <div class="w-20 md:w-32 flex-shrink-0">
                  @if (group.state === 'downloading') {
                    <div class="space-y-1">
                      <div class="h-1.5 bg-theme-surface-2 rounded-full overflow-hidden">
                        <div class="h-full bg-blue-500 rounded-full transition-all duration-500" [style.width.%]="group.overallPercent"></div>
                      </div>
                      <p class="text-xs text-blue-400 text-right">{{ group.overallPercent }}%</p>
                    </div>
                  } @else {
                    <p class="text-xs text-right font-medium text-theme-muted">Queued</p>
                  }
                </div>
                <button (click)="clearGroup(group)" class="text-xs text-theme-muted hover:text-theme-secondary transition flex-shrink-0" title="Cancel">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </button>
              </div>
            }
            <!-- Errored -->
            @for (group of errorGroups(); track group.key) {
              <div class="flex items-center gap-3 md:gap-4 px-3 md:px-4 py-3 rounded-lg bg-theme-surface/30 border border-red-900/20 min-w-0">
                <div class="flex-1 min-w-0">
                  <p class="text-sm text-theme-secondary truncate w-full">{{ group.name }}</p>
                  <p class="text-xs text-theme-muted mt-0.5 truncate w-full">{{ group.completedFiles }} of {{ group.totalFiles }} tracks</p>
                </div>
                <p class="text-xs text-red-400/70 font-medium flex-shrink-0">Error</p>
                <button (click)="clearGroup(group)" class="text-xs text-theme-muted hover:text-theme-secondary transition flex-shrink-0" title="Dismiss">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </button>
              </div>
            }
            <!-- Done -->
            @for (group of doneGroups(); track group.key) {
              <div class="flex items-center gap-3 md:gap-4 px-3 md:px-4 py-3 rounded-lg bg-theme-surface/40 border border-theme opacity-80 min-w-0">
                <div class="flex-1 min-w-0">
                  <p class="text-sm text-theme-secondary truncate w-full">{{ group.name }}</p>
                  <p class="text-xs text-theme-muted mt-0.5 truncate w-full">{{ group.totalFiles }} tracks</p>
                </div>
                <p class="text-xs text-emerald-400/70 font-medium flex-shrink-0">Done</p>
                <button (click)="clearGroup(group)" class="text-xs text-theme-muted hover:text-theme-secondary transition flex-shrink-0" title="Dismiss">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </button>
              </div>
            }
          </div>
        </section>
      }

      <!-- TODO: Preserved section (Phase 5 — PreserveService) -->

      <!-- Recently Added -->
      <section>
        <div class="flex items-center justify-between mb-3">
          <div class="flex items-center gap-2">
            <h2 class="text-xs font-semibold uppercase tracking-wider text-theme-muted">
              Recently Added
              @if (recentSongs().length > 0) {
                <span class="font-normal normal-case ml-1.5 text-theme-muted">({{ recentSongs().length }})</span>
              }
            </h2>
            @if (recentSongs().length > 0) {
              <button (click)="recentControls.showToolbar()" class="p-1 text-theme-muted hover:text-theme-secondary transition" title="Search (Ctrl+F)">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" /></svg>
              </button>
            }
          </div>
          @if (recentSongs().length > 0) {
            <button (click)="selectAll()" class="text-xs text-theme-muted hover:text-theme-secondary transition">
              {{ selected().size === recentControls.filtered().length ? 'Deselect all' : 'Select all' }}
            </button>
          }
        </div>

        @if (recentControls.isToolbarVisible()) {
          <app-list-toolbar
            [searchText]="recentControls.searchText()"
            [sortField]="recentControls.sortField()"
            [sortDirection]="recentControls.sortDirection()"
            [sortOptions]="recentSortOptions"
            [resultCount]="recentControls.filtered().length"
            (searchChange)="recentControls.setSearchText($event)"
            (sortFieldChange)="recentControls.setSortField($event)"
            (toggleDirection)="recentControls.toggleSortDirection()"
            (dismiss)="recentControls.hideToolbar()"
          />
        }

        <!-- Bulk action bar -->
        @if (selected().size > 0) {
          <div class="flex flex-wrap items-center gap-2 md:gap-3 px-3 md:px-4 py-2.5 mb-3 rounded-lg bg-theme-surface-2/60 border border-theme">
            <span class="text-sm text-theme-secondary font-medium">{{ selected().size }} selected</span>
            <div class="flex-1 min-w-0"></div>

            @if (showPlaylistPicker()) {
              <div class="flex flex-wrap items-center gap-2 w-full md:w-auto">
                <span class="text-xs text-theme-secondary flex-shrink-0">Add to:</span>
                <div class="flex gap-1.5 flex-wrap">
                  @for (pl of playlists(); track pl.id) {
                    <button (click)="addToPlaylist(pl.id)" [disabled]="addingToPlaylist()"
                      class="px-2.5 py-1 rounded-md text-xs bg-theme-hover text-theme-secondary hover:bg-theme-hover transition disabled:opacity-50">
                      {{ pl.name }}
                    </button>
                  }
                </div>
                <div class="flex gap-1.5 w-full md:w-auto">
                  <input type="text" [ngModel]="newPlaylistName()" (ngModelChange)="newPlaylistName.set($event)"
                    placeholder="New playlist..."
                    class="flex-1 md:w-36 md:flex-none px-2.5 py-1 text-xs rounded-md bg-theme-surface border border-theme text-theme-primary placeholder-zinc-600 focus:outline-none focus:border-zinc-500"
                    (keydown.enter)="createAndAdd()" />
                  <button (click)="createAndAdd()" [disabled]="!newPlaylistName().trim() || addingToPlaylist()"
                    class="px-2.5 py-1 rounded-md text-xs font-medium bg-zinc-100 text-zinc-900 hover:bg-zinc-200 transition disabled:opacity-40">
                    Create
                  </button>
                </div>
                <button (click)="showPlaylistPicker.set(false)" class="text-xs text-theme-muted hover:text-theme-secondary">Cancel</button>
              </div>
            } @else {
              <button (click)="openPlaylistPicker()"
                class="px-3 py-1.5 rounded-md text-xs font-medium bg-theme-hover text-theme-primary hover:bg-theme-hover transition">
                Add to playlist
              </button>
              <button (click)="normalizeSelected()" [disabled]="normalizing()"
                class="px-3 py-1.5 rounded-md text-xs font-medium bg-theme-hover text-theme-primary hover:bg-theme-hover transition disabled:opacity-50 disabled:cursor-wait">
                {{ normalizing() ? 'Normalizing…' : 'Normalize metadata' }}
              </button>
              <button (click)="handleDelete(selectedArray())"
                class="px-3 py-1.5 rounded-md text-xs font-medium bg-theme-hover text-red-400 hover:bg-red-500/20 transition">
                Delete
              </button>
            }
          </div>
        }

        <!-- Song list -->
        @if (recentSongs().length === 0 && groups().length === 0) {
          <p class="text-center text-theme-muted text-sm py-20">
            No recent downloads. Search for music and start downloading!
          </p>
        }
        @if (recentSongs().length === 0 && groups().length > 0) {
          <p class="text-center text-theme-muted text-sm py-12">
            New songs will appear here after downloads complete and library rescans.
          </p>
        }
        @if (recentSongs().length > 0) {
          <div class="space-y-4">
            @if (showDateGroups()) {
              @for (group of dateGroups(); track group.label) {
                <div>
                  <div class="px-1.5 md:px-0 mb-1">
                    <span class="text-xs font-semibold uppercase tracking-wider text-theme-muted">{{ group.label }}</span>
                  </div>
                  <div class="space-y-0.5">
                    @for (song of group.songs; track song.id) {
                      <ng-container *ngTemplateOutlet="songRow; context: { $implicit: song }"></ng-container>
                    }
                  </div>
                </div>
              }
            } @else {
              <div class="space-y-0.5">
                @for (song of recentControls.filtered(); track song.id) {
                  <ng-container *ngTemplateOutlet="songRow; context: { $implicit: song }"></ng-container>
                }
              </div>
            }
          </div>
        }

        <!-- Song row template -->
        <ng-template #songRow let-song>
          <div [class]="'flex items-center gap-1.5 md:gap-3 px-1.5 md:px-4 py-2.5 rounded-lg transition group '
            + (isSelected(song.id) ? 'bg-theme-surface-2/60 border border-theme' : 'hover:bg-theme-surface-2/30 border border-transparent')
            + (deleting().has(song.id) ? ' opacity-40 pointer-events-none' : '')">
            <!-- Checkbox -->
            <button (click)="toggleSelect(song.id)"
              [class]="'w-4.5 h-4.5 rounded border flex-shrink-0 flex items-center justify-center transition '
                + (isSelected(song.id) ? 'bg-blue-500 border-blue-500' : 'border-theme hover:border-zinc-500')">
              @if (isSelected(song.id)) {
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              }
            </button>

            <!-- Song info -->
            <div class="flex-1 min-w-0">
              <p class="text-sm text-theme-primary truncate">{{ song.title }}</p>
              <p class="text-xs text-theme-muted truncate">
                <span class="cursor-pointer hover:underline hover:text-theme-secondary transition" (click)="navigateAndSearch(song.artist)">{{ song.artist }}</span>
                &middot; {{ song.album }}
              </p>
            </div>

            <!-- Metadata -->
            <span class="hidden md:inline text-xs text-theme-muted flex-shrink-0 w-12 text-right">{{ song.bitRate ? song.bitRate + 'k' : '' }}</span>
            <span class="hidden md:inline text-xs text-theme-muted flex-shrink-0 w-14 text-right">{{ formatSize(song.size) }}</span>
            <span class="text-xs text-theme-muted flex-shrink-0 w-12 text-right">{{ formatDuration(song.duration) }}</span>
            <span class="hidden lg:inline text-xs text-theme-muted flex-shrink-0 w-20 text-right">{{ timeAgo(song.created) }}</span>

            <!-- Normalization status -->
            @if (normStatus().has(song.id)) {
              <span class="flex-shrink-0 w-5 flex items-center justify-center">
                @switch (normStatus().get(song.id)) {
                  @case ('pending') { <span class="w-1.5 h-1.5 rounded-full bg-theme-muted"></span> }
                  @case ('running') {
                    <svg class="animate-spin text-theme-secondary" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                      <path d="M21 12a9 9 0 1 1-3-6.7" /><polyline points="21 3 21 9 15 9" />
                    </svg>
                  }
                  @case ('fixed') {
                    <svg class="text-emerald-400" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                  }
                  @case ('skipped') { <span class="text-theme-muted text-xs leading-none">—</span> }
                  @case ('failed') {
                    <svg class="text-red-400/70" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                      <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                    </svg>
                  }
                }
              </span>
            }

            <!-- Play -->
            <button (click)="handlePlay(song)" class="p-1.5 text-theme-muted hover:text-theme-secondary transition flex-shrink-0 md:opacity-0 md:group-hover:opacity-100" title="Play">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="5,3 19,12 5,21" /></svg>
            </button>

            <!-- Delete -->
            <button (click)="handleDelete([song.id])" class="p-1.5 text-theme-muted hover:text-red-400 transition flex-shrink-0 md:opacity-0 md:group-hover:opacity-100" title="Delete from library">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="3 6 5 6 21 6" /><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" />
              </svg>
            </button>
          </div>
        </ng-template>
      </section>
    </div>
  `,
})
export class DownloadsComponent implements OnInit, OnDestroy {
  private api = inject(ApiService);
  private player = inject(PlayerService);
  private transferService = inject(TransferService);
  private listControls = inject(ListControlsService);
  private router = inject(Router);

  readonly formatDuration = formatDuration;
  readonly formatSize = formatSize;
  readonly timeAgo = timeAgo;

  // State
  readonly recentSongs = signal<Song[]>([]);
  readonly selected = signal(new Set<string>());
  readonly deleting = signal(new Set<string>());
  readonly scanning = signal(false);
  readonly showPlaylistPicker = signal(false);
  readonly playlists = signal<PlaylistOption[]>([]);
  readonly newPlaylistName = signal('');
  readonly addingToPlaylist = signal(false);
  readonly normStatus = signal(new Map<string, NormState>());
  readonly normalizing = signal(false);

  private prevHadActive = false;

  // List controls for Recently Added
  readonly recentSortOptions: SortOption[] = [
    { field: 'created', label: 'Date added' },
    { field: 'title', label: 'Title' },
    { field: 'artist', label: 'Artist' },
  ];

  readonly recentControls = this.listControls.connect({
    pageKey: 'downloads-recent',
    items: this.recentSongs,
    searchFields: ['title', 'artist', 'album'] as const,
    sortOptions: this.recentSortOptions,
    defaultSort: 'created',
    defaultDirection: 'desc',
  });

  // Computed
  readonly groups = computed(() => groupByAlbum(this.transferService.downloads()));
  readonly inProgressGroups = computed(() => this.groups().filter(g => g.state === 'downloading' || g.state === 'queued'));
  readonly errorGroups = computed(() => this.groups().filter(g => g.state === 'error'));
  readonly doneGroups = computed(() => this.groups().filter(g => g.state === 'done'));
  readonly clearableGroups = computed(() => [...this.errorGroups(), ...this.doneGroups()]);

  readonly showDateGroups = computed(() =>
    this.recentControls.sortField() === 'created' &&
    this.recentControls.sortDirection() === 'desc' &&
    !this.recentControls.searchText(),
  );

  readonly dateGroups = computed(() => groupRecentSongsByDate(this.recentControls.filtered()));

  readonly selectedArray = computed(() => Array.from(this.selected()));

  // Auto-refresh when active downloads complete
  private completionEffect = effect(() => {
    const hasActive = this.inProgressGroups().length > 0;
    if (this.prevHadActive && !hasActive) {
      setTimeout(() => this.fetchRecentSongs(), 5000);
    }
    this.prevHadActive = hasActive;
  });

  ngOnInit(): void {
    this.fetchRecentSongs();
  }

  ngOnDestroy(): void {}

  isSelected(id: string): boolean {
    return this.selected().has(id);
  }

  toggleSelect(id: string): void {
    this.selected.update(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  selectAll(): void {
    const visible = this.recentControls.filtered();
    if (this.selected().size === visible.length) {
      this.selected.set(new Set());
    } else {
      this.selected.set(new Set(visible.map(s => s.id)));
    }
  }

  handlePlay(song: Song): void {
    const track: Track = {
      id: song.id,
      title: song.title,
      artist: song.artist,
      album: song.album,
      coverArt: song.coverArt,
      duration: song.duration,
    };
    this.player.play(track);
  }

  handlePlayAll(): void {
    const songs = this.selected().size > 0
      ? this.recentSongs().filter(s => this.selected().has(s.id))
      : this.recentSongs();
    if (!songs.length) return;
    const tracks = songs.map((s): Track => ({
      id: s.id,
      title: s.title,
      artist: s.artist,
      album: s.album,
      coverArt: s.coverArt,
      duration: s.duration,
    }));
    this.player.play(tracks[0]);
    tracks.slice(1).forEach(t => this.player.addToQueue(t));
  }

  async handleDelete(songIds: string[]): Promise<void> {
    this.deleting.update(prev => {
      const next = new Set(prev);
      songIds.forEach(id => next.add(id));
      return next;
    });
    for (const id of songIds) {
      try {
        await firstValueFrom(this.api.deleteSong(id));
        this.recentSongs.update(prev => prev.filter(s => s.id !== id));
        this.selected.update(prev => { const n = new Set(prev); n.delete(id); return n; });
      } catch { /* ignore */ }
    }
    this.deleting.update(prev => {
      const next = new Set(prev);
      songIds.forEach(id => next.delete(id));
      return next;
    });
  }

  async clearGroup(group: AlbumGroup): Promise<void> {
    for (const fileId of group.fileIds) {
      try { await firstValueFrom(this.api.cancelDownload(group.username, fileId)); } catch { /* may already be gone */ }
    }
    this.transferService.poll();
  }

  async clearAllFinished(): Promise<void> {
    for (const group of this.clearableGroups()) {
      for (const fileId of group.fileIds) {
        try { await firstValueFrom(this.api.cancelDownload(group.username, fileId)); } catch { /* ignore */ }
      }
    }
    this.transferService.poll();
  }

  async cancelAll(): Promise<void> {
    try { await firstValueFrom(this.api.cancelAllDownloads()); } catch { /* ignore */ }
    this.transferService.poll();
  }

  async triggerScan(): Promise<void> {
    if (this.scanning()) return;
    this.scanning.set(true);
    try {
      await firstValueFrom(this.api.triggerScan());
      setTimeout(() => this.fetchRecentSongs(), 5000);
    } catch { /* ignore */ }
    finally { this.scanning.set(false); }
  }

  async openPlaylistPicker(): Promise<void> {
    this.showPlaylistPicker.set(true);
    try {
      const data = await firstValueFrom(this.api.getPlaylists());
      this.playlists.set(data);
    } catch { /* ignore */ }
  }

  async addToPlaylist(playlistId: string): Promise<void> {
    const songIds = Array.from(this.selected());
    this.addingToPlaylist.set(true);
    try {
      await firstValueFrom(this.api.updatePlaylist(playlistId, { songIdsToAdd: songIds }));
      this.selected.set(new Set());
      this.showPlaylistPicker.set(false);
    } catch { /* ignore */ }
    finally { this.addingToPlaylist.set(false); }
  }

  async createAndAdd(): Promise<void> {
    if (!this.newPlaylistName().trim()) return;
    const songIds = Array.from(this.selected());
    this.addingToPlaylist.set(true);
    try {
      await firstValueFrom(this.api.createPlaylist(this.newPlaylistName().trim(), songIds));
      this.selected.set(new Set());
      this.showPlaylistPicker.set(false);
      this.newPlaylistName.set('');
    } catch { /* ignore */ }
    finally { this.addingToPlaylist.set(false); }
  }

  async normalizeSelected(): Promise<void> {
    const ids = Array.from(this.selected());
    this.normalizing.set(true);
    this.normStatus.set(new Map(ids.map(id => [id, 'pending' as NormState])));
    for (const id of ids) {
      this.normStatus.update(prev => new Map(prev).set(id, 'running'));
      try {
        const result = await firstValueFrom(this.api.fixSongMetadata(id));
        this.normStatus.update(prev => new Map(prev).set(id, result.fixed ? 'fixed' : 'skipped'));
      } catch {
        this.normStatus.update(prev => new Map(prev).set(id, 'failed'));
      }
    }
    this.normalizing.set(false);
    this.fetchRecentSongs();
  }

  navigateAndSearch(query: string): void {
    this.router.navigate(['/'], { queryParams: { q: query } });
  }

  private async fetchRecentSongs(): Promise<void> {
    try {
      const data = await firstValueFrom(this.api.getRecentSongs(50));
      this.recentSongs.set(data);
    } catch { /* ignore */ }
  }
}
