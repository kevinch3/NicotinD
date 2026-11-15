/**
 * Signing in and navigating inside an emulator WebView, shared by the TV and
 * phone lanes (docs/e2e-tv-emulator.md).
 */
import type { Page } from '@playwright/test';

/** The origin the WebView serves the app from — NOT the API origin. */
export const APP_ORIGIN = 'https://localhost';

/** The API as the device reaches it, through `adb reverse`. The host reaches the same port directly. */
export function apiOrigin(port: string): string {
  return `http://localhost:${port}`;
}

export interface LaneUser {
  username: string;
  password: string;
}

/** Register-or-login against the throwaway server; the first user becomes admin. */
export async function mintToken(api: string, user: LaneUser): Promise<string> {
  for (const path of ['/api/auth/register', '/api/auth/login']) {
    const res = await fetch(`${api}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(user),
    });
    if (res.ok) {
      const body = (await res.json()) as { token?: string };
      if (body.token) return body.token;
    }
  }
  throw new Error(`[e2e:android] could not obtain a token from ${api}`);
}

/**
 * Sign in by seeding localStorage.
 *
 * `storageState` cannot work here — it's a different browser on a different
 * device. The token is minted over HTTP against the fixture server and written
 * into the WebView's storage; the next navigation boots Angular authenticated.
 */
export async function seedAuth(page: Page, api: string, user: LaneUser): Promise<string> {
  const token = await mintToken(api, user);
  await page.goto(`${APP_ORIGIN}/`);
  await page.evaluate(
    ([origin, jwt, username]) => {
      localStorage.setItem('nicotind_server_url', origin);
      localStorage.setItem('nicotind_token', jwt);
      localStorage.setItem('nicotind_username', username);
      localStorage.setItem('nicotind_role', 'admin');
    },
    [api, token, user.username] as const,
  );
  return token;
}

/** Navigate within the app (app origin, not the API origin). */
export async function goto(page: Page, route: string): Promise<void> {
  await page.goto(`${APP_ORIGIN}${route}`);
  await page.waitForLoadState('domcontentloaded');
}
