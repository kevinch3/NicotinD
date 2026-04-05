import { Component, inject, input, output, signal, computed } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { ApiService } from '../../services/api.service';
import { SearchService } from '../../services/search.service';
import { TransferService } from '../../services/transfer.service';
import {
  buildFolderTree,
  getDirectFiles,
  type BrowseDir,
  type BrowseFile,
  type FolderNode,
} from '../../lib/folder-utils';
import {
  getSingleDownloadLabel,
  getFolderDownloadLabel,
  isPathEffectivelyQueued,
  BUTTON_CLASSES,
  DEFAULT_FOLDER_LABEL,
} from '../../lib/download-status';
import { FolderTreeNodeComponent } from './folder-tree-node.component';

function buildBreadcrumb(path: string): Array<{ label: string; path: string }> {
  const segs = path.split(/[\\/]/).filter(Boolean);
  return segs.map((seg, i) => ({
    label: seg,
    path: segs.slice(0, i + 1).join('\\'),
  }));
}

function formatSize(bytes: number) {
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  return `${(bytes / 1_000).toFixed(0)} KB`;
}

function extractBasename(filepath: string): string {
  const parts = filepath.split(/[\\/]/);
  return parts[parts.length - 1];
}

@Component({
  selector: 'app-folder-browser',
  imports: [FolderTreeNodeComponent],
  template: `
    <div class="mt-2 border border-zinc-800 rounded-lg overflow-hidden">
      <!-- Header -->
      <div class="flex items-center justify-between px-3 py-2 bg-zinc-900 border-b border-zinc-800">
        <span class="text-xs text-zinc-400 truncate">{{ username() }}'s library</span>
        @if (loading()) {
          <span class="text-[11px] text-zinc-600 flex items-center gap-1">
            <span class="inline-block w-3 h-3 border border-zinc-600 border-t-zinc-400 rounded-full animate-spin"></span>
            Loading…
          </span>
        }
        @if (error()) {
          <div class="flex flex-col items-end">
            <span class="text-[11px] text-amber-600">
              Couldn't load full library ({{ errorMsg() }}) — showing files from search results
            </span>
            <span class="text-[10px] text-zinc-500">
              Check Soulseek network settings (Port, UPnP) in Settings if this happens often.
            </span>
          </div>
        }
      </div>

      <!-- Mobile layout -->
      <div class="md:hidden">
        <div class="flex items-center gap-1 px-3 py-2 border-b border-zinc-800 overflow-x-auto">
          @for (crumb of breadcrumbs(); track crumb.path; let i = $index; let last = $last) {
            <span class="flex items-center gap-1 shrink-0">
              @if (i > 0) { <span class="text-zinc-700">›</span> }
              <button (click)="selected.set(crumb.path)"
                [class]="'text-xs ' + (last ? 'text-zinc-200' : 'text-zinc-500 hover:text-zinc-300')">
                {{ crumb.label }}
              </button>
            </span>
          }
        </div>

        <div class="overflow-y-auto max-h-64 p-1">
          @if (!loading() && !error()) {
            @for (child of mobileChildren(); track child.fullPath) {
              <button (click)="selected.set(child.fullPath)"
                class="w-full text-left flex items-center justify-between px-2 py-1.5 rounded text-xs text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200">
                <span class="flex items-center gap-1.5 truncate">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" class="shrink-0 text-zinc-600">
                    <path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V7z"/>
                  </svg>
                  {{ child.segment }}
                </span>
                <span class="text-zinc-700">›</span>
              </button>
            }
            @for (file of directFiles(); track file.filename) {
              <div class="flex items-center justify-between text-[11px] text-zinc-500 hover:text-zinc-300 px-2 py-1">
                <span class="truncate flex-1">{{ extractBasename(file.filename) }}</span>
                <span class="shrink-0 ml-2 text-zinc-700">
                  {{ file.bitRate ? file.bitRate + ' kbps · ' : '' }}{{ formatSize(file.size) }}
                </span>
              </div>
            }
          }
        </div>
      </div>

      <!-- Desktop layout -->
      <div class="hidden md:flex min-h-[120px] max-h-64">
        @if (!loading() && !error() && dirs()) {
          <div class="w-44 shrink-0 overflow-y-auto border-r border-zinc-800 p-1">
            @for (node of tree(); track node.fullPath) {
              <app-folder-tree-node
                [node]="node"
                [selected]="selected()"
                (selectNode)="selected.set($event)"
              />
            }
          </div>
        }

        <div class="flex-1 overflow-y-auto p-2 flex flex-col gap-1">
          @if (directFiles().length === 0) {
            <p class="text-xs text-zinc-600 p-2">No files</p>
          } @else {
            <div class="flex items-center justify-between mb-1">
              <span class="text-[11px] text-zinc-600">
                {{ directFiles().length }} file{{ directFiles().length !== 1 ? 's' : '' }}
              </span>
              <button
                (click)="handleDownloadAll()"
                [disabled]="folderBtnState().disabled || validDirectFiles().length === 0"
                [class]="'px-2 py-0.5 rounded text-[11px] font-medium transition ' + btnClasses[folderBtnState().variant] + (folderBtnState().disabled ? ' cursor-default' : '')">
                {{ folderBtnDisplayLabel() }}
              </button>
            </div>
            @for (file of directFiles(); track file.filename) {
              <div class="flex items-center justify-between text-[11px] text-zinc-500 hover:text-zinc-300 px-1 py-0.5">
                <span class="truncate flex-1">{{ extractBasename(file.filename) }}</span>
                <div class="flex items-center gap-3 ml-2 shrink-0">
                  <span class="text-zinc-700">
                    {{ file.bitRate ? file.bitRate + ' kbps · ' : '' }}{{ formatSize(file.size) }}
                  </span>
                  <button
                    (click)="downloadTrack.emit({ username: username(), file: { filename: file.filename, size: file.size } })"
                    [disabled]="fileBtnState(file).disabled"
                    [class]="'px-1.5 py-0.5 rounded transition ' + btnClasses[fileBtnState(file).variant] + (fileBtnState(file).disabled ? ' cursor-default' : '')">
                    {{ fileBtnState(file).label }}
                  </button>
                </div>
              </div>
            }
          }
        </div>
      </div>
    </div>
  `,
})
export class FolderBrowserComponent {
  private api = inject(ApiService);
  private search = inject(SearchService);
  private transfers = inject(TransferService);

  readonly username = input.required<string>();
  readonly matchedPath = input.required<string>();
  readonly fallbackFiles = input.required<BrowseFile[]>();
  readonly download = output<{ files: Array<{ filename: string; size: number }>; path?: string }>();
  readonly downloadTrack = output<{ username: string; file: { filename: string; size: number } }>();

  readonly dirs = signal<BrowseDir[] | null>(null);
  readonly loading = signal(true);
  readonly error = signal(false);
  readonly errorMsg = signal<string | null>(null);
  readonly selected = signal('');

  readonly btnClasses = BUTTON_CLASSES;
  readonly extractBasename = extractBasename;
  readonly formatSize = formatSize;

  readonly tree = computed(() => this.dirs() ? buildFolderTree(this.dirs()!) : []);

  readonly breadcrumbs = computed(() => buildBreadcrumb(this.selected()));

  readonly mobileChildren = computed(() => {
    const tree = this.tree();
    const sel = this.selected();
    const node = this.findNode(tree, sel);
    return node?.children ?? [];
  });

  readonly directFiles = computed<BrowseFile[]>(() => {
    const d = this.dirs();
    return d ? getDirectFiles(d, this.selected()) : this.fallbackFiles();
  });

  readonly validDirectFiles = computed(() =>
    this.directFiles().filter(f => f.size > 0),
  );

  readonly folderBtnState = computed(() => {
    const validFiles = this.validDirectFiles();
    const folderFiles = validFiles.map(f => ({ username: this.username(), filename: f.filename }));
    const isFolderQueued = isPathEffectivelyQueued(this.username(), this.selected(), this.search.downloadedFolders());
    return getFolderDownloadLabel(
      folderFiles,
      isFolderQueued,
      (u, f) => this.transfers.getStatus(u, f),
    );
  });

  readonly folderBtnDisplayLabel = computed(() => {
    const btn = this.folderBtnState();
    return btn.label === DEFAULT_FOLDER_LABEL
      ? `Download all (${this.validDirectFiles().length})`
      : btn.label;
  });

  ngOnInit(): void {
    this.selected.set(this.matchedPath());
    this.loadBrowse();
  }

  fileBtnState(file: BrowseFile) {
    const key = `${this.username()}:${file.filename}`;
    return getSingleDownloadLabel(
      this.username(),
      file.filename,
      this.search.downloading().has(key),
      (u, f) => this.transfers.getStatus(u, f),
    );
  }

  handleDownloadAll(): void {
    const validFiles = this.validDirectFiles();
    this.download.emit({
      files: validFiles.map(f => ({ filename: f.filename, size: f.size })),
      path: this.selected(),
    });
  }

  private async loadBrowse(): Promise<void> {
    this.loading.set(true);
    this.error.set(false);
    this.errorMsg.set(null);
    try {
      const result = await firstValueFrom(this.api.browseUser(this.username()));
      this.dirs.set(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.error.set(true);
      this.errorMsg.set(msg);
    } finally {
      this.loading.set(false);
    }
  }

  private findNode(nodes: FolderNode[], path: string): FolderNode | null {
    for (const n of nodes) {
      if (n.fullPath === path) return n;
      const found = this.findNode(n.children, path);
      if (found) return found;
    }
    return null;
  }
}
