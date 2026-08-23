import { Component, OnDestroy, inject } from '@angular/core';
import { ServiceReviewService } from '../../services/service-review.service';
import { SettingsGroupComponent } from '../../components/settings-group/settings-group.component';
import { TranslatePipe } from '../../pipes/translate.pipe';
import { RadioPollsCardComponent } from './radio-polls/radio-polls-card.component';
import { UserManagementPanelComponent } from './user-management/user-management-panel.component';
import { LibraryProcessingPanelComponent } from './library-processing/library-processing-panel.component';
import { SystemHealthPanelComponent } from './system-health/system-health-panel.component';
import { LibraryMaintenancePanelComponent } from './library-maintenance/library-maintenance-panel.component';
import { StreamingMediaPanelComponent } from './streaming-media/streaming-media-panel.component';
import { BackupsDataPanelComponent } from './backups-data/backups-data-panel.component';
import { AcquisitionAutomationPanelComponent } from './acquisition-automation/acquisition-automation-panel.component';
import { AuditLogPanelComponent } from './audit-log/audit-log-panel.component';

/**
 * The Admin page shell. Each section is its own panel component, so this
 * template is an ordered list of tags and **reordering a section is a one-line
 * move** — guarded by "renders the panels in the intended order" in the spec.
 *
 * The shell keeps exactly one responsibility: owning the `ServiceReview`
 * polling lifecycle. That service is root-provided with a refcounted
 * `start()`/`stop()` and a coalescing `refresh()`, so every panel injects the
 * same instance and reads `computed()` slices off a single 5 s poll — but the
 * timer has to be started and disposed once, by the page. A panel doing it
 * would keep the poll alive after the route unmounts.
 */
@Component({
  selector: 'app-admin',
  imports: [
    TranslatePipe,
    SettingsGroupComponent,
    RadioPollsCardComponent,
    UserManagementPanelComponent,
    LibraryProcessingPanelComponent,
    SystemHealthPanelComponent,
    LibraryMaintenancePanelComponent,
    StreamingMediaPanelComponent,
    BackupsDataPanelComponent,
    AcquisitionAutomationPanelComponent,
    AuditLogPanelComponent,
  ],
  templateUrl: './admin.component.html',
})
export class AdminComponent implements OnDestroy {
  private readonly reviewSvc = inject(ServiceReviewService);
  private readonly reviewDispose: () => void;

  constructor() {
    this.reviewDispose = this.reviewSvc.start();
  }

  ngOnDestroy(): void {
    this.reviewDispose();
  }
}
