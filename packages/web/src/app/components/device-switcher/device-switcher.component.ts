import {
  Component,
  inject,
  signal,
  ElementRef,
  HostListener,
  computed,
  input,
} from '@angular/core';
import { RemotePlaybackService } from '../../services/remote-playback.service';
import { PlaybackWsService } from '../../services/playback-ws.service';
import { otherDevicesFor } from '../../lib/device-list';
import { TranslatePipe } from '../../pipes/translate.pipe';

function deviceEmoji(name: string, type: string): string {
  if (type !== 'web') return '\uD83C\uDFB5';
  return /iPhone|iPad|Android/i.test(name) ? '\uD83D\uDCF1' : '\uD83D\uDDA5\uFE0F';
}

@Component({
  selector: 'app-device-switcher',
  imports: [TranslatePipe],
  templateUrl: './device-switcher.component.html',
})
export class DeviceSwitcherComponent {
  readonly placement = input<'up' | 'down'>('up');

  readonly remote = inject(RemotePlaybackService);
  private ws = inject(PlaybackWsService);
  private elRef = inject(ElementRef);

  private myId = this.ws.getDeviceId();

  readonly myDevice = computed(() => this.remote.devices().find((d) => d.id === this.myId));
  // Shared with the TV chooser (`otherDevicesFor`) so the two pickers cannot
  // disagree about which devices are offerable.
  readonly otherDevices = computed(() => otherDevicesFor(this.remote.devices(), this.myId));
  readonly isRemoteActive = computed(() => {
    const active = this.remote.activeDeviceId();
    return active !== null && active !== this.myId;
  });
  /**
   * Is there anywhere to send the audio?
   *
   * The button used to render unconditionally, which on the common
   * single-device setup put a permanent dead control immediately beside Next —
   * a near-miss for the thumb aiming at it, whose only reward was a panel
   * saying "no other devices" (#1263). It appears when the roster holds
   * something other than this device, listed-but-unavailable included: that is
   * still a device worth telling the listener about, and the panel already says
   * so per row.
   *
   * Two states keep it visible with an empty roster. If the audio is already
   * elsewhere, hiding the control would strand the listener with no way to pull
   * it back; and if the panel is open — `PlayingElsewhereComponent` and the TV
   * player both open it without this button — the trigger must not vanish out
   * from under an open popover.
   */
  readonly canPickOutput = computed(
    () => this.otherDevices().length > 0 || this.isRemoteActive() || this.remote.switcherOpen(),
  );
  readonly activeDevice = computed(() =>
    this.remote.devices().find((d) => d.id === this.remote.activeDeviceId()),
  );
  readonly isThisDeviceActive = computed(() => {
    const active = this.remote.activeDeviceId();
    return active === null || active === this.myId;
  });
  readonly myDeviceEmoji = computed(() => {
    const d = this.myDevice();
    return d ? deviceEmoji(d.name, d.type) : '\uD83D\uDDA5\uFE0F';
  });
  readonly myDeviceName = computed(() => {
    const d = this.myDevice();
    return d?.name ?? this.ws.getDeviceName();
  });

  @HostListener('document:mousedown', ['$event'])
  onDocumentClick(event: MouseEvent): void {
    if (!this.remote.switcherOpen()) return;
    const target = event.target as HTMLElement;
    if (!target.closest('app-device-switcher')) {
      this.remote.setSwitcherOpen(false);
    }
  }

  toggleSwitcher(event: MouseEvent): void {
    event.stopPropagation();
    this.remote.setSwitcherOpen(!this.remote.switcherOpen());
  }

  selectThisDevice(): void {
    this.remote.switchToDevice(this.myId);
    this.remote.setSwitcherOpen(false);
  }

  selectDevice(id: string): void {
    this.remote.switchToDevice(id);
    this.remote.setSwitcherOpen(false);
  }

  getDeviceEmoji(name: string, type: string): string {
    return deviceEmoji(name, type);
  }
}
