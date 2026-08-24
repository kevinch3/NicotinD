import { Component, inject, signal } from '@angular/core';
import { SettingsGroupComponent } from '../../../components/settings-group/settings-group.component';
import { TranslatePipe } from '../../../pipes/translate.pipe';
import { ServiceReviewService } from '../../../services/service-review.service';
import { LibraryApiService } from '../../../services/api/library-api.service';
import { ToastService } from '../../../services/toast.service';
import { TranslateService } from '../../../services/translate.service';

/**
 * Admin card for the curation review queue (issue #682) — the cases a curator or
 * an MCP agent deliberately did not decide alone. Read-only apart from Resolve,
 * and it starts no poll of its own: the rows arrive on the shared `ServiceReview`
 * snapshot, whose lifecycle `AdminComponent` owns.
 *
 * `host: { class: 'contents' }` keeps the host box out of the layout so the
 * group's `<section>` stays a direct flow child of `.page-shell`, matching every
 * other panel.
 */
@Component({
  selector: 'app-review-flags-panel',
  standalone: true,
  host: { class: 'contents' },
  imports: [SettingsGroupComponent, TranslatePipe],
  templateUrl: './review-flags-panel.component.html',
})
export class ReviewFlagsPanelComponent {
  private readonly reviewSvc = inject(ServiceReviewService);
  private readonly api = inject(LibraryApiService);
  private readonly toast = inject(ToastService);
  private readonly i18n = inject(TranslateService);

  readonly flags = this.reviewSvc.reviewFlags;
  /** Ids resolved in this session, hidden immediately so the row does not sit
   *  there looking unhandled until the next snapshot lands. */
  readonly resolved = signal<ReadonlySet<number>>(new Set());
  readonly resolving = signal<number | null>(null);

  openFlags(): ReadonlyArray<{
    id: number;
    targetKind: string;
    targetId: string;
    reason: string;
    createdBy: string;
    createdAt: number;
  }> {
    const done = this.resolved();
    return this.flags().filter((f) => !done.has(f.id));
  }

  formatFlagTime(ms: number): string {
    return new Date(ms).toLocaleString();
  }

  resolve(id: number): void {
    if (this.resolving() !== null) return;
    this.resolving.set(id);
    this.api.resolveReviewFlag(id).subscribe({
      next: () => {
        this.resolved.update((s) => new Set([...s, id]));
        this.resolving.set(null);
      },
      error: () => {
        this.resolving.set(null);
        this.toast.show({ message: this.i18n.t('admin.reviewFlagResolveFailed'), kind: 'error' });
      },
    });
  }
}
