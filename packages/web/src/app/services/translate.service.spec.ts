import { TestBed } from '@angular/core/testing';
import { Component } from '@angular/core';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TranslateService, resolveInitialLang, interpolate } from './translate.service';
import { TranslatePipe } from '../pipes/translate.pipe';

const EN = { 'login.title': 'Sign in', 'login.hi': 'Hi {name}', 'only.en': 'English only' };
const ES = { 'login.title': 'Iniciar sesión' };

/** Serves the two catalogs without touching the network. */
function fakeFetch(catalogs: Record<string, unknown> = { en: EN, es: ES }) {
  return vi.fn(async (url: string) => {
    const lang = url.replace('/i18n/', '').replace('.json', '');
    const body = catalogs[lang];
    return {
      ok: body !== undefined,
      json: async () => body,
    } as unknown as Response;
  }) as unknown as typeof fetch;
}

describe('resolveInitialLang', () => {
  it('prefers an explicit past choice', () => {
    expect(resolveInitialLang('es', ['en-US'])).toBe('es');
  });

  it('ignores a stored language we have no catalog for', () => {
    // A catalog can be removed between releases; don't strand the user on it.
    expect(resolveInitialLang('kl', ['en-US'])).toBe('en');
  });

  it('falls back to the browser preference, matching on the base language', () => {
    // `es-AR` must match the `es` catalog — v1 keys catalogs by base language.
    expect(resolveInitialLang(null, ['es-AR', 'en'])).toBe('es');
  });

  it('walks the preference list in order', () => {
    expect(resolveInitialLang(null, ['kl-GL', 'es-MX'])).toBe('es');
  });

  it('defaults to English when nothing matches', () => {
    expect(resolveInitialLang(null, ['kl-GL'])).toBe('en');
    expect(resolveInitialLang(null, [])).toBe('en');
  });
});

describe('interpolate', () => {
  it('substitutes named placeholders', () => {
    expect(interpolate('Hi {name}, {n} new', { name: 'Ana', n: 3 })).toBe('Hi Ana, 3 new');
  });

  it('leaves an unknown placeholder visible rather than blanking it', () => {
    // A silently-empty string hides the bug; a visible {who} gets reported.
    expect(interpolate('Hi {who}', { name: 'Ana' })).toBe('Hi {who}');
  });

  it('is a no-op with no params', () => {
    expect(interpolate('Plain')).toBe('Plain');
  });
});

describe('TranslateService', () => {
  let svc: TranslateService;

  beforeEach(() => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({});
    svc = TestBed.inject(TranslateService);
    localStorage.clear();
  });

  it('translates from the active catalog', async () => {
    await svc.init(fakeFetch());
    await svc.use('es', fakeFetch());
    expect(svc.t('login.title')).toBe('Iniciar sesión');
  });

  /** The property that makes incremental translation safe. */
  it('falls back to English for a key the language lacks', async () => {
    await svc.init(fakeFetch());
    await svc.use('es', fakeFetch());
    expect(svc.t('only.en')).toBe('English only');
  });

  it('returns the key itself when it exists nowhere', async () => {
    await svc.init(fakeFetch());
    // Visible in the UI so it gets noticed and fixed — never blank.
    expect(svc.t('nope.missing')).toBe('nope.missing');
  });

  it('interpolates through t()', async () => {
    await svc.init(fakeFetch());
    expect(svc.t('login.hi', { name: 'Ana' })).toBe('Hi Ana');
  });

  it('remembers the choice for this device', async () => {
    await svc.init(fakeFetch());
    await svc.use('es', fakeFetch());
    expect(localStorage.getItem('nicotind-lang')).toBe('es');
  });

  /** A broken catalog must never break boot. */
  it('degrades to raw keys when the catalog fetch fails', async () => {
    const failing = vi.fn(async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    await svc.init(failing);
    expect(svc.t('login.title')).toBe('login.title');
  });

  it('degrades to English when only the target catalog is missing', async () => {
    await svc.init(fakeFetch({ en: EN })); // no `es`
    await svc.use('es', fakeFetch({ en: EN }));
    expect(svc.t('login.title')).toBe('Sign in');
  });
});

/**
 * The switch has to actually reach the DOM, and this is the test that decided
 * the pipe's design. A PURE pipe looked right — `t()` reads signals — but it
 * FAILS here: a pure pipe memoizes on its arguments, so when only the language
 * changes `transform` is never called again and the signal is never read. The
 * pipe is impure (with an internal memo) because of this assertion, not despite
 * it. Don't "optimise" it back to pure without re-running this.
 */
@Component({
  standalone: true,
  imports: [TranslatePipe],
  template: `<span data-testid="out">{{ 'login.title' | t }}</span>`,
})
class HostComponent {}

describe('TranslatePipe reactivity', () => {
  it('re-renders through a pure pipe when the language changes', async () => {
    // The service is providedIn:'root' and persists the choice, so a prior
    // test's `es` would otherwise leak in through init()'s stored-language path.
    localStorage.clear();
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ imports: [HostComponent] });
    const svc = TestBed.inject(TranslateService);
    await svc.init(fakeFetch());

    const fixture = TestBed.createComponent(HostComponent);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.textContent).toContain('Sign in');

    await svc.use('es', fakeFetch());
    fixture.detectChanges();
    expect(el.textContent).toContain('Iniciar sesión');
  });

  /**
   * #1106: `lang` flips synchronously in `use()`, strictly before the catalog
   * it names has loaded. A render inside that window used to memoize the
   * English fallback under `(key, lang='es', params)` — a key the eventual
   * catalog load can never invalidate again, since `lang` does not change a
   * second time. The switch above never renders inside the window (it awaits
   * `use()` before ever calling `detectChanges`), so it could not catch this.
   */
  it('does not strand the English fallback when the target catalog lands after a render (#1106)', async () => {
    localStorage.clear();
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ imports: [HostComponent] });
    const svc = TestBed.inject(TranslateService);
    await svc.init(fakeFetch());

    // Hold `es.json` open — the way a fresh service worker's sequential
    // prefetch does (#1106) — and render WHILE `lang()` already reads 'es' but
    // `active()` is still empty.
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const slowEs = vi.fn(async (url: string) => {
      if (url.includes('es.json')) await held;
      return { ok: true, json: async () => ES } as unknown as Response;
    }) as unknown as typeof fetch;

    const fixture = TestBed.createComponent(HostComponent);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.textContent).toContain('Sign in');

    const switching = svc.use('es', slowEs);
    fixture.detectChanges(); // renders INSIDE the window — the defect site
    expect(el.textContent).toContain('Sign in'); // correct fallback at this instant

    release();
    await switching;
    fixture.detectChanges();
    expect(el.textContent).toContain('Iniciar sesión'); // must not still read the memoized fallback
  });

  /**
   * The same defect on the OTHER catalog, and `(key, lang)` cannot even
   * express it: `lang` never changes here (`init()`'s language resolution
   * hasn't run yet), so a fix keyed only on `lang` would not touch this case.
   */
  it('does not strand a raw key when the base catalog lands after a render (#1106)', async () => {
    localStorage.clear();
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ imports: [HostComponent] });
    const svc = TestBed.inject(TranslateService);

    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const slowEn = vi.fn(async (url: string) => {
      if (url.includes('en.json')) await held;
      return { ok: true, json: async () => EN } as unknown as Response;
    }) as unknown as typeof fetch;

    const initing = svc.init(slowEn);
    const fixture = TestBed.createComponent(HostComponent);
    fixture.detectChanges(); // renders before the base catalog exists at all
    const el = fixture.nativeElement as HTMLElement;
    expect(el.textContent).toContain('login.title'); // the raw key — correct at this instant

    release();
    await initing;
    fixture.detectChanges();
    expect(el.textContent).toContain('Sign in'); // must not still read the memoized raw key
  });
});
