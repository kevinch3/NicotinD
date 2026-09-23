import { signal } from '@angular/core';
import { vi } from 'vitest';
import { of, throwError } from 'rxjs';
import { refreshSession } from './app.config';
import type { AuthApiService } from './services/api/auth-api.service';
import type { AuthService } from './services/auth.service';
import type { PlayerService } from './services/player.service';
import type { ThemeService } from './services/theme.service';
import type { TranslateService } from './services/translate.service';
import type { UserPreferencesService } from './services/user-preferences.service';

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

  // Per-user preferences ride on /me (#1299): hydrate the door, then let the
  // owning services adopt what it now holds.
  it('hydrates the preferences door and lets the owners adopt them', () => {
    const preferences = {
      homeView: 'shelves',
      theme: 'eink',
      followSystemTheme: false,
      language: 'es',
      radioStrategy: 'similar',
      welcomeDismissed: true,
    };
    const { api, auth } = makeMocks({ ...profile, preferences });
    const prefs = { hydrate: vi.fn() };
    const theme = { adoptPreferences: vi.fn() };
    const i18n = { adoptPreferences: vi.fn() };

    refreshSession(api as unknown as AuthApiService, auth as unknown as AuthService, undefined, {
      prefs: prefs as unknown as UserPreferencesService,
      theme: theme as unknown as ThemeService,
      i18n: i18n as unknown as TranslateService,
    });

    expect(prefs.hydrate).toHaveBeenCalledWith(preferences);
    expect(theme.adoptPreferences).toHaveBeenCalled();
    expect(i18n.adoptPreferences).toHaveBeenCalled();
  });

  it('skips the preferences door when an older server omits the object', () => {
    const { api, auth } = makeMocks(profile);
    const prefs = { hydrate: vi.fn() };
    refreshSession(api as unknown as AuthApiService, auth as unknown as AuthService, undefined, {
      prefs: prefs as unknown as UserPreferencesService,
      theme: { adoptPreferences: vi.fn() } as unknown as ThemeService,
      i18n: { adoptPreferences: vi.fn() } as unknown as TranslateService,
    });
    expect(prefs.hydrate).not.toHaveBeenCalled();
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
