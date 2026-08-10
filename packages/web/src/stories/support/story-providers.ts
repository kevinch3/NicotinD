/**
 * Providers every story of a service-injecting component needs.
 *
 * There are no fake service classes here, and that is deliberate. Every service the
 * light-DI components inject is a plain signal holder whose only outside dependency is
 * HttpClient — so stories run the *real* services and fake the transport
 * (`fixtureHttpInterceptor`) plus the starting signal state. A fake class would be a
 * second implementation to keep in sync, and it can stay green while the real one breaks.
 */
import {
  provideAppInitializer,
  inject,
  type EnvironmentProviders,
  type Provider,
} from '@angular/core';
import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { provideRouter } from '@angular/router';
import { fixtureHttpInterceptor } from './http-fixtures';
import { AuthService } from '../../app/services/auth.service';
import { PlayerService } from '../../app/services/player.service';
import type { Track } from '../../app/services/player.service';

export interface StoryState {
  /** Role the component should render for. `listener` hides acquisition affordances. */
  role?: 'listener' | 'user' | 'refiner' | 'admin';
  /** Track the player reports as current — drives the track-row playing indicator. */
  currentTrack?: Track | null;
  isPlaying?: boolean;
  /** Drives the buffering spinner / track-row buffering indicator. */
  buffering?: boolean;
  queue?: Track[];
}

export function storyProviders(state: StoryState = {}): Array<Provider | EnvironmentProviders> {
  return [
    provideHttpClient(withInterceptors([fixtureHttpInterceptor])),
    provideRouter([]),
    provideAppInitializer(() => {
      const auth = inject(AuthService);
      const player = inject(PlayerService);

      // A signed-in admin is the default because it is the only role that renders every
      // affordance; role-gated stories narrow it explicitly.
      auth.token.set('storybook-token');
      auth.username.set('storybook');
      auth.role.set(state.role ?? 'admin');

      if (state.currentTrack !== undefined) player.currentTrack.set(state.currentTrack);
      if (state.isPlaying !== undefined) player.isPlaying.set(state.isPlaying);
      if (state.buffering !== undefined) {
        player.buffering.set(state.buffering);
        player.bufferingVisible.set(state.buffering);
      }
      if (state.queue !== undefined) player.queue.set(state.queue);
    }),
  ];
}
