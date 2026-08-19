import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import type { RadioPollResults, RadioPollSummary } from '../../../../types/core';
import type { Song } from '../../../services/api/api-types';
import { RadioPollService } from '../../../services/radio-poll.service';
import { ToastService } from '../../../services/toast.service';
import { ConfirmService } from '../../../services/confirm.service';
import { TranslateService } from '../../../services/translate.service';
import { TranslatePipe } from '../../../pipes/translate.pipe';
import { SongPickerComponent } from '../../../components/song-picker/song-picker.component';
import { approvalShare, breakdownLine } from './radio-polls-card.lib';

/**
 * Admin card for radio evaluation polls (docs/radio-eval-polls.md): create a
 * poll (freezing its scenarios), copy the public link, watch tallies come in,
 * and close/delete. Loads on demand from the settings-group's `opened` output
 * (a dev/curation list, never the ServiceReview poll — same stance as the
 * generation-feedback queue).
 */
@Component({
  selector: 'app-radio-polls-card',
  standalone: true,
  imports: [FormsModule, TranslatePipe, SongPickerComponent],
  templateUrl: './radio-polls-card.component.html',
})
export class RadioPollsCardComponent {
  private polls = inject(RadioPollService);
  private toast = inject(ToastService);
  private confirm = inject(ConfirmService);
  private i18n = inject(TranslateService);

  readonly rows = signal<RadioPollSummary[]>([]);
  readonly loading = signal(false);
  readonly loaded = signal(false);

  // Create form
  readonly name = signal('');
  readonly scenarioCount = signal(5);
  readonly nextUpCount = signal(5);
  readonly expiresInHours = signal<number | null>(null);
  readonly pinnedSeeds = signal<Song[]>([]);
  readonly creating = signal(false);

  // Per-poll expanded results
  readonly openResults = signal<RadioPollResults | null>(null);
  readonly resultsLoadingId = signal<string | null>(null);

  readonly breakdownLine = breakdownLine;
  readonly approvalShare = approvalShare;

  /** Fetch once per page visit — the group re-emits `opened` on every expand. */
  load(): void {
    if (this.loaded() || this.loading()) return;
    this.loading.set(true);
    this.polls.list().subscribe({
      next: (rows) => {
        this.rows.set(rows);
        this.loaded.set(true);
        this.loading.set(false);
      },
      error: () => this.loading.set(false),
    });
  }

  reload(): void {
    this.loaded.set(false);
    this.load();
  }

  addPinnedSeed(song: Song): void {
    if (this.pinnedSeeds().some((s) => s.id === song.id)) return;
    this.pinnedSeeds.update((s) => [...s, song]);
  }

  removePinnedSeed(id: string): void {
    this.pinnedSeeds.update((s) => s.filter((x) => x.id !== id));
  }

  pinnedSeedIds(): string[] {
    return this.pinnedSeeds().map((s) => s.id);
  }

  create(): void {
    const name = this.name().trim();
    if (!name || this.creating()) return;
    this.creating.set(true);
    this.polls
      .create({
        name,
        scenarioCount: this.scenarioCount(),
        nextUpCount: this.nextUpCount(),
        pinnedSeedIds: this.pinnedSeedIds(),
        expiresInHours: this.expiresInHours() ?? undefined,
      })
      .subscribe({
        next: ({ url }) => {
          this.creating.set(false);
          this.name.set('');
          this.pinnedSeeds.set([]);
          this.copyLink(url);
          this.reload();
        },
        error: (err: { error?: { error?: string } }) => {
          this.creating.set(false);
          this.toast.show({
            message: err.error?.error ?? this.i18n.t('admin.radioPollsCreateFailed'),
            kind: 'error',
          });
        },
      });
  }

  copyLink(url: string): void {
    navigator.clipboard?.writeText(url).catch(() => {});
    this.toast.show({ message: this.i18n.t('admin.radioPollsLinkCopied'), kind: 'success' });
  }

  toggleResults(row: RadioPollSummary): void {
    if (this.openResults()?.poll.id === row.id) {
      this.openResults.set(null);
      return;
    }
    this.resultsLoadingId.set(row.id);
    this.polls.results(row.id).subscribe({
      next: (results) => {
        this.openResults.set(results);
        this.resultsLoadingId.set(null);
      },
      error: () => this.resultsLoadingId.set(null),
    });
  }

  close(row: RadioPollSummary): void {
    this.polls.close(row.id).subscribe(() => {
      this.rows.update((rs) =>
        rs.map((r) => (r.id === row.id ? { ...r, closedAt: Date.now() } : r)),
      );
    });
  }

  async remove(row: RadioPollSummary): Promise<void> {
    const ok = await this.confirm.ask(this.i18n.t('admin.radioPollsDeleteConfirm'));
    if (!ok) return;
    this.polls.remove(row.id).subscribe(() => {
      if (this.openResults()?.poll.id === row.id) this.openResults.set(null);
      this.rows.update((rs) => rs.filter((r) => r.id !== row.id));
    });
  }

  status(row: RadioPollSummary): 'open' | 'closed' | 'expired' {
    if (row.closedAt != null) return 'closed';
    if (row.expiresAt != null && Date.now() >= row.expiresAt) return 'expired';
    return 'open';
  }

  formatWhen(at: number): string {
    return new Date(at).toLocaleString();
  }
}
