import { TestBed } from '@angular/core/testing';
import { vi } from 'vitest';
import { DesktopWindowControlsComponent } from './desktop-window-controls.component';

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

type Bridge = Partial<{
  minimize: () => void;
  maximizeToggle: () => void;
  close: () => void;
  onMaximizeChange: (cb: (s: { isMaximized: boolean }) => void) => () => void;
}>;

function withBridge(bridge: Bridge | undefined, run: () => void) {
  const win = (globalThis as { window?: { nicotind?: unknown } }).window;
  const saved = win?.nicotind;
  if (win) win.nicotind = bridge ? ({ platform: 'electron', os: 'linux', ...bridge } as never) : undefined;
  try {
    run();
  } finally {
    if (win) win.nicotind = saved;
  }
}

function makeFixture() {
  TestBed.configureTestingModule({ imports: [DesktopWindowControlsComponent] });
  return TestBed.createComponent(DesktopWindowControlsComponent);
}

describe('DesktopWindowControlsComponent', () => {
  it('renders nothing outside Linux/Windows Electron', () => {
    const fixture = makeFixture();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[data-testid="desktop-window-controls"]')).toBeNull();
    fixture.destroy();
  });

  it('renders the three window controls on Linux Electron', async () => {
    const platform = await platformMock();
    vi.mocked(platform.isElectronLinux).mockReturnValue(true);
    const fixture = makeFixture();
    fixture.detectChanges();
    for (const id of ['desktop-window-minimize', 'desktop-window-maximize', 'desktop-window-close']) {
      expect(fixture.nativeElement.querySelector(`[data-testid="${id}"]`)).toBeTruthy();
    }
    vi.mocked(platform.isElectronLinux).mockReturnValue(false);
    fixture.destroy();
  });

  it('forwards minimize / maximizeToggle / close to the preload bridge on Linux Electron', async () => {
    const platform = await platformMock();
    vi.mocked(platform.isElectronLinux).mockReturnValue(true);
    const bridge = { minimize: vi.fn(), maximizeToggle: vi.fn(), close: vi.fn() };
    withBridge(bridge, () => {
      const fixture = makeFixture();
      fixture.detectChanges();
      fixture.componentInstance.minimize();
      fixture.componentInstance.toggleMaximize();
      fixture.componentInstance.closeWindow();
      fixture.destroy();
    });
    expect(bridge.minimize).toHaveBeenCalledTimes(1);
    expect(bridge.maximizeToggle).toHaveBeenCalledTimes(1);
    expect(bridge.close).toHaveBeenCalledTimes(1);
    vi.mocked(platform.isElectronLinux).mockReturnValue(false);
  });

  it('is a no-op outside the desktop shell even when a bridge global is present', () => {
    const bridge = { maximizeToggle: vi.fn() };
    withBridge(bridge, () => {
      const fixture = makeFixture();
      fixture.detectChanges();
      fixture.componentInstance.toggleMaximize();
      fixture.destroy();
    });
    expect(bridge.maximizeToggle).not.toHaveBeenCalled();
  });

  it('mirrors maximize-state pushes and unsubscribes on destroy', async () => {
    const platform = await platformMock();
    vi.mocked(platform.isElectronLinux).mockReturnValue(true);
    let pushed: ((s: { isMaximized: boolean }) => void) | null = null;
    const unsubscribe = vi.fn();
    const bridge = {
      onMaximizeChange: (cb: (s: { isMaximized: boolean }) => void) => {
        pushed = cb;
        return unsubscribe;
      },
    };
    withBridge(bridge, () => {
      const fixture = makeFixture();
      fixture.detectChanges();
      expect(fixture.componentInstance.isMaximized()).toBe(false);
      pushed?.({ isMaximized: true });
      expect(fixture.componentInstance.isMaximized()).toBe(true);
      fixture.destroy();
    });
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    vi.mocked(platform.isElectronLinux).mockReturnValue(false);
  });
});
