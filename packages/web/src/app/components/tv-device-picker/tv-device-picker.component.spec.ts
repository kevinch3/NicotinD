import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { vi } from 'vitest';
import { TvDevicePickerComponent } from './tv-device-picker.component';
import { RemotePlaybackService } from '../../services/remote-playback.service';
import { PlaybackWsService } from '../../services/playback-ws.service';

describe('TvDevicePickerComponent', () => {
  function create() {
    TestBed.configureTestingModule({
      imports: [TvDevicePickerComponent],
      providers: [provideRouter([])],
    });
    const remote = TestBed.inject(RemotePlaybackService);
    const myId = TestBed.inject(PlaybackWsService).getDeviceId();
    const fixture = TestBed.createComponent(TvDevicePickerComponent);
    fixture.detectChanges();
    return { fixture, remote, myId };
  }

  const rows = (fixture: { nativeElement: HTMLElement }): HTMLButtonElement[] =>
    Array.from(fixture.nativeElement.querySelectorAll('[data-testid="tv-device-row"]'));

  afterEach(() => localStorage.clear());

  it('always offers this TV first, so the audio can always come home', () => {
    const { fixture } = create();

    // Even with an empty device list — the self row is not built from it.
    expect(rows(fixture)).toHaveLength(1);
    expect(rows(fixture)[0].getAttribute('data-device-id')).toBeNull();
  });

  it('lists the other connected devices', () => {
    const { fixture, remote, myId } = create();
    remote.setDevices([
      { id: myId, name: 'NicotinD TV', type: 'web', lastSeen: 0 },
      { id: 'p:1', name: 'Safari on iPhone', type: 'web', lastSeen: 0 },
    ]);
    fixture.detectChanges();

    const names = rows(fixture).map((r) => r.querySelector('span')?.textContent?.trim());
    expect(names).toEqual(['NicotinD TV', 'Safari on iPhone']);
  });

  it('lists a device that opted out but refuses to offer it', () => {
    const { fixture, remote } = create();
    remote.setDevices([{ id: 'p:1', name: 'Kiosk', type: 'web', lastSeen: 0, available: false }]);
    fixture.detectChanges();

    const kiosk = rows(fixture).find((r) => r.getAttribute('data-device-id') === 'p:1');
    expect(kiosk?.disabled).toBe(true);
  });

  it('picking a device moves the audio and closes', () => {
    const { fixture, remote, myId } = create();
    const switchTo = vi.spyOn(remote, 'switchToDevice').mockImplementation(() => {});
    remote.setSwitcherOpen(true);
    remote.setDevices([
      { id: myId, name: 'NicotinD TV', type: 'web', lastSeen: 0 },
      { id: 'p:1', name: 'Safari on iPhone', type: 'web', lastSeen: 0 },
    ]);
    fixture.detectChanges();

    rows(fixture)[1].click();

    expect(switchTo).toHaveBeenCalledWith('p:1');
    expect(remote.switcherOpen()).toBe(false);
  });

  it('closes without changing anything from the Back row', () => {
    const { fixture, remote } = create();
    const switchTo = vi.spyOn(remote, 'switchToDevice').mockImplementation(() => {});
    remote.setSwitcherOpen(true);

    (fixture.nativeElement as HTMLElement)
      .querySelector<HTMLElement>('[data-testid="tv-device-picker-back"]')!
      .click();

    expect(switchTo).not.toHaveBeenCalled();
    expect(remote.switcherOpen()).toBe(false);
  });
});
