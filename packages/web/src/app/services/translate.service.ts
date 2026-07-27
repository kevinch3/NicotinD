import { Injectable, signal, computed } from '@angular/core';

/**
 * Runtime JSON i18n (issue #236).
 *
 * ## Why runtime JSON and not `@angular/localize`
 *
 * `@angular/localize` is compile-time: one build per locale. This project ships
 * a PWA plus Capacitor and Electron shells that all wrap the *same*
 * `@nicotind/web` build, and releases are frequent (0.1.27x at time of writing).
 * N builds per release, N service-worker payloads, and no live language switch
 * is the wrong trade here. Runtime JSON keeps **one build**, lets the language
 * change without a reload, and leaves the catalog as a plain file a translation
 * provider can export/import later — which is the issue's stated v1 goal.
 *
 * ## Why no library
 *
 * `@ngx-translate/core` would work, but the whole surface needed is "look a key
 * up in a JSON object and interpolate `{placeholders}`". That is this file. The
 * repo already made the same call for charting (an inline SVG radar rather than
 * a chart dep — see docs/genre-radar.md), and the initial bundle is already
 * under scrutiny (issue #256). Swapping in a library later is a
 * change of this service, not of the call sites.
 *
 * ## English is always loaded
 *
 * `en` is the base catalog and the source of truth. A non-English catalog is
 * loaded *in addition*, and lookup falls back through it, so a partially
 * translated language shows English for the gaps rather than raw keys. That is
 * what makes incremental translation safe — a translator can ship 20 keys.
 *
 * Missing everywhere, the key itself is returned: visible in the UI (so it gets
 * noticed and fixed) but never blank or crashing.
 */

export const BASE_LANG = 'en';
/** Languages with a catalog in `public/i18n/`. */
export const AVAILABLE_LANGS = ['en', 'es'] as const;
export type Lang = (typeof AVAILABLE_LANGS)[number];

const STORAGE_KEY = 'nicotind-lang';

export type Catalog = Record<string, string>;

/**
 * Pick the startup language: an explicit past choice wins, else the browser's
 * preference when we have a catalog for it, else English.
 *
 * Per-device (localStorage) rather than per-user on purpose for v1: the login,
 * setup and public share pages all render before any user exists, and a
 * language that only applies after sign-in would leave exactly those pages
 * untranslatable. A per-user `user_settings` mirror is a follow-up.
 */
export function resolveInitialLang(
  stored: string | null,
  navigatorLangs: readonly string[],
  available: readonly string[] = AVAILABLE_LANGS,
): string {
  if (stored && available.includes(stored)) return stored;
  for (const raw of navigatorLangs) {
    // `es-AR` → `es`; we key catalogs by base language for v1.
    const base = raw.toLowerCase().split('-')[0];
    if (available.includes(base)) return base;
  }
  return BASE_LANG;
}

/** Substitute `{name}` placeholders. Unknown placeholders are left visible. */
export function interpolate(template: string, params?: Record<string, string | number>): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (whole, key: string) =>
    key in params ? String(params[key]) : whole,
  );
}

@Injectable({ providedIn: 'root' })
export class TranslateService {
  private readonly base = signal<Catalog>({});
  private readonly active = signal<Catalog>({});
  readonly lang = signal<string>(BASE_LANG);
  /** True once the base catalog has loaded; templates render keys until then. */
  readonly ready = signal(false);

  readonly available = AVAILABLE_LANGS;
  readonly isBase = computed(() => this.lang() === BASE_LANG);

  /** Load the base catalog + the resolved language. Call once at bootstrap. */
  async init(fetchFn: typeof fetch = fetch): Promise<void> {
    const stored = safeRead(STORAGE_KEY);
    const navLangs = typeof navigator !== 'undefined' ? (navigator.languages ?? []) : [];
    this.base.set(await loadCatalog(BASE_LANG, fetchFn));
    this.ready.set(true);
    await this.use(resolveInitialLang(stored, navLangs), fetchFn);
  }

  /** Switch language, persisting the choice for this device. */
  async use(lang: string, fetchFn: typeof fetch = fetch): Promise<void> {
    this.lang.set(lang);
    safeWrite(STORAGE_KEY, lang);
    this.active.set(lang === BASE_LANG ? {} : await loadCatalog(lang, fetchFn));
  }

  /**
   * Translate a key. Reads signals, so a template using it re-renders on a
   * language switch with no reload — the property `@angular/localize` can't give.
   */
  t(key: string, params?: Record<string, string | number>): string {
    const hit = this.active()[key] ?? this.base()[key];
    return interpolate(hit ?? key, params);
  }
}

async function loadCatalog(lang: string, fetchFn: typeof fetch): Promise<Catalog> {
  try {
    const res = await fetchFn(`/i18n/${lang}.json`);
    if (!res.ok) return {};
    return (await res.json()) as Catalog;
  } catch {
    // A missing/broken catalog must never break boot — the app falls back to
    // English, or to raw keys if even that failed to load.
    return {};
  }
}

function safeRead(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null; // private mode / disabled storage
  }
}

function safeWrite(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* non-fatal */
  }
}
