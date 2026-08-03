import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { of } from 'rxjs';
import { provideRouter } from '@angular/router';
import { DevicesComponent } from './devices.component';
import { DevicesApiService } from '../../../services/api/devices-api.service';
import { AuthService } from '../../../services/auth.service';
import type { PairedDevice, PairingMintResponse } from '../../../services/api/api-types';

/**
 * Issue #256. `qrcode` moved from a static import to `await import('qrcode')`
 * inside `renderQr`, which keeps a 24 kB CommonJS dependency out of the devices
 * route's chunk until a pairing QR is actually requested (measured: the chunk
 * went 38.9 kB → 14 kB).
 *
 * That trade swaps a **build-time** failure for a **runtime** one: a broken
 * static import fails the build, a broken dynamic import fails at click time.
 * These tests cover the swapped path so the regression can't ship silently.
 */
const MINT: PairingMintResponse = {
  name: 'test-server',
  urls: ['http://localhost:8484'],
  token: 'tok-123',
  code: 'ABC123',
  expiresAt: Date.now() + 300_000,
} as PairingMintResponse;

function setup(mint: PairingMintResponse = MINT): DevicesComponent {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    imports: [DevicesComponent],
    providers: [
      provideRouter([]),
      {
        provide: DevicesApiService,
        useValue: {
          mintPairing: () => of(mint),
          getDevices: () => of({ devices: [] }),
          getRemoteAccess: () => of(null),
          setRemoteAccess: () => of(null),
          revokeDevice: () => of(undefined),
        },
      },
      { provide: AuthService, useValue: { isAdmin: () => false, user: () => null } },
    ],
  });
  return TestBed.createComponent(DevicesComponent).componentInstance;
}

const DEVICE: PairedDevice = {
  id: 'd1',
  name: 'Living Room TV',
  platform: 'android',
  createdAt: Date.now(),
  lastSeenAt: Date.now(),
  current: false,
};

const DEVICE_2: PairedDevice = {
  id: 'd2',
  name: 'Kitchen tablet',
  platform: 'android',
  createdAt: Date.now(),
  lastSeenAt: Date.now(),
  current: false,
};

/**
 * Task 3 (settings-cards unification): the three sections are now collapsible
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
function expandAllGroups(fixture: { nativeElement: unknown; detectChanges: () => void }): void {
  const el = fixture.nativeElement as HTMLElement;
  const toggles = el.querySelectorAll<HTMLButtonElement>('[data-testid="settings-group-toggle"]');
  toggles.forEach((btn) => {
    if (btn.getAttribute('aria-expanded') !== 'true') btn.click();
  });
  fixture.detectChanges();
}

function setupWithDevices(devices: PairedDevice[]) {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    imports: [DevicesComponent],
    providers: [
      provideRouter([]),
      {
        provide: DevicesApiService,
        useValue: {
          mintPairing: () => of(MINT),
          getDevices: () => of({ devices }),
          getRemoteAccess: () => of(null),
          setRemoteAccess: () => of(null),
          revokeDevice: () => of(undefined),
        },
      },
      { provide: AuthService, useValue: { isAdmin: () => false, user: () => null } },
    ],
  });
  const fixture = TestBed.createComponent(DevicesComponent);
  fixture.detectChanges();
  return fixture;
}

describe('DevicesComponent — TV nav (Android TV phase 4)', () => {
  it('renders the devices list as an appTvNavGroup with each revoke button as appTvNavItem', () => {
    const fixture = setupWithDevices([DEVICE]);
    expandAllGroups(fixture);
    const el: HTMLElement = fixture.nativeElement;
    const button = el.querySelector('[data-testid="device-revoke"]');
    expect(button?.matches('[appTvNavItem]')).toBe(true);
    const group = button?.closest('[appTvNavGroup]');
    expect(group?.getAttribute('axis')).toBe('vertical');
  });

  /**
   * The assertion above is attribute-only: a directive selector stays in the
   * rendered DOM whether or not the directive is imported, applied, or able to
   * reach its group (the Extensions page shipped exactly that way, with every
   * group registering zero items and D-pad nav a silent no-op). This is the
   * behavioural proof — a real key event moving real focus.
   */
  it('ArrowDown moves focus from one device revoke button to the next', () => {
    const fixture = setupWithDevices([DEVICE, DEVICE_2]);
    expandAllGroups(fixture);
    const el: HTMLElement = fixture.nativeElement;
    const buttons: HTMLElement[] = Array.from(el.querySelectorAll('[data-testid="device-revoke"]'));
    expect(buttons.length).toBe(2);
    buttons[0]!.focus();
    buttons[0]!.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }),
    );
    expect(document.activeElement).toBe(buttons[1]);
  });
});

describe('DevicesComponent — lazy qrcode (#256)', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('resolves the dynamically imported qrcode module and renders a data URL', async () => {
    const c = setup();
    // renderQr is private; drive it the way the component does.
    await (c as unknown as { renderQr: (m: PairingMintResponse) => Promise<void> }).renderQr(MINT);

    const url = c.qrDataUrl();
    expect(url).toBeTruthy();
    // A real qrcode render, not a stub — proves the dynamic import resolved.
    expect(url).toMatch(/^data:image\/png;base64,/);
  });

  it('leaves the QR null when the mint carries no reachable URL', async () => {
    const c = setup({ ...MINT, urls: [] });
    await (c as unknown as { renderQr: (m: PairingMintResponse) => Promise<void> }).renderQr({
      ...MINT,
      urls: [],
    });
    expect(c.qrDataUrl()).toBeNull();
  });
});

describe('DevicesComponent — settings-group migration (Task 3)', () => {
  function setupSpiedMint(mint: PairingMintResponse = MINT) {
    TestBed.resetTestingModule();
    const mintPairing = vi.fn().mockReturnValue(of(mint));
    TestBed.configureTestingModule({
      imports: [DevicesComponent],
      providers: [
        provideRouter([]),
        {
          provide: DevicesApiService,
          useValue: {
            mintPairing,
            getDevices: () => of({ devices: [] }),
            getRemoteAccess: () => of(null),
            setRemoteAccess: () => of(null),
            revokeDevice: () => of(undefined),
          },
        },
        { provide: AuthService, useValue: { isAdmin: () => false, user: () => null } },
      ],
    });
    const fixture = TestBed.createComponent(DevicesComponent);
    return { fixture, mintPairing };
  }

  it('renders every group collapsed on a fresh render (all groups default-collapsed)', () => {
    localStorage.clear();
    const { fixture } = setupSpiedMint();
    fixture.detectChanges();
    const bodies = fixture.nativeElement.querySelectorAll('[data-testid="settings-group-body"]');
    expect(bodies.length).toBe(0);
  });

  it('does not mint a pairing code while the Link device group is collapsed on init', () => {
    localStorage.clear();
    const { fixture, mintPairing } = setupSpiedMint();
    fixture.detectChanges();
    expect(mintPairing).not.toHaveBeenCalled();
  });

  /**
   * The JIT harness never propagates a nested component's `output()` binding
   * back to the parent template handler (see docs/web-ui.md "JIT vitest
   * harness limitation" — confirmed during Task 10 for the same
   * `output()`-across-a-component-boundary gap), so a DOM click on the
   * settings-group toggle can't be asserted to reach `onLinkOpened()` here —
   * only e2e (real Chromium) proves that click-through wiring
   * (`device-pairing.spec.ts`). These tests instead drive `onLinkOpened()`
   * directly, covering the mint-vs-no-mint *decision* it makes.
   */
  it('mints a pairing code when onLinkOpened runs with no pairing yet', () => {
    const { fixture, mintPairing } = setupSpiedMint();
    fixture.detectChanges();
    expect(mintPairing).not.toHaveBeenCalled();
    fixture.componentInstance.onLinkOpened();
    expect(mintPairing).toHaveBeenCalledTimes(1);
  });

  it('does not re-mint a pairing code when onLinkOpened runs with one already present', () => {
    const { fixture, mintPairing } = setupSpiedMint();
    fixture.detectChanges();
    // Simulate a pairing already minted (e.g. re-opening after a prior visit
    // within the same component instance) before the group opens again.
    fixture.componentInstance.regenerate();
    expect(mintPairing).toHaveBeenCalledTimes(1);
    fixture.componentInstance.onLinkOpened();
    expect(mintPairing).toHaveBeenCalledTimes(1);
  });
});
