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
    serverAcquisitionEnabled: signal(false),
  };
  return { api, auth };
}

const profile = {
  role: 'admin',
  welcomeDismissed: true,
  acquisitionEnabled: false,
};

describe('refreshSession', () => {
  it('refreshes the token and syncs every profile flag', () => {
    const { api, auth } = makeMocks(profile);

    refreshSession(api as unknown as AuthApiService, auth as unknown as AuthService);

    expect(auth.setToken).toHaveBeenCalledWith('new-token');
    expect(auth.setRole).toHaveBeenCalledWith('admin');
    expect(auth.welcomeDismissed()).toBe(true);
    expect(auth.serverAcquisitionEnabled()).toBe(false);
  });

  it('defaults the acquisition kill-switch to enabled when an older server omits the field', () => {
    const { api, auth } = makeMocks({ ...profile, acquisitionEnabled: undefined });

    refreshSession(api as unknown as AuthApiService, auth as unknown as AuthService);

    expect(auth.serverAcquisitionEnabled()).toBe(true);
  });

  it('swallows a failed refresh without touching auth state', () => {
    const { api, auth } = makeMocks(profile);
    api.refreshToken = vi.fn(() => throwError(() => new Error('down')));

    expect(() =>
      refreshSession(api as unknown as AuthApiService, auth as unknown as AuthService),
    ).not.toThrow();
    expect(auth.setToken).not.toHaveBeenCalled();
    expect(auth.setRole).not.toHaveBeenCalled();
  });
});
