import { Injectable, inject, signal } from '@angular/core';
import { THEME_IDS, type ThemeId } from '@nicotind/core';
import { UserPreferencesService } from './user-preferences.service';

// The id list lives in core (#1299) so the API validates a preference against
// exactly the presets the web renders; re-exported for the existing importers.
export type { ThemeId };

export interface ThemePreset {
  id: ThemeId;
  name: string;
}

export const THEME_PRESETS: ThemePreset[] = [
  { id: 'midnight', name: 'Midnight' },
  { id: 'daylight', name: 'Daylight' },
  { id: 'warm-paper', name: 'Warm Paper' },
  { id: 'oled', name: 'OLED Black' },
  { id: 'twilight', name: 'Twilight' },
  { id: 'forest', name: 'Forest' },
  { id: 'eink', name: 'E-Ink' },
];

const STORAGE_KEY = 'nicotind-theme';

const ACCENT_COLORS: Record<ThemeId, string> = {
  midnight: '#6366f1',
  daylight: '#6366f1',
  'warm-paper': '#d97706',
  oled: '#818cf8',
  twilight: '#a78bfa',
  forest: '#2dd4bf',
  eink: '#000000',
};

export function resolveTheme(
  theme: ThemeId,
  systemTheme: boolean,
  isLight = window.matchMedia('(prefers-color-scheme: light)').matches,
): ThemeId {
  if (!systemTheme) return theme;
  return isLight ? 'daylight' : 'midnight';
}

@Injectable({ providedIn: 'root' })
export class ThemeService {
  readonly theme = signal<ThemeId>('midnight');
  readonly systemTheme = signal(false);

  private mqlListener: (() => void) | null = null;
  private readonly prefs = inject(UserPreferencesService);

  constructor() {
    this.loadFromStorage();
    // The per-user mirror beats the device key: the last person to sign in on
    // this device chose it, and the server will confirm or correct on /me.
    this.adoptPreferences();
  }

  /** A user choice: apply here, then write it through the per-user door. */
  setTheme(id: ThemeId): void {
    this.applyTheme(id);
    this.prefs.patch({ theme: id });
  }

  setSystemTheme(on: boolean): void {
    this.applySystemTheme(on);
    this.prefs.patch({ followSystemTheme: on });
  }

  /** Take what the per-user door holds (a server hydrate or the mirror), writing nothing back. */
  adoptPreferences(): void {
    const theme = this.prefs.theme();
    const follow = this.prefs.followSystemTheme();
    if (theme && theme !== this.theme()) this.applyTheme(theme);
    if (follow !== null && follow !== this.systemTheme()) this.applySystemTheme(follow);
  }

  private applyTheme(id: ThemeId): void {
    this.theme.set(id);
    this.applyToDOM();
    this.persist();
  }

  private applySystemTheme(on: boolean): void {
    this.systemTheme.set(on);
    this.applyToDOM();
    this.persist();

    const mql = window.matchMedia('(prefers-color-scheme: light)');
    if (this.mqlListener) {
      mql.removeEventListener('change', this.mqlListener);
      this.mqlListener = null;
    }
    if (on) {
      this.mqlListener = () => this.applyToDOM();
      mql.addEventListener('change', this.mqlListener);
    }
  }

  apply(): void {
    this.applyToDOM();
  }

  private applyToDOM(): void {
    const resolved = resolveTheme(this.theme(), this.systemTheme());
    document.documentElement.setAttribute('data-theme', resolved);
    const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
    if (meta) meta.content = ACCENT_COLORS[resolved];
  }

  private persist(): void {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ state: { theme: this.theme(), systemTheme: this.systemTheme() } }),
    );
  }

  private loadFromStorage(): void {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const stored = JSON.parse(raw);
      const t = stored.state?.theme;
      const s = stored.state?.systemTheme;
      if (t && (THEME_IDS as readonly string[]).includes(t)) {
        this.theme.set(t);
      }
      if (typeof s === 'boolean') {
        this.systemTheme.set(s);
      }
    } catch {
      /* ignore corrupt storage */
    }
  }
}
