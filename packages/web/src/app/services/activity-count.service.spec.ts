import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { describe, expect, it } from 'vitest';
import { ActivityCountService } from './activity-count.service';
import { TransferService } from './transfer.service';
import { ImportUploadService } from './import-upload.service';

describe('ActivityCountService (#1938)', () => {
  function setup(unfinished: number, uploads: number) {
    const unfinishedCount = signal(unfinished);
    const inFlight = signal(uploads);
    TestBed.configureTestingModule({
      providers: [
        { provide: TransferService, useValue: { unfinishedCount } },
        { provide: ImportUploadService, useValue: { inFlight } },
      ],
    });
    return { service: TestBed.inject(ActivityCountService), unfinishedCount, inFlight };
  }

  it("is the header's unfinished count plus uploads not yet a job", () => {
    const { service } = setup(41, 1);
    expect(service.count()).toBe(42);
  });

  it('follows both as they change', () => {
    const { service, unfinishedCount, inFlight } = setup(2, 0);
    unfinishedCount.set(0);
    inFlight.set(3);
    expect(service.count()).toBe(3);
  });
});
