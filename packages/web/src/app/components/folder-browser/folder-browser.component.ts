import { Component, inject, input, output, signal, computed, OnDestroy } from '@angular/core';
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

const MIN_BROWSER_HEIGHT = 180;
const MAX_BROWSER_HEIGHT = 700;
const MIN_TREE_WIDTH = 140;
const MAX_TREE_WIDTH = 420;

@Component({
  selector: 'app-folder-browser',
  imports: [FolderTreeNodeComponent],
  templateUrl: './folder-browser.component.html',
  })
export class FolderBrowserComponent implements OnDestroy {
  private api = inject(ApiService);
  private search = inject(SearchService);
  private transfers = inject(TransferService);

  readonly username = input.required<string>();
  readonly matchedPath = input.required<string>();
  readonly fallbackFiles = input.required<BrowseFile[]>();
  readonly download = output<{ files: Array<{ filename: string; size: number }>; path?: string }>();
  readonly downloadTrack = output<{ username: string; file: { filename: string; size: number } }>();

  readonly dirs = signal<BrowseDir[] | null>(null);
  readonly loading = signal(false);
  readonly error = signal(false);
  readonly errorMsg = signal<string | null>(null);
  readonly selected = signal('');
  readonly browserHeight = signal(280);
  readonly treeWidth = signal(220);

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
  }

  ngOnDestroy(): void {
    this.stopResize();
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

  async loadBrowse(): Promise<void> {
    if (this.loading() || this.dirs()) return;
    this.loading.set(true);
    this.error.set(false);
    this.errorMsg.set(null);
    try {
      const { jobId } = await firstValueFrom(this.api.startBrowse(this.username()));
      await this.pollBrowseJob(this.username(), jobId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.error.set(true);
      this.errorMsg.set(msg);
    } finally {
      this.loading.set(false);
    }
  }

  private async pollBrowseJob(username: string, jobId: string): Promise<void> {
    const POLL_INTERVAL_MS = 2500;
    const MAX_POLLS = 60; // 2.5s × 60 = 2.5 minutes max

    for (let i = 0; i < MAX_POLLS; i++) {
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      try {
        const result = await firstValueFrom(this.api.pollBrowse(username, jobId));
        if (result.state === 'pending') continue;
        if (result.state === 'error') {
          this.error.set(true);
          this.errorMsg.set(result.error);
          return;
        }
        if (result.state === 'complete') {
          this.dirs.set(result.dirs);
          return;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.error.set(true);
        this.errorMsg.set(msg);
        return;
      }
    }

    this.error.set(true);
    this.errorMsg.set('Browse timed out. The peer may be offline or slow to respond.');
  }

  startHeightResize(event: PointerEvent): void {
    this.startResize('height', event);
  }

  startTreeResize(event: PointerEvent): void {
    this.startResize('tree', event);
  }

  private resizeMode: 'height' | 'tree' | null = null;
  private resizeStartX = 0;
  private resizeStartY = 0;
  private resizeStartHeight = MIN_BROWSER_HEIGHT;
  private resizeStartTreeWidth = MIN_TREE_WIDTH;

  private readonly onPointerMove = (event: PointerEvent): void => {
    if (this.resizeMode === 'height') {
      const deltaY = event.clientY - this.resizeStartY;
      this.browserHeight.set(this.clamp(this.resizeStartHeight + deltaY, MIN_BROWSER_HEIGHT, MAX_BROWSER_HEIGHT));
      return;
    }

    if (this.resizeMode === 'tree') {
      const deltaX = event.clientX - this.resizeStartX;
      this.treeWidth.set(this.clamp(this.resizeStartTreeWidth + deltaX, MIN_TREE_WIDTH, MAX_TREE_WIDTH));
    }
  };

  private readonly onPointerUp = (): void => {
    this.stopResize();
  };

  private startResize(mode: 'height' | 'tree', event: PointerEvent): void {
    if (event.button !== 0) return;
    event.preventDefault();

    this.resizeMode = mode;
    this.resizeStartX = event.clientX;
    this.resizeStartY = event.clientY;
    this.resizeStartHeight = this.browserHeight();
    this.resizeStartTreeWidth = this.treeWidth();

    document.addEventListener('pointermove', this.onPointerMove);
    document.addEventListener('pointerup', this.onPointerUp, { once: true });
  }

  private stopResize(): void {
    this.resizeMode = null;
    document.removeEventListener('pointermove', this.onPointerMove);
    document.removeEventListener('pointerup', this.onPointerUp);
  }

  private clamp(value: number, min: number, max: number): number {
    if (value < min) return min;
    if (value > max) return max;
    return value;
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
