import { Component, inject, signal, ElementRef, HostListener, computed } from '@angular/core';
import { RemotePlaybackService } from '../../services/remote-playback.service';
import { PlaybackWsService } from '../../services/playback-ws.service';

function deviceEmoji(name: string, type: string): string {
  if (type !== 'web') return '\uD83C\uDFB5';
  return /iPhone|iPad|Android/i.test(name) ? '\uD83D\uDCF1' : '\uD83D\uDDA5\uFE0F';
}

@Component({
  selector: 'app-device-switcher',
  template: `
    <div class="relative">
      <button
        (click)="toggleSwitcher($event)"
        title="Play on a device"
        [class]="'w-7 h-7 flex items-center justify-center rounded-full transition ' +
          (isRemoteActive() ? 'text-emerald-400' : 'text-zinc-500 hover:text-zinc-300')"
      >
        <!-- Cast icon -->
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <rect x="2" y="7" width="8" height="10" rx="1" />
          <polygon points="14,5 22,3 22,21 14,19" />
        </svg>
      </button>

      @if (remote.switcherOpen()) {
        <div class="absolute bottom-10 right-0 w-64 bg-zinc-800 border border-zinc-700 rounded-xl shadow-2xl overflow-hidden z-50">
          <div class="px-4 py-3 border-b border-zinc-700">
            <p class="text-xs font-semibold text-zinc-400 uppercase tracking-widest">Play on...</p>
          </div>

          <!-- This device -->
          <div class="border-b border-zinc-700/60">
            <button
              [class]="'w-full flex items-center gap-3 px-4 py-2.5 text-sm transition hover:bg-zinc-700 ' +
                (isThisDeviceActive() ? 'text-zinc-100' : 'text-zinc-400')"
              (click)="selectThisDevice()"
            >
              <span class="text-base leading-none">{{ myDeviceEmoji() }}</span>
              <span class="flex-1 text-left truncate">{{ myDeviceName() }}</span>
              <span class="text-[10px] text-zinc-500 flex-shrink-0">this device</span>
              @if (isThisDeviceActive()) {
                <span class="w-2 h-2 rounded-full bg-emerald-400 flex-shrink-0 animate-pulse"></span>
              }
            </button>
          </div>

          <!-- Other remote devices -->
          <ul class="py-1 max-h-52 overflow-y-auto">
            @if (otherDevices().length === 0) {
              <li class="px-4 py-3 text-sm text-zinc-500 text-center">No other devices online</li>
            }
            @for (device of otherDevices(); track device.id) {
              <li>
                <button
                  [class]="'w-full flex items-center gap-3 px-4 py-2.5 text-sm transition hover:bg-zinc-700 ' +
                    (device.id === remote.activeDeviceId() ? 'text-zinc-100' : 'text-zinc-400')"
                  (click)="selectDevice(device.id)"
                >
                  <span class="text-base leading-none">{{ getDeviceEmoji(device.name, device.type) }}</span>
                  <span class="flex-1 text-left truncate">{{ device.name }}</span>
                  @if (device.id === remote.activeDeviceId()) {
                    <span class="flex-shrink-0 text-[10px] font-semibold tracking-wide px-1.5 py-0.5 rounded bg-emerald-900/70 text-emerald-400">
                      NOW PLAYING
                    </span>
                  }
                </button>
              </li>
            }
          </ul>

          @if (isRemoteActive() && activeDevice()) {
            <div class="px-4 py-2 border-t border-zinc-700 text-xs text-zinc-500 truncate">
              Playing on: <span class="text-zinc-400">{{ activeDevice()!.name }}</span>
            </div>
          }
        </div>
      }
    </div>
  `,
})
export class DeviceSwitcherComponent {
  readonly remote = inject(RemotePlaybackService);
  private ws = inject(PlaybackWsService);
  private elRef = inject(ElementRef);

  private myId = this.ws.getDeviceId();

  readonly myDevice = computed(() => this.remote.devices().find(d => d.id === this.myId));
  readonly otherDevices = computed(() => this.remote.devices().filter(d => d.id !== this.myId));
  readonly isRemoteActive = computed(() => {
    const active = this.remote.activeDeviceId();
    return active !== null && active !== this.myId;
  });
  readonly activeDevice = computed(() => this.remote.devices().find(d => d.id === this.remote.activeDeviceId()));
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
    if (!this.elRef.nativeElement.contains(event.target as Node)) {
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
