import { Component, inject } from '@angular/core';
import { ReportTrackService } from '../../services/report-track.service';
import { ReportTrackDialogComponent } from '../report-track-dialog/report-track-dialog.component';

@Component({
  selector: 'app-report-track-host',
  imports: [ReportTrackDialogComponent],
  template: `
    @if (report.target(); as trackId) {
      <app-report-track-dialog [trackId]="trackId" (closed)="report.close()" />
    }
  `,
})
export class ReportTrackHostComponent {
  readonly report = inject(ReportTrackService);
}
