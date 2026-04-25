import { TestBed } from '@angular/core/testing';
import { NO_ERRORS_SCHEMA, signal } from '@angular/core';
import { provideRouter } from '@angular/router';
import { NowPlayingComponent } from './now-playing.component';
import { PlayerService } from '../../services/player.service';
import { AuthService } from '../../services/auth.service';
import { RemotePlaybackService } from '../../services/remote-playback.service';
import { PlaybackWsService } from '../../services/playback-ws.service';

function makePlayerStub() {
  return {
    currentTrack: signal<{ id: string; title: string; artist: string; artistId?: string } | null>(null),
    nowPlayingOpen: signal(true),
    isPlaying: signal(false),
    shuffle: signal(false),
    repeat: signal('off'),
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

  TestBed.configureTestingModule({
    imports: [NowPlayingComponent],
    providers: [
      provideRouter([]),
      { provide: PlayerService, useValue: playerStub },
      { provide: AuthService, useValue: { token: signal('tok') } },
      { provide: RemotePlaybackService, useValue: makeRemoteStub() },
      { provide: PlaybackWsService, useValue: { getDeviceId: () => 'dev-1', getDeviceName: () => 'Test', sendCommand: () => {} } },
    ],
    schemas: [NO_ERRORS_SCHEMA],
  });

  const fixture = TestBed.createComponent(NowPlayingComponent);
  fixture.detectChanges();
  return { fixture, playerStub };
}

describe('NowPlayingComponent', () => {
  describe('device switcher', () => {
    it('renders app-device-switcher when a track is loaded', () => {
      const { fixture, playerStub } = setup();

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
});
