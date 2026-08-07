import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { of } from 'rxjs';
import { provideRouter, Router } from '@angular/router';
import { expandAllGroups } from '../../../../testing/expand-groups';
import { DevicesApiService } from '../../../services/api/devices-api.service';
import { AuthService } from '../../../services/auth.service';
import type { ScanOutcome } from '../../../services/native/native-capabilities';

/**
 * Issue #434 — the camera button in Settings → Devices. Lives in its own spec
 * because `canScanBarcode` is read once at field-init time, so the mock has to
 * be in place before `DevicesComponent` is imported; forcing it true in the
 * main spec would add the scan card to every template assertion there.
 */
const scanBarcode = vi.fn<() => Promise<ScanOutcome>>();
const canScanBarcode = vi.fn(() => true);

vi.mock('../../../services/native/native-capabilities', () => ({
  canScanBarcode: () => canScanBarcode(),
  scanBarcode: () => scanBarcode(),
}));

const { DevicesComponent } = await import('./devices.component');

function setup() {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    imports: [DevicesComponent],
    providers: [
      provideRouter([]),
      {
        provide: DevicesApiService,
        useValue: {
          mintPairing: () => of(null),
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
  const navigateByUrl = vi.spyOn(TestBed.inject(Router), 'navigateByUrl').mockResolvedValue(true);
  fixture.detectChanges();
  return { fixture, component: fixture.componentInstance, navigateByUrl };
}

describe('DevicesComponent — scan a TV sign-in code (issue #434)', () => {
  beforeEach(() => {
    localStorage.clear();
    scanBarcode.mockReset();
    canScanBarcode.mockReturnValue(true);
  });

  it('renders the scan button where a camera exists', () => {
    const { fixture } = setup();
    expandAllGroups(fixture);
    const btn = (fixture.nativeElement as HTMLElement).querySelector(
      '[data-testid="devices-scan-approve"]',
    );
    expect(btn).not.toBeNull();
  });

  it('routes to the approval screen with the scanned code', async () => {
    const { component, navigateByUrl } = setup();
    scanBarcode.mockResolvedValue({
      status: 'ok',
      value: 'https://nas.local:8484/approve#c=ABC234',
    });

    await component.scanApproveCode();

    expect(navigateByUrl).toHaveBeenCalledWith('/approve#c=ABC234');
    expect(component.error()).toBe('');
  });

  it('accepts the bare code printed under the TV QR', async () => {
    const { component, navigateByUrl } = setup();
    scanBarcode.mockResolvedValue({ status: 'ok', value: 'abc234' });

    await component.scanApproveCode();

    expect(navigateByUrl).toHaveBeenCalledWith('/approve#c=ABC234');
  });

  it('surfaces an error and stays put on a scan that is not a sign-in code', async () => {
    const { component, navigateByUrl } = setup();
    scanBarcode.mockResolvedValue({ status: 'ok', value: 'https://example.com/' });

    await component.scanApproveCode();

    expect(navigateByUrl).not.toHaveBeenCalled();
    expect(component.error()).not.toBe('');
  });

  it('reports a denied camera permission', async () => {
    const { component, navigateByUrl } = setup();
    scanBarcode.mockResolvedValue({ status: 'denied' });

    await component.scanApproveCode();

    expect(navigateByUrl).not.toHaveBeenCalled();
    expect(component.error()).not.toBe('');
  });

  it('stays silent when the user cancels the scanner', async () => {
    const { component, navigateByUrl } = setup();
    scanBarcode.mockResolvedValue({ status: 'cancelled' });

    await component.scanApproveCode();

    expect(navigateByUrl).not.toHaveBeenCalled();
    expect(component.error()).toBe('');
  });

  it('clears the busy flag even when the scanner throws', async () => {
    const { component } = setup();
    scanBarcode.mockRejectedValue(new Error('plugin exploded'));

    await expect(component.scanApproveCode()).rejects.toThrow();
    expect(component.scanning()).toBe(false);
  });

  it('hides the card entirely where no camera exists (web/desktop)', () => {
    canScanBarcode.mockReturnValue(false);
    const { fixture } = setup();
    expandAllGroups(fixture);
    const btn = (fixture.nativeElement as HTMLElement).querySelector(
      '[data-testid="devices-scan-approve"]',
    );
    expect(btn).toBeNull();
  });
});
