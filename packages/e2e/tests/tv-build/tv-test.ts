// Composes on the suite's `test` (helpers.ts), so the TV lane gets the same
// per-spec playback-session reset as the phone lane — its server is separate,
// but its specs play audio too.
import { test as base, expect, type Locator, type Page } from '../../helpers';

export { expect };

/** What a 1080p Android TV gives the WebView: 960×540 CSS px (DPR 2 there,
 *  DPR 1 here — the layout is identical and the baselines stay small). */
export const TV_VIEWPORT = { width: 960, height: 540 } as const;

/**
 * The `tv` project's `test`: every spec in this folder imports it from here.
 *
 * It pins the fonts. A screenshot baseline is a rendering, and text is most of
 * every TV screen: the UI font stack resolves through fontconfig to whatever
 * the box has (FreeSans here, Liberation or Ubuntu on a runner), and two
 * machines disagreeing on a typeface fail every baseline for no reason a
 * layout would recognise. DejaVu Sans is what every Ubuntu image — a GitHub
 * runner included — carries, and Noto Color Emoji is what Playwright's own
 * `install-deps` puts down, so both are pinned by an injected stylesheet. The
 * real TV renders Roboto; any face is a stand-in there, and the geometry
 * assertions beside the screenshots do not depend on which one.
 *
 * Baselines are therefore **Linux renderings** — regenerate them with
 * `--update-snapshots` on Linux only; the .gitignore drops the darwin/win32
 * files another OS would write.
 */
export const test = base.extend<{ pinnedFonts: void }>({
  pinnedFonts: [
    async ({ page }, use) => {
      await page.addInitScript(() => {
        const install = (): void => {
          const style = document.createElement('style');
          style.setAttribute('data-e2e-pinned-fonts', '');
          style.textContent =
            '*, *::before, *::after { font-family: "DejaVu Sans", "Noto Color Emoji", sans-serif !important; }' +
            'code, pre, .font-mono { font-family: "DejaVu Sans Mono", monospace !important; }';
          document.head.appendChild(style);
        };
        if (document.head) install();
        else document.addEventListener('DOMContentLoaded', install);
      });
      await use();
    },
    { auto: true },
  ],
});

/**
 * The invariant the TV surface is built on (docs/tv-ux.md "Enforcement"): a
 * remote has no Tab key, so any focusable native form control is a trap by
 * construction. The emulator lane asserts it per route; this lane asserts it
 * on every screen it screenshots, including overlays, which the emulator's
 * route walk never opens.
 */
export async function expectNoNativeFormControls(page: Page): Promise<void> {
  await expect(page.locator('input, select, textarea, [contenteditable]')).toHaveCount(0);
}

/** The element's centre, from its bounding box. */
export async function centreOf(locator: Locator): Promise<{ x: number; y: number }> {
  const box = await locator.boundingBox();
  if (!box) throw new Error(`no bounding box for ${locator}`);
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/**
 * Everything the TV shows must fit: a TV does not scroll to reveal what a
 * page forgot to fit, it just cuts it off (#1133, #1135). Pass the elements
 * a viewer must be able to see without moving focus.
 */
export async function expectFitsTheScreen(page: Page, ...mustSee: Locator[]): Promise<void> {
  for (const el of mustSee) await expect(el).toBeInViewport({ ratio: 1 });
}
