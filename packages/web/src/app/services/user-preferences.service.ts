/**
 * UserPreferencesService — the one door for what follows a person across
 * devices (issue #1299): home view, theme, language, radio variety, welcome.
 *
 * Two stores, one precedence rule:
 * - a **per-device mirror** in localStorage, read synchronously at construction
 *   so the first paint after a reload already shows the remembered choice;
 * - the **server** (`/api/me/preferences`, embedded in `/api/auth/me`), which
 *   wins whenever it answers (`hydrate`).
 *
 * Writes are optimistic: state and mirror move first, the PATCH follows, and a
 * failed write reverts. Nothing is sent without a stored session — the login,
 * setup and share pages carry a language picker before any user exists, and a
 * 401 from there would make the auth interceptor bounce the user mid-login.
 *
 * Owning services (ThemeService, TranslateService, PlayerService) keep their
 * own signals and device storage; they call `patch()` on a user choice and
 * follow this service's signals when the server hydrates. That direction —
 * owners depend on this, never the reverse — is what keeps the graph acyclic.
 * `HttpClient` is optional so a spec that never provides it still runs. The
 * validator is the zod-free `parseUserPreferences`: zod must not enter the
 * initial bundle for a six-key object.
 */
import { Injectable, computed, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import {
  EMPTY_USER_PREFERENCES,
  parseUserPreferences,
  type UserPreferences,
  type UserPreferencesPatch,
} from '@nicotind/core';

export const PREFERENCES_MIRROR_KEY = 'nicotind-prefs';
const SESSION_TOKEN_KEY = 'nicotind_token';

export function mergePreferences(
  base: UserPreferences,
  patch: UserPreferencesPatch,
): UserPreferences {
  const next = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) (next as Record<string, unknown>)[key] = value;
  }
  return next;
}

function readMirror(): UserPreferences {
  try {
    const raw = localStorage.getItem(PREFERENCES_MIRROR_KEY);
    if (!raw) return EMPTY_USER_PREFERENCES;
    return parseUserPreferences(JSON.parse(raw)) ?? EMPTY_USER_PREFERENCES;
  } catch {
    return EMPTY_USER_PREFERENCES;
  }
}

function writeMirror(prefs: UserPreferences | null): void {
  try {
    if (prefs) localStorage.setItem(PREFERENCES_MIRROR_KEY, JSON.stringify(prefs));
    else localStorage.removeItem(PREFERENCES_MIRROR_KEY);
  } catch {
    /* storage unavailable — the choice still lives on the server */
  }
}

function hasStoredSession(): boolean {
  try {
    return localStorage.getItem(SESSION_TOKEN_KEY) !== null;
  } catch {
    return false;
  }
}

@Injectable({ providedIn: 'root' })
export class UserPreferencesService {
  private readonly http = inject(HttpClient, { optional: true });
  private readonly state = signal<UserPreferences>(readMirror());

  readonly preferences = this.state.asReadonly();
  readonly homeView = computed(() => this.state().homeView);
  readonly theme = computed(() => this.state().theme);
  readonly followSystemTheme = computed(() => this.state().followSystemTheme);
  readonly language = computed(() => this.state().language);
  readonly radioStrategy = computed(() => this.state().radioStrategy);
  readonly welcomeDismissed = computed(() => this.state().welcomeDismissed);

  /** The server's word, on `/me`: replaces the state and the mirror. */
  hydrate(server: UserPreferences): void {
    this.state.set(server);
    writeMirror(server);
  }

  /** A user choice: optimistic locally, then written through; reverted on failure. */
  patch(patch: UserPreferencesPatch): void {
    const before = this.state();
    const next = mergePreferences(before, patch);
    this.state.set(next);
    writeMirror(next);
    if (!this.http || !hasStoredSession()) return;
    this.http.patch<UserPreferences>('/api/me/preferences', patch).subscribe({
      next: (merged) => {
        const parsed = parseUserPreferences(merged);
        if (parsed) this.hydrate(parsed);
      },
      error: () => {
        this.state.set(before);
        writeMirror(before);
      },
    });
  }

  /** Logout or a server switch: nothing of the old person stays on the device. */
  clear(): void {
    this.state.set(EMPTY_USER_PREFERENCES);
    writeMirror(null);
  }
}
