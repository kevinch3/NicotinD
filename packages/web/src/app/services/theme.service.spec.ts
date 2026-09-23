import { TestBed } from '@angular/core/testing';
import { vi } from 'vitest';
import { resolveTheme, THEME_PRESETS, ThemeService, type ThemeId } from './theme.service';
import { UserPreferencesService } from './user-preferences.service';

describe('THEME_PRESETS', () => {
  const EXPECTED_IDS: ThemeId[] = [
    'midnight',
    'daylight',
    'warm-paper',
    'oled',
    'twilight',
    'forest',
    'eink',
  ];

  it('contains exactly 7 presets', () => {
    expect(THEME_PRESETS).toHaveLength(7);
  });

  it('includes all required theme IDs', () => {
    const ids = THEME_PRESETS.map((p) => p.id);
    for (const id of EXPECTED_IDS) {
      expect(ids).toContain(id);
    }
  });

  it('every preset has a non-empty name', () => {
    for (const preset of THEME_PRESETS) {
      expect(preset.name.length).toBeGreaterThan(0);
    }
  });

  it('midnight is first (used as default)', () => {
    expect(THEME_PRESETS[0].id).toBe('midnight');
  });
});

describe('resolveTheme', () => {
  it('returns the chosen theme when systemTheme is false', () => {
    expect(resolveTheme('daylight', false, true)).toBe('daylight');
    expect(resolveTheme('forest', false, false)).toBe('forest');
    expect(resolveTheme('oled', false, true)).toBe('oled');
  });

  it('ignores the isLight arg when systemTheme is false', () => {
    expect(resolveTheme('twilight', false, true)).toBe('twilight');
    expect(resolveTheme('twilight', false, false)).toBe('twilight');
  });

  it('returns daylight when systemTheme is true and OS is light', () => {
    expect(resolveTheme('midnight', true, true)).toBe('daylight');
    expect(resolveTheme('forest', true, true)).toBe('daylight');
  });

  it('returns midnight when systemTheme is true and OS is dark', () => {
    expect(resolveTheme('daylight', true, false)).toBe('midnight');
    expect(resolveTheme('warm-paper', true, false)).toBe('midnight');
  });
});

// The per-user door (#1299): a choice writes through, a server hydrate is
// adopted without writing back, and the mirrored per-user theme beats the
// device key at construction.
describe('ThemeService — per-user preferences', () => {
  function stubMatchMedia() {
    (window as { matchMedia?: unknown }).matchMedia = () => ({
      matches: false,
      addEventListener: () => {},
      removeEventListener: () => {},
    });
  }

  function setup() {
    localStorage.clear();
    stubMatchMedia();
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({});
    const prefs = TestBed.inject(UserPreferencesService);
    const patch = vi.spyOn(prefs, 'patch');
    return { prefs, patch };
  }

  afterEach(() => {
    localStorage.clear();
    delete (window as { matchMedia?: unknown }).matchMedia;
  });

  it('setTheme applies locally and writes through the preferences door', () => {
    const { patch } = setup();
    const svc = TestBed.inject(ThemeService);
    svc.setTheme('forest');
    expect(document.documentElement.getAttribute('data-theme')).toBe('forest');
    expect(patch).toHaveBeenCalledWith({ theme: 'forest' });
  });

  it('setSystemTheme writes followSystemTheme through', () => {
    const { patch } = setup();
    TestBed.inject(ThemeService).setSystemTheme(true);
    expect(patch).toHaveBeenCalledWith({ followSystemTheme: true });
  });

  it('adoptPreferences takes the server choice without writing it back', () => {
    const { prefs, patch } = setup();
    const svc = TestBed.inject(ThemeService);
    prefs.hydrate({ ...prefs.preferences(), theme: 'eink', followSystemTheme: false });
    svc.adoptPreferences();
    expect(svc.theme()).toBe('eink');
    expect(document.documentElement.getAttribute('data-theme')).toBe('eink');
    expect(patch).not.toHaveBeenCalled();
  });

  it('adoptPreferences leaves a device choice alone when the server has none', () => {
    const { prefs } = setup();
    localStorage.setItem('nicotind-theme', JSON.stringify({ state: { theme: 'oled' } }));
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({});
    const svc = TestBed.inject(ThemeService);
    expect(svc.theme()).toBe('oled');
    prefs.hydrate(prefs.preferences());
    svc.adoptPreferences();
    expect(svc.theme()).toBe('oled');
  });

  it('at construction the mirrored per-user theme wins over the device key', () => {
    setup();
    localStorage.setItem('nicotind-theme', JSON.stringify({ state: { theme: 'oled' } }));
    localStorage.setItem(
      'nicotind-prefs',
      JSON.stringify({
        homeView: null,
        theme: 'twilight',
        followSystemTheme: null,
        language: null,
        radioStrategy: null,
        welcomeDismissed: false,
      }),
    );
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({});
    expect(TestBed.inject(ThemeService).theme()).toBe('twilight');
  });
});
