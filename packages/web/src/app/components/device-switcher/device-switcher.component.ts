import { Component, inject, signal, ElementRef, HostListener, computed } from '@angular/core';
import { RemotePlaybackService } from '../../services/remote-playback.service';
import { PlaybackWsService } from '../../services/playback-ws.service';

function deviceEmoji(name: string, type: string): string {
  if (type !== 'web') return '\uD83C\uDFB5';
  return /iPhone|iPad|Android/i.test(name) ? '\uD83D\uDCF1' : '\uD83D\uDDA5\uFE0F';
}

@Component({
  selector: 'app-device-switcher',
  templateUrl: './device-switcher.component.html',
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
