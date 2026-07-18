import { TestBed } from '@angular/core/testing';
import { Subject } from 'rxjs';
import { vi } from 'vitest';
import { SwUpdate, VersionEvent, VersionReadyEvent } from '@angular/service-worker';
import { UpdateService } from './update.service';

function makeSwStub(isEnabled: boolean, checkForUpdateResult: 'true' | 'false' | 'reject' = 'false') {
  const stub = {
    isEnabled,
    versionUpdates: new Subject<VersionEvent>(),
    activateUpdate: vi.fn().mockResolvedValue(true),
    checkForUpdate: vi.fn(),
  };
  if (checkForUpdateResult === 'true') {
    stub.checkForUpdate.mockResolvedValue(true);
  } else if (checkForUpdateResult === 'reject') {
    stub.checkForUpdate.mockRejectedValue(new Error('network'));
  } else {
    stub.checkForUpdate.mockResolvedValue(false);
  }
  return stub;
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
    expect(service.enabled()).toBe(false);
    expect(service.checkAvailable()).toBe(false);
  });

  it('exposes enabled + checkAvailable when the service worker is enabled', () => {
    const sw = makeSwStub(true);
    const service = provide(sw);

    expect(service.enabled()).toBe(true);
    expect(service.checkAvailable()).toBe(true);
  });

  it('hides the manual checker once an update is already staged', () => {
    const sw = makeSwStub(true);
    const service = provide(sw);

    sw.versionUpdates.next(versionReady);

    expect(service.checkAvailable()).toBe(false);
  });

  it('checkForUpdate reports up-to-date when no new version is found', async () => {
    const sw = makeSwStub(true, 'false');
    const service = provide(sw);

    const result = await service.checkForUpdate();

    expect(result).toBe('up-to-date');
    expect(sw.checkForUpdate).toHaveBeenCalledTimes(1);
    expect(service.searching()).toBe(false);
  });

  it('checkForUpdate reports available when the SW staged a new version', async () => {
    const sw = makeSwStub(true, 'true');
    const service = provide(sw);

    const result = await service.checkForUpdate();

    expect(result).toBe('available');
    expect(service.searching()).toBe(false);
  });

  it('checkForUpdate returns unavailable without calling the SW when disabled', async () => {
    const sw = makeSwStub(false);
    const service = provide(sw);

    const result = await service.checkForUpdate();

    expect(result).toBe('unavailable');
    expect(sw.checkForUpdate).not.toHaveBeenCalled();
  });

  it('checkForUpdate rejects and clears searching when the SW throws', async () => {
    const sw = makeSwStub(true, 'reject');
    const service = provide(sw);

    await expect(service.checkForUpdate()).rejects.toThrow('network');
    expect(service.searching()).toBe(false);
  });

  it('checkForUpdate is reentrant-safe while a previous check is in flight', async () => {
    let resolveCheck!: (found: boolean) => void;
    const sw = makeSwStub(true);
    sw.checkForUpdate.mockImplementation(
      () => new Promise<boolean>((resolve) => { resolveCheck = resolve; }),
    );
    const service = provide(sw);

    const first = service.checkForUpdate();
    expect(service.searching()).toBe(true);
    const second = await service.checkForUpdate();

    expect(second).toBe('unavailable');
    expect(sw.checkForUpdate).toHaveBeenCalledTimes(1);

    resolveCheck(false);
    const firstResult = await first;

    expect(firstResult).toBe('up-to-date');
    expect(service.searching()).toBe(false);
  });

  it('applyUpdate activates the SW and reloads the document', async () => {
    const sw = makeSwStub(true);
    let activated = false;
    const activateDeferred = new Promise<void>((resolve) => {
      sw.activateUpdate.mockImplementation(async () => {
        activated = true;
        resolve();
        return true;
      });
    });
    const service = provide(sw);
    const inFlight = service.applyUpdate();
    await activateDeferred;
    expect(activated).toBe(true);
    await inFlight;
    expect(sw.activateUpdate).toHaveBeenCalledTimes(1);
  });
});
