import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { signal } from '@angular/core';
import { vi } from 'vitest';
import { DownloadIndicatorComponent } from './download-indicator.component';
import { TransferService } from '../../services/transfer.service';
import { AcquireService } from '../../services/acquire.service';

// The active-count *logic* is covered in transfer.service.spec.ts; here we only
// verify the indicator sums slskd + acquire activity and navigates on click.
describe('DownloadIndicatorComponent', () => {
  const activeDownloadCount = signal(0);
  const activeJobs = signal<unknown[]>([]);

  beforeEach(async () => {
    activeDownloadCount.set(0);
    activeJobs.set([]);

    await TestBed.configureTestingModule({
      imports: [DownloadIndicatorComponent],
      providers: [
        { provide: TransferService, useValue: { activeDownloadCount } },
        { provide: AcquireService, useValue: { activeJobs } },
        { provide: Router, useValue: { navigate: vi.fn() } },
      ],
    }).compileComponents();
  });

  it('sums slskd transfers and in-flight acquire jobs', () => {
    const fixture = TestBed.createComponent(DownloadIndicatorComponent);
    fixture.detectChanges();
    expect(fixture.componentInstance.activeCount()).toBe(0);

    activeDownloadCount.set(3);
    fixture.detectChanges();
    expect(fixture.componentInstance.activeCount()).toBe(3);

    activeJobs.set([{}, {}]);
    fixture.detectChanges();
    expect(fixture.componentInstance.activeCount()).toBe(5);
  });

  it('navigate() calls router.navigate with /downloads', () => {
    const fixture = TestBed.createComponent(DownloadIndicatorComponent);
    const router = TestBed.inject(Router);
    fixture.componentInstance.navigate();
    expect(router.navigate).toHaveBeenCalledWith(['/downloads']);
  });
});
