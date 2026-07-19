import { TestBed } from '@angular/core/testing';
import { NO_ERRORS_SCHEMA, signal } from '@angular/core';
import { provideRouter } from '@angular/router';
import { vi } from 'vitest';
import { LayoutComponent } from './layout.component';
import { AuthService } from '../../services/auth.service';
import { PlayerService } from '../../services/player.service';
import { TransferService } from '../../services/transfer.service';
import { AcquireService } from '../../services/acquire.service';
import { DesktopChromeService } from '../../services/desktop-chrome.service';
import { APP_VERSION } from '../../app.config';

vi.mock('../../lib/platform', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/platform')>();
  return {
    ...actual,
    isElectron: vi.fn().mockReturnValue(false),
    electronOS: vi.fn().mockReturnValue(null),
    // The composite the component actually calls — must be mocked directly:
    // the real one closes over the un-mocked module-internal isElectron/
    // electronOS bindings, so flipping those two alone wouldn't reach it.
    isElectronLinux: vi.fn().mockReturnValue(false),
  };
});

function setup() {
  const playerStub = {
    currentTrack: signal<{ id: string } | null>(null),
    setRadioProvider: () => {},
  };
  const authStub = { username: signal('user'), role: signal('user'), logout: () => {} };

  TestBed.configureTestingModule({
    imports: [LayoutComponent],
    providers: [
      provideRouter([]),
      { provide: PlayerService, useValue: playerStub },
      { provide: AuthService, useValue: authStub },
      { provide: APP_VERSION, useValue: '0.0.0-test' },
    ],
    schemas: [NO_ERRORS_SCHEMA],
  });

  // Override template to only what we're testing — avoids instantiating heavy child components
  TestBed.overrideComponent(LayoutComponent, {
    set: {
      template: `<main [class]="'flex-1 ' + mainPadClass()"></main>`,
      imports: [],
    },
  });

  const fixture = TestBed.createComponent(LayoutComponent);
  fixture.detectChanges();
  return { fixture, playerStub };
}

describe('LayoutComponent — player + tab-bar safe margin', () => {
  it('stacks tab-bar + player padding when a track is loaded', () => {
    const { fixture, playerStub } = setup();

    playerStub.currentTrack.set({ id: '1' });
    fixture.detectChanges();

    const main: HTMLElement = fixture.nativeElement.querySelector('main');
    // mobile: tab bar + player (+ safe-area inset); desktop: just the player
    expect(main.classList).toContain('pb-[calc(8rem+env(safe-area-inset-bottom))]');
    expect(main.classList).toContain('md:pb-20');
  });

  it('reserves only the tab-bar height on mobile when no track is loaded', () => {
    const { fixture } = setup();
    // currentTrack is null by default

    const main: HTMLElement = fixture.nativeElement.querySelector('main');
    expect(main.classList).toContain('pb-[calc(3.5rem+env(safe-area-inset-bottom))]');
    expect(main.classList).toContain('md:pb-0');
    expect(main.classList).not.toContain('pb-[calc(8rem+env(safe-area-inset-bottom))]');
  });

  it('drops the player padding when a track is cleared after being set', () => {
    const { fixture, playerStub } = setup();

    playerStub.currentTrack.set({ id: '1' });
    fixture.detectChanges();

    playerStub.currentTrack.set(null);
    fixture.detectChanges();

    const main: HTMLElement = fixture.nativeElement.querySelector('main');
    expect(main.classList).not.toContain('pb-[calc(8rem+env(safe-area-inset-bottom))]');
    expect(main.classList).toContain('pb-[calc(3.5rem+env(safe-area-inset-bottom))]');
  });
});

describe('LayoutComponent — desktop downloads badge', () => {
  it('sums active transfers and in-flight acquire jobs into downloadCount', () => {
    const playerStub = {
      currentTrack: signal<{ id: string } | null>(null),
      setRadioProvider: () => {},
    };
    const transfersStub = {
      activeDownloadCount: signal(2),
      startPolling: () => {},
      stopPolling: () => {},
    };
    const acquireStub = {
      activeJobs: signal<unknown[]>([{}, {}, {}]),
      refresh: async () => {},
    };

    TestBed.configureTestingModule({
      imports: [LayoutComponent],
      providers: [
        provideRouter([]),
        { provide: PlayerService, useValue: playerStub },
        { provide: AuthService, useValue: { username: signal('u'), role: signal('user'), logout: () => {} } },
        { provide: TransferService, useValue: transfersStub },
        { provide: AcquireService, useValue: acquireStub },
        { provide: APP_VERSION, useValue: '0.0.0-test' },
      ],
      schemas: [NO_ERRORS_SCHEMA],
    });
    TestBed.overrideComponent(LayoutComponent, {
      set: { template: `<span>{{ downloadCount() }}</span>`, imports: [] },
    });

    const fixture = TestBed.createComponent(LayoutComponent);
    fixture.detectChanges();

    expect(fixture.componentInstance.downloadCount()).toBe(5);

    transfersStub.activeDownloadCount.set(0);
    acquireStub.activeJobs.set([]);
    expect(fixture.componentInstance.downloadCount()).toBe(0);
  });
});

describe('LayoutComponent — desktop chrome bar (Electron)', () => {
  /**
   * Re-imports the mocked `platform` module so each test can flip the
   * `isElectronLinux` return value without leaking into the next test.
   * The top-of-file mock provides the default (`false`).
   */
  async function importPlatformMock() {
    return await import('../../lib/platform');
  }

  function makeHeaderFixture() {
    TestBed.configureTestingModule({
      imports: [LayoutComponent],
      providers: [
        provideRouter([]),
        { provide: PlayerService, useValue: { currentTrack: signal(null), setRadioProvider: () => {} } },
        { provide: AuthService, useValue: { username: signal('u'), role: signal('user'), logout: () => {} } },
        { provide: APP_VERSION, useValue: '0.0.0-test' },
      ],
      schemas: [NO_ERRORS_SCHEMA],
    });
    TestBed.overrideComponent(LayoutComponent, {
      set: {
        template: `<header [class]="headerClass()" [attr.data-electron-title-bar]="isElectronLinux() ? '' : null"></header>`,
        imports: [],
      },
    });
    const fixture = TestBed.createComponent(LayoutComponent);
    return { fixture };
  }

  it('isElectronLinux is false on plain web / macOS Electron (no drag handle, no marker attr)', async () => {
    const { fixture } = makeHeaderFixture();
    fixture.detectChanges();
    expect(fixture.componentInstance.isElectronLinux()).toBe(false);
    expect(fixture.componentInstance.headerClass()).not.toContain('[-webkit-app-region:drag]');
    expect(fixture.nativeElement.querySelector('header').getAttribute('data-electron-title-bar')).toBeNull();
    fixture.destroy();
  });

  it('isElectronLinux is true on Linux Electron (header turns into the drag handle)', async () => {
    const platform = await importPlatformMock();
    vi.mocked(platform.isElectronLinux).mockReturnValue(true);
    const { fixture } = makeHeaderFixture();
    fixture.detectChanges();
    expect(fixture.componentInstance.isElectronLinux()).toBe(true);
    expect(fixture.componentInstance.headerClass()).toContain('[-webkit-app-region:drag]');
    expect(fixture.nativeElement.querySelector('header').getAttribute('data-electron-title-bar')).toBe('');
    vi.mocked(platform.isElectronLinux).mockReturnValue(false);
    fixture.destroy();
  });

  it('onHeaderDoubleClick is a no-op outside the desktop shell', () => {
    const { fixture } = makeHeaderFixture();
    fixture.detectChanges();
    const bridge = vi.fn();
    const win = (globalThis as { window?: { nicotind?: unknown } }).window;
    const savedNic = win?.nicotind;
    if (win) {
      win.nicotind = { platform: 'electron', os: 'linux', maximizeToggle: bridge } as never;
    }
    fixture.componentInstance.onHeaderDoubleClick();
    expect(bridge).not.toHaveBeenCalled();
    if (win) win.nicotind = savedNic;
    fixture.destroy();
  });

  it('onHeaderDoubleClick toggles maximize via the preload bridge on Linux Electron', async () => {
    const platform = await importPlatformMock();
    vi.mocked(platform.isElectronLinux).mockReturnValue(true);
    const bridge = { maximizeToggle: vi.fn() };
    const win = (globalThis as { window?: { nicotind?: unknown } }).window;
    const savedNic = win?.nicotind;
    if (win) {
      win.nicotind = { platform: 'electron', os: 'linux', ...bridge } as never;
    }
    const { fixture } = makeHeaderFixture();
    fixture.detectChanges();
    fixture.componentInstance.onHeaderDoubleClick();
    expect(bridge.maximizeToggle).toHaveBeenCalledTimes(1);
    vi.mocked(platform.isElectronLinux).mockReturnValue(false);
    if (win) win.nicotind = savedNic;
    fixture.destroy();
  });

  it('flags the shell header active for the pre-auth overlay while mounted', () => {
    const { fixture } = makeHeaderFixture();
    const chrome = TestBed.inject(DesktopChromeService);
    expect(chrome.shellHeaderActive()).toBe(false);
    fixture.detectChanges(); // runs ngOnInit
    expect(chrome.shellHeaderActive()).toBe(true);
    fixture.destroy();
    expect(chrome.shellHeaderActive()).toBe(false);
  });
});
