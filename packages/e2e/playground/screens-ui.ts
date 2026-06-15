/**
 * Small resilience helpers for the live `*.screens.ts` flows. Live screenshot
 * runs target a *deployed* backend that may be a release or two behind this
 * branch, so a flow must (a) wait for async content before probing optional
 * elements (the SPA renders grids / plugin-gated affordances after its initial
 * fetches) and (b) fall back from a not-yet-deployed `data-testid` to a stable
 * role/text selector. These keep the flow capturing instead of hard-failing.
 */
import type { Locator } from '@playwright/test';

/** First locator (as `.first()`) that currently matches ≥1 element, else null. */
export async function firstPresent(...locators: Locator[]): Promise<Locator | null> {
  for (const loc of locators) {
    if ((await loc.count()) > 0) return loc.first();
  }
  return null;
}

/**
 * Wait until `loc` is visible, returning whether it appeared within `timeoutMs`.
 * Never throws — absence is a signal the flow records, not a test failure.
 */
export async function appeared(loc: Locator, timeoutMs = 8000): Promise<boolean> {
  try {
    await loc.first().waitFor({ state: 'visible', timeout: timeoutMs });
    return true;
  } catch {
    return false;
  }
}
