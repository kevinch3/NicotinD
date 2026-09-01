import { TestBed } from '@angular/core/testing';
import { NO_ERRORS_SCHEMA, signal } from '@angular/core';
import { provideRouter } from '@angular/router';
import { vi } from 'vitest';
import { LayoutComponent, headerDisplayClass } from './layout.component';
import { AuthService } from '../../services/auth.service';
import { PlayerService } from '../../services/player.service';
import { TransferService } from '../../services/transfer.service';
import { AcquireService } from '../../services/acquire.service';
import { DownloadReviewService } from '../../services/download-review.service';
import { LibraryApiService } from '../../services/api/library-api.service';
import { LikeService } from '../../services/like.service';
import { SetupService } from '../../services/setup.service';
import { PreserveService } from '../../services/preserve.service';
import { DesktopChromeService } from '../../services/desktop-chrome.service';
import { PullToRefreshService } from '../../services/pull-to-refresh.service';
import { ScrollLockService } from '../../services/scroll-lock.service';
import { TranslatePipe } from '../../pipes/translate.pipe';
import { APP_VERSION } from '../../app.config';

// jsdom lacks a PointerEvent constructor; MouseEvent carries clientX/Y + button
// and dispatches under any type string, so it stands in for pointer events here.
function pointer(type: string, clientY: number, button = 0): PointerEvent {
  return new MouseEvent(type, { clientY, button }) as unknown as PointerEvent;
}

let mockCoarsePointer = true;

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
    isCoarsePointer: () => mockCoarsePointer,
  };
});

function setup() {
  const playerStub = {
    currentTrack: signal<{ id: string } | null>(null),
    setRadioProvider: () => {},
  };
  const authStub = {
    username: signal('user'),
    role: signal('user'),
    logout: () => {},
    canCurate: () => false,
  };

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
  it('sums active transfers, in-flight acquire jobs, and the review queue into downloadCount', () => {
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
    const reviewStub = { pending: signal(1), start: () => () => {} };

    TestBed.configureTestingModule({
      imports: [LayoutComponent],
      providers: [
        provideRouter([]),
        { provide: PlayerService, useValue: playerStub },
        {
          provide: AuthService,
          useValue: {
            username: signal('u'),
            role: signal('user'),
            logout: () => {},
            canCurate: () => false,
          },
        },
        { provide: TransferService, useValue: transfersStub },
        { provide: AcquireService, useValue: acquireStub },
        { provide: DownloadReviewService, useValue: reviewStub },
        { provide: APP_VERSION, useValue: '0.0.0-test' },
      ],
      schemas: [NO_ERRORS_SCHEMA],
    });
    TestBed.overrideComponent(LayoutComponent, {
      set: { template: `<span>{{ downloadCount() }}</span>`, imports: [] },
    });

    const fixture = TestBed.createComponent(LayoutComponent);
    fixture.detectChanges();

    expect(fixture.componentInstance.downloadCount()).toBe(6);

    transfersStub.activeDownloadCount.set(0);
    acquireStub.activeJobs.set([]);
    reviewStub.pending.set(0);
    expect(fixture.componentInstance.downloadCount()).toBe(0);
  });
});

describe('LayoutComponent — pull-to-refresh gesture host', () => {
  beforeEach(() => {
    mockCoarsePointer = true;
  });

  function setup() {
    const playerStub = {
      currentTrack: signal<{ id: string } | null>(null),
      setRadioProvider: () => {},
    };
    const authStub = {
      username: signal('user'),
      role: signal('user'),
      logout: () => {},
      canCurate: () => false,
    };

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

    TestBed.overrideComponent(LayoutComponent, {
      set: {
        template: `
          <main [class]="'relative flex-1 ' + mainPadClass()" (pointerdown)="pull.onPointerDown($event)">
            @if (pull.phase() !== 'idle') {
              <div data-testid="pull-refresh-indicator"></div>
            }
          </main>
        `,
        imports: [],
      },
    });

    const fixture = TestBed.createComponent(LayoutComponent);
    return { fixture, component: fixture.componentInstance };
  }

  it('renders no pull indicator while idle', () => {
    const { fixture } = setup();
    fixture.detectChanges();
    expect(
      fixture.nativeElement.querySelector('[data-testid="pull-refresh-indicator"]'),
    ).toBeNull();
  });

  it('shows the indicator and triggers the registered handler on an armed pull', async () => {
    const { fixture, component } = setup();
    fixture.detectChanges();
    const p2r = TestBed.inject(PullToRefreshService);
    const handler = vi.fn().mockResolvedValue(undefined);
    TestBed.runInInjectionContext(() => p2r.register(handler));

    Object.defineProperty(window, 'scrollY', { value: 0, configurable: true, writable: true });
    component.pull.onPointerDown(pointer('pointerdown', 100));
    document.dispatchEvent(pointer('pointermove', 400));
    fixture.detectChanges();
    expect(
      fixture.nativeElement.querySelector('[data-testid="pull-refresh-indicator"]'),
    ).not.toBeNull();

    document.dispatchEvent(pointer('pointerup', 400));
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('does not start a pull when the scroll lock is held', () => {
    const { fixture, component } = setup();
    fixture.detectChanges();
    const p2r = TestBed.inject(PullToRefreshService);
    TestBed.runInInjectionContext(() => p2r.register(vi.fn()));
    TestBed.inject(ScrollLockService).lock();

    component.pull.onPointerDown(pointer('pointerdown', 100));
    document.dispatchEvent(pointer('pointermove', 400));
    expect(component.pull.phase()).toBe('idle');
  });

  it('does not start a pull on fine-pointer devices', () => {
    mockCoarsePointer = false;
    const { fixture, component } = setup();
    fixture.detectChanges();
    const p2r = TestBed.inject(PullToRefreshService);
    TestBed.runInInjectionContext(() => p2r.register(vi.fn()));

    component.pull.onPointerDown(pointer('pointerdown', 100));
    document.dispatchEvent(pointer('pointermove', 400));
    expect(component.pull.phase()).toBe('idle');
  });
});

describe('LayoutComponent — pull-to-refresh wiring on the REAL template', () => {
  // The block above overrides the template with a hand-copied `<main
  // (pointerdown)...>` snippet, so it would keep passing even if the real
  // `layout.component.html` lost the binding or the indicator entirely. This
  // block renders the actual templateUrl (no `template`/`templateUrl`
  // override) to prove the wiring really exists in the shipped markup.
  // `imports` is trimmed to just the one pipe the template needs (`t`) —
  // every child component tag (`<app-player>`, `<router-outlet>`, etc.)
  // becomes an inert unknown element under NO_ERRORS_SCHEMA, which is fine:
  // this block only cares about `<main>` and the indicator.
  beforeEach(() => {
    mockCoarsePointer = true;
  });

  function setup() {
    const playerStub = {
      currentTrack: signal<{ id: string } | null>(null),
      queue: () => [],
      history: () => [],
      setRadioProvider: () => {},
    };
    const authStub = {
      username: signal('user'),
      role: signal('user'),
      logout: () => {},
      canAcquire: () => true,
      isAdmin: () => false,
      canCurate: () => false,
    };
    const setupStub = { isOffline: () => false };
    const preserveStub = { totalUsage: () => 0, clearAll: async () => {} };
    const transfersStub = {
      activeDownloadCount: signal(0),
      startPolling: () => {},
      stopPolling: () => {},
    };
    const acquireStub = { activeJobs: signal<unknown[]>([]), refresh: async () => {} };
    const likesStub = { refresh: async () => {} };
    const apiStub = {};

    TestBed.configureTestingModule({
      imports: [LayoutComponent],
      providers: [
        provideRouter([]),
        { provide: PlayerService, useValue: playerStub },
        { provide: AuthService, useValue: authStub },
        { provide: SetupService, useValue: setupStub },
        { provide: PreserveService, useValue: preserveStub },
        { provide: TransferService, useValue: transfersStub },
        { provide: AcquireService, useValue: acquireStub },
        { provide: LikeService, useValue: likesStub },
        { provide: LibraryApiService, useValue: apiStub },
        { provide: APP_VERSION, useValue: '0.0.0-test' },
      ],
      schemas: [NO_ERRORS_SCHEMA],
    });

    // No `template`/`templateUrl` key — the real templateUrl is kept.
    TestBed.overrideComponent(LayoutComponent, {
      set: { imports: [TranslatePipe] },
    });

    const fixture = TestBed.createComponent(LayoutComponent);
    return { fixture, component: fixture.componentInstance };
  }

  it('renders the real <main> with the pointerdown binding and no indicator while idle', () => {
    const { fixture } = setup();
    fixture.detectChanges();

    const main: HTMLElement | null = fixture.nativeElement.querySelector('main');
    expect(main).not.toBeNull();
    expect(
      fixture.nativeElement.querySelector('[data-testid="pull-refresh-indicator"]'),
    ).toBeNull();
  });

  it('a real pointerdown on <main> reaches the gesture and arms it past threshold', () => {
    const { fixture, component } = setup();
    fixture.detectChanges();
    const p2r = TestBed.inject(PullToRefreshService);
    TestBed.runInInjectionContext(() => p2r.register(vi.fn().mockResolvedValue(undefined)));

    Object.defineProperty(window, 'scrollY', { value: 0, configurable: true, writable: true });
    const main: HTMLElement = fixture.nativeElement.querySelector('main');
    // Dispatched on the rendered element (not called directly on the
    // component) — this is what proves the template's `(pointerdown)`
    // binding actually reaches `pull.onPointerDown`, since the readonly
    // `pull` object can't be spied on.
    main.dispatchEvent(pointer('pointerdown', 100));
    document.dispatchEvent(pointer('pointermove', 400));

    expect(component.pull.phase()).not.toBe('idle');
    fixture.detectChanges();
    expect(
      fixture.nativeElement.querySelector('[data-testid="pull-refresh-indicator"]'),
    ).not.toBeNull();
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
        {
          provide: PlayerService,
          useValue: { currentTrack: signal(null), setRadioProvider: () => {} },
        },
        {
          provide: AuthService,
          useValue: {
            username: signal('u'),
            role: signal('user'),
            logout: () => {},
            canCurate: () => false,
          },
        },
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
    expect(
      fixture.nativeElement.querySelector('header').getAttribute('data-electron-title-bar'),
    ).toBeNull();
    fixture.destroy();
  });

  it('isElectronLinux is true on Linux Electron (header turns into the drag handle)', async () => {
    const platform = await importPlatformMock();
    vi.mocked(platform.isElectronLinux).mockReturnValue(true);
    const { fixture } = makeHeaderFixture();
    fixture.detectChanges();
    expect(fixture.componentInstance.isElectronLinux()).toBe(true);
    expect(fixture.componentInstance.headerClass()).toContain('[-webkit-app-region:drag]');
    expect(
      fixture.nativeElement.querySelector('header').getAttribute('data-electron-title-bar'),
    ).toBe('');
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

describe('headerDisplayClass — the top bar yields to the mosaic on phones', () => {
  it('collapses below md on the mosaic home, where every control is already md-gated', () => {
    expect(headerDisplayClass('/')).toBe('hidden md:flex');
  });

  it('ignores query params and fragments when matching the home route', () => {
    expect(headerDisplayClass('/?utm=x')).toBe('hidden md:flex');
    expect(headerDisplayClass('/#top')).toBe('hidden md:flex');
  });

  it('keeps the header everywhere else — scrolling pages want the sticky backdrop', () => {
    for (const url of ['/library', '/classic', '/get?tab=find', '/settings']) {
      expect(headerDisplayClass(url)).toBe('flex');
    }
  });
});
