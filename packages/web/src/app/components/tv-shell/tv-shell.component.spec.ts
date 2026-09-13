import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { Component } from '@angular/core';
import { vi } from 'vitest';
import { TvShellComponent } from './tv-shell.component';
import { PlayerService } from '../../services/player.service';
import { PlayerComponent } from '../player/player.component';
import { UpdateBannerComponent } from '../update-banner/update-banner.component';

@Component({ selector: 'app-player', template: '' })
class StubPlayerComponent {}

@Component({ selector: 'app-update-banner', template: '' })
class StubUpdateBannerComponent {}

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
      ],
    });
    TestBed.overrideComponent(TvShellComponent, {
      remove: { imports: [PlayerComponent, UpdateBannerComponent] },
      add: { imports: [StubPlayerComponent, StubUpdateBannerComponent] },
    });
    const player = TestBed.inject(PlayerService);
    const router = TestBed.inject(Router);
    const navigate = vi.spyOn(router, 'navigate').mockResolvedValue(true);
    const fixture = TestBed.createComponent(TvShellComponent);
    fixture.detectChanges();
    return { fixture, player, navigate };
  }

  afterEach(() => {
    localStorage.clear();
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
});
