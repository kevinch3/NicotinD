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

function makeRemoteStub(devices: RemoteDevice[], activeDeviceId: string | null) {
  return {
    devices: signal(devices),
    activeDeviceId: signal(activeDeviceId),
    switcherOpen: signal(true),
    setSwitcherOpen: () => {},
    switchToDevice: () => {},
  };
}

function setup(devices: RemoteDevice[], activeDeviceId: string | null = null) {
  const remoteStub = makeRemoteStub(devices, activeDeviceId);
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
  it('always exposes the toggle testid', () => {
    const { fixture } = setup([]);
    const el: HTMLElement = fixture.nativeElement;
    expect(el.querySelector('[data-testid="device-switcher-toggle"]')).not.toBeNull();
  });

  it('renders the panel + self option when the switcher is open', () => {
    const { fixture } = setup([{ id: MY_ID, name: 'Self', type: 'web', lastSeen: Date.now() }]);
    const el: HTMLElement = fixture.nativeElement;
    expect(el.querySelector('[data-testid="device-switcher-panel"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="device-option-self"]')).not.toBeNull();
  });

  it('lists other remote devices with a data-device-id and marks the active one NOW PLAYING', () => {
    const other: RemoteDevice = { id: 'target-device', name: 'Living Room', type: 'web', lastSeen: Date.now() };
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

  it('hides the panel when the switcher is closed', () => {
    const { fixture, remoteStub } = setup([]);
    remoteStub.switcherOpen.set(false);
    fixture.detectChanges();
    const el: HTMLElement = fixture.nativeElement;
    expect(el.querySelector('[data-testid="device-switcher-panel"]')).toBeNull();
  });
});
