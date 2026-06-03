import {
  Component,
  inject,
  input,
  output,
  signal,
  computed,
  OnInit,
} from '@angular/core';
import { firstValueFrom } from 'rxjs';
import {
  ApiService,
  type DiscographyAlbum,
  type FolderCandidate,
} from '../../services/api.service';
import { TransferService } from '../../services/transfer.service';
import { baseQueries, skewedQueries } from '../../lib/hunt-queries';

type HuntState = 'idle' | 'searching' | 'results' | 'error' | 'downloading';

@Component({
  selector: 'app-album-hunt-modal',
  standalone: true,
  templateUrl: './album-hunt-modal.component.html',
  host: { '(document:keydown.escape)': 'close()' },
})
export class AlbumHuntModalComponent implements OnInit {
  private api = inject(ApiService);
  private transfer = inject(TransferService);

  readonly album = input.required<DiscographyAlbum>();
  readonly artistName = input.required<string>();
  // Set by the admin re-hunt so the server supersedes the album's prior active
  // job instead of rejecting the download as a duplicate.
  readonly replace = input(false);
  readonly closed = output<void>();
  readonly downloaded = output<void>();

  readonly state = signal<HuntState>('idle');
  readonly candidates = signal<FolderCandidate[]>([]);
  readonly totalTracks = signal(0);
  readonly errorMsg = signal('');
  readonly selectedCandidate = signal<FolderCandidate | null>(null);

  // Filter state — signals so the filtered list recomputes instantly. The server
  // returns ALL candidates (above a low floor); filtering is purely client-side,
  // so toggling a filter never requires another network round-trip.
  readonly includeFlac = signal(true);
  readonly includeLive = signal(false);
  readonly minMatchPct = signal(10);

  // On by default: retries the hunt with textually-skewed query variants to
  // bypass slskd's soft phrase ban. Changes the server-side queries (not a
  // client filter), so toggling it re-runs the hunt. Can be unchecked to force
  // the unmodified queries only.
  readonly skewSearch = signal(true);

  // The exact Soulseek search strings this hunt fires — shown in the loading
  // message so the user can see what's being searched (and which skew variants
  // are tried). Mirrors the server's query builder.
  readonly baseSearchQueries = computed(() =>
    baseQueries(this.artistName(), this.album().title),
  );
  readonly skewSearchQueries = computed(() =>
    this.skewSearch() ? skewedQueries(this.artistName(), this.album().title) : [],
  );

  readonly filteredCandidates = computed(() => {
    const flac = this.includeFlac();
    const live = this.includeLive();
    const minPct = this.minMatchPct();
    return this.candidates().filter((c) => {
      if (!flac && c.format === 'FLAC') return false;
      if (!live && c.isLive) return false;
      if (c.matchPct < minPct) return false;
      return true;
    });
  });

  // Server already ranks candidates (match %, then peer health, then FLAC), so the
  // top of the filtered list is the smart default. The user need not pick a folder:
  // a single tap on Download grabs this. Tapping a row overrides it.
  readonly bestCandidate = computed(() => this.filteredCandidates()[0] ?? null);

  // What Download actually queues: the user's explicit pick if any, else the best.
  readonly effectiveCandidate = computed(
    () => this.selectedCandidate() ?? this.bestCandidate(),
  );

  async ngOnInit(): Promise<void> {
    await this.startHunt();
  }

  async startHunt(): Promise<void> {
    this.state.set('searching');
    this.candidates.set([]);
    this.selectedCandidate.set(null);
    this.errorMsg.set('');

    try {
      const result = await firstValueFrom(
        this.api.huntAlbum(this.album().lidarrId, {
          artistName: this.artistName(),
          albumTitle: this.album().title,
          skewSearch: this.skewSearch(),
        }),
      );

      this.candidates.set(result.candidates);
      this.totalTracks.set(result.totalTracks);
      this.state.set('results');
    } catch (err) {
      this.errorMsg.set(err instanceof Error ? err.message : 'Hunt failed');
      this.state.set('error');
    }
  }

  async downloadSelected(): Promise<void> {
    const candidate = this.effectiveCandidate();
    if (!candidate) return;

    // Pass the other candidates as ranked alternates so the server can recover
    // any tracks this peer fails to deliver from a different peer.
    const toFiles = (c: FolderCandidate) =>
      c.files.map((f) => ({ filename: f.filename, size: f.size }));
    const alternates = this.candidates()
      .filter((c) => c !== candidate)
      .map((c) => ({ username: c.username, directory: c.directory, files: toFiles(c) }));

    this.state.set('downloading');
    try {
      await firstValueFrom(
        this.api.huntDownload(
          this.album().lidarrId,
          {
            selected: {
              username: candidate.username,
              directory: candidate.directory,
              files: toFiles(candidate),
            },
            alternates,
          },
          this.replace(),
        ),
      );
      // Surface the new transfers immediately in the global download UI.
      void this.transfer.poll();
      this.downloaded.emit();
      this.close();
    } catch (err) {
      this.errorMsg.set(this.downloadErrorMessage(err));
      this.state.set('error');
    }
  }

  // The server rejects a duplicate acquisition with 409 + a machine code; turn
  // those into a clear message instead of a generic HTTP failure string.
  private downloadErrorMessage(err: unknown): string {
    const code = (err as { error?: { error?: string } })?.error?.error;
    if (code === 'already-downloading') return 'This album is already downloading.';
    if (code === 'already-complete') return 'This album is already in your library.';
    return err instanceof Error ? err.message : 'Download failed';
  }

  setMinMatch(value: string): void {
    const n = Number(value);
    if (!Number.isNaN(n)) this.minMatchPct.set(Math.max(0, Math.min(100, n)));
  }

  select(candidate: FolderCandidate): void {
    this.selectedCandidate.set(
      this.selectedCandidate() === candidate ? null : candidate,
    );
  }

  isSelected(candidate: FolderCandidate): boolean {
    return this.effectiveCandidate() === candidate;
  }

  // True when this row is the smart default (best) and the user hasn't picked
  // another — drives the "Best match" hint so the auto-selection is visible.
  isAutoBest(candidate: FolderCandidate): boolean {
    return this.selectedCandidate() === null && this.bestCandidate() === candidate;
  }

  matchClass(pct: number): string {
    if (pct >= 90) return 'text-green-400';
    if (pct >= 60) return 'text-yellow-400';
    return 'text-zinc-400';
  }

  displayDir(dir: string): string {
    const parts = dir.replace(/\\/g, '/').split('/');
    return parts.slice(-2).join(' / ');
  }

  close(): void {
    this.closed.emit();
  }
}
