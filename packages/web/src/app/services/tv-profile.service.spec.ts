import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { Component } from '@angular/core';
import { of, throwError } from 'rxjs';
import { vi } from 'vitest';
import { TvProfileService } from './tv-profile.service';
import { AuthService } from './auth.service';
import { AuthApiService } from './api/auth-api.service';
import { loadProfiles, rememberProfile } from '../lib/tv-profiles';

@Component({ template: '' })
class BlankComponent {}

describe('TvProfileService', () => {
  function create(refresh: 'ok' | 'refused' = 'ok') {
    const api = {
      refreshToken: vi.fn(() =>
        refresh === 'ok' ? of({ token: 'fresh' }) : throwError(() => new Error('401')),
      ),
      getMe: vi.fn(() => of({ role: 'user', welcomeDismissed: true, acquisitionEnabled: true })),
    };
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

  afterEach(() => localStorage.clear());

  it('mirrors the active session into the store, including a refreshed token', () => {
    const { service, auth } = create();
    auth.login('jwt-a', 'ana', 'user');
    TestBed.flushEffects();
    expect(loadProfiles(localStorage).map((p) => [p.username, p.token])).toEqual([
      ['ana', 'jwt-a'],
    ]);
    auth.setToken('jwt-a2');
    TestBed.flushEffects();
    expect(loadProfiles(localStorage)[0].token).toBe('jwt-a2');
    expect(service.profiles().map((p) => p.username)).toEqual(['ana']);
  });

  it('switches: reset → login as the stored person → refresh → Home', async () => {
    const { service, auth, api, navigate, reset } = create();
    rememberProfile(localStorage, { username: 'ben', role: 'admin', token: 'jwt-b' });
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
      loadProfiles(localStorage)
        .map((p) => p.username)
        .sort(),
    ).toEqual(['ana', 'ben']);
  });

  it('a refused refresh forgets that person and asks for the QR again', async () => {
    const { service, auth, navigate } = create('refused');
    rememberProfile(localStorage, { username: 'ben', role: 'user', token: 'expired' });
    auth.login('jwt-a', 'ana', 'user');
    TestBed.flushEffects();

    await service.switchTo('ben');

    expect(loadProfiles(localStorage).map((p) => p.username)).toEqual(['ana']);
    expect(auth.token()).toBeNull();
    expect(navigate).toHaveBeenCalledWith(['/login']);
  });

  it('beginAdd resets the session but keeps the current person in the store', () => {
    const { service, auth, navigate, reset } = create();
    auth.login('jwt-a', 'ana', 'user');
    TestBed.flushEffects();
    service.beginAdd();
    expect(reset).toHaveBeenCalled();
    expect(auth.token()).toBeNull();
    expect(loadProfiles(localStorage).map((p) => p.username)).toEqual(['ana']);
    expect(navigate).toHaveBeenCalledWith(['/login']);
  });

  it('signOut forgets the active person and moves to the next, or to login when alone', async () => {
    const { service, auth, navigate } = create();
    rememberProfile(localStorage, { username: 'ben', role: 'user', token: 'jwt-b' });
    auth.login('jwt-a', 'ana', 'user');
    TestBed.flushEffects();

    await service.signOut();
    expect(auth.username()).toBe('ben');
    expect(loadProfiles(localStorage).map((p) => p.username)).toEqual(['ben']);

    await service.signOut();
    expect(auth.token()).toBeNull();
    expect(loadProfiles(localStorage)).toEqual([]);
    expect(navigate).toHaveBeenLastCalledWith(['/login']);
  });
});
