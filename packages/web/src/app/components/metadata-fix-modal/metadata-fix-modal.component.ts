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
import type { MetadataCandidate } from '../../../types/core';
import { ApiService } from '../../services/api.service';
import { AuthService } from '../../services/auth.service';
import { httpErrorMessage } from '../../lib/http-error';
import {
  defaultQuery,
  candidateToRequest,
  manualToRequest,
  isPlaceholderArtist,
} from '../../lib/metadata-fix';

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
  private api = inject(ApiService);
  readonly auth = inject(AuthService);

  readonly albumId = input.required<string>();
  readonly currentArtist = input<string>('');
  readonly currentAlbum = input<string>('');

  readonly applied = output<{ albumId: string }>();
  readonly cancel = output<void>();

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
