import { TestBed } from '@angular/core/testing';
import { expandAllGroups } from '../../../testing/expand-groups';
import { provideRouter } from '@angular/router';
import { signal } from '@angular/core';
import { vi } from 'vitest';
import type { Mock } from 'vitest';
import { SwUpdate } from '@angular/service-worker';
import { SettingsComponent } from './settings.component';
import { AuthService } from '../../services/auth.service';
import { ThemeService } from '../../services/theme.service';
import { RemotePlaybackService } from '../../services/remote-playback.service';
import { PlaybackWsService } from '../../services/playback-ws.service';
import { PreserveService } from '../../services/preserve.service';
import { MediaControlsService } from '../../services/media-controls.service';
import { ConfirmService } from '../../services/confirm.service';
import { APP_VERSION } from '../../app.config';
import { isElectron } from '../../lib/platform';
import { pickDirectory, setMusicDir, revealLogs } from '../../services/native/native-capabilities';
import { ToastService } from '../../services/toast.service';
import { UpdateService } from '../../services/update.service';
import type { CheckUpdateOutcome } from '../../services/update.service';
import BASE_CATALOG from '../../../../public/i18n/en.json';

vi.mock('../../lib/platform', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/platform')>();
  return { ...actual, isElectron: vi.fn().mockReturnValue(false) };
});

vi.mock('../../services/native/native-capabilities', () => ({
  pickDirectory: vi.fn(),
  setMusicDir: vi.fn().mockResolvedValue({ ok: true }),
  revealLogs: vi.fn().mockResolvedValue(undefined),
}));

/**
 * Task 2 (settings-cards unification): every card is now a collapsible
 * `<app-settings-group>` whose body is `@if (open())`-gated, and `open()`
 * reads a `[groupId]`/`[defaultOpen]` signal `input()`. This JIT vitest
 * harness never registers signal inputs on a *nested imported* component (see
 * `src/testing/signal-input.ts` / `docs/web-ui.md` "Testing input()-signal
 * components"), so every group's `[groupId]`/`[title]`/etc. binding silently
 * fails to land — all four groups fall back to the same default `groupId`
 * (`''`), meaning they all read/write the *same* localStorage key. That's
 * harmless for opening every card (this helper just clicks whichever toggles
 * are still closed), but it does mean a prior test's "open" write can leak
 * into a later test's fresh fixture — tests that assert the fresh-render
 * collapsed state must `localStorage.clear()` first, mirroring
 * `admin.component.spec.ts`'s `expandAllGroups`.
 */
function makeToastService() {
  return {
    show: vi.fn().mockImplementation(() => 'toast-1'),
    dismiss: vi.fn(),
    toasts: signal([]),
  };
}

// The mock fns carry their real signatures: `satisfies Partial<UpdateService>`
// below rejects the bare `ReturnType<typeof vi.fn>` these used to be typed as.
// Mock<…>, not a bare function type: the tests call `.mockResolvedValueOnce`
// on these, which a plain signature doesn't carry.
type UpdateOverrides = Partial<{
  enabled: boolean;
  updateAvailable: boolean;
  searching: boolean;
  pendingApkVersion: string | null;
  downloadProgress: number | null;
  checkForUpdate: Mock<() => Promise<CheckUpdateOutcome>>;
  applyUpdate: Mock<() => Promise<void>>;
}>;

function makeUpdateService(overrides: UpdateOverrides = {}) {
  const check =
    overrides.checkForUpdate ??
    vi.fn<() => Promise<CheckUpdateOutcome>>().mockResolvedValue('up-to-date');
  const apply = overrides.applyUpdate ?? vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
  return {
    enabled: signal(overrides.enabled ?? false),
    updateAvailable: signal(overrides.updateAvailable ?? false),
    searching: signal(overrides.searching ?? false),
    checkAvailable: signal(
      (overrides.enabled ?? false) &&
        !(overrides.updateAvailable ?? false) &&
        !(overrides.searching ?? false),
    ),
    pendingApkVersion: signal(overrides.pendingApkVersion ?? null),
    downloadProgress: signal(overrides.downloadProgress ?? null),
    checkForUpdate: check,
    applyUpdate: apply,
  } satisfies Partial<UpdateService> & { [k: string]: unknown };
}

/**
 * Guards the post-refactor Settings page: it renders only universal prefs and
 * must NOT surface admin/extension coupling (Soulseek/streaming/processing/
 * shares/duplicates). The Extensions/Admin links appear for admins only.
 */
function makeProviders(role: 'admin' | 'user', updateOverrides: UpdateOverrides = {}) {
  const toast = makeToastService();
  const update = makeUpdateService(updateOverrides);
  return {
    list: [
      provideRouter([]),
      { provide: APP_VERSION, useValue: '9.9.9' },
      {
        provide: SwUpdate,
        useValue: {
          isEnabled: updateOverrides.enabled ?? false,
          versionUpdates: { subscribe: vi.fn() },
          activateUpdate: vi.fn(),
          checkForUpdate: update.checkForUpdate,
        },
      },
      {
        provide: AuthService,
        useValue: {
          username: signal('kev'),
          role: signal(role),
          isAdmin: () => role === 'admin',
          canCurate: () => role === 'admin',
          welcomeDismissed: signal(false),
          autoplayOnLoad: signal(false),
          feedbackCapture: signal(false),
          setAutoplayOnLoad: vi.fn(),
          setFeedbackCapture: vi.fn(),
          logout: vi.fn(),
        },
      },
      {
        provide: ThemeService,
        useValue: {
          systemTheme: signal(false),
          theme: signal('dark'),
          setSystemTheme: vi.fn(),
          setTheme: vi.fn(),
        },
      },
      {
        provide: RemotePlaybackService,
        useValue: {
          remoteEnabled: signal(false),
          disabledReason: signal(null),
          devices: signal([]),
          activeDeviceId: signal(null),
          setRemoteEnabled: vi.fn(),
        },
      },
      {
        provide: PlaybackWsService,
        useValue: { getDeviceId: () => 'dev1', getDeviceName: () => 'Web', setDeviceName: vi.fn() },
      },
      {
        provide: PreserveService,
        useValue: {
          budget: signal(2 * 1024 * 1024 * 1024),
          setBudget: vi.fn(),
          totalUsage: signal(0),
          preservedTracks: signal([]),
          autoPreserveMode: signal('off'),
          setAutoPreserveMode: vi.fn(),
          autoPreservedCount: vi.fn().mockReturnValue(0),
          removeAllAutoPreserved: vi.fn().mockResolvedValue(0),
          clearAll: vi.fn(),
        },
      },
      { provide: ConfirmService, useValue: { ask: vi.fn().mockResolvedValue(true) } },
      { provide: MediaControlsService, useValue: { getDiagnostics: vi.fn() } },
      { provide: ToastService, useValue: toast },
      { provide: UpdateService, useValue: update },
    ],
    toast,
    update,
  };
}

describe('SettingsComponent (TV D-pad navigation)', () => {
  it('renders the theme presets grid as an appTvNavGroup with grid axis', async () => {
    const { list } = makeProviders('user');
    await TestBed.configureTestingModule({
      imports: [SettingsComponent],
      providers: list,
    }).compileComponents();
    const fixture = TestBed.createComponent(SettingsComponent);
    fixture.detectChanges();
    expandAllGroups(fixture);
    const el: HTMLElement = fixture.nativeElement;
    const group = el.querySelector('[appTvNavGroup][axis="grid"]');
    expect(group).not.toBeNull();
    expect(group!.querySelectorAll('[appTvNavItem]').length).toBeGreaterThan(0);
    fixture.destroy();
  });

  /**
   * The attribute assertion above cannot fail for a wiring bug — a directive
   * selector stays in the rendered DOM whether or not the directive is
   * imported, applied, or able to reach its group (exactly how the Extensions
   * page shipped with every group registering zero items). This is the
   * behavioural counterpart: a real key event must move real focus.
   *
   * jsdom computes no layout, so every `offsetTop` is 0 and
   * `inferColumnsPerRow` reads the presets as a single row — which is why this
   * uses ArrowRight (intra-row movement) rather than ArrowDown.
   */
  it('ArrowRight moves focus between theme preset buttons', async () => {
    const { list } = makeProviders('user');
    await TestBed.configureTestingModule({
      imports: [SettingsComponent],
      providers: list,
    }).compileComponents();
    const fixture = TestBed.createComponent(SettingsComponent);
    fixture.detectChanges();
    expandAllGroups(fixture);
    const el: HTMLElement = fixture.nativeElement;
    const group = el.querySelector('[appTvNavGroup][axis="grid"]')!;
    const presets: HTMLElement[] = Array.from(group.querySelectorAll('[appTvNavItem]'));
    expect(presets.length).toBeGreaterThan(1);
    presets[0]!.focus();
    presets[0]!.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }),
    );
    expect(document.activeElement).toBe(presets[1]);
    fixture.destroy();
  });

  /**
   * `TvNavGroupDirective` binds `[attr.role]` on every change-detection pass,
   * so a hand-written `role` on the same element is silently overwritten. The
   * auto-preserve group declared `role="radiogroup"` and rendered as
   * `role="grid"`; the static one is gone and the directive's is authoritative.
   */
  it('the auto-preserve group carries only the nav group role, no stale radiogroup', async () => {
    const { list } = makeProviders('user');
    await TestBed.configureTestingModule({
      imports: [SettingsComponent],
      providers: list,
    }).compileComponents();
    const fixture = TestBed.createComponent(SettingsComponent);
    fixture.detectChanges();
    expandAllGroups(fixture);
    const el: HTMLElement = fixture.nativeElement;
    const group = el
      .querySelector('[data-testid="auto-preserve-off"]')!
      .closest('[appTvNavGroup]')!;
    expect(group.getAttribute('role')).toBe('grid');
    expect(el.querySelector('[role="radiogroup"]')).toBeNull();
    fixture.destroy();
  });
});

describe('SettingsComponent (universal prefs only)', () => {
  it('renders universal sections without any admin/extension coupling', async () => {
    const { list } = makeProviders('user');
    await TestBed.configureTestingModule({
      imports: [SettingsComponent],
      providers: list,
    }).compileComponents();
    const fixture = TestBed.createComponent(SettingsComponent);
    fixture.detectChanges();
    expandAllGroups(fixture);
    const text = fixture.nativeElement.textContent as string;
    // Section headers/copy are i18n keys now (issue #236); the raw key renders
    // since no catalog is loaded in this harness.
    //
    // 'settings.appearance' is no longer asserted here: the settings-page
    // regroup (task 4) moved it from a literal h2 in this component's own
    // template into a `[title]` binding on the nested, imported
    // `app-settings-group-header` (Card 1's header). Per
    // docs/web-ui.md "Testing input()-signal components (JIT vitest
    // limitation)", this harness's JIT compiler never registers a template
    // binding onto a *nested imported* standalone component's signal
    // `input()` — the binding silently doesn't land, so the child renders its
    // input's default rather than the passed value. That's a harness
    // constraint on how a parent spec can observe a nested component's
    // content, not a defect in the app: `settings-group-header.component.spec.ts`
    // covers the header's own rendering directly (via the shared
    // `setInputValue` helper), and `bun run typecheck`/`ng build` confirm the
    // binding is real at compile time and runtime outside this harness.
    expect(text).toContain('settings.offlineStorage');
    expect(text).toContain('settings.remotePlayback');
    expect(text).toContain('settings.resumePlayback');
    for (const key of [
      'settings.appearance',
      'settings.offlineStorage',
      'settings.remotePlayback',
      'settings.resumePlayback',
    ]) {
      expect(BASE_CATALOG, `missing catalog key: ${key}`).toHaveProperty([key]);
    }
    expect(text).not.toContain('Soulseek');
    expect(text).not.toContain('Shared Folders');
    expect(text).not.toContain('Library processing');
    expect(text).not.toContain('Find Duplicates');
    expect(
      fixture.nativeElement.querySelector('[data-testid="settings-extensions-link"]'),
    ).toBeNull();
    expect(fixture.nativeElement.querySelector('[data-testid="settings-check-update"]')).toBeNull();
    fixture.destroy();
  });

  it('shows Admin + Extensions links for admins', async () => {
    const { list } = makeProviders('admin');
    await TestBed.configureTestingModule({
      imports: [SettingsComponent],
      providers: list,
    }).compileComponents();
    const fixture = TestBed.createComponent(SettingsComponent);
    fixture.detectChanges();
    expandAllGroups(fixture);
    expect(
      fixture.nativeElement.querySelector('[data-testid="settings-extensions-link"]'),
    ).toBeTruthy();
    // `settings.adminPanel` is an i18n key now (issue #236); the raw key renders
    // since no catalog is loaded in this harness — assert it resolves too.
    expect(fixture.nativeElement.textContent).toContain('settings.adminPanel');
    expect(BASE_CATALOG).toHaveProperty(['settings.adminPanel']);
    fixture.destroy();
  });

  it('autoplay toggle routes through AuthService.setAutoplayOnLoad', async () => {
    const { list } = makeProviders('user');
    await TestBed.configureTestingModule({
      imports: [SettingsComponent],
      providers: list,
    }).compileComponents();
    const fixture = TestBed.createComponent(SettingsComponent);
    fixture.detectChanges();
    expandAllGroups(fixture);
    const toggle = fixture.nativeElement.querySelector(
      '[data-testid="autoplay-on-load-toggle"]',
    ) as HTMLButtonElement;
    expect(toggle).toBeTruthy();
    toggle.click();
    const auth = TestBed.inject(AuthService) as unknown as {
      setAutoplayOnLoad: ReturnType<typeof vi.fn>;
    };
    expect(auth.setAutoplayOnLoad).toHaveBeenCalledWith(true);
    fixture.destroy();
  });

  it('renders the Advanced card with the Developer section for admins', async () => {
    const { list } = makeProviders('admin');
    await TestBed.configureTestingModule({
      imports: [SettingsComponent],
      providers: list,
    }).compileComponents();
    const fixture = TestBed.createComponent(SettingsComponent);
    fixture.detectChanges();
    expandAllGroups(fixture);
    expect(fixture.nativeElement.querySelector('[data-testid="developer-section"]')).toBeTruthy();
    fixture.destroy();
  });

  it('hides the Advanced card entirely for a plain web user', async () => {
    const { list } = makeProviders('user');
    await TestBed.configureTestingModule({
      imports: [SettingsComponent],
      providers: list,
    }).compileComponents();
    const fixture = TestBed.createComponent(SettingsComponent);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[data-testid="developer-section"]')).toBeNull();
    fixture.destroy();
  });

  it('has catalog entries for the settings regroup i18n keys', () => {
    for (const key of [
      'settings.groupAppearanceDesc',
      'settings.groupPlaybackTitle',
      'settings.groupPlaybackDesc',
      'settings.groupAccountTitle',
      'settings.groupAccountDesc',
      'settings.subLinks',
      'settings.subUpdates',
      'settings.groupAdvancedTitle',
      'settings.groupAdvancedDesc',
    ]) {
      expect(BASE_CATALOG, `missing catalog key: ${key}`).toHaveProperty([key]);
    }
  });

  it('renders every card collapsed on a fresh render (all cards default-collapsed)', async () => {
    localStorage.clear();
    const { list } = makeProviders('admin');
    await TestBed.configureTestingModule({
      imports: [SettingsComponent],
      providers: list,
    }).compileComponents();
    const fixture = TestBed.createComponent(SettingsComponent);
    fixture.detectChanges();
    const bodies = fixture.nativeElement.querySelectorAll('[data-testid="settings-group-body"]');
    expect(bodies.length).toBe(0);
    fixture.destroy();
  });
});

describe('SettingsComponent (desktop music folder, Electron-gated)', () => {
  beforeEach(() => {
    vi.mocked(pickDirectory).mockReset();
    vi.mocked(setMusicDir).mockReset().mockResolvedValue({ ok: true });
    vi.mocked(revealLogs).mockReset().mockResolvedValue(undefined);
  });

  it('does not render the change-folder control off-Electron', async () => {
    vi.mocked(isElectron).mockReturnValue(false);
    const { list } = makeProviders('user');
    await TestBed.configureTestingModule({
      imports: [SettingsComponent],
      providers: list,
    }).compileComponents();
    const fixture = TestBed.createComponent(SettingsComponent);
    fixture.detectChanges();
    expect(
      fixture.nativeElement.querySelector('[data-testid="settings-change-folder"]'),
    ).toBeNull();
    fixture.destroy();
  });

  it('does not render the reveal-logs control off-Electron', async () => {
    vi.mocked(isElectron).mockReturnValue(false);
    const { list } = makeProviders('user');
    await TestBed.configureTestingModule({
      imports: [SettingsComponent],
      providers: list,
    }).compileComponents();
    const fixture = TestBed.createComponent(SettingsComponent);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[data-testid="settings-reveal-logs"]')).toBeNull();
    fixture.destroy();
  });

  it('reveals logs via the preload bridge in Electron', async () => {
    vi.mocked(isElectron).mockReturnValue(true);
    const { list } = makeProviders('user');
    await TestBed.configureTestingModule({
      imports: [SettingsComponent],
      providers: list,
    }).compileComponents();
    const fixture = TestBed.createComponent(SettingsComponent);
    fixture.detectChanges();
    expandAllGroups(fixture);
    const btn = fixture.nativeElement.querySelector(
      '[data-testid="settings-reveal-logs"]',
    ) as HTMLButtonElement;
    expect(btn).toBeTruthy();
    await fixture.componentInstance.revealLogs();
    expect(revealLogs).toHaveBeenCalledTimes(1);
    fixture.destroy();
  });

  it('renders the change-folder control in Electron and restarts on pick', async () => {
    vi.mocked(isElectron).mockReturnValue(true);
    vi.mocked(pickDirectory).mockResolvedValue('/new/music');
    const { list } = makeProviders('user');
    await TestBed.configureTestingModule({
      imports: [SettingsComponent],
      providers: list,
    }).compileComponents();
    const fixture = TestBed.createComponent(SettingsComponent);
    fixture.detectChanges();
    expandAllGroups(fixture);
    const btn = fixture.nativeElement.querySelector(
      '[data-testid="settings-change-folder"]',
    ) as HTMLButtonElement;
    expect(btn).toBeTruthy();

    await fixture.componentInstance.changeMusicFolder();

    expect(setMusicDir).toHaveBeenCalledWith('/new/music', { restart: true });
    expect(fixture.componentInstance.musicDirChosen()).toBe('/new/music');
    fixture.destroy();
  });

  it('leaves musicDirChosen unset when the picker is canceled', async () => {
    vi.mocked(isElectron).mockReturnValue(true);
    vi.mocked(pickDirectory).mockResolvedValue(null);
    const { list } = makeProviders('user');
    await TestBed.configureTestingModule({
      imports: [SettingsComponent],
      providers: list,
    }).compileComponents();
    const fixture = TestBed.createComponent(SettingsComponent);
    fixture.detectChanges();

    await fixture.componentInstance.changeMusicFolder();

    expect(setMusicDir).not.toHaveBeenCalled();
    expect(fixture.componentInstance.musicDirChosen()).toBeNull();
    fixture.destroy();
  });

  it('surfaces an error and clears the spinner when the sidecar restart fails', async () => {
    vi.mocked(isElectron).mockReturnValue(true);
    vi.mocked(pickDirectory).mockResolvedValue('/new/music');
    vi.mocked(setMusicDir).mockResolvedValue({
      ok: false,
      error: 'Sidecar exited before becoming healthy',
    });
    const { list } = makeProviders('user');
    await TestBed.configureTestingModule({
      imports: [SettingsComponent],
      providers: list,
    }).compileComponents();
    const fixture = TestBed.createComponent(SettingsComponent);
    fixture.detectChanges();
    expandAllGroups(fixture);

    await fixture.componentInstance.changeMusicFolder();
    fixture.detectChanges();

    expect(fixture.componentInstance.musicDirChosen()).toBeNull();
    expect(fixture.componentInstance.musicDirChanging()).toBe(false);
    expect(fixture.componentInstance.musicDirError()).toBe(
      'Sidecar exited before becoming healthy',
    );
    const errorEl = fixture.nativeElement.querySelector(
      '[data-testid="settings-change-folder-error"]',
    );
    expect(errorEl?.textContent).toContain('Sidecar exited before becoming healthy');
    fixture.destroy();
  });
});

describe('SettingsComponent (auto-preserve queue toggle)', () => {
  let confirmAsk: ReturnType<typeof vi.fn>;
  let setAutoPreserveMode: ReturnType<typeof vi.fn>;
  let removeAllAutoPreserved: ReturnType<typeof vi.fn>;
  let autoPreserveMode: ReturnType<typeof signal<string>>;

  async function makeFixture(role: 'admin' | 'user' = 'user') {
    const { list } = makeProviders(role);
    await TestBed.configureTestingModule({
      imports: [SettingsComponent],
      providers: list,
    }).compileComponents();
    return TestBed.createComponent(SettingsComponent);
  }

  beforeEach(() => {
    confirmAsk = vi.fn().mockResolvedValue(true);
    setAutoPreserveMode = vi.fn();
    removeAllAutoPreserved = vi.fn().mockResolvedValue(0);
    autoPreserveMode = signal('off');
  });

  function patchPreserve(): void {
    const preserve = TestBed.inject(PreserveService) as unknown as Record<string, unknown>;
    preserve['autoPreserveMode'] = autoPreserveMode;
    preserve['setAutoPreserveMode'] = setAutoPreserveMode;
    preserve['autoPreservedCount'] = vi.fn().mockReturnValue(0);
    preserve['removeAllAutoPreserved'] = removeAllAutoPreserved;
    TestBed.inject(ConfirmService);
  }

  function patchConfirm(): void {
    const confirm = TestBed.inject(ConfirmService) as unknown as { ask: typeof confirmAsk };
    confirm.ask = confirmAsk;
  }

  it('renders the auto-preserve selector with all four modes', async () => {
    const fixture = await makeFixture();
    patchPreserve();
    fixture.detectChanges();
    expandAllGroups(fixture);
    const buttons = Array.from(
      fixture.nativeElement.querySelectorAll('button[data-testid^="auto-preserve-"]'),
    ) as HTMLButtonElement[];
    const ids = buttons.map((b) => b.getAttribute('data-testid'));
    expect(ids).toEqual([
      'auto-preserve-off',
      'auto-preserve-5',
      'auto-preserve-20',
      'auto-preserve-full',
    ]);
    const labels = buttons.map((b) => b.textContent?.trim());
    expect(labels).toEqual(['Off', 'Next 5', 'Next 20', 'Whole queue']);
    fixture.destroy();
  });

  it('clicking a non-off mode persists the choice without prompting', async () => {
    const fixture = await makeFixture();
    patchPreserve();
    patchConfirm();
    fixture.detectChanges();
    expandAllGroups(fixture);
    const btn = fixture.nativeElement.querySelector(
      '[data-testid="auto-preserve-5"]',
    ) as HTMLButtonElement;
    btn.click();
    await fixture.whenStable();
    expect(setAutoPreserveMode).toHaveBeenCalledWith('5');
    expect(confirmAsk).not.toHaveBeenCalled();
    expect(removeAllAutoPreserved).not.toHaveBeenCalled();
    fixture.destroy();
  });

  it('clicking "off" with no auto-preserved tracks: instant toggle, no prompt', async () => {
    autoPreserveMode.set('5');
    const fixture = await makeFixture();
    patchPreserve();
    patchConfirm();
    fixture.detectChanges();
    expandAllGroups(fixture);
    const offBtn = fixture.nativeElement.querySelector(
      '[data-testid="auto-preserve-off"]',
    ) as HTMLButtonElement;
    offBtn.click();
    await fixture.whenStable();
    expect(confirmAsk).not.toHaveBeenCalled();
    expect(setAutoPreserveMode).toHaveBeenCalledWith('off');
    fixture.destroy();
  });

  it('clicking "off" with auto-preserved tracks: confirms then removes', async () => {
    autoPreserveMode.set('20');
    const fixture = await makeFixture();
    patchPreserve();
    patchConfirm();
    (
      fixture.componentInstance.preserve as unknown as { autoPreservedCount: () => number }
    ).autoPreservedCount = () => 7;
    fixture.detectChanges();
    expandAllGroups(fixture);
    const offBtn = fixture.nativeElement.querySelector(
      '[data-testid="auto-preserve-off"]',
    ) as HTMLButtonElement;
    offBtn.click();
    await fixture.whenStable();
    expect(confirmAsk).toHaveBeenCalledOnce();
    // The message is now an i18n key (issue #236); count > 1 picks the plural key.
    expect(confirmAsk.mock.calls[0]?.[0]).toBe('settings.removeAutoSavedOther');
    expect(BASE_CATALOG).toHaveProperty(['settings.removeAutoSavedOther']);
    expect(removeAllAutoPreserved).toHaveBeenCalled();
    expect(setAutoPreserveMode).toHaveBeenCalledWith('off');
    fixture.destroy();
  });

  it('canceling the confirm leaves the mode unchanged', async () => {
    confirmAsk.mockResolvedValue(false);
    autoPreserveMode.set('5');
    const fixture = await makeFixture();
    patchPreserve();
    patchConfirm();
    (
      fixture.componentInstance.preserve as unknown as { autoPreservedCount: () => number }
    ).autoPreservedCount = () => 3;
    fixture.detectChanges();
    expandAllGroups(fixture);
    const offBtn = fixture.nativeElement.querySelector(
      '[data-testid="auto-preserve-off"]',
    ) as HTMLButtonElement;
    offBtn.click();
    await fixture.whenStable();
    expect(removeAllAutoPreserved).not.toHaveBeenCalled();
    expect(setAutoPreserveMode).not.toHaveBeenCalled();
    fixture.destroy();
  });

  it('explain line updates with the selected mode', async () => {
    autoPreserveMode.set('full');
    const fixture = await makeFixture();
    patchPreserve();
    fixture.detectChanges();
    expandAllGroups(fixture);
    const explain = fixture.nativeElement.querySelector(
      '[data-testid="auto-preserve-explain"]',
    ) as HTMLElement;
    // i18n key now (issue #236); 'full' mode picks the explain-full key.
    expect(explain.textContent).toContain('settings.autoPreserveExplainFull');
    expect(BASE_CATALOG).toHaveProperty(['settings.autoPreserveExplainFull']);
    fixture.destroy();
  });
});

describe('SettingsComponent (manual PWA update check)', () => {
  it('hides the control when the service worker is disabled', async () => {
    const { list } = makeProviders('user', { enabled: false });
    await TestBed.configureTestingModule({
      imports: [SettingsComponent],
      providers: list,
    }).compileComponents();
    const fixture = TestBed.createComponent(SettingsComponent);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[data-testid="settings-check-update"]')).toBeNull();
    fixture.destroy();
  });

  it('renders the control when the service worker is enabled', async () => {
    const { list } = makeProviders('user', { enabled: true });
    await TestBed.configureTestingModule({
      imports: [SettingsComponent],
      providers: list,
    }).compileComponents();
    const fixture = TestBed.createComponent(SettingsComponent);
    fixture.detectChanges();
    expandAllGroups(fixture);
    expect(
      fixture.nativeElement.querySelector('[data-testid="settings-check-update"]'),
    ).toBeTruthy();
    fixture.destroy();
  });

  it('hides the control when an update is already staged (banner owns the CTA)', async () => {
    const { list, update } = makeProviders('user', { enabled: true, updateAvailable: true });
    update.checkAvailable.set(false);
    await TestBed.configureTestingModule({
      imports: [SettingsComponent],
      providers: list,
    }).compileComponents();
    const fixture = TestBed.createComponent(SettingsComponent);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[data-testid="settings-check-update"]')).toBeNull();
    fixture.destroy();
  });

  it('clicking toasts success when the SW reports no update', async () => {
    const { list, toast, update } = makeProviders('user', { enabled: true });
    update.checkForUpdate.mockResolvedValueOnce('up-to-date');
    await TestBed.configureTestingModule({
      imports: [SettingsComponent],
      providers: list,
    }).compileComponents();
    const fixture = TestBed.createComponent(SettingsComponent);
    fixture.detectChanges();
    expandAllGroups(fixture);
    const btn = fixture.nativeElement.querySelector(
      '[data-testid="settings-check-update"]',
    ) as HTMLButtonElement;
    await fixture.componentInstance.searchForUpdates();
    expect(update.checkForUpdate).toHaveBeenCalledTimes(1);
    expect(toast.show).toHaveBeenCalledTimes(1);
    expect(toast.show.mock.calls[0][0].kind).toBe('success');
    // i18n key now (issue #236) — the raw key renders since no catalog is
    // loaded in this harness; the version param only interpolates once a
    // real catalog resolves the template (covered by translate.service specs).
    expect(toast.show.mock.calls[0][0].message).toBe('settings.updateUpToDate');
    expect(BASE_CATALOG).toHaveProperty(['settings.updateUpToDate']);
    btn.textContent = 'Check for updates';
    fixture.destroy();
  });

  it('clicking toasts an info + Reload/Later when an update is available', async () => {
    const { list, toast, update } = makeProviders('user', { enabled: true });
    update.checkForUpdate.mockResolvedValueOnce('available');
    await TestBed.configureTestingModule({
      imports: [SettingsComponent],
      providers: list,
    }).compileComponents();
    const fixture = TestBed.createComponent(SettingsComponent);
    fixture.detectChanges();
    await fixture.componentInstance.searchForUpdates();
    expect(toast.show).toHaveBeenCalledTimes(1);
    expect(toast.show.mock.calls[0][0].kind).toBe('info');
    // i18n keys now (issue #236).
    expect(toast.show.mock.calls[0][0].actions?.map((a: { label: string }) => a.label)).toEqual([
      'settings.reload',
      'settings.later',
    ]);
    expect(BASE_CATALOG).toHaveProperty(['settings.reload']);
    expect(BASE_CATALOG).toHaveProperty(['settings.later']);
    toast.show.mock.calls[0][0].actions![0].callback();
    expect(update.applyUpdate).toHaveBeenCalledTimes(1);
    fixture.destroy();
  });

  it('offers Install (not Reload) when the native APK path found the update', async () => {
    const { list, toast, update } = makeProviders('user', {
      enabled: true,
      pendingApkVersion: '0.1.305',
    });
    update.checkForUpdate.mockResolvedValueOnce('available');
    await TestBed.configureTestingModule({
      imports: [SettingsComponent],
      providers: list,
    }).compileComponents();
    const fixture = TestBed.createComponent(SettingsComponent);
    fixture.detectChanges();
    await fixture.componentInstance.searchForUpdates();
    expect(toast.show).toHaveBeenCalledTimes(1);
    expect(toast.show.mock.calls[0][0].message).toBe('settings.updateAvailableApk');
    expect(toast.show.mock.calls[0][0].actions?.[0].label).toBe('settings.install');
    expect(BASE_CATALOG).toHaveProperty(['settings.updateAvailableApk']);
    expect(BASE_CATALOG).toHaveProperty(['settings.install']);
    toast.show.mock.calls[0][0].actions![0].callback();
    expect(update.applyUpdate).toHaveBeenCalledTimes(1);
    fixture.destroy();
  });

  it('renders the APK download progress line while the native download streams', async () => {
    const { list } = makeProviders('user', { enabled: true, downloadProgress: 42 });
    await TestBed.configureTestingModule({
      imports: [SettingsComponent],
      providers: list,
    }).compileComponents();
    const fixture = TestBed.createComponent(SettingsComponent);
    fixture.detectChanges();
    expandAllGroups(fixture);
    const progress = fixture.nativeElement.querySelector(
      '[data-testid="settings-update-progress"]',
    );
    expect(progress).toBeTruthy();
    expect(progress.textContent).toContain('settings.updateDownloading');
    expect(BASE_CATALOG).toHaveProperty(['settings.updateDownloading']);
    fixture.destroy();
  });

  it('replaces a stale toast on a new check', async () => {
    const { list, toast, update } = makeProviders('user', { enabled: true });
    update.checkForUpdate.mockResolvedValueOnce('up-to-date').mockResolvedValueOnce('up-to-date');
    await TestBed.configureTestingModule({
      imports: [SettingsComponent],
      providers: list,
    }).compileComponents();
    const fixture = TestBed.createComponent(SettingsComponent);
    fixture.detectChanges();
    await fixture.componentInstance.searchForUpdates();
    await fixture.componentInstance.searchForUpdates();
    expect(toast.dismiss).toHaveBeenCalledWith('toast-1');
    expect(toast.show).toHaveBeenCalledTimes(2);
    fixture.destroy();
  });

  it('toasts an error when the SW check rejects', async () => {
    const { list, toast, update } = makeProviders('user', { enabled: true });
    update.checkForUpdate.mockRejectedValueOnce(new Error('network'));
    await TestBed.configureTestingModule({
      imports: [SettingsComponent],
      providers: list,
    }).compileComponents();
    const fixture = TestBed.createComponent(SettingsComponent);
    fixture.detectChanges();
    await fixture.componentInstance.searchForUpdates();
    expect(toast.show.mock.calls[0][0].kind).toBe('error');
    // i18n key now (issue #236).
    expect(toast.show.mock.calls[0][0].message).toBe('settings.updateCheckFailed');
    expect(BASE_CATALOG).toHaveProperty(['settings.updateCheckFailed']);
    fixture.destroy();
  });

  it('disables the button while a check is in flight', async () => {
    const { list, update } = makeProviders('user', { enabled: true });
    update.searching.set(true);
    let resolveCheck!: (v: 'up-to-date' | 'available') => void;
    update.checkForUpdate.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveCheck = resolve as unknown as (v: 'up-to-date' | 'available') => void;
        }),
    );
    await TestBed.configureTestingModule({
      imports: [SettingsComponent],
      providers: list,
    }).compileComponents();
    const fixture = TestBed.createComponent(SettingsComponent);
    fixture.detectChanges();
    expandAllGroups(fixture);
    const inFlight = fixture.componentInstance.searchForUpdates();
    fixture.detectChanges();
    const btn = fixture.nativeElement.querySelector(
      '[data-testid="settings-check-update"]',
    ) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    // i18n key now (issue #236).
    expect(btn.textContent?.trim()).toBe('settings.checkingForUpdates');
    expect(BASE_CATALOG).toHaveProperty(['settings.checkingForUpdates']);
    update.searching.set(false);
    resolveCheck('up-to-date');
    await inFlight;
    fixture.detectChanges();
    expect(btn.disabled).toBe(false);
    // i18n key now (issue #236).
    expect(btn.textContent?.trim()).toBe('settings.checkForUpdates');
    expect(BASE_CATALOG).toHaveProperty(['settings.checkForUpdates']);
    fixture.destroy();
  });
});

describe('SettingsComponent (device icon mapping)', () => {
  it('maps device type/name to the right glyph', async () => {
    const { list } = makeProviders('user');
    await TestBed.configureTestingModule({
      imports: [SettingsComponent],
      providers: list,
    }).compileComponents();
    const fixture = TestBed.createComponent(SettingsComponent);
    const component = fixture.componentInstance;
    expect(component.getDeviceIcon({ type: 'web', name: 'Chrome on Linux' })).toBe('monitor');
    expect(component.getDeviceIcon({ type: 'web', name: 'Safari on iPhone' })).toBe('smartphone');
    expect(component.getDeviceIcon({ type: 'web', name: 'Android Chrome' })).toBe('smartphone');
    expect(component.getDeviceIcon({ type: 'cast', name: 'Living Room Speaker' })).toBe('speaker');
    fixture.destroy();
  });
});
