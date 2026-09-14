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
   * A fetch whose catalogs resolve only when the test says so — the order at
   * bootstrap, where `init()` is not awaited and the first render happens
   * while the catalogs are still in flight.
   */
  function deferredFetch(catalogs: Record<string, unknown>) {
    const release: Record<string, () => void> = {};
    const fetchFn = vi.fn(
      (url: string) =>
        new Promise<Response>((resolve) => {
          const lang = url.replace('/i18n/', '').replace('.json', '');
          release[lang] = () =>
            resolve({ ok: true, json: async () => catalogs[lang] } as unknown as Response);
        }),
    ) as unknown as typeof fetch;
    return { fetchFn, release };
  }

  it('a catalog that lands after the first render still reaches the DOM', async () => {
    // The memo used to be (key, language, params): the first render looked up
    // an empty catalog, fell through to the key, and memoized THAT — the
    // arrival of the catalog invalidated nothing. Keys stayed on screen.
    localStorage.clear();
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ imports: [HostComponent] });
    const svc = TestBed.inject(TranslateService);
    const { fetchFn, release } = deferredFetch({ en: EN });
    const booting = svc.init(fetchFn);

    const fixture = TestBed.createComponent(HostComponent);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.textContent).toContain('login.title');

    release['en']!();
    await booting;
    fixture.detectChanges();
    expect(el.textContent).toContain('Sign in');
  });

  it('never shows the base text under the new language while its catalog loads', async () => {
    // `use()` flipped `lang` first and awaited the catalog second, so the
    // render in between memoized "Sign in" under 'es' for good. Now the flip
    // waits for the catalog: mid-load the page is still, truthfully, English.
    localStorage.clear();
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ imports: [HostComponent] });
    const svc = TestBed.inject(TranslateService);
    await svc.init(fakeFetch({ en: EN }));
    const fixture = TestBed.createComponent(HostComponent);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;

    const { fetchFn, release } = deferredFetch({ es: ES });
    const switching = svc.use('es', fetchFn);
    fixture.detectChanges();
    expect(svc.lang()).toBe('en');
    expect(el.textContent).toContain('Sign in');

    release['es']!();
    await switching;
    fixture.detectChanges();
    expect(svc.lang()).toBe('es');
    expect(el.textContent).toContain('Iniciar sesión');
  });
});
