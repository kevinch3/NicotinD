import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { DeviceSwitcherComponent } from './device-switcher.component';
import { RemotePlaybackService, type RemoteDevice } from '../../services/remote-playback.service';
import { PlaybackWsService } from '../../services/playback-ws.service';

/**
 * Guards the e2e-targeted `data-testid` contract on the device switcher (the
 * remote-playback "cast" control). The two-context remote-playback playground
 * flow drives these selectors, so a renamed/dropped testid silently breaks the
 * only coverage of the cast UI — this spec fails fast in the CI web job instead.
 */
const MY_ID = 'self-device';

function makeRemoteStub(devices: RemoteDevice[], activeDeviceId: string | null, open = true) {
  return {
    devices: signal(devices),
    activeDeviceId: signal(activeDeviceId),
    switcherOpen: signal(open),
    setSwitcherOpen: () => {},
    switchToDevice: () => {},
  };
}

function setup(devices: RemoteDevice[], activeDeviceId: string | null = null, open = true) {
  const remoteStub = makeRemoteStub(devices, activeDeviceId, open);
  TestBed.configureTestingModule({
    imports: [DeviceSwitcherComponent],
    providers: [
      { provide: RemotePlaybackService, useValue: remoteStub },
      {
        provide: PlaybackWsService,
        useValue: { getDeviceId: () => MY_ID, getDeviceName: () => 'Self' },
      },
    ],
  });
  const fixture = TestBed.createComponent(DeviceSwitcherComponent);
  fixture.detectChanges();
  return { fixture, remoteStub };
}

describe('DeviceSwitcherComponent', () => {
  it('exposes the toggle testid whenever there is somewhere to send the audio', () => {
    const other: RemoteDevice = {
      id: 'target-device',
      name: 'Living Room',
      type: 'web',
      lastSeen: Date.now(),
    };
    const { fixture } = setup([{ id: MY_ID, name: 'Self', type: 'web', lastSeen: 0 }, other]);
    const el: HTMLElement = fixture.nativeElement;
    expect(el.querySelector('[data-testid="device-switcher-toggle"]')).not.toBeNull();
  });

  /**
   * A cast button on a single-device setup is a dead control sitting right
   * beside Next, and the only thing behind it is "no other devices" (#1262).
   */
  describe('with nowhere else to play', () => {
    const self: RemoteDevice = { id: MY_ID, name: 'Self', type: 'web', lastSeen: 0 };

    it('hides the toggle when this device is the only one', () => {
      const { fixture } = setup([self], null, false);
      expect(
        (fixture.nativeElement as HTMLElement).querySelector(
          '[data-testid="device-switcher-toggle"]',
        ),
      ).toBeNull();
    });

    it('hides it on an empty roster too', () => {
      const { fixture } = setup([], null, false);
      expect(
        (fixture.nativeElement as HTMLElement).querySelector(
          '[data-testid="device-switcher-toggle"]',
        ),
      ).toBeNull();
    });

    /** Hiding it here would strand the listener with no way to pull the audio back. */
    it('keeps it while the audio is playing somewhere else', () => {
      const { fixture } = setup([self], 'gone-device', false);
      expect(
        (fixture.nativeElement as HTMLElement).querySelector(
          '[data-testid="device-switcher-toggle"]',
        ),
      ).not.toBeNull();
    });

    /** Other surfaces open the picker without this button; the trigger must not
     *  disappear out from under an open popover. */
    it('keeps it while the panel is open', () => {
      const { fixture } = setup([self], null, true);
      expect(
        (fixture.nativeElement as HTMLElement).querySelector(
          '[data-testid="device-switcher-toggle"]',
        ),
      ).not.toBeNull();
    });

    /** The panel is never gated — only its trigger is. */
    it('still renders the panel when something else opened it', () => {
      const { fixture } = setup([self], null, true);
      expect(
        (fixture.nativeElement as HTMLElement).querySelector(
          '[data-testid="device-switcher-panel"]',
        ),
      ).not.toBeNull();
    });
  });

  it('renders the panel + self option when the switcher is open', () => {
    const { fixture } = setup([{ id: MY_ID, name: 'Self', type: 'web', lastSeen: Date.now() }]);
    const el: HTMLElement = fixture.nativeElement;
    expect(el.querySelector('[data-testid="device-switcher-panel"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="device-option-self"]')).not.toBeNull();
  });

  it('lists other remote devices with a data-device-id and marks the active one NOW PLAYING', () => {
    const other: RemoteDevice = {
      id: 'target-device',
      name: 'Living Room',
      type: 'web',
      lastSeen: Date.now(),
    };
    const { fixture } = setup(
      [{ id: MY_ID, name: 'Self', type: 'web', lastSeen: Date.now() }, other],
      other.id,
    );
    const el: HTMLElement = fixture.nativeElement;

    const option = el.querySelector('[data-testid="device-option"]');
    expect(option).not.toBeNull();
    expect(option?.getAttribute('data-device-id')).toBe('target-device');
    // The active remote device surfaces the NOW PLAYING badge the controller asserts on.
    expect(el.querySelector('[data-testid="device-now-playing"]')).not.toBeNull();
  });

  it('lists a device that opted out, disabled and outside the offerable testid', () => {
    const out: RemoteDevice = {
      id: 'kiosk',
      name: 'Kiosk',
      type: 'web',
      lastSeen: Date.now(),
      available: false,
    };
    const { fixture } = setup([
      { id: MY_ID, name: 'Self', type: 'web', lastSeen: Date.now() },
      out,
    ]);
    const el: HTMLElement = fixture.nativeElement;
    expect(el.querySelector('[data-testid="device-option"]')).toBeNull();
    const row = el.querySelector('[data-testid="device-option-unavailable"]') as HTMLButtonElement;
    expect(row).not.toBeNull();
    expect(row.disabled).toBe(true);
    expect(row.textContent).toContain('Kiosk');
  });

  it('an opted-out device that is the output still wears the NOW PLAYING badge', () => {
    const out: RemoteDevice = {
      id: 'kiosk',
      name: 'Kiosk',
      type: 'web',
      lastSeen: Date.now(),
      available: false,
    };
    const { fixture } = setup([out], out.id);
    const el: HTMLElement = fixture.nativeElement;
    expect(el.querySelector('[data-testid="device-now-playing"]')).not.toBeNull();
  });

  it('hides the panel when the switcher is closed', () => {
    const { fixture, remoteStub } = setup([]);
    remoteStub.switcherOpen.set(false);
    fixture.detectChanges();
    const el: HTMLElement = fixture.nativeElement;
    expect(el.querySelector('[data-testid="device-switcher-panel"]')).toBeNull();
  });
});

describe('DeviceSwitcherComponent sibling tabs (#882)', () => {
  const PROFILE = 'profile-x';
  const MINE = `${PROFILE}:tab-1`;
  const SIBLING = `${PROFILE}:tab-2`;
  const STRANGER = 'profile-y:tab-1';

  function setupTabs(activeDeviceId: string | null = null) {
    const remoteStub = makeRemoteStub(
      [
        { id: MINE, name: 'Chrome on Linux', type: 'web', lastSeen: Date.now() },
        { id: SIBLING, name: 'Chrome on Linux', type: 'web', lastSeen: Date.now() },
        { id: STRANGER, name: 'Chrome on Linux', type: 'web', lastSeen: Date.now() },
      ],
      activeDeviceId,
    );
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [DeviceSwitcherComponent],
      providers: [
        { provide: RemotePlaybackService, useValue: remoteStub },
        {
          provide: PlaybackWsService,
          useValue: { getDeviceId: () => MINE, getDeviceName: () => 'Chrome on Linux' },
        },
      ],
    });
    const fixture = TestBed.createComponent(DeviceSwitcherComponent);
    fixture.detectChanges();
    return fixture;
  }

  function siblingMark(fixture: ReturnType<typeof setupTabs>, deviceId: string): Element | null {
    const el: HTMLElement = fixture.nativeElement;
    const row = el.querySelector(`[data-device-id="${deviceId}"]`);
    return row?.querySelector('[data-testid="device-sibling-tab"]') ?? null;
  }

  it('marks another tab of this browser instead of showing an identical row', () => {
    const fixture = setupTabs();
    expect(siblingMark(fixture, SIBLING)).not.toBeNull();
  });

  it('leaves a different browser with the same name unmarked', () => {
    const fixture = setupTabs();
    expect(siblingMark(fixture, STRANGER)).toBeNull();
  });

  it('still lists a sibling tab as a selectable target', () => {
    const fixture = setupTabs();
    const el: HTMLElement = fixture.nativeElement;
    expect(el.querySelector(`[data-device-id="${SIBLING}"]`)).not.toBeNull();
  });
});
