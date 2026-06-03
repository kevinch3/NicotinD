import { Component, inject, computed } from '@angular/core';
import { Router } from '@angular/router';
import { TransferService } from '../../services/transfer.service';
import { AcquireService } from '../../services/acquire.service';

@Component({
  selector: 'app-download-indicator',
  templateUrl: './download-indicator.component.html',
})
export class DownloadIndicatorComponent {
  private transfers = inject(TransferService);
  private acquire = inject(AcquireService);
  private router = inject(Router);

  // slskd transfers + in-flight URL acquisitions (yt-dlp/spotdl), so the badge
  // reflects all download activity app-wide, not just Soulseek.
  readonly activeCount = computed(
    () => this.transfers.activeDownloadCount() + this.acquire.activeJobs().length,
  );

  navigate(): void {
    this.router.navigate(['/downloads']);
  }
}
