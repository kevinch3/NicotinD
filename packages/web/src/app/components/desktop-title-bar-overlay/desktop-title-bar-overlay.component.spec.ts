import { TestBed } from '@angular/core/testing';
import { vi } from 'vitest';
import { DesktopTitleBarOverlayComponent } from './desktop-title-bar-overlay.component';
import { DesktopChromeService } from '../../services/desktop-chrome.service';

vi.mock('../../lib/platform', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/platform')>();
  return {
    ...actual,
    isElectronLinux: vi.fn().mockReturnValue(false),
  };
});

async function platformMock() {
  return await import('../../lib/platform');
}

function makeFixture() {
  TestBed.configureTestingModule({ imports: [DesktopTitleBarOverlayComponent] });
  return TestBed.createComponent(DesktopTitleBarOverlayComponent);
}

describe('DesktopTitleBarOverlayComponent', () => {
  it('renders nothing outside Linux/Windows Electron', () => {
    const fixture = makeFixture();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[data-electron-title-bar]')).toBeNull();
    fixture.destroy();
  });

  it('renders the fallback title bar on Linux Electron while no shell header is active', async () => {
    const platform = await platformMock();
    vi.mocked(platform.isElectronLinux).mockReturnValue(true);
    const fixture = makeFixture();
    fixture.detectChanges();
    const bar = fixture.nativeElement.querySelector('header[data-electron-title-bar]');
    expect(bar).toBeTruthy();
    expect(bar.className).toContain('[-webkit-app-region:drag]');
    expect(fixture.nativeElement.querySelector('[data-testid="desktop-window-controls"]')).toBeTruthy();
    vi.mocked(platform.isElectronLinux).mockReturnValue(false);
    fixture.destroy();
  });

  it('hides while the shell header owns the chrome (no double title bar)', async () => {
    const platform = await platformMock();
    vi.mocked(platform.isElectronLinux).mockReturnValue(true);
    const fixture = makeFixture();
    const chrome = TestBed.inject(DesktopChromeService);
    chrome.shellHeaderActive.set(true);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[data-electron-title-bar]')).toBeNull();
    // Shell header unmounts (e.g. logout back to /login) → overlay returns.
    chrome.shellHeaderActive.set(false);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[data-electron-title-bar]')).toBeTruthy();
    vi.mocked(platform.isElectronLinux).mockReturnValue(false);
    fixture.destroy();
  });
});
