import { AfterViewChecked, Component, ElementRef, computed, inject } from '@angular/core';
import { RemotePlaybackService } from '../../services/remote-playback.service';
import { PlaybackWsService } from '../../services/playback-ws.service';
import { otherDevicesFor } from '../../lib/device-list';
import { registerOverlayCloser } from '../../services/native/back-button.service';
import { TvNavGroupDirective } from '../../directives/tv-nav-group.directive';
import { TvNavItemDirective } from '../../directives/tv-nav-item.directive';
import { TranslatePipe } from '../../pipes/translate.pipe';

/**
 * "Play on …" for a remote: a full-screen list of buttons.
 *
 * The phone's `DeviceSwitcherComponent` is a popover that closes on an outside
 * `mousedown` — an interaction a D-pad cannot perform — so the TV gets the same
 * shape every other TV chooser uses (docs/tv-ux.md: a full-screen list, never a
 * `<select>` and never a popover). Only the *presentation* is forked: the
 * offerable/sibling rules come from the shared `otherDevicesFor`, and the pick
 * goes through `RemotePlaybackService.switchToDevice` like every other picker.
 *
 * Rendered under an `@if` by `TvShellComponent`, keyed off the same
 * `switcherOpen` signal the phone popover uses, so anything that already asks
 * for the switcher ("Playing on …" strips included) opens the right one for the
 * surface it is on. Its lifetime is its open lifetime, so the Escape/hardware-
 * Back closer registers once in the constructor (the #398 modal shape).
 */
@Component({
  selector: 'app-tv-device-picker',
  standalone: true,
  imports: [TvNavGroupDirective, TvNavItemDirective, TranslatePipe],
  templateUrl: './tv-device-picker.component.html',
})
export class TvDevicePickerComponent implements AfterViewChecked {
  private readonly remote = inject(RemotePlaybackService);
  private readonly ws = inject(PlaybackWsService);
  private readonly el = inject<ElementRef<HTMLElement>>(ElementRef);
  private autofocused = false;

  readonly myId = this.ws.getDeviceId();

  /** The name other devices' pickers show for this TV (docs/remote-playback.md). */
  readonly myName = computed(
    () => this.remote.devices().find((d) => d.id === this.myId)?.name ?? this.ws.getDeviceName(),
  );
  readonly playingHere = computed(() => {
    const active = this.remote.activeDeviceId();
    return active === null || active === this.myId;
  });
  readonly others = computed(() => otherDevicesFor(this.remote.devices(), this.myId));
  readonly activeDeviceId = this.remote.activeDeviceId;

  constructor() {
    registerOverlayCloser(() => this.close());
  }

  /** One-shot autofocus of the first row so the D-pad lands inside the overlay
   *  (the MenuPanel pattern — idempotent, no signal writes). */
  ngAfterViewChecked(): void {
    if (this.autofocused) return;
    const first = this.el.nativeElement.querySelector<HTMLElement>('[data-testid="tv-device-row"]');
    if (!first) return;
    first.focus();
    this.autofocused = true;
  }

  pick(id: string): void {
    this.remote.switchToDevice(id);
    this.close();
  }

  close(): void {
    this.remote.setSwitcherOpen(false);
  }
}
