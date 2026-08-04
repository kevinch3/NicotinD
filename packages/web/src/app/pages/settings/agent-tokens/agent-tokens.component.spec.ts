import { TestBed } from '@angular/core/testing';
import { expandAllGroups } from '../../../../testing/expand-groups';
import { describe, it, expect } from 'vitest';
import { of, throwError } from 'rxjs';
import { provideRouter } from '@angular/router';
import { AgentTokensComponent } from './agent-tokens.component';
import { AgentTokensApiService } from '../../../services/api/agent-tokens-api.service';
import type { AgentTokenMintResponse, AgentTokenRow } from '../../../services/api/api-types';

const TOKENS: AgentTokenRow[] = [
  {
    id: 't1',
    userId: 'u1',
    name: 'Claude Desktop',
    scope: 'refiner:curate',
    createdAt: Date.now(),
    lastUsedAt: null,
    expiresAt: null,
    revokedAt: null,
  },
];

const MINT: AgentTokenMintResponse = {
  id: 't2',
  name: 'New agent',
  scope: 'refiner:curate',
  expiresAt: null,
  token: 'nca_secret',
};

/**
 * Task 3 (settings-cards unification): the two sections are now collapsible
 * `<app-settings-group>` cards. This JIT vitest harness never registers signal
 * inputs on a nested imported component (see `src/testing/signal-input.ts`),
 * so every group's `[groupId]` binding silently fails to land and all groups
 * fall back to the same default groupId (`''`) — meaning they share one
 * localStorage key. Harmless for opening every card (this helper just clicks
 * whichever toggles are still closed), but a prior test's "open" write can
 * leak into a later fixture — tests asserting the fresh-render collapsed
 * state must `localStorage.clear()` first, mirroring
 * `settings.component.spec.ts`/`admin.component.spec.ts`.
 */
function setup(overrides: Partial<Record<keyof AgentTokensApiService, unknown>> = {}) {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    imports: [AgentTokensComponent],
    providers: [
      provideRouter([]),
      {
        provide: AgentTokensApiService,
        useValue: {
          listTokens: () => of({ tokens: TOKENS }),
          mintToken: () => of(MINT),
          revokeToken: () => of({ ok: true }),
          ...overrides,
        },
      },
    ],
  });
  const fixture = TestBed.createComponent(AgentTokensComponent);
  fixture.detectChanges();
  return fixture;
}

describe('AgentTokensComponent', () => {
  it('loads tokens on init', () => {
    const fixture = setup();
    expect(fixture.componentInstance.tokens()).toEqual(TOKENS);
  });

  it('surfaces a load error', () => {
    const fixture = setup({ listTokens: () => throwError(() => new Error('boom')) });
    expect(fixture.componentInstance.error()).toBe('Could not load agent tokens');
  });

  it('mints a token, shows the once-only secret, and clears the name field', () => {
    const fixture = setup();
    const c = fixture.componentInstance;
    c.name = 'New agent';
    c.mint();
    expect(c.minted()).toEqual(MINT);
    expect(c.name).toBe('');
  });

  it('does not mint with an empty/whitespace name', () => {
    let called = false;
    const fixture = setup({
      mintToken: () => {
        called = true;
        return of(MINT);
      },
    });
    const c = fixture.componentInstance;
    c.name = '   ';
    c.mint();
    expect(called).toBe(false);
  });

  it('surfaces a mint error', () => {
    const fixture = setup({ mintToken: () => throwError(() => new Error('boom')) });
    const c = fixture.componentInstance;
    c.name = 'New agent';
    c.mint();
    expect(c.error()).toBe('Could not create a token');
    expect(c.busy()).toBe(false);
  });

  it('revokes a token, removing it from the list optimistically', () => {
    const fixture = setup();
    const c = fixture.componentInstance;
    c.revoke(TOKENS[0]!);
    expect(c.tokens()).toEqual([]);
  });

  it('surfaces a revoke error without mutating the list', () => {
    const fixture = setup({ revokeToken: () => throwError(() => new Error('boom')) });
    const c = fixture.componentInstance;
    c.revoke(TOKENS[0]!);
    expect(c.error()).toBe('Could not revoke token');
    expect(c.tokens()).toEqual(TOKENS);
  });

  it('dismissMinted clears the shown secret', () => {
    const fixture = setup();
    const c = fixture.componentInstance;
    c.name = 'New agent';
    c.mint();
    expect(c.minted()).not.toBeNull();
    c.dismissMinted();
    expect(c.minted()).toBeNull();
  });

  it('renders the tokens list as an appTvNavGroup with each revoke button as appTvNavItem', () => {
    const fixture = setup();
    fixture.detectChanges();
    expandAllGroups(fixture);
    const el: HTMLElement = fixture.nativeElement;
    const button = el.querySelector('[data-testid="agent-token-revoke"]');
    expect(button?.matches('[appTvNavItem]')).toBe(true);
    const group = button?.closest('[appTvNavGroup]');
    expect(group?.getAttribute('axis')).toBe('vertical');
  });

  /**
   * The assertion above is attribute-only, and a directive selector survives in
   * the DOM whether or not the directive is imported, applied, or able to reach
   * its group — which is how the Extensions page shipped with every group
   * registering zero items. This is the behavioural proof: a real key event
   * moving real focus.
   */
  it('ArrowDown moves focus from one token revoke button to the next', () => {
    const fixture = setup({
      listTokens: () => of({ tokens: [...TOKENS, { ...TOKENS[0]!, id: 't9', name: 'Second' }] }),
    });
    expandAllGroups(fixture);
    const el: HTMLElement = fixture.nativeElement;
    const buttons: HTMLElement[] = Array.from(
      el.querySelectorAll('[data-testid="agent-token-revoke"]'),
    );
    expect(buttons.length).toBe(2);
    buttons[0]!.focus();
    buttons[0]!.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }),
    );
    expect(document.activeElement).toBe(buttons[1]);
  });

  it('renders every group collapsed on a fresh render (all groups default-collapsed)', () => {
    localStorage.clear();
    const fixture = setup();
    fixture.detectChanges();
    const bodies = fixture.nativeElement.querySelectorAll('[data-testid="settings-group-body"]');
    expect(bodies.length).toBe(0);
  });
});
