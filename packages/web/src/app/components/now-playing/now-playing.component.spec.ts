import { TestBed } from '@angular/core/testing';
import { NO_ERRORS_SCHEMA, signal } from '@angular/core';
import { vi } from 'vitest';
import { provideRouter } from '@angular/router';
import { NowPlayingComponent } from './now-playing.component';
import { PlayerService } from '../../services/player.service';
import { AuthService } from '../../services/auth.service';
import { RemotePlaybackService } from '../../services/remote-playback.service';
import { PlaybackWsService } from '../../services/playback-ws.service';

function makePlayerStub() {
  return {
    currentTrack: signal<{ id: string; title: string; artist: string; artistId?: string } | null>(
      null,
    ),
    nowPlayingOpen: signal(true),
    isPlaying: signal(false),
    shuffle: signal(false),
    repeat: signal('off'),
    radio: signal(false),
    toggleRadio: () => {},
    queue: signal([]),
    history: signal([]),
    context: signal(null),
    currentTime: signal(0),
    duration: signal(0),
    autoplayBlocked: signal(false),
    setNowPlayingOpen: () => {},
    seek: () => {},
  };
}

function makeRemoteStub() {
  return {
    isActiveDevice: signal(true),
    remoteEnabled: signal(false),
    remoteIsPlaying: signal(false),
    remoteDuration: signal(0),
    remotePosition: signal(0),
    remotePositionTs: signal(Date.now()),
    devices: signal([]),
    activeDeviceId: signal(null),
    switcherOpen: signal(false),
    setSwitcherOpen: () => {},
    switchToDevice: () => {},
    setRemoteProgress: () => {},
  };
}

function setup() {
  const playerStub = makePlayerStub();
  const remoteStub = makeRemoteStub();

  TestBed.configureTestingModule({
    imports: [NowPlayingComponent],
    providers: [
      provideRouter([]),
      { provide: PlayerService, useValue: playerStub },
      { provide: AuthService, useValue: { token: signal('tok') } },
      { provide: RemotePlaybackService, useValue: remoteStub },
      {
        provide: PlaybackWsService,
        useValue: {
          getDeviceId: () => 'dev-1',
          getDeviceName: () => 'Test',
          sendCommand: () => {},
        },
      },
    ],
    schemas: [NO_ERRORS_SCHEMA],
  });

  const fixture = TestBed.createComponent(NowPlayingComponent);
  fixture.detectChanges();
  return { fixture, playerStub, remoteStub };
}

describe('NowPlayingComponent', () => {
  describe('device switcher', () => {
    it('renders app-device-switcher when a track is loaded and remote is enabled', () => {
      const { fixture, playerStub, remoteStub } = setup();

      remoteStub.remoteEnabled.set(true);
      playerStub.currentTrack.set({ id: '1', title: 'Song', artist: 'Artist' });
      fixture.detectChanges();

      const el: HTMLElement = fixture.nativeElement;
      expect(el.querySelector('app-device-switcher')).not.toBeNull();
    });

    it('does not render app-device-switcher when no track is loaded', () => {
      const { fixture } = setup();
      // currentTrack is null by default

      const el: HTMLElement = fixture.nativeElement;
      expect(el.querySelector('app-device-switcher')).toBeNull();
    });
  });

  describe('drag-to-dismiss (live-follow)', () => {
    // jsdom has no PointerEvent constructor; MouseEvent carries clientY + button
    // and dispatches under any type string, driving the real document listeners.
    const pointer = (type: string, clientY: number, button = 0) =>
      new MouseEvent(type, { clientY, button }) as unknown as PointerEvent;

    it('follows the finger downward and closes the sheet past the threshold', () => {
      const { fixture, playerStub } = setup();
      const component = fixture.componentInstance;
      const setOpen = vi.spyOn(playerStub, 'setNowPlayingOpen');

      component.onSheetDragStart(pointer('pointerdown', 100));
      expect(component.dragging()).toBe(true);

      document.dispatchEvent(pointer('pointermove', 280)); // delta 180 > 120 threshold
      expect(component.dragOffsetPx()).toBe(180);

      document.dispatchEvent(pointer('pointerup', 280));
      expect(setOpen).toHaveBeenCalledWith(false);
      expect(component.dragOffsetPx()).toBe(0);
      expect(component.dragging()).toBe(false);
    });

    it('snaps back without closing for a short drag', () => {
      const { fixture, playerStub } = setup();
      const component = fixture.componentInstance;
      const setOpen = vi.spyOn(playerStub, 'setNowPlayingOpen');

      component.onSheetDragStart(pointer('pointerdown', 100));
      document.dispatchEvent(pointer('pointermove', 150)); // delta 50 < 120 threshold
      document.dispatchEvent(pointer('pointerup', 150));

      expect(setOpen).not.toHaveBeenCalled();
      expect(component.dragOffsetPx()).toBe(0);
      expect(component.dragging()).toBe(false);
    });

    it('clamps an upward drag to zero (downward-only)', () => {
      const { fixture } = setup();
      const component = fixture.componentInstance;

      component.onSheetDragStart(pointer('pointerdown', 200));
      document.dispatchEvent(pointer('pointermove', 50)); // delta -150
      expect(component.dragOffsetPx()).toBe(0);
    });

    it('ignores non-primary buttons and stops tracking after release', () => {
      const { fixture } = setup();
      const component = fixture.componentInstance;

      component.onSheetDragStart(pointer('pointerdown', 100, 2)); // right-click
      expect(component.dragging()).toBe(false);

      component.onSheetDragStart(pointer('pointerdown', 100));
      document.dispatchEvent(pointer('pointerup', 100));
      // Listeners detached: a post-release move must not move the sheet.
      document.dispatchEvent(pointer('pointermove', 300));
      expect(component.dragOffsetPx()).toBe(0);
      expect(component.dragging()).toBe(false);
    });
  });
});
