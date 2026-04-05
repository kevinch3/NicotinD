import { Component, inject, signal, computed, OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';
import { ApiService, type Playlist, type PlaylistDetail } from '../../services/api.service';
import { AuthService } from '../../services/auth.service';
import { PlayerService, type Track } from '../../services/player.service';
import { ListControlsService, type SortOption } from '../../services/list-controls.service';
import { ListToolbarComponent } from '../../components/list-toolbar/list-toolbar.component';
import { TrackRowComponent } from '../../components/track-row/track-row.component';
import { toTrack } from '../../lib/track-utils';

// Deterministic gradient from playlist name
const GRADIENTS = [
  'from-indigo-500 to-purple-600',
  'from-pink-500 to-rose-600',
  'from-teal-500 to-cyan-600',
  'from-amber-500 to-red-600',
  'from-emerald-500 to-teal-600',
  'from-blue-500 to-indigo-600',
  'from-violet-500 to-fuchsia-600',
  'from-orange-500 to-amber-600',
];

function gradientFor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = ((hash << 5) - hash + name.charCodeAt(i)) | 0;
  return GRADIENTS[Math.abs(hash) % GRADIENTS.length];
}

function formatTotalDuration(seconds: number) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const days = Math.floor(diff / 86_400_000);
  if (days === 0) return 'Added today';
  if (days === 1) return 'Added yesterday';
  if (days < 30) return `Added ${days} days ago`;
  return `Added ${new Date(dateStr).toLocaleDateString()}`;
}

interface DetailItem {
  id: string;
  title: string;
  artist: string;
  album: string;
  duration?: number;
  track?: number;
  coverArt?: string;
  _originalIndex: number;
}

@Component({
  selector: 'app-playlists',
  imports: [FormsModule, ListToolbarComponent, TrackRowComponent],
  template: `
    <!-- Detail view -->
    @if (selected()) {
      <div class="max-w-6xl mx-auto px-3 py-4 md:px-6 md:py-8">
        <button (click)="selected.set(null)"
          class="text-sm text-zinc-500 hover:text-zinc-300 transition mb-6">
          &larr; Back to playlists
        </button>

        <div class="flex flex-col sm:flex-row items-center sm:items-end gap-6 mb-8 text-center sm:text-left">
          @if (selected()!.coverArt) {
            <img [src]="'/api/cover/' + selected()!.coverArt + '?size=300&token=' + auth.token()"
              alt="" class="w-48 h-48 rounded-lg object-cover flex-shrink-0" />
          } @else {
            <div [class]="'w-48 h-48 rounded-lg bg-gradient-to-br ' + gradientFor(selected()!.name) + ' flex items-center justify-center flex-shrink-0'">
              <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="opacity-40">
                <path d="M9 18V5l12-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="18" cy="16" r="3" />
              </svg>
            </div>
          }
          <div class="flex flex-col justify-end">
            @if (editingName()) {
              <input autofocus
                [ngModel]="nameDraft()"
                (ngModelChange)="nameDraft.set($event)"
                (blur)="saveRename()"
                (keydown.enter)="saveRename()"
                (keydown.escape)="editingName.set(false)"
                class="text-2xl font-bold text-zinc-100 bg-transparent border-b border-zinc-600 focus:border-zinc-400 outline-none pb-0.5" />
            } @else {
              <h1 class="text-2xl font-bold text-zinc-100 cursor-pointer hover:text-zinc-300 transition"
                (click)="startRename()" title="Click to rename">
                {{ selected()!.name }}
              </h1>
            }
            <p class="text-zinc-400 mt-1">
              {{ selected()!.entry?.length ?? selected()!.songCount }} tracks · {{ formatTotalDuration(selected()!.duration) }}
            </p>
            <div class="flex justify-center sm:justify-start gap-3 mt-4">
              <button (click)="playAll()"
                class="px-5 py-2 rounded-lg bg-zinc-100 text-zinc-900 text-sm font-semibold hover:bg-zinc-200 transition">
                Play All
              </button>
              <!-- TODO: Preserve All (Phase 5) -->
              <button (click)="handleDelete()" [disabled]="deleting()"
                class="px-4 py-2 rounded-lg bg-zinc-800 text-zinc-400 text-sm font-medium hover:bg-zinc-700 hover:text-red-400 transition disabled:opacity-50">
                {{ deleting() ? 'Deleting...' : 'Delete' }}
              </button>
            </div>
          </div>
        </div>

        @if (detailControls.isToolbarVisible()) {
          <app-list-toolbar
            [searchText]="detailControls.searchText()"
            [sortField]="detailControls.sortField()"
            [sortDirection]="detailControls.sortDirection()"
            [sortOptions]="detailSortOptions"
            [resultCount]="detailControls.filtered().length"
            (searchChange)="detailControls.setSearchText($event)"
            (sortFieldChange)="detailControls.setSortField($event)"
            (toggleDirection)="detailControls.toggleSortDirection()"
            (dismiss)="detailControls.hideToolbar()"
          />
        }

        <div>
          @for (song of detailControls.filtered(); track song.id + '-' + song._originalIndex) {
            <app-track-row
              [track]="toTrackFromSong(song)"
              [indexLabel]="song.track ?? song._originalIndex + 1"
              [subtitle]="song.artist"
              [duration]="song.duration"
              [disabled]="removing().has(song._originalIndex)"
              [showRemove]="true"
              (play)="playSong(song)"
              (remove)="removeSong(song._originalIndex)"
            />
          }
        </div>
      </div>
    } @else {
      <!-- Grid view -->
      <div class="max-w-6xl mx-auto px-3 py-4 md:px-6 md:py-8">
        <div class="flex items-center gap-3 mb-6">
          <h1 class="text-lg font-semibold text-zinc-100">Playlists</h1>
          <button (click)="gridControls.showToolbar()" class="p-1 text-zinc-600 hover:text-zinc-300 transition" title="Search (Ctrl+F)">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" /></svg>
          </button>
        </div>

        @if (gridControls.isToolbarVisible()) {
          <app-list-toolbar
            [searchText]="gridControls.searchText()"
            [sortField]="gridControls.sortField()"
            [sortDirection]="gridControls.sortDirection()"
            [sortOptions]="gridSortOptions"
            [resultCount]="gridControls.filtered().length"
            (searchChange)="gridControls.setSearchText($event)"
            (sortFieldChange)="gridControls.setSortField($event)"
            (toggleDirection)="gridControls.toggleSortDirection()"
            (dismiss)="gridControls.hideToolbar()"
          />
        }

        @if (loading()) {
          <div class="text-center py-20">
            <span class="inline-block w-5 h-5 border-2 border-zinc-600 border-t-zinc-300 rounded-full animate-spin"></span>
          </div>
        }

        @if (!loading() && playlists().length === 0) {
          <p class="text-center text-zinc-600 py-20">
            No playlists yet. Download an album and one will be created automatically!
          </p>
        }

        <div class="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
          @for (pl of gridControls.filtered(); track pl.id) {
            <button (click)="openPlaylist(pl)" [disabled]="loadingDetail()"
              class="p-3 rounded-lg bg-zinc-900/30 hover:bg-zinc-800/50 transition text-left">
              @if (pl.coverArt) {
                <img [src]="'/api/cover/' + pl.coverArt + '?size=300&token=' + auth.token()"
                  alt="" class="w-full aspect-square rounded object-cover mb-2" />
              } @else {
                <div [class]="'w-full aspect-square rounded bg-gradient-to-br ' + gradientFor(pl.name) + ' flex items-center justify-center mb-2'">
                  <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="opacity-40">
                    <path d="M9 18V5l12-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="18" cy="16" r="3" />
                  </svg>
                </div>
              }
              <p class="text-sm text-zinc-200 truncate">{{ pl.name }}</p>
              <p class="text-xs text-zinc-500 truncate">
                {{ pl.songCount }} tracks · {{ timeAgo(pl.created) }}
              </p>
            </button>
          }
        </div>
      </div>
    }
  `,
})
export class PlaylistsComponent implements OnInit {
  private api = inject(ApiService);
  readonly auth = inject(AuthService);
  private player = inject(PlayerService);
  private listControls = inject(ListControlsService);

  readonly gradientFor = gradientFor;
  readonly formatTotalDuration = formatTotalDuration;
  readonly timeAgo = timeAgo;

  readonly playlists = signal<Playlist[]>([]);
  readonly loading = signal(true);
  readonly selected = signal<PlaylistDetail | null>(null);
  readonly loadingDetail = signal(false);
  readonly deleting = signal(false);
  readonly editingName = signal(false);
  readonly nameDraft = signal('');
  readonly removing = signal(new Set<number>());

  readonly detailItems = computed<DetailItem[]>(() => {
    const sel = this.selected();
    return (sel?.entry ?? []).map((song, idx) => ({ ...song, _originalIndex: idx }));
  });

  readonly gridSortOptions: SortOption[] = [
    { field: 'name', label: 'Name' },
    { field: 'created', label: 'Date created' },
    { field: 'songCount', label: 'Track count' },
  ];

  readonly detailSortOptions: SortOption[] = [
    { field: 'title', label: 'Title' },
    { field: 'artist', label: 'Artist' },
    { field: 'duration', label: 'Duration' },
  ];

  readonly gridControls = this.listControls.connect({
    pageKey: 'playlists',
    items: this.playlists,
    searchFields: ['name'] as const,
    sortOptions: this.gridSortOptions,
  });

  readonly detailControls = this.listControls.connect({
    pageKey: 'playlist-detail',
    items: this.detailItems,
    searchFields: ['title', 'artist', 'album'] as const,
    sortOptions: this.detailSortOptions,
  });

  ngOnInit(): void {
    this.fetchPlaylists();
  }

  async openPlaylist(pl: Playlist): Promise<void> {
    this.loadingDetail.set(true);
    try {
      const detail = await firstValueFrom(this.api.getPlaylist(pl.id));
      this.selected.set(detail);
    } catch { /* ignore */ }
    finally { this.loadingDetail.set(false); }
  }

  playSong(song: DetailItem): void {
    this.player.play(toTrack(song));
  }

  playAll(): void {
    const pl = this.selected();
    if (!pl?.entry?.length) return;
    const tracks = pl.entry.map((s): Track => ({
      id: s.id,
      title: s.title,
      artist: s.artist,
      album: s.album,
      coverArt: s.coverArt,
      duration: s.duration,
    }));
    this.player.playWithContext(tracks, 0, { type: 'playlist', id: pl.id, name: pl.name });
  }

  async handleDelete(): Promise<void> {
    const pl = this.selected();
    if (!pl) return;
    this.deleting.set(true);
    try {
      await firstValueFrom(this.api.deletePlaylist(pl.id));
      this.playlists.update(prev => prev.filter(p => p.id !== pl.id));
      this.selected.set(null);
    } catch { /* ignore */ }
    finally { this.deleting.set(false); }
  }

  startRename(): void {
    const pl = this.selected();
    if (!pl) return;
    this.nameDraft.set(pl.name);
    this.editingName.set(true);
  }

  async saveRename(): Promise<void> {
    const pl = this.selected();
    if (!pl) return;
    const trimmed = this.nameDraft().trim();
    if (!trimmed || trimmed === pl.name) {
      this.editingName.set(false);
      return;
    }
    try {
      await firstValueFrom(this.api.updatePlaylist(pl.id, { name: trimmed }));
      this.selected.set({ ...pl, name: trimmed });
      this.playlists.update(prev => prev.map(p => p.id === pl.id ? { ...p, name: trimmed } : p));
    } catch { /* ignore */ }
    this.editingName.set(false);
  }

  async removeSong(songIndex: number): Promise<void> {
    const pl = this.selected();
    if (!pl) return;
    this.removing.update(prev => new Set(prev).add(songIndex));
    try {
      await firstValueFrom(this.api.updatePlaylist(pl.id, { songIndexesToRemove: [songIndex] }));
      const updatedEntry = pl.entry?.filter((_, i) => i !== songIndex) ?? [];
      this.selected.set({ ...pl, entry: updatedEntry, songCount: updatedEntry.length });
      this.playlists.update(prev => prev.map(p => p.id === pl.id ? { ...p, songCount: updatedEntry.length } : p));
    } catch { /* ignore */ }
    this.removing.update(prev => { const n = new Set(prev); n.delete(songIndex); return n; });
  }

  toTrackFromSong(song: DetailItem): Track {
    return toTrack(song);
  }

  private async fetchPlaylists(): Promise<void> {
    try {
      const data = await firstValueFrom(this.api.getPlaylists());
      this.playlists.set(data);
    } catch { /* ignore */ }
    finally { this.loading.set(false); }
  }
}
