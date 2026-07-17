import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { vi } from 'vitest';
import { of, throwError } from 'rxjs';
import { SetupService } from './setup.service';
import { SystemApiService } from './api/system-api.service';
import { NetworkStatusService } from './network-status.service';
import type { SetupStatus } from './api/api-types';

function makeApi(getSetupStatus: () => ReturnType<SystemApiService['getSetupStatus']>) {
  return { getSetupStatus: vi.fn(getSetupStatus) } as unknown as SystemApiService & {
    getSetupStatus: ReturnType<typeof vi.fn>;
  };
}

function configure(online: boolean, api: ReturnType<typeof makeApi>) {
  const net = { online: signal(online) };
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      SetupService,
      { provide: SystemApiService, useValue: api },
      { provide: NetworkStatusService, useValue: net as unknown as NetworkStatusService },
    ],
  });
  return { svc: TestBed.inject(SetupService), net };
}

const okStatus = (needsSetup: boolean) => () => of({ needsSetup } as SetupStatus);

describe('SetupService', () => {
  it('skips the HTTP probe entirely and is offline when the device reports offline', async () => {
    // Regression: an offline launch previously blocked bootstrap on a ~3s setup
    // probe (blank WebView → Android ANR). Offline is now known up front.
    const api = makeApi(okStatus(false));
    const { svc } = configure(false, api);

    await svc.check();

    expect(api.getSetupStatus).not.toHaveBeenCalled();
    expect(svc.isOffline()).toBe(true);
    expect(svc.checked()).toBe(true);
  });

  it('probes and is online when the server is reachable', async () => {
    const api = makeApi(okStatus(true));
    const { svc } = configure(true, api);

    await svc.check();

    expect(api.getSetupStatus).toHaveBeenCalled();
    expect(svc.isOffline()).toBe(false);
    expect(svc.status()?.needsSetup).toBe(true);
  });

  it('is offline when the network is up but the server is unreachable', async () => {
    const api = makeApi(() => throwError(() => new Error('down')));
    const { svc } = configure(true, api);

    await svc.check();

    expect(svc.isOffline()).toBe(true);
    expect(svc.checked()).toBe(true);
  });

  it('recomputes isOffline live when connectivity flips in both directions', async () => {
    const api = makeApi(okStatus(false));
    const { svc, net } = configure(true, api);

    await svc.check();
    expect(svc.isOffline()).toBe(false);

    // Drop mid-session → offline without any re-check.
    net.online.set(false);
    expect(svc.isOffline()).toBe(true);

    // Reconnect → back online, again reactively.
    net.online.set(true);
    expect(svc.isOffline()).toBe(false);
  });
});
