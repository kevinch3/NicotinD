import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { EMPTY_USER_PREFERENCES, type UserPreferences } from '@nicotind/core';
import {
  PREFERENCES_MIRROR_KEY,
  UserPreferencesService,
  mergePreferences,
} from './user-preferences.service';

const SERVER: UserPreferences = {
  homeView: 'shelves',
  theme: 'eink',
  followSystemTheme: false,
  language: 'es',
  radioStrategy: 'similar',
  welcomeDismissed: true,
  queueAcquired: false,
};

describe('mergePreferences', () => {
  it('overlays only the keys the patch carries', () => {
    expect(mergePreferences(EMPTY_USER_PREFERENCES, { theme: 'oled' })).toEqual({
      ...EMPTY_USER_PREFERENCES,
      theme: 'oled',
    });
  });
});

describe('UserPreferencesService', () => {
  function setup(opts: { session?: boolean; mirror?: UserPreferences; http?: boolean } = {}) {
    localStorage.clear();
    if (opts.session ?? true) localStorage.setItem('nicotind_token', 'tok');
    if (opts.mirror) localStorage.setItem(PREFERENCES_MIRROR_KEY, JSON.stringify(opts.mirror));
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: (opts.http ?? true) ? [provideHttpClient(), provideHttpClientTesting()] : [],
    });
    const svc = TestBed.inject(UserPreferencesService);
    const http = (opts.http ?? true) ? TestBed.inject(HttpTestingController) : null;
    return { svc, http };
  }

  afterEach(() => localStorage.clear());

  it('starts empty when nothing is mirrored on this device', () => {
    const { svc } = setup();
    expect(svc.preferences()).toEqual(EMPTY_USER_PREFERENCES);
    expect(svc.theme()).toBeNull();
  });

  // First paint after a reload must already be the remembered view: the mirror
  // is read synchronously at construction, before /me answers.
  it('loads the per-device mirror at construction', () => {
    const { svc } = setup({ mirror: SERVER });
    expect(svc.preferences()).toEqual(SERVER);
    expect(svc.language()).toBe('es');
  });

  it('ignores a corrupt or unknown-shaped mirror', () => {
    localStorage.setItem(PREFERENCES_MIRROR_KEY, '{not json');
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    expect(TestBed.inject(UserPreferencesService).preferences()).toEqual(EMPTY_USER_PREFERENCES);

    localStorage.setItem(PREFERENCES_MIRROR_KEY, JSON.stringify({ theme: 'neon', extra: 1 }));
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    expect(TestBed.inject(UserPreferencesService).preferences()).toEqual(EMPTY_USER_PREFERENCES);
  });

  it('hydrate replaces the state with the server object and rewrites the mirror', () => {
    const { svc } = setup({ mirror: { ...EMPTY_USER_PREFERENCES, theme: 'forest' } });
    svc.hydrate(SERVER);
    expect(svc.preferences()).toEqual(SERVER);
    expect(JSON.parse(localStorage.getItem(PREFERENCES_MIRROR_KEY)!)).toEqual(SERVER);
  });

  it('patch is optimistic: state and mirror update before the PATCH answers', () => {
    const { svc, http } = setup();
    svc.patch({ homeView: 'shelves' });
    expect(svc.homeView()).toBe('shelves');
    expect(JSON.parse(localStorage.getItem(PREFERENCES_MIRROR_KEY)!).homeView).toBe('shelves');

    const req = http!.expectOne({ method: 'PATCH', url: '/api/me/preferences' });
    expect(req.request.body).toEqual({ homeView: 'shelves' });
    req.flush({ ...EMPTY_USER_PREFERENCES, homeView: 'shelves' });
    expect(svc.homeView()).toBe('shelves');
  });

  it('patch adopts the merged object the server returns (another device may have written)', () => {
    const { svc, http } = setup();
    svc.patch({ theme: 'oled' });
    http!.expectOne('/api/me/preferences').flush({ ...SERVER, theme: 'oled' });
    expect(svc.preferences()).toEqual({ ...SERVER, theme: 'oled' });
  });

  it('patch reverts the key on a failed write', () => {
    const { svc, http } = setup({ mirror: { ...EMPTY_USER_PREFERENCES, theme: 'forest' } });
    svc.patch({ theme: 'oled' });
    expect(svc.theme()).toBe('oled');
    http!.expectOne('/api/me/preferences').flush('nope', { status: 500, statusText: 'boom' });
    expect(svc.theme()).toBe('forest');
    expect(JSON.parse(localStorage.getItem(PREFERENCES_MIRROR_KEY)!).theme).toBe('forest');
  });

  // The login/setup/share pages render before any user exists and still carry
  // a language picker; a PATCH from there would 401 and the interceptor would
  // bounce the user to /login mid-login.
  it('patch keeps the device mirror but sends nothing without a stored session', () => {
    const { svc, http } = setup({ session: false });
    svc.patch({ language: 'es' });
    expect(svc.language()).toBe('es');
    http!.expectNone('/api/me/preferences');
  });

  it('works without an HttpClient in the injector (pure device mirror)', () => {
    const { svc } = setup({ http: false });
    svc.patch({ theme: 'oled' });
    expect(svc.theme()).toBe('oled');
  });

  // #1294: an opt-out — never chosen reads as on, only an explicit false is off.
  it('reads queueAcquired as on until the person turns it off', () => {
    const { svc: prefs } = setup({ session: false });
    expect(prefs.queueAcquired()).toBe(true);
    prefs.patch({ queueAcquired: false });
    expect(prefs.queueAcquired()).toBe(false);
    prefs.patch({ queueAcquired: true });
    expect(prefs.queueAcquired()).toBe(true);
  });

  it('clear drops the state and the mirror (logout / server switch)', () => {
    const { svc } = setup({ mirror: SERVER });
    svc.clear();
    expect(svc.preferences()).toEqual(EMPTY_USER_PREFERENCES);
    expect(localStorage.getItem(PREFERENCES_MIRROR_KEY)).toBeNull();
  });
});
