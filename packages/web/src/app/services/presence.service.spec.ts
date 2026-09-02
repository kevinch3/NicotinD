import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { of } from 'rxjs';
import { PresenceService } from './presence.service';
import { resolveTabId } from '../lib/device-id';
import { AuthService } from './auth.service';
import { PlaybackWsService } from './playback-ws.service';
import { SystemApiService } from './api/system-api.service';

/**
 * Presence counts DEVICES (`amountOfDevices` is a set of `deviceId`), so it
 * must report the machine, not the output. Since #882 the playback device id
 * is per-tab — reporting it here would turn "3 tabs on one laptop" into three
 * devices in the Admin users table.
 */
describe('PresenceService (#882)', () => {
  const PROFILE = 'profile-uuid';

  function setup() {
    const calls: { deviceId: string; tabId: string }[] = [];
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        PresenceService,
        { provide: AuthService, useValue: { token: signal('t') } },
        {
          provide: PlaybackWsService,
          useValue: { getDeviceId: () => `${PROFILE}:tab-7` },
        },
        {
          provide: SystemApiService,
          useValue: {
            postHeartbeat: (deviceId: string, tabId: string) => {
              calls.push({ deviceId, tabId });
              return of(null);
            },
          },
        },
      ],
    });
    const service = TestBed.inject(PresenceService);
    TestBed.runInInjectionContext(() => service.initialize());
    TestBed.tick();
    return calls;
  }

  it('reports the browser, not the tab, as the device', () => {
    expect(setup()[0].deviceId).toBe(PROFILE);
  });

  it('still distinguishes tabs, through the shared tab-id helper', () => {
    expect(setup()[0].tabId).toBe(resolveTabId(sessionStorage));
  });
});
