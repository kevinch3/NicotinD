import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type ThemeId =
  | 'midnight'
  | 'daylight'
  | 'warm-paper'
  | 'oled'
  | 'twilight'
  | 'forest';

export interface ThemePreset {
  id: ThemeId;
  name: string;
}

export const THEME_PRESETS: ThemePreset[] = [
  { id: 'midnight',   name: 'Midnight' },
  { id: 'daylight',   name: 'Daylight' },
  { id: 'warm-paper', name: 'Warm Paper' },
  { id: 'oled',       name: 'OLED Black' },
  { id: 'twilight',   name: 'Twilight' },
  { id: 'forest',     name: 'Forest' },
];

interface ThemeStore {
  theme: ThemeId;
  systemTheme: boolean;
  setTheme: (id: ThemeId) => void;
  setSystemTheme: (on: boolean) => void;
  /** Apply the effective theme to <html data-theme="..."> */
  apply: () => void;
}

export function resolveTheme(
  theme: ThemeId,
  systemTheme: boolean,
  isLight = window.matchMedia('(prefers-color-scheme: light)').matches,
): ThemeId {
  if (!systemTheme) return theme;
  return isLight ? 'daylight' : 'midnight';
}

// Module-level ref so the listener can be removed when system-follow is toggled off
let _mqlListener: (() => void) | null = null;

export const useThemeStore = create<ThemeStore>()(
  persist(
    (set, get) => ({
      theme: 'midnight',
      systemTheme: false,

      setTheme: (id) => {
        set({ theme: id });
        document.documentElement.setAttribute(
          'data-theme',
          resolveTheme(id, get().systemTheme),
        );
      },

      setSystemTheme: (on) => {
        set({ systemTheme: on });
        document.documentElement.setAttribute(
          'data-theme',
          resolveTheme(get().theme, on),
        );
        const mql = window.matchMedia('(prefers-color-scheme: light)');
        if (_mqlListener) {
          mql.removeEventListener('change', _mqlListener);
          _mqlListener = null;
        }
        if (on) {
          _mqlListener = () => get().apply();
          mql.addEventListener('change', _mqlListener);
        }
      },

      apply: () => {
        const { theme, systemTheme } = get();
        document.documentElement.setAttribute(
          'data-theme',
          resolveTheme(theme, systemTheme),
        );
      },
    }),
    {
      name: 'nicotind-theme',
      partialize: (s) => ({ theme: s.theme, systemTheme: s.systemTheme }),
    },
  ),
);
