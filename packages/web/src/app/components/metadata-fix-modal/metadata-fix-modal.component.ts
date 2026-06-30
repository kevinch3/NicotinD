import {
  Component,
  HostListener,
  inject,
  input,
  output,
  signal,
  computed,
  OnInit,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';
import type { MetadataCandidate, AlbumCoverCandidate } from '../../../types/core';
import { LibraryApiService } from '../../services/api/library-api.service';
import { AuthService } from '../../services/auth.service';
import { ServerConfigService } from '../../services/server-config.service';
import { httpErrorMessage } from '../../lib/http-error';
import {
  defaultQuery,
  candidateToRequest,
  manualToRequest,
  isPlaceholderArtist,
} from '../../lib/metadata-fix';
import {
  flattenCoverCandidates,
  coverThumbUrl,
  coverCandidateToRequest,
  customCoverToRequest,
} from '../../lib/cover-candidates';

/**
 * Admin metadata fix modal: search Lidarr with an editable query, pick a candidate
 * (even low-confidence — the user confirms), or enter artist/album/year by hand.
 * Applying persists a correction the scanner honors. Emits `applied` with the new
 * albumId so the parent can re-fetch + cache-bust the cover.
 */
@Component({
  selector: 'app-metadata-fix-modal',
  standalone: true,
  imports: [FormsModule],
  templateUrl: './metadata-fix-modal.component.html',
})
export class MetadataFixModalComponent implements OnInit {
  private api = inject(LibraryApiService);
  readonly auth = inject(AuthService);
  private server = inject(ServerConfigService);

  readonly albumId = input.required<string>();
  readonly currentArtist = input<string>('');
  readonly currentAlbum = input<string>('');

  readonly applied = output<{ albumId: string }>();
  /** Emitted after a cover-only change so the parent can refetch + cache-bust without closing. */
  readonly coverChanged = output<void>();
  readonly cancel = output<void>();

  // Cover picker state.
  readonly coverOptions = signal<AlbumCoverCandidate[]>([]);
  readonly coverApplying = signal(false);
  readonly customCoverUrl = signal('');

  readonly query = signal('');
  // The stored artist is a placeholder ("<Desconocido>") — prompt the user to type
  // the real artist, since the default query was searched by album title alone.
  readonly artistIsPlaceholder = computed(() => isPlaceholderArtist(this.currentArtist()));
  readonly searched = signal(false);
  readonly searching = signal(false);
  readonly applying = signal(false);
  readonly candidates = signal<MetadataCandidate[]>([]);
  readonly msg = signal<string | null>(null);

  // Free-text fallback fields.
  readonly manualArtist = signal('');
  readonly manualAlbum = signal('');
  readonly manualYear = signal('');

  /** Prefill the search box + manual fields from the album's current values. */
  ngOnInit(): void {
    this.query.set(defaultQuery(this.currentArtist(), this.currentAlbum()));
    this.manualArtist.set(this.currentArtist());
    this.manualAlbum.set(this.currentAlbum());
    // Show the current cover immediately; Lidarr alts + per-track art arrive
    // async (and must not block the picker on a slow/dead Lidarr lookup).
    this.coverOptions.set([this.currentCoverOption()]);
    void this.loadCovers();
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
    if (req) await this.applyCover(req);
  }

  /** Apply a pasted cover URL. */
  async applyCustomCover(): Promise<void> {
    const req = customCoverToRequest(this.customCoverUrl());
    if (!req) {
      this.msg.set('Paste an image URL first.');
      return;
    }
    await this.applyCover(req);
  }

  private async applyCover(req: import('../../../types/core').ApplyCoverRequest): Promise<void> {
    if (this.coverApplying()) return;
    this.coverApplying.set(true);
    this.msg.set(null);
    try {
      await firstValueFrom(this.api.applyCover(this.albumId(), req));
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

  @HostListener('document:keydown.escape')
  onEscape(): void {
    this.cancel.emit();
  }

  async search(): Promise<void> {
    if (this.searching()) return;
    this.searching.set(true);
    this.msg.set(null);
    try {
      const r = await firstValueFrom(this.api.getMetadataCandidates(this.albumId(), this.query()));
      this.candidates.set(r.candidates);
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
}
