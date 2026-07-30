import { signal } from '@angular/core';
import { vi } from 'vitest';
import { of, throwError } from 'rxjs';
import { refreshSession } from './app.config';
import type { AuthApiService } from './services/api/auth-api.service';
import type { AuthService } from './services/auth.service';
import type { PlayerService } from './services/player.service';

function makeMocks(profile: Record<string, unknown>) {
  const api = {
    refreshToken: vi.fn(() => of({ token: 'new-token' })),
    getMe: vi.fn(() => of(profile)),
  };
  const auth = {
    setToken: vi.fn(),
    setRole: vi.fn(),
    welcomeDismissed: signal(false),
    autoplayOnLoad: signal(false),
    feedbackCapture: signal(false),
    serverAcquisitionEnabled: signal(false),
  };
  const player = { maybeResumeAutoplay: vi.fn() };
  return { api, auth, player };
}

const profile = {
  role: 'admin',
  welcomeDismissed: true,
  autoplayOnLoad: true,
  feedbackCapture: true,
  acquisitionEnabled: false,
};

describe('refreshSession', () => {
  it('refreshes the token and syncs every profile flag', () => {
    const { api, auth, player } = makeMocks(profile);

    refreshSession(
      api as unknown as AuthApiService,
      auth as unknown as AuthService,
      player as unknown as PlayerService,
      true,
    );

    expect(auth.setToken).toHaveBeenCalledWith('new-token');
    expect(auth.setRole).toHaveBeenCalledWith('admin');
    expect(auth.welcomeDismissed()).toBe(true);
    expect(auth.autoplayOnLoad()).toBe(true);
    expect(auth.feedbackCapture()).toBe(true);
    expect(auth.serverAcquisitionEnabled()).toBe(false);
    expect(player.maybeResumeAutoplay).toHaveBeenCalledWith(true);
  });

  it('suppresses the autoplay resume when withAutoplay is false (the deferred offline-recovery path)', () => {
    // Music suddenly starting minutes after launch — when connectivity happens
    // to return — would be a surprise, not a restore. The recovery refresh syncs
    // the profile but never resumes playback.
    const { api, auth, player } = makeMocks(profile);

    refreshSession(
      api as unknown as AuthApiService,
      auth as unknown as AuthService,
      player as unknown as PlayerService,
      false,
    );

    expect(auth.setRole).toHaveBeenCalledWith('admin');
    expect(player.maybeResumeAutoplay).not.toHaveBeenCalled();
  });

  it('defaults the acquisition kill-switch to enabled when an older server omits the field', () => {
    const { api, auth, player } = makeMocks({ ...profile, acquisitionEnabled: undefined });

    refreshSession(
      api as unknown as AuthApiService,
      auth as unknown as AuthService,
      player as unknown as PlayerService,
      false,
    );

    expect(auth.serverAcquisitionEnabled()).toBe(true);
  });

  it('swallows a failed refresh without touching auth state', () => {
    const { api, auth, player } = makeMocks(profile);
    api.refreshToken = vi.fn(() => throwError(() => new Error('down')));

    expect(() =>
      refreshSession(
        api as unknown as AuthApiService,
        auth as unknown as AuthService,
        player as unknown as PlayerService,
        true,
      ),
    ).not.toThrow();
    expect(auth.setToken).not.toHaveBeenCalled();
    expect(auth.setRole).not.toHaveBeenCalled();
  });
});
