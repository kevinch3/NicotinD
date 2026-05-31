import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { signal } from '@angular/core';
import { vi } from 'vitest';
import { DownloadIndicatorComponent } from './download-indicator.component';
import { TransferService } from '../../services/transfer.service';
import type { SlskdUserTransferGroup } from '@nicotind/core';

function makeGroup(states: string[][]): SlskdUserTransferGroup {
  return {
    username: 'user',
    directories: states.map((fileStates, i) => ({
      directory: `/dir${i}`,
      fileCount: fileStates.length,
      files: fileStates.map((state, j) => ({
        id: `${i}-${j}`,
        username: 'user',
        filename: `file${j}`,
        size: 0,
        state: state as any,
        bytesTransferred: 0,
        averageSpeed: 0,
        percentComplete: 0,
      })),
    })),
  };
}

describe('DownloadIndicatorComponent', () => {
  const downloadsSignal = signal<SlskdUserTransferGroup[]>([]);

  beforeEach(async () => {
    downloadsSignal.set([]);

    await TestBed.configureTestingModule({
      imports: [DownloadIndicatorComponent],
      providers: [
        {
          provide: TransferService,
          useValue: { downloads: downloadsSignal },
        },
        {
          provide: Router,
          useValue: { navigate: vi.fn() },
        },
      ],
    }).compileComponents();
  });

  it('returns 0 when there are no downloads', () => {
    const fixture = TestBed.createComponent(DownloadIndicatorComponent);
    fixture.detectChanges();
    expect(fixture.componentInstance.activeCount()).toBe(0);
  });

  it('counts directories that have at least one InProgress file', () => {
    downloadsSignal.set([makeGroup([['InProgress'], ['Completed']])]);
    const fixture = TestBed.createComponent(DownloadIndicatorComponent);
    fixture.detectChanges();
    // first dir has InProgress → counted; second dir has Completed → not counted
    expect(fixture.componentInstance.activeCount()).toBe(1);
  });

  it('counts Queued and Initializing as active', () => {
    downloadsSignal.set([makeGroup([['Queued'], ['Initializing'], ['Completed']])]);
    const fixture = TestBed.createComponent(DownloadIndicatorComponent);
    fixture.detectChanges();
    expect(fixture.componentInstance.activeCount()).toBe(2);
  });

  it('counts across multiple users and directories', () => {
    downloadsSignal.set([
      makeGroup([['InProgress', 'InProgress'], ['Completed']]),
      makeGroup([['Queued'], ['Initializing']]),
    ]);
    const fixture = TestBed.createComponent(DownloadIndicatorComponent);
    fixture.detectChanges();
    // user1: 1 active dir (first); user2: 2 active dirs → total 3
    expect(fixture.componentInstance.activeCount()).toBe(3);
  });

  it('returns 0 when all files are in a terminal state', () => {
    downloadsSignal.set([makeGroup([['Completed'], ['Failed'], ['Cancelled']])]);
    const fixture = TestBed.createComponent(DownloadIndicatorComponent);
    fixture.detectChanges();
    expect(fixture.componentInstance.activeCount()).toBe(0);
  });

  it('reacts to signal updates without re-creating the component', () => {
    const fixture = TestBed.createComponent(DownloadIndicatorComponent);
    fixture.detectChanges();
    expect(fixture.componentInstance.activeCount()).toBe(0);

    downloadsSignal.set([makeGroup([['InProgress']])]);
    fixture.detectChanges();
    expect(fixture.componentInstance.activeCount()).toBe(1);

    downloadsSignal.set([]);
    fixture.detectChanges();
    expect(fixture.componentInstance.activeCount()).toBe(0);
  });

  it('navigate() calls router.navigate with /downloads', () => {
    const fixture = TestBed.createComponent(DownloadIndicatorComponent);
    const router = TestBed.inject(Router);
    fixture.componentInstance.navigate();
    expect(router.navigate).toHaveBeenCalledWith(['/downloads']);
  });
});
