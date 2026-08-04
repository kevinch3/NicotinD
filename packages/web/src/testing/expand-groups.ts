/**
 * Shared JIT-harness helper for specs rendering `SettingsGroupComponent`
 * cards (issue #377 — this used to be copy-pasted per spec file).
 *
 * `SettingsGroupComponent` persists open/closed to localStorage per groupId,
 * which survives across tests within a file (jsdom's localStorage is
 * process-wide, not reset per-test). Only click a toggle that's actually
 * closed — blindly clicking every toggle would re-collapse a group a prior
 * test already opened and left "true" in storage.
 *
 * Extra selectors run as additional passes: nested toggles (an Extensions
 * plugin card) only mount once their enclosing group's first pass has run
 * `detectChanges()`, so each pass queries the DOM the previous one revealed.
 */
export interface ExpandableFixture {
  nativeElement: unknown;
  detectChanges: () => void;
}

export function expandAllGroups(
  fixture: ExpandableFixture,
  extraToggleSelectors: string[] = [],
): void {
  const el = fixture.nativeElement as HTMLElement;
  for (const selector of ['[data-testid="settings-group-toggle"]', ...extraToggleSelectors]) {
    el.querySelectorAll<HTMLButtonElement>(selector).forEach((btn) => {
      if (btn.getAttribute('aria-expanded') !== 'true') btn.click();
    });
    fixture.detectChanges();
  }
}
