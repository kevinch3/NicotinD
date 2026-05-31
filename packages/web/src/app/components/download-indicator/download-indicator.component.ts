import { Component, inject, computed } from '@angular/core';
import { Router } from '@angular/router';
import { TransferService } from '../../services/transfer.service';

@Component({
  selector: 'app-download-indicator',
  templateUrl: './download-indicator.component.html',
})
export class DownloadIndicatorComponent {
  private transfers = inject(TransferService);
  private router = inject(Router);

  readonly activeCount = computed(() => {
    const ACTIVE = new Set(['InProgress', 'Queued', 'Initializing']);
    return this.transfers.downloads().reduce(
      (count, group) =>
        count + group.directories.filter(dir => dir.files.some(f => ACTIVE.has(f.state))).length,
      0,
    );
  });

  navigate(): void {
    this.router.navigate(['/downloads']);
  }
}
