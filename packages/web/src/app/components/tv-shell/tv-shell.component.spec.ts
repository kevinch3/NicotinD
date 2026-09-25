import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { Component } from '@angular/core';
import { vi } from 'vitest';
import { TvShellComponent } from './tv-shell.component';
import { PlayerService } from '../../services/player.service';
import { RemotePlaybackService } from '../../services/remote-playback.service';
import { PlaybackWsService } from '../../services/playback-ws.service';
import { PlayerComponent } from '../player/player.component';
import { UpdateBannerComponent } from '../update-banner/update-banner.component';
import { TvDevicePickerComponent } from '../tv-device-picker/tv-device-picker.component';
import { APP_VERSION } from '../../app.config';
import { AuthService } from '../../services/auth.service';

@Component({ selector: 'app-player', template: '' })
class StubPlayerComponent {}

@Component({ selector: 'app-update-banner', template: '' })
class StubUpdateBannerComponent {}

@Component({ selector: 'app-tv-device-picker', template: '' })
class StubTvDevicePickerComponent {}

@Component({ template: '' })
class BlankComponent {}

describe('TvShellComponent', () => {
  function create() {
    TestBed.configureTestingModule({
      providers: [
        provideRouter([
          { path: '', component: BlankComponent },
          { path: 'player', component: BlankComponent },
        ]),
        { provide: APP_VERSION, useValue: '0.1.234' },
      ],
    });
    TestBed.overrideComponent(TvShellComponent, {
      remove: { imports: [PlayerComponent, UpdateBannerComponent, TvDevicePickerComponent] },
      add: {
        imports: [StubPlayerComponent, StubUpdateBannerComponent, StubTvDevicePickerComponent],
      },
    });
    const player = TestBed.inject(PlayerService);
    const remote = TestBed.inject(RemotePlaybackService);
    const myId = TestBed.inject(PlaybackWsService).getDeviceId();
    const router = TestBed.inject(Router);
    const navigate = vi.spyOn(router, 'navigate').mockResolvedValue(true);
    const fixture = TestBed.createComponent(TvShellComponent);
    fixture.detectChanges();
    return { fixture, player, remote, myId, navigate };
  }

  afterEach(() => {
    localStorage.clear();
  });

  it('names the signed-in user and the version on every screen (#1404)', () => {
    localStorage.setItem('nicotind_username', 'couch');
    const { fixture } = create();
    TestBed.inject(AuthService).username.set('couch');
    fixture.detectChanges();

    const el: HTMLElement = fixture.nativeElement;
    expect(el.querySelector('[data-testid="tv-status-user"]')?.textContent?.trim()).toBe('couch');
    expect(el.querySelector('[data-testid="tv-status-version"]')?.textContent?.trim()).toBe(
      'v0.1.234',
    );
  });

  it('turns radio on, because a TV has no control that could turn it back on (#1127)', () => {
    const { player } = create();

    expect(player.radio()).toBe(true);
  });

  it('adapts a "show what is playing" request into a route change', () => {
    const { fixture, player, navigate } = create();

    player.nowPlayingOpen.set(true);
    fixture.detectChanges();

    expect(navigate).toHaveBeenCalledWith(['/player']);
    // Reset so a later open fires the effect again.
    expect(player.nowPlayingOpen()).toBe(false);
  });

  it('shows the player when a cast lands on this TV (#1128)', () => {
    const { fixture, remote, navigate } = create();

    // What a phone picking this TV produces: a server message whose reducer
    // effect plays a track here.
    remote.castsReceived.update((n) => n + 1);
    fixture.detectChanges();

    expect(navigate).toHaveBeenCalledWith(['/player']);
  });

  it('does not jump to the player for the paused track a cold boot restores', () => {
    const { fixture, player, navigate } = create();

    player.currentTrack.set({ id: 's1', title: 'S', artist: 'A' });
    fixture.detectChanges();

    expect(navigate).not.toHaveBeenCalled();
  });

  it('does not jump to the player when this device simply plays on its own', () => {
    // A local play claims the output, so every state-derived "am I the output"
    // check is true here — only a server message means a cast arrived.
    const { fixture, player, remote, myId, navigate } = create();

    remote.setActiveDeviceId(myId);
    player.play({ id: 's1', title: 'S', artist: 'A' });
    fixture.detectChanges();

    expect(navigate).not.toHaveBeenCalled();
  });

  it('does not follow a session that names another device', () => {
    const { fixture, player, remote, navigate } = create();

    remote.setActiveDeviceId('someone-else');
    player.play({ id: 's1', title: 'S', artist: 'A' });
    fixture.detectChanges();

    expect(navigate).not.toHaveBeenCalled();
  });
});
