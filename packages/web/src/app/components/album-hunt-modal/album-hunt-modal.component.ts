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

  // Opt-in: retries the hunt with textually-skewed query variants to bypass
  // slskd's soft phrase ban. Changes the server-side queries (not a client
  // filter), so toggling it re-runs the hunt.
  readonly skewSearch = signal(false);

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
    const candidate = this.selectedCandidate();
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
        this.api.huntDownload(this.album().lidarrId, {
          selected: {
            username: candidate.username,
            directory: candidate.directory,
            files: toFiles(candidate),
          },
          alternates,
        }),
      );
      // Surface the new transfers immediately in the global download UI.
      void this.transfer.poll();
      this.downloaded.emit();
      this.close();
    } catch (err) {
      this.errorMsg.set(err instanceof Error ? err.message : 'Download failed');
      this.state.set('error');
    }
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
    return this.selectedCandidate() === candidate;
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
