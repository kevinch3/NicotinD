import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * The engine floor guard (docs/mobile-app.md "Minimum WebView"). On an Android
 * WebView older than the bundle's floor the module entry is a SyntaxError and
 * the app boots to a black screen (moto g6 plus, WebView 70). index.html's
 * inline scripts run before that module, so they must themselves be ES5, and
 * the guard must replace <app-root> with a readable message.
 */
const html = readFileSync(join(__dirname, 'index.html'), 'utf8');
const inlineScripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
const guard = inlineScripts.find((s) => s.includes('engine-too-old'));

// Syntax an old engine cannot parse; one of these in an inline script kills it.
const POST_ES5 = [/\?\./, /\?\?/, /=>/, /\blet\s/, /\bconst\s/, /`/, /\bclass\s/, /\.\.\./];

function runGuard(supportsOklch: boolean | undefined, ua: string) {
  document.body.innerHTML = '<app-root></app-root>';
  Object.defineProperty(window, 'CSS', {
    configurable: true,
    value: supportsOklch === undefined ? undefined : { supports: () => supportsOklch },
  });
  Object.defineProperty(navigator, 'userAgent', { configurable: true, value: ua });
  new Function(guard!)();
}

describe('index.html engine floor guard', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('exists and every inline script is ES5', () => {
    expect(guard).toBeDefined();
    for (const src of inlineScripts) {
      for (const re of POST_ES5) expect(src, `inline script uses ${re}`).not.toMatch(re);
    }
  });

  it('runs before the module bundle can boot', () => {
    expect(html.indexOf('engine-too-old')).toBeGreaterThan(html.indexOf('<app-root>'));
  });

  it('replaces app-root with a message naming the version on an old WebView', () => {
    runGuard(false, 'Mozilla/5.0 (Linux; Android 9) Chrome/70.0.3538.80 Mobile Safari/537.36');
    expect(document.querySelector('app-root')).toBeNull();
    expect(document.getElementById('engine-too-old')?.textContent).toContain('this device has 70');
  });

  it('treats an engine without CSS.supports as too old', () => {
    runGuard(undefined, 'Mozilla/5.0');
    expect(document.getElementById('engine-too-old')).not.toBeNull();
  });

  it('leaves app-root alone on a supported engine', () => {
    runGuard(true, 'Mozilla/5.0 Chrome/138.0.0.0');
    expect(document.querySelector('app-root')).not.toBeNull();
    expect(document.getElementById('engine-too-old')).toBeNull();
  });
});
