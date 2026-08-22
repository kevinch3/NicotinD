import { TestBed } from '@angular/core/testing';
import { vi, beforeEach, describe, it, expect, afterEach } from 'vitest';
import { Subject, throwError, of, firstValueFrom } from 'rxjs';
import { ServiceReviewService } from './service-review.service';
import { SystemApiService } from './api/system-api.service';
import type { ServiceReview } from './api/api-types';

function makeReview(over: Partial<ServiceReview> = {}): ServiceReview {
  return {
    collectedAt: 1_700_000_000_000,
    version: '0.1.234',
    uptimeMs: 60_000,
    hardware: {
      cpuModel: 'Test CPU',
      cores: 4,
      arch: 'x64',
      platform: 'linux',
      totalMemoryBytes: 8000,
      gpuDetected: null,
    },
    load: {
      cpu: { percent: 25, cores: 4, model: 'Test CPU' },
      memory: {
        totalBytes: 8000,
        usedBytes: 4000,
        freeBytes: 4000,
        processRssBytes: 100,
        processHeapBytes: 50,
      },
      gpu: null,
    },
    services: {
      slskd: { configured: false, healthy: false, connected: false },
      analysis: { configured: false, healthy: false },
    },
    library: { scanning: false, indexedSongCount: 0 },
    updateCheck: null,
    backups: [],
    backupsSummary: { total: 0, totalBytes: 0, newestAt: null, lastBackupName: null },
    processing: null,
    maintenance: null,
    incompleteJobsCount: 0,
    untrackedCount: 0,
    orphanRows: [],
    playEvents: 0,
    artistImages: { visible: 0, withPortrait: 0, missing: 0, manualOverride: 0 },
    downloadReviews: { pending: 0, oldestCreated: null },
    auditTail: [],
    incompleteJobs: [],
    untracked: [],
    errors: [],
    ...over,
  };
}

describe('ServiceReviewService', () => {
  let getServiceReview: ReturnType<typeof vi.fn>;
  let service: ServiceReviewService;

  beforeEach(() => {
    getServiceReview = vi.fn(() => of(makeReview()));
    TestBed.configureTestingModule({
      providers: [
        ServiceReviewService,
        { provide: SystemApiService, useValue: { getServiceReview } },
      ],
    });
    service = TestBed.inject(ServiceReviewService);
  });

  afterEach(() => {
    service.stop();
  });

  it('start() fetches immediately and stops when stop() is called', async () => {
    const dispose = service.start();
    await firstValueFrom(service.refresh$);
    expect(getServiceReview).toHaveBeenCalled();
    expect(service.review()?.version).toBe('0.1.234');
    dispose();
    expect(service.active()).toBe(false);
  });

  it('exposes computed slices that reflect the underlying snapshot', async () => {
    service.start();
    await service.refresh();
    expect(service.cpu()?.percent).toBe(25);
    expect(service.memory()?.totalBytes).toBe(8000);
    expect(service.gpu()).toBeNull();
    expect(service.version()).toBe('0.1.234');
  });

  describe('downloadReviews (issue #417)', () => {
    it('defaults to zeros when the snapshot has none / hasn’t landed yet', async () => {
      service.start();
      await service.refresh();
      expect(service.downloadReviews()).toEqual({ pending: 0, oldestCreated: null });
      expect(service.reviewHeldCount()).toBe(0);
      expect(service.reviewHeldOldestDays()).toBeNull();
    });

    it('reflects a nonzero snapshot slice', async () => {
      const threeDaysAgo = new Date(Date.now() - 3 * 86_400_000).toISOString();
      getServiceReview.mockImplementationOnce(() =>
        of(makeReview({ downloadReviews: { pending: 2, oldestCreated: threeDaysAgo } })),
      );
      service.start();
      await service.refresh();
      expect(service.reviewHeldCount()).toBe(2);
      expect(service.reviewHeldOldestDays()).toBe(3);
    });

    it('clamps a future/skewed oldestCreated at 0 rather than going negative', async () => {
      const oneHourFromNow = new Date(Date.now() + 60 * 60 * 1000).toISOString();
      getServiceReview.mockImplementationOnce(() =>
        of(makeReview({ downloadReviews: { pending: 1, oldestCreated: oneHourFromNow } })),
      );
      service.start();
      await service.refresh();
      expect(service.reviewHeldOldestDays()).toBe(0);
    });
  });

  it('ref-counts concurrent start() / stop() calls — timer survives while owners remain', () => {
    service.start();
    service.start();
    expect(service.active()).toBe(true);
    service.stop();
    expect(service.active()).toBe(true);
    service.stop();
    expect(service.active()).toBe(false);
  });

  it('keeps the prior snapshot when the API throws and surfaces the error', async () => {
    service.start();
    await service.refresh(); // success path → snapshots the version
    getServiceReview.mockImplementationOnce(() => throwError(() => new Error('502 gateway')));
    await service.refresh();
    expect(service.lastError()).toBe('502 gateway');
    expect(service.review()?.version).toBe('0.1.234');
    expect(service.hasErrors()).toBe(false);
  });

  it('flags hasErrors when the snapshot itself reports degraded sub-fetches', async () => {
    getServiceReview.mockImplementationOnce(() =>
      of(makeReview({ errors: ['metrics: probe exploded', 'systemStatus: refused'] })),
    );
    service.start();
    await service.refresh();
    expect(service.errors()).toEqual(['metrics: probe exploded', 'systemStatus: refused']);
    expect(service.hasErrors()).toBe(true);
  });

  it('coalesces parallel refresh() calls into a single fetch', async () => {
    const subject = new Subject<ServiceReview>();
    getServiceReview = vi.fn(() => subject.asObservable());
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        ServiceReviewService,
        { provide: SystemApiService, useValue: { getServiceReview } },
      ],
    });
    const s = TestBed.inject(ServiceReviewService);
    void s.start();
    const p1 = s.refresh();
    const p2 = s.refresh();
    const p3 = s.refresh();
    subject.next(makeReview());
    subject.complete();
    await Promise.all([p1, p2, p3]);
    expect(getServiceReview).toHaveBeenCalledTimes(1);
    s.stop();
  });
});
