import { TestBed } from '@angular/core/testing';
import { TransferService } from './transfer.service';
import { ApiService } from './api.service';
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
        state: state as never,
        bytesTransferred: 0,
        averageSpeed: 0,
        percentComplete: 0,
      })),
    })),
  };
}

describe('TransferService.activeDownloadCount', () => {
  let service: TransferService;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [TransferService, { provide: ApiService, useValue: {} }],
    });
    service = TestBed.inject(TransferService);
  });

  it('is 0 with no downloads', () => {
    expect(service.activeDownloadCount()).toBe(0);
  });

  it('counts a directory with at least one InProgress file', () => {
    service.downloads.set([makeGroup([['InProgress'], ['Completed']])]);
    expect(service.activeDownloadCount()).toBe(1);
  });

  it('counts Queued and Initializing as active', () => {
    service.downloads.set([makeGroup([['Queued'], ['Initializing'], ['Completed']])]);
    expect(service.activeDownloadCount()).toBe(2);
  });

  it('counts across multiple users and directories', () => {
    service.downloads.set([
      makeGroup([['InProgress', 'InProgress'], ['Completed']]),
      makeGroup([['Queued'], ['Initializing']]),
    ]);
    expect(service.activeDownloadCount()).toBe(3);
  });

  it('is 0 when all files are terminal', () => {
    service.downloads.set([makeGroup([['Completed'], ['Failed'], ['Cancelled']])]);
    expect(service.activeDownloadCount()).toBe(0);
  });

  it('reacts to signal updates', () => {
    expect(service.activeDownloadCount()).toBe(0);
    service.downloads.set([makeGroup([['InProgress']])]);
    expect(service.activeDownloadCount()).toBe(1);
    service.downloads.set([]);
    expect(service.activeDownloadCount()).toBe(0);
  });
});
