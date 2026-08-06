import {
  Component,
  ElementRef,
  inject,
  input,
  output,
  signal,
  computed,
  viewChild,
  OnInit,
} from '@angular/core';
import { registerOverlayCloser } from '../../services/native/back-button.service';
import { FormsModule } from '@angular/forms';
import { firstValueFrom, type Observable } from 'rxjs';
import type { MetadataCandidate, AlbumCoverCandidate, IdentifyOutcome } from '../../../types/core';
import { LibraryApiService } from '../../services/api/library-api.service';
import { ReviewApiService } from '../../services/api/review-api.service';
import type { ReviewQueueAlbum } from '../../services/api/api-types';
import { AuthService } from '../../services/auth.service';
import { ServerConfigService } from '../../services/server-config.service';
import { ConfirmService } from '../../services/confirm.service';
import { ToastService } from '../../services/toast.service';
import { TranslateService } from '../../services/translate.service';
import { TranslatePipe } from '../../pipes/translate.pipe';
import { httpErrorMessage } from '../../lib/http-error';
import {
  defaultQuery,
  candidateToRequest,
  manualToRequest,
  isPlaceholderArtist,
} from '../../lib/metadata-fix';
import {
  toEditableTracks,
  dirtyTrackPayload,
  applyIdentify,
  markTracksSaved,
  type EditableTrack,
} from '../../lib/review-tracks';
import { CoverArtComponent } from '../cover-art/cover-art.component';
import {
  flattenCoverCandidates,
  coverThumbUrl,
  coverCandidateToRequest,
  customCoverToRequest,
} from '../../lib/cover-candidates';
import { BottomChromeSafeDirective } from '../../directives/bottom-chrome-safe.directive';

/**
 * Admin metadata fix modal: search Lidarr with an editable query, pick a candidate
 * (even low-confidence — the user confirms), or enter artist/album/year by hand.
 * Applying persists a correction the scanner honors. Emits `applied` with the new
 * albumId so the parent can re-fetch + cache-bust the cover.
 */
@Component({
  selector: 'app-metadata-fix-modal',
  standalone: true,
  imports: [FormsModule, CoverArtComponent, BottomChromeSafeDirective, TranslatePipe],
  templateUrl: './metadata-fix-modal.component.html',
})
export class MetadataFixModalComponent implements OnInit {
  private api = inject(LibraryApiService);
  private review = inject(ReviewApiService);
  readonly auth = inject(AuthService);
  private server = inject(ServerConfigService);
  private confirm = inject(ConfirmService);
  private toast = inject(ToastService);
  private i18n = inject(TranslateService);

  readonly albumId = input.required<string>();
  readonly currentArtist = input<string>('');
  readonly currentAlbum = input<string>('');
  /** Non-null puts the modal in review mode (issue #411 Task 12): the Tracks
   *  section renders, and the header copy/candidate list gain the per-track
   *  identify/retag flow driven by `/api/review/*` rather than a plain
   *  metadata correction. */
  readonly reviewTracks = input<ReviewQueueAlbum['songs'] | null>(null);
  readonly isReviewMode = computed(() => this.reviewTracks() !== null);

  readonly applied = output<{ albumId: string }>();
  /** Emitted after a cover-only change so the parent can refetch + cache-bust without closing. */
  readonly coverChanged = output<void>();
  /** Emitted after `retagTracks` succeeds (review mode only). */
  readonly tracksSaved = output<void>();
  readonly cancel = output<void>();

  constructor() {
    // Escape / hardware Back cancel via the shared stack (issue #398).
    registerOverlayCloser(() => this.cancel.emit());
  }

  // Cover picker state.
  readonly coverOptions = signal<AlbumCoverCandidate[]>([]);
  readonly coverApplying = signal(false);
  readonly customCoverUrl = signal('');
  readonly coverFileInput = viewChild<ElementRef<HTMLInputElement>>('coverFileInput');

  readonly query = signal('');
  // The stored artist is a placeholder ("<Desconocido>") — prompt the user to type
  // the real artist, since the default query was searched by album title alone.
  readonly artistIsPlaceholder = computed(() => isPlaceholderArtist(this.currentArtist()));
  readonly searched = signal(false);
  readonly searching = signal(false);
  readonly applying = signal(false);
  readonly candidates = signal<MetadataCandidate[]>([]);
  readonly msg = signal<string | null>(null);
  /** Per-source status from the last search — an `ok: false` entry is
   *  unconfigured/down, surfaced as a muted `review.sourcesDown` line. */
  readonly sources = signal<Array<{ id: string; ok: boolean }>>([]);
  readonly sourcesDownList = computed(() =>
    this.sources()
      .filter((s) => !s.ok)
      .map((s) => s.id)
      .join(', '),
  );
  /** Whether an enabled+configured fingerprint plugin exists (from the last search). */
  readonly identifyAvailable = signal(false);

  // Free-text fallback fields.
  readonly manualArtist = signal('');
  readonly manualAlbum = signal('');
  readonly manualYear = signal('');

  // Review mode: per-track grid state.
  readonly tracks = signal<EditableTrack[]>([]);
  readonly hasDirtyTracks = computed(() => dirtyTrackPayload(this.tracks()).length > 0);
  readonly identifyingTrackIds = signal<Set<string>>(new Set());
  /**
   * Per-track identify failures (issue #414), keyed by song id. Only failures
   * live here — a match updates the row itself, so an entry means "this track
   * has something to tell the curator". Kept beside `tracks` rather than on
   * EditableTrack because it is transient UI state, not editable track data
   * (`hasDirtyTracks` must not see it).
   */
  readonly identifyFailures = signal<Map<string, { kind: string; detail?: string }>>(new Map());
  readonly identifyingAlbum = signal(false);
  readonly savingTracks = signal(false);

  /** Prefill the search box + manual fields from the album's current values. */
  ngOnInit(): void {
    this.query.set(defaultQuery(this.currentArtist(), this.currentAlbum()));
    this.manualArtist.set(this.currentArtist());
    this.manualAlbum.set(this.currentAlbum());
    // Show the current cover immediately; Lidarr alts + per-track art arrive
    // async (and must not block the picker on a slow/dead Lidarr lookup).
    this.coverOptions.set([this.currentCoverOption()]);
    void this.loadCovers();
    const reviewSongs = this.reviewTracks();
    if (reviewSongs !== null) {
      this.tracks.set(toEditableTracks(reviewSongs));
      // Review mode opens straight into a fix flow, so run the candidate
      // search immediately rather than requiring an extra click — it also
      // populates `identifyAvailable`/`sources` for the Tracks section.
      void this.search();
    }
  }

  private currentCoverOption(): AlbumCoverCandidate {
    return { source: 'current', url: `/api/cover/${this.albumId()}`, label: 'Current' };
  }

  /** Load the cover picker options (current + Lidarr alts + per-track embedded). */
  async loadCovers(): Promise<void> {
    try {
      const res = await firstValueFrom(this.api.getCoverCandidates(this.albumId(), this.query()));
      this.coverOptions.set(flattenCoverCandidates(res));
    } catch {
      // Keep the synthetic current option so the picker still renders.
      this.coverOptions.set([this.currentCoverOption()]);
    }
  }

  /** Renderable thumbnail src for a cover option (token + size for our own URLs). */
  coverSrc(c: AlbumCoverCandidate): string {
    return this.server.apiUrl(coverThumbUrl(c, this.auth.token() ?? ''));
  }

  /** Apply a picked cover (Lidarr alt / album-track embedded art). Current = no-op. */
  async selectCover(c: AlbumCoverCandidate): Promise<void> {
    const req = coverCandidateToRequest(c);
    if (req) await this.runCoverApply(() => this.api.applyCover(this.albumId(), req));
  }

  /** Apply a pasted cover URL. */
  async applyCustomCover(): Promise<void> {
    const req = customCoverToRequest(this.customCoverUrl());
    if (!req) {
      this.msg.set('Paste an image URL first.');
      return;
    }
    await this.runCoverApply(() => this.api.applyCover(this.albumId(), req));
  }

  /** Open the OS file picker (wired to the hidden input). */
  triggerCoverUpload(): void {
    this.coverFileInput()?.nativeElement.click();
  }

  /** Upload a local image file as the album cover. */
  async onCoverFileSelected(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = ''; // allow re-selecting the same file later
    if (!file) return;
    await this.runCoverApply(() => this.api.uploadAlbumCover(this.albumId(), file));
  }

  private async runCoverApply(action: () => Observable<{ ok: boolean }>): Promise<void> {
    if (this.coverApplying()) return;
    this.coverApplying.set(true);
    this.msg.set(null);
    try {
      await firstValueFrom(action());
      this.customCoverUrl.set('');
      this.coverChanged.emit();
      // Refresh the picker so the "Current" thumbnail reflects the new cover.
      await this.loadCovers();
    } catch (err) {
      this.msg.set(httpErrorMessage(err, 'Could not apply the cover.'));
    } finally {
      this.coverApplying.set(false);
    }
  }

  async search(): Promise<void> {
    if (this.searching()) return;
    this.searching.set(true);
    this.msg.set(null);
    try {
      const r = await firstValueFrom(this.api.getMetadataCandidates(this.albumId(), this.query()));
      this.candidates.set(r.candidates);
      this.sources.set(r.sources);
      this.identifyAvailable.set(r.identifyAvailable);
      this.searched.set(true);
      // Refresh the Lidarr cover alternatives against the same edited query.
      void this.loadCovers();
      if (r.candidates.length === 0) {
        this.msg.set('No matches — refine the search or enter the details manually below.');
      }
    } catch (err) {
      this.candidates.set([]);
      this.searched.set(true);
      this.msg.set(httpErrorMessage(err, 'Search unavailable — enter the details manually below.'));
    } finally {
      this.searching.set(false);
    }
  }

  async applyCandidate(c: MetadataCandidate): Promise<void> {
    await this.apply(candidateToRequest(c));
  }

  async applyManual(): Promise<void> {
    const req = manualToRequest({
      artist: this.manualArtist(),
      album: this.manualAlbum(),
      year: this.manualYear(),
    });
    if (!req) {
      this.msg.set('Enter an artist, album, or year first.');
      return;
    }
    await this.apply(req);
  }

  private async apply(req: import('../../../types/core').ApplyMetadataRequest): Promise<void> {
    if (this.applying()) return;
    this.applying.set(true);
    this.msg.set(null);
    try {
      const r = await firstValueFrom(this.api.applyMetadata(this.albumId(), req));
      this.applied.emit({ albumId: r.albumId });
    } catch (err) {
      this.msg.set(httpErrorMessage(err, 'Could not apply the correction.'));
    } finally {
      this.applying.set(false);
    }
  }

  // ─── Review mode: per-track grid (issue #411 Task 12) ──────────────────

  onTrackTitleChange(id: string, title: string): void {
    this.tracks.update((list) =>
      list.map((t) => (t.id === id ? { ...t, title, dirtyTitle: true } : t)),
    );
  }

  onTrackArtistChange(id: string, artist: string): void {
    this.tracks.update((list) =>
      list.map((t) => (t.id === id ? { ...t, artist, dirtyArtist: true } : t)),
    );
  }

  isIdentifyingTrack(id: string): boolean {
    return this.identifyingTrackIds().has(id);
  }

  /** The failure to show on a track row, or undefined when there is none. */
  identifyFailure(id: string): { kind: string; detail?: string } | undefined {
    return this.identifyFailures().get(id);
  }

  /**
   * Human copy for an identify failure. `no-match` keeps the existing neutral
   * wording; the other kinds each name a different thing to *do* about it —
   * which is the point of #414, since they used to be indistinguishable.
   */
  identifyFailureLabel(kind: string): string {
    switch (kind) {
      case 'fpcalc-missing':
        return this.i18n.t('review.identifyFpcalcMissing');
      case 'undecodable':
        return this.i18n.t('review.identifyUndecodable');
      case 'source-error':
        return this.i18n.t('review.identifySourceError');
      case 'file-missing':
        return this.i18n.t('review.identifyFileMissing');
      default:
        return this.i18n.t('review.identifyNoMatch');
    }
  }

  /** Narrow an outcome to its diagnostic detail (the match arm carries none). */
  private outcomeDetail(outcome: IdentifyOutcome | undefined): string | undefined {
    return outcome && outcome.kind !== 'match' ? outcome.detail : undefined;
  }

  /** Record or clear a track's identify failure. */
  private setIdentifyFailure(id: string, failure?: { kind: string; detail?: string }): void {
    this.identifyFailures.update((m) => {
      const next = new Map(m);
      if (failure && failure.kind !== 'match') next.set(id, failure);
      else next.delete(id);
      return next;
    });
  }

  /** Fingerprint-identify one track and merge a match into its row (no-op on a miss). */
  async identifyTrack(t: EditableTrack): Promise<void> {
    if (this.isIdentifyingTrack(t.id)) return;
    this.identifyingTrackIds.update((s) => new Set(s).add(t.id));
    try {
      const { result, outcome } = await firstValueFrom(this.review.identifySong(t.id));
      if (!result) {
        const kind = outcome?.kind ?? 'no-match';
        this.setIdentifyFailure(t.id, { kind, detail: this.outcomeDetail(outcome) });
        // A broken file / missing binary is a real problem, not an "oh well" —
        // so it warns rather than sharing no-match's neutral info toast.
        this.toast.show({
          message: this.identifyFailureLabel(kind),
          kind: kind === 'no-match' ? 'info' : 'error',
        });
        return;
      }
      this.setIdentifyFailure(t.id);
      this.tracks.update((list) => list.map((x) => (x.id === t.id ? applyIdentify(x, result) : x)));
    } catch (err) {
      this.msg.set(httpErrorMessage(err, 'Could not identify the track.'));
    } finally {
      this.identifyingTrackIds.update((s) => {
        const next = new Set(s);
        next.delete(t.id);
        return next;
      });
    }
  }

  /**
   * Fingerprint-identify every track at once: merges each per-track match into
   * the grid, and a majority artist/album vote prefills the manual fields +
   * is injected as a top `acoustid`-sourced candidate the curator can Apply.
   */
  async identifyAlbumFingerprint(): Promise<void> {
    if (this.identifyingAlbum()) return;
    this.identifyingAlbum.set(true);
    this.msg.set(null);
    try {
      const { perTrack, vote } = await firstValueFrom(this.review.identifyAlbum(this.albumId()));
      this.tracks.update((list) =>
        list.map((t) => {
          const hit = perTrack.find((p) => p.songId === t.id);
          return hit?.result ? applyIdentify(t, hit.result) : t;
        }),
      );
      // One unreadable file among ten is exactly the signal a bulk identify
      // should surface per row instead of averaging into a single verdict.
      for (const p of perTrack) {
        this.setIdentifyFailure(
          p.songId,
          p.result
            ? undefined
            : { kind: p.outcome?.kind ?? 'no-match', detail: this.outcomeDetail(p.outcome) },
        );
      }
      if (vote) {
        this.manualArtist.set(vote.artist);
        this.manualAlbum.set(vote.album);
        const score = Math.round((vote.votes / vote.total) * 100);
        this.candidates.update((list) => [
          {
            releaseGroupId: null,
            artist: vote.artist,
            title: vote.album,
            year: null,
            releaseType: null,
            coverUrl: null,
            score,
            source: 'acoustid',
          },
          ...list,
        ]);
      } else {
        this.toast.show({ message: this.i18n.t('review.identifyNoMatch'), kind: 'info' });
      }
    } catch (err) {
      this.msg.set(httpErrorMessage(err, 'Could not identify the album.'));
    } finally {
      this.identifyingAlbum.set(false);
    }
  }

  /** Drop a track from the album entirely (confirmed) — no new route; the
   *  server's existing bulk-delete already goes through `deleteOne`. */
  async removeTrack(t: EditableTrack): Promise<void> {
    const ok = await this.confirm.ask(`Remove "${t.title}" from this album?`);
    if (!ok) return;
    try {
      await firstValueFrom(this.api.deleteSongs([t.id]));
      this.tracks.update((list) => list.filter((x) => x.id !== t.id));
    } catch (err) {
      this.msg.set(httpErrorMessage(err, 'Could not remove the track.'));
    }
  }

  /**
   * Persist only the edited (dirty) rows. The server returns 200 even on a
   * partial failure (`failed: [...]` for an unknown id / path escape), so a
   * non-empty `failed` must never read as success: no toast, no
   * `tracksSaved` emit (the modal stays open so the curator sees what
   * didn't land), and only the rows that *did* save have their dirty flags
   * cleared — a failed row keeps its edits so retrying is just "Save" again.
   */
  async saveTracks(): Promise<void> {
    const payload = dirtyTrackPayload(this.tracks());
    if (payload.length === 0 || this.savingTracks()) return;
    this.savingTracks.set(true);
    this.msg.set(null);
    try {
      const r = await firstValueFrom(this.review.retagTracks(this.albumId(), payload));
      const failedIds = r.failed.map((f) => f.id);
      this.tracks.update((list) => markTracksSaved(list, failedIds));
      if (r.failed.length > 0) {
        this.msg.set(
          this.i18n.t('review.tracksPartial', {
            updated: r.updated,
            failed: r.failed.length,
          }),
        );
      } else {
        this.toast.show({ message: this.i18n.t('review.tracksSaved'), kind: 'success' });
        this.tracksSaved.emit();
      }
    } catch (err) {
      this.msg.set(httpErrorMessage(err, 'Could not save the tracks.'));
    } finally {
      this.savingTracks.set(false);
    }
  }
}
