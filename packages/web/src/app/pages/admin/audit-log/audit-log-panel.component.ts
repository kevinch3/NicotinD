import { Component, inject } from '@angular/core';
import { SettingsGroupComponent } from '../../../components/settings-group/settings-group.component';
import { TranslatePipe } from '../../../pipes/translate.pipe';
import { ServiceReviewService } from '../../../services/service-review.service';

/**
 * Admin card for the audit log — the recent destructive/curation actions
 * recorded by `recordAudit` (docs/roles.md). Read-only, and it starts no poll of
 * its own: the rows arrive on the shared `ServiceReview` snapshot, which
 * `AdminComponent` owns the lifecycle of.
 *
 * `host: { class: 'contents' }` keeps the host box out of the layout so the
 * group's `<section>` stays a direct flow child of `.page-shell`, exactly as it
 * was when this markup lived inline in `admin.component.html`.
 */
@Component({
  selector: 'app-audit-log-panel',
  standalone: true,
  host: { class: 'contents' },
  imports: [SettingsGroupComponent, TranslatePipe],
  templateUrl: './audit-log-panel.component.html',
})
export class AuditLogPanelComponent {
  private readonly reviewSvc = inject(ServiceReviewService);

  readonly auditTail = this.reviewSvc.auditTail;

  formatAuditTime(ms: number): string {
    return new Date(ms).toLocaleString();
  }
}
