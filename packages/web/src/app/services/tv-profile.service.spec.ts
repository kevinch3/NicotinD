import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { HttpErrorResponse } from '@angular/common/http';
import { Component } from '@angular/core';
import { Observable, Subject, of, throwError } from 'rxjs';
import { vi } from 'vitest';
import { TvProfileService } from './tv-profile.service';
import { AuthService } from './auth.service';
import { AuthApiService } from './api/auth-api.service';
import { PlayerService } from './player.service';
import { UserPreferencesService } from './user-preferences.service';
import { ThemeService } from './theme.service';
import { TranslateService } from './translate.service';
import { loadProfiles, rememberProfile } from '../lib/tv-profiles';

const platform = vi.hoisted(() => ({ tv: true }));
vi.mock('../lib/platform', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/platform')>();
  return { ...actual, isTvBuild: vi.fn(() => platform.tv) };
});

@Component({ template: '' })
class BlankComponent {}

const me = { role: 'user', welcomeDismissed: true, acquisitionEnabled: true };
const people = () => loadProfiles(localStorage, '');
const remember = (username: string, token: string, role = 'user') =>
  rememberProfile(localStorage, '', { username, role, token });

describe('TvProfileService', () => {
  function create(
    refreshToken: () => Observable<{ token: string }> = () => of({ token: 'fresh' }),
    getMe: () => Observable<unknown> = () => of(me),
  ) {
    const api = { refreshToken: vi.fn(refreshToken), getMe: vi.fn(getMe) };
    TestBed.configureTestingModule({
      providers: [
        provideRouter([
          { path: '', component: BlankComponent },
          { path: 'login', component: BlankComponent },
          { path: 'who', component: BlankComponent },
        ]),
        { provide: AuthApiService, useValue: api },
      ],
    });
    const auth = TestBed.inject(AuthService);
    const router = TestBed.inject(Router);
    const navigate = vi.spyOn(router, 'navigate').mockResolvedValue(true);
    const reset = vi.spyOn(auth, 'resetSession');
    const service = TestBed.inject(TvProfileService);
    return { service, auth, api, navigate, reset };
  }

  const refusedWith = (status: number) => () => throwError(() => new HttpErrorResponse({ status }));

  afterEach(() => {
    localStorage.clear();
    platform.tv = true;
  });

  it('mirrors the active session into the store, including a refreshed token', () => {
    const { service, auth } = create();
    auth.login('jwt-a', 'ana', 'user');
    TestBed.flushEffects();
    expect(people().map((p) => [p.username, p.token])).toEqual([['ana', 'jwt-a']]);
    auth.setToken('jwt-a2');
    TestBed.flushEffects();
    expect(people()[0].token).toBe('jwt-a2');
    expect(service.profiles().map((p) => p.username)).toEqual(['ana']);
  });

  it('never mirrors anything off the TV build', () => {
    platform.tv = false;
    const { service, auth } = create();
    auth.login('jwt-a', 'ana', 'user');
    TestBed.flushEffects();
    expect(localStorage.getItem('nicotind_tv_profiles::')).toBeNull();
    expect(service.profiles()).toEqual([]);
  });

  it('keys the store by the saved server', () => {
    localStorage.setItem('nicotind_server_url', 'http://a');
    const { service, auth } = create();
    auth.login('jwt-a', 'ana', 'user');
    TestBed.flushEffects();
    expect(loadProfiles(localStorage, 'http://a').map((p) => p.username)).toEqual(['ana']);
    expect(people()).toEqual([]);
    expect(service.profiles().map((p) => p.username)).toEqual(['ana']);
  });

  it('switches: reset → login as the stored person → refresh → Home', async () => {
    const { service, auth, api, navigate, reset } = create();
    remember('ben', 'jwt-b', 'admin');
    auth.login('jwt-a', 'ana', 'user');
    TestBed.flushEffects();

    await service.switchTo('ben');

    expect(reset).toHaveBeenCalledTimes(1);
    expect(auth.username()).toBe('ben');
    expect(auth.role()).toBe('user'); // getMe's role wins over the stored one
    expect(auth.token()).toBe('fresh');
    expect(api.refreshToken).toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith(['/']);
    // Ana is still known to the TV.
    expect(
      people()
        .map((p) => p.username)
        .sort(),
    ).toEqual(['ana', 'ben']);
  });

  it('applies the whole boot refresh: preferences, theme, language, radio variety', async () => {
    const preferences = { theme: 'eink', language: 'es', radioStrategy: 'similar' };
    const { service, auth } = create(undefined, () =>
      of({ ...me, radioStrategy: 'adventurous', preferences }),
    );
    const hydrate = vi
      .spyOn(TestBed.inject(UserPreferencesService), 'hydrate')
      .mockImplementation(() => {});
    const theme = vi
      .spyOn(TestBed.inject(ThemeService), 'adoptPreferences')
      .mockImplementation(() => {});
    const i18n = vi
      .spyOn(TestBed.inject(TranslateService), 'adoptPreferences')
      .mockResolvedValue(undefined);
    const player = TestBed.inject(PlayerService);
    remember('ben', 'jwt-b');
    auth.login('jwt-a', 'ana', 'user');
    TestBed.flushEffects();
    expect(player.radioStrategy()).toBe('balanced');

    await service.switchTo('ben');

    expect(hydrate).toHaveBeenCalledWith(preferences);
    expect(theme).toHaveBeenCalled();
    expect(i18n).toHaveBeenCalled();
    expect(player.radioStrategy()).toBe('adventurous');
  });

  it('a refused refresh (401) forgets that person and returns to the people left', async () => {
    const { service, auth, navigate } = create(refusedWith(401));
    remember('ben', 'expired');
    auth.login('jwt-a', 'ana', 'user');
    TestBed.flushEffects();

    await service.switchTo('ben');

    expect(people().map((p) => p.username)).toEqual(['ana']);
    expect(auth.token()).toBeNull();
    expect(navigate).toHaveBeenCalledWith(['/who']);
  });

  it('a refused refresh (403) with nobody left asks for the QR', async () => {
    const { service, auth, navigate } = create(refusedWith(403));
    remember('ben', 'expired');
    auth.login('jwt-a', 'ana', 'user');
    TestBed.flushEffects();
    // Ana signs out on this TV: the store now holds only ben's dead token.
    await service.signOut();

    expect(people()).toEqual([]);
    expect(auth.token()).toBeNull();
    expect(navigate).toHaveBeenLastCalledWith(['/login']);
  });

  it.each([
    ['a 500', 500],
    ['a status-0 network failure', 0],
  ])('%s from the refresh keeps the login and goes Home', async (_label, status) => {
    const { service, auth, navigate } = create(refusedWith(status));
    remember('ben', 'jwt-b');
    auth.login('jwt-a', 'ana', 'user');
    TestBed.flushEffects();

    await service.switchTo('ben');

    expect(auth.username()).toBe('ben');
    expect(auth.token()).toBe('jwt-b');
    expect(people().find((p) => p.username === 'ben')?.token).toBe('jwt-b');
    expect(navigate).toHaveBeenCalledWith(['/']);
  });

  it('keeps the login when refresh succeeds but getMe fails', async () => {
    const { service, auth, navigate } = create(undefined, () =>
      throwError(() => new HttpErrorResponse({ status: 500 })),
    );
    remember('ben', 'jwt-b');
    auth.login('jwt-a', 'ana', 'user');
    TestBed.flushEffects();

    await service.switchTo('ben');

    expect(auth.token()).toBe('fresh');
    expect(
      people()
        .map((p) => p.username)
        .sort(),
    ).toEqual(['ana', 'ben']);
    expect(navigate).toHaveBeenCalledWith(['/']);
  });

  it('a newer switch wins over an older one still refreshing — tokens never cross', async () => {
    const refreshes: Subject<{ token: string }>[] = [];
    const { service, auth, navigate } = create(() => {
      const s = new Subject<{ token: string }>();
      refreshes.push(s);
      return s;
    });
    remember('ben', 'jwt-b');
    remember('carol', 'jwt-c');
    auth.login('jwt-a', 'ana', 'user');
    TestBed.flushEffects();

    const toBen = service.switchTo('ben');
    const toCarol = service.switchTo('carol');
    refreshes[1].next({ token: 'carol-fresh' });
    refreshes[1].complete();
    await toCarol;
    // Ben's refresh answers last.
    refreshes[0].next({ token: 'ben-fresh' });
    refreshes[0].complete();
    await toBen;
    TestBed.flushEffects();

    expect(auth.username()).toBe('carol');
    expect(auth.token()).toBe('carol-fresh');
    expect(people().find((p) => p.username === 'carol')?.token).toBe('carol-fresh');
    expect(people().find((p) => p.username === 'ben')?.token).toBe('jwt-b');
    expect(navigate).toHaveBeenCalledTimes(1);
  });

  it('switchTo the active person is a no-op besides navigating Home', async () => {
    const { service, auth, api, navigate, reset } = create();
    auth.login('jwt-a', 'ana', 'user');
    TestBed.flushEffects();

    await service.switchTo('ana');

    expect(reset).not.toHaveBeenCalled();
    expect(api.refreshToken).not.toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith(['/']);
  });

  it('beginAdd resets the session but keeps the current person in the store', () => {
    const { service, auth, navigate, reset } = create();
    auth.login('jwt-a', 'ana', 'user');
    TestBed.flushEffects();
    service.beginAdd();
    expect(reset).toHaveBeenCalled();
    expect(auth.token()).toBeNull();
    expect(people().map((p) => p.username)).toEqual(['ana']);
    expect(navigate).toHaveBeenCalledWith(['/login']);
  });

  it('signOut forgets the active person and moves to the next, or to login when alone', async () => {
    const { service, auth, navigate } = create();
    remember('ben', 'jwt-b');
    auth.login('jwt-a', 'ana', 'user');
    TestBed.flushEffects();

    await service.signOut();
    expect(auth.username()).toBe('ben');
    expect(people().map((p) => p.username)).toEqual(['ben']);

    await service.signOut();
    expect(auth.token()).toBeNull();
    expect(people()).toEqual([]);
    expect(navigate).toHaveBeenLastCalledWith(['/login']);
  });
});
