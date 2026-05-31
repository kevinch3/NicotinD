import { TestBed } from '@angular/core/testing';
import { Subject } from 'rxjs';
import { vi } from 'vitest';
import { SwUpdate, VersionEvent, VersionReadyEvent } from '@angular/service-worker';
import { UpdateService } from './update.service';

function makeSwStub(isEnabled: boolean) {
  return {
    isEnabled,
    versionUpdates: new Subject<VersionEvent>(),
    activateUpdate: vi.fn().mockResolvedValue(true),
  };
}

function provide(sw: ReturnType<typeof makeSwStub>) {
  TestBed.configureTestingModule({ providers: [{ provide: SwUpdate, useValue: sw }] });
  return TestBed.inject(UpdateService);
}

const versionReady = {
  type: 'VERSION_READY',
  currentVersion: { hash: 'a' },
  latestVersion: { hash: 'b' },
} as VersionReadyEvent;

describe('UpdateService', () => {
  it('flips updateAvailable to true on a VERSION_READY event', () => {
    const sw = makeSwStub(true);
    const service = provide(sw);
    expect(service.updateAvailable()).toBe(false);

    sw.versionUpdates.next(versionReady);

    expect(service.updateAvailable()).toBe(true);
  });

  it('ignores non-VERSION_READY events', () => {
    const sw = makeSwStub(true);
    const service = provide(sw);

    sw.versionUpdates.next({ type: 'VERSION_DETECTED', version: { hash: 'b' } } as VersionEvent);

    expect(service.updateAvailable()).toBe(false);
  });

  it('stays false when the service worker is disabled', () => {
    const sw = makeSwStub(false);
    const service = provide(sw);

    expect(service.updateAvailable()).toBe(false);
  });
});
