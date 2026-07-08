import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { signal } from '@angular/core';
import { vi } from 'vitest';
import { of } from 'rxjs';
import type { SlskdStatus } from '@nicotind/core';
import { SlskdSettingsComponent } from './slskd-settings.component';
import { SystemApiService } from '../../../services/api/system-api.service';
import { PluginService } from '../../../services/plugin.service';

function status(over: Partial<SlskdStatus> = {}): SlskdStatus {
  return {
    enabled: true,
    available: true,
    connection: { state: 'Connected', username: 'me', isConnected: true },
    speeds: { downloadBytesPerSec: 256 * 1024, uploadBytesPerSec: 0 },
    counts: { downloading: 1, uploading: 0, queued: 2 },
    limits: { uploadSlots: 4, uploadSpeedLimit: 0, downloadSpeedLimit: 500 },
    shares: { directories: 3, files: 99 },
    version: '1.0',
    uptimeSeconds: 3700,
    ...over,
  };
}

describe('SlskdSettingsComponent', () => {
  const hasSlskd = signal(true);
  const getSlskdStatus = vi.fn(() => of(status()));
  const systemApi = {
    getSoulseekSettings: vi.fn(() =>
      of({ username: 'me', configured: true, connected: true, listeningPort: 50000, enableUPnP: true }),
    ),
    getShares: vi.fn(() => of({ directories: ['/music'] })),
    getSoulseekStatus: vi.fn(() => of({ configured: true, connected: true, username: 'me' })),
    saveSoulseekSettings: vi.fn(() => of({ ok: true, message: 'ok', connected: true, username: 'me' })),
    toggleSoulseekConnection: vi.fn(() => of({ connected: false })),
    addShare: vi.fn(() => of({ ok: true })),
    removeShare: vi.fn(() => of({ ok: true })),
    rescanShares: vi.fn(() => of({ ok: true })),
  };

  beforeEach(async () => {
    hasSlskd.set(true);
    await TestBed.configureTestingModule({
      imports: [SlskdSettingsComponent],
      providers: [
        provideRouter([]),
        { provide: SystemApiService, useValue: systemApi },
        { provide: PluginService, useValue: { hasSlskd, getSlskdStatus } },
      ],
    }).compileComponents();
  });

  it('renders the status panel + connection form when the extension is enabled', async () => {
    const fixture = TestBed.createComponent(SlskdSettingsComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    const html = fixture.nativeElement.textContent as string;
    expect(html).toContain('Status');
    expect(html).toContain('Connection');
    // Download speed tile formatted from bytes/sec.
    expect(fixture.nativeElement.querySelector('[data-testid="slskd-download-speed"]')?.textContent).toContain(
      'KB/s',
    );
    fixture.destroy();
  });

  it('shows the "enable it first" notice when the extension is disabled', () => {
    hasSlskd.set(false);
    const fixture = TestBed.createComponent(SlskdSettingsComponent);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[data-testid="slskd-disabled-notice"]')).toBeTruthy();
    fixture.destroy();
  });

  it('formatSpeed and formatLimit render human units', () => {
    const c = TestBed.createComponent(SlskdSettingsComponent).componentInstance;
    expect(c.formatSpeed(0)).toBe('0 KB/s');
    expect(c.formatSpeed(2 * 1024 * 1024)).toBe('2.0 MB/s');
    expect(c.formatLimit(undefined)).toBe('—');
    expect(c.formatLimit(0)).toBe('Unlimited');
    expect(c.formatLimit(500)).toBe('500 KB/s');
  });
});
