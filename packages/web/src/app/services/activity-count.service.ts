import { Injectable, computed, inject } from '@angular/core';
import { TransferService } from './transfer.service';
import { ImportUploadService } from './import-upload.service';

/**
 * The number every Activity badge prints: the desktop nav link, the phone tab bar and the /get
 * tab. It is the Downloads header's unfinished count plus uploads that are not a job yet (#1664).
 * One service, because three copies of the formula already drifted once (the phone left out URL
 * acquisitions) and then disagreed with the header: 14 against "41 in progress" (#1938).
 */
@Injectable({ providedIn: 'root' })
export class ActivityCountService {
  private readonly transfers = inject(TransferService);
  private readonly uploads = inject(ImportUploadService);

  readonly count = computed(() => this.transfers.unfinishedCount() + this.uploads.inFlight());
}
