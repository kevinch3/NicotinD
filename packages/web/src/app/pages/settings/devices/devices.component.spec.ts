import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { of } from 'rxjs';
import { provideRouter } from '@angular/router';
import { DevicesComponent } from './devices.component';
import { DevicesApiService } from '../../../services/api/devices-api.service';
import { AuthService } from '../../../services/auth.service';
import type { PairingMintResponse } from '../../../services/api/api-types';

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
