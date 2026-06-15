/**
 * Screenshot path helper for the live mobile `*.screens.ts` flows.
 *
 * The pure `shotPath`/`kebab` part lives here (next to the other harness logic)
 * so it is exercised by the CI unit run (`bun test packages/e2e/playground`); the
 * `shot()` wrapper is the thin IO layer the flows call. Screenshots land under
 * `screenshots/mobile/<flow>/NN-label.png` so a lexical sort == capture order and
 * each flow keeps its own folder (no shared counter to collide on).
 */
import type { Page } from '@playwright/test';

const ROOT = 'screenshots/mobile';

/** Kebab-case a free-text label/flow name for safe use in a filename. */
export function kebab(label: string): string {
  return label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Deterministic screenshot path: `screenshots/mobile/<flow>/NN-label.png`.
 * `step` is zero-padded to two digits so filenames sort in capture order.
 */
export function shotPath(flow: string, step: number, label: string): string {
  const nn = String(Math.max(0, Math.trunc(step))).padStart(2, '0');
  return `${ROOT}/${kebab(flow)}/${nn}-${kebab(label)}.png`;
}

export interface ShotOptions {
  /** Capture the full scrollable page (default: just the viewport). */
  fullPage?: boolean;
  /** Settle delay before the shot (covers/transitions), in ms. */
  settleMs?: number;
}

/** Capture a screenshot at the deterministic `shotPath` (IO wrapper). */
export async function shot(
  page: Page,
  flow: string,
  step: number,
  label: string,
  opts: ShotOptions = {},
): Promise<string> {
  if (opts.settleMs) await page.waitForTimeout(opts.settleMs);
  const path = shotPath(flow, step, label);
  await page.screenshot({ path, fullPage: opts.fullPage ?? false });
  return path;
}
