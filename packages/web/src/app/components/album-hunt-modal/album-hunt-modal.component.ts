import { Component, inject, input, output, signal, computed, OnInit } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { firstValueFrom } from 'rxjs';
import type { ArchiveCandidate } from '@nicotind/core';
import {
  ApiService,
  type DiscographyAlbum,
  type FolderCandidate,
} from '../../services/api.service';
import { TransferService } from '../../services/transfer.service';
import { AcquireService } from '../../services/acquire.service';
import { PluginService } from '../../services/plugin.service';
import { baseQueries, skewedQueries } from '../../lib/hunt-queries';

type HuntState = 'idle' | 'searching' | 'results' | 'error' | 'downloading';
export type QueryPhaseState = 'idle' | 'searching' | 'done' | 'skipped';
type ArchiveState = 'idle' | 'searching' | 'done' | 'error';

@Component({
  selector: 'app-album-hunt-modal',
  standalone: true,
  imports: [NgTemplateOutlet],
  templateUrl: './album-hunt-modal.component.html',
  host: { '(document:keydown.escape)': 'close()' },
})
export class AlbumHuntModalComponent implements OnInit {
  private api = inject(ApiService);
  private transfer = inject(TransferService);
  private acquire = inject(AcquireService);
  private plugins = inject(PluginService);

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

  // §C1/§F2 per-track fallback for the no-candidates dead-end.
  readonly trackHuntState = signal<'idle' | 'running' | 'done' | 'error'>('idle');
  readonly trackHuntResult = signal<{ requested: number; enqueued: number; misses: string[] } | null>(
    null,
  );

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

  // Per-query progress state — updated in real time as each phase completes.
  // Keys are the exact query strings; value is one of the QueryPhaseState literals.
  readonly queryStates = signal<Record<string, QueryPhaseState>>({});

  // The exact Soulseek search strings this hunt fires — shown in the loading
  // message so the user can see what's being searched (and which skew variants
  // are tried). Mirrors the server's query builder.
  readonly baseSearchQueries = computed(() => baseQueries(this.artistName(), this.album().title));
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
  readonly effectiveCandidate = computed(() => this.selectedCandidate() ?? this.bestCandidate());

  // archive.org lane — a second source surfaced alongside the Soulseek candidates
  // (the user can pull a missing album from the Internet Archive in one click).
  // Gated on the `archive` plugin being enabled.
  readonly hasArchive = this.plugins.hasArchive;
  readonly archiveState = signal<ArchiveState>('idle');
  readonly archiveCandidates = signal<ArchiveCandidate[]>([]);
  // Item identifiers whose download has been kicked off (button → "Started").
  readonly archiveAcquired = signal<Set<string>>(new Set());

  async ngOnInit(): Promise<void> {
    // Fire the archive.org search in parallel; it must not block the Soulseek hunt.
    void this.searchArchive();
    await this.startHunt();
  }

  async searchArchive(): Promise<void> {
    if (!this.hasArchive()) {
      this.archiveState.set('idle');
      return;
    }
    this.archiveState.set('searching');
    this.archiveCandidates.set([]);
    try {
      const res = await firstValueFrom(
        this.api.archiveSearchAlbum(this.artistName(), this.album().title),
      );
      this.archiveCandidates.set(res.candidates);
      this.archiveState.set('done');
    } catch {
      this.archiveState.set('error');
    }
  }

  // Download an archive.org item: hand its detailsUrl to the acquire pipeline (the
  // `archive` resolve plugin stages the audio; the job tracks in Downloads → Active).
  async getFromArchive(item: ArchiveCandidate): Promise<void> {
    this.archiveAcquired.update((s) => new Set(s).add(item.identifier));
    try {
      await this.acquire.submit(item.detailsUrl);
    } catch {
      this.archiveAcquired.update((s) => {
        const next = new Set(s);
        next.delete(item.identifier);
        return next;
      });
    }
  }

  isAcquired(item: ArchiveCandidate): boolean {
    return this.archiveAcquired().has(item.identifier);
  }

  async startHunt(): Promise<void> {
    this.state.set('searching');
    this.candidates.set([]);
    this.selectedCandidate.set(null);
    this.errorMsg.set('');

    const artist = this.artistName();
    const album = this.album().title;

    // Initialise all query rows to 'idle' before either phase fires.
    const initialStates: Record<string, QueryPhaseState> = {};
    for (const q of baseQueries(artist, album)) initialStates[q] = 'idle';
    if (this.skewSearch()) {
      for (const q of skewedQueries(artist, album)) initialStates[q] = 'idle';
    }
    this.queryStates.set(initialStates);

    try {
      // Phase 1 — base queries.
      this._setPhaseState(baseQueries(artist, album), 'searching');

      const baseResult = await firstValueFrom(
        this.api.huntAlbumBase(this.album().lidarrId, {
          artistName: artist,
          albumTitle: album,
          skewSearch: this.skewSearch(),
        }),
      );

      this._setPhaseState(baseQueries(artist, album), 'done');
      this.candidates.set(baseResult.candidates);
      this.totalTracks.set(baseResult.totalTracks);

      // Phase 2 — skew queries (only when the base didn't find a confident match).
      if (this.skewSearch() && baseResult.skewNeeded) {
        const skewQs = skewedQueries(artist, album);
        if (skewQs.length) {
          this._setPhaseState(skewQs, 'searching');

          const skewResult = await firstValueFrom(
            this.api.huntAlbumSkew(this.album().lidarrId, {
              artistName: artist,
              albumTitle: album,
            }),
          );

          this._setPhaseState(skewQs, 'done');

          // Merge skew candidates with base on the frontend: de-dupe by
          // username::directory, keep the higher-scoring instance, then re-rank.
          this.candidates.set(mergeCandidates(baseResult.candidates, skewResult.candidates));
        }
      } else if (this.skewSearch()) {
        // Base was confident — skew not needed; mark rows as skipped.
        this._setPhaseState(skewedQueries(artist, album), 'skipped');
      }

      this.state.set('results');
    } catch (err) {
      this.errorMsg.set(err instanceof Error ? err.message : 'Hunt failed');
      this.state.set('error');
    }
  }

  private _setPhaseState(queries: string[], st: QueryPhaseState): void {
    this.queryStates.update((prev) => {
      const next = { ...prev };
      for (const q of queries) next[q] = st;
      return next;
    });
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
      this.transfer.kickPoll();
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
    this.selectedCandidate.set(this.selectedCandidate() === candidate ? null : candidate);
  }

  // §C1: no whole-album folder matched — hunt each track individually and
  // enqueue the best match per track. The server resolves the tracklist.
  async huntIndividualTracks(): Promise<void> {
    if (this.trackHuntState() === 'running') return;
    this.trackHuntState.set('running');
    try {
      const result = await firstValueFrom(
        this.api.huntAlbumTracks(this.album().lidarrId, this.artistName()),
      );
      this.trackHuntResult.set(result);
      this.trackHuntState.set('done');
      if (result.enqueued > 0) this.transfer.kickPoll();
    } catch {
      this.trackHuntState.set('error');
    }
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

  queryState(q: string): QueryPhaseState {
    return this.queryStates()[q] ?? 'idle';
  }

  queryRowClass(st: QueryPhaseState): string {
    if (st === 'searching') return 'bg-blue-500/20 text-blue-300';
    if (st === 'done') return 'bg-green-500/15 text-green-300';
    if (st === 'skipped') return 'bg-theme-surface-2 opacity-40';
    return 'bg-theme-surface-2'; // idle
  }

  close(): void {
    this.closed.emit();
  }
}

// Client-side candidate merge: de-dupe by username::directory, keep the
// higher-scoring instance per key, then sort by matchPct descending.
function mergeCandidates(base: FolderCandidate[], extra: FolderCandidate[]): FolderCandidate[] {
  const byKey = new Map<string, FolderCandidate>();
  for (const c of [...base, ...extra]) {
    const key = `${c.username}::${c.directory}`;
    const prev = byKey.get(key);
    if (!prev || c.matchPct > prev.matchPct) byKey.set(key, c);
  }
  return [...byKey.values()].sort((a, b) => b.matchPct - a.matchPct);
}
