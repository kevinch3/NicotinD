import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { signal } from '@angular/core';
import { vi } from 'vitest';
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

vi.mock('../../lib/platform', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/platform')>();
  return { ...actual, isElectron: vi.fn().mockReturnValue(false) };
});

vi.mock('../../services/native/native-capabilities', () => ({
  pickDirectory: vi.fn(),
  setMusicDir: vi.fn().mockResolvedValue({ ok: true }),
  revealLogs: vi.fn().mockResolvedValue(undefined),
}));

function makeToastService() {
  return {
    show: vi.fn().mockImplementation(() => 'toast-1'),
    dismiss: vi.fn(),
    toasts: signal([]),
  };
}

function makeUpdateService(overrides: Partial<{
  enabled: boolean;
  updateAvailable: boolean;
  searching: boolean;
  checkForUpdate: ReturnType<typeof vi.fn>;
  applyUpdate: ReturnType<typeof vi.fn>;
}> = {}) {
  const check = overrides.checkForUpdate ?? vi.fn().mockResolvedValue('up-to-date');
  const apply = overrides.applyUpdate ?? vi.fn();
  return {
    enabled: signal(overrides.enabled ?? false),
    updateAvailable: signal(overrides.updateAvailable ?? false),
    searching: signal(overrides.searching ?? false),
    checkAvailable: signal(
      (overrides.enabled ?? false) && !(overrides.updateAvailable ?? false) && !(overrides.searching ?? false),
    ),
    checkForUpdate: check,
    applyUpdate: apply,
  } satisfies Partial<UpdateService> & { [k: string]: unknown };
}

/**
 * Guards the post-refactor Settings page: it renders only universal prefs and
 * must NOT surface admin/extension coupling (Soulseek/streaming/processing/
 * shares/duplicates). The Extensions/Admin links appear for admins only.
 */
function makeProviders(role: 'admin' | 'user', updateOverrides = {}) {
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
      { provide: AuthService, useValue: {
          username: signal('kev'),
          role: signal(role),
          isAdmin: () => role === 'admin',
          welcomeDismissed: signal(false),
          autoplayOnLoad: signal(false),
          setAutoplayOnLoad: vi.fn(),
          logout: vi.fn(),
        } },
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

describe('SettingsComponent (universal prefs only)', () => {
  it('renders universal sections without any admin/extension coupling', async () => {
    const { list } = makeProviders('user');
    await TestBed.configureTestingModule({ imports: [SettingsComponent], providers: list }).compileComponents();
    const fixture = TestBed.createComponent(SettingsComponent);
    fixture.detectChanges();
    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('Appearance');
    expect(text).toContain('Offline storage');
    expect(text).toContain('Remote Playback');
    expect(text).toContain('Resume playback when opening the app');
    expect(text).not.toContain('Soulseek');
    expect(text).not.toContain('Shared Folders');
    expect(text).not.toContain('Library processing');
    expect(text).not.toContain('Find Duplicates');
    expect(fixture.nativeElement.querySelector('[data-testid="settings-extensions-link"]')).toBeNull();
    expect(fixture.nativeElement.querySelector('[data-testid="settings-check-update"]')).toBeNull();
    fixture.destroy();
  });

  it('shows Admin + Extensions links for admins', async () => {
    const { list } = makeProviders('admin');
    await TestBed.configureTestingModule({ imports: [SettingsComponent], providers: list }).compileComponents();
    const fixture = TestBed.createComponent(SettingsComponent);
    fixture.detectChanges();
    expect(
      fixture.nativeElement.querySelector('[data-testid="settings-extensions-link"]'),
    ).toBeTruthy();
    expect(fixture.nativeElement.textContent).toContain('Admin panel');
    fixture.destroy();
  });

  it('autoplay toggle routes through AuthService.setAutoplayOnLoad', async () => {
    const { list } = makeProviders('user');
    await TestBed.configureTestingModule({ imports: [SettingsComponent], providers: list }).compileComponents();
    const fixture = TestBed.createComponent(SettingsComponent);
    fixture.detectChanges();
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
    await TestBed.configureTestingModule({ imports: [SettingsComponent], providers: list }).compileComponents();
    const fixture = TestBed.createComponent(SettingsComponent);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[data-testid="settings-change-folder"]')).toBeNull();
    fixture.destroy();
  });

  it('does not render the reveal-logs control off-Electron', async () => {
    vi.mocked(isElectron).mockReturnValue(false);
    const { list } = makeProviders('user');
    await TestBed.configureTestingModule({ imports: [SettingsComponent], providers: list }).compileComponents();
    const fixture = TestBed.createComponent(SettingsComponent);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[data-testid="settings-reveal-logs"]')).toBeNull();
    fixture.destroy();
  });

  it('reveals logs via the preload bridge in Electron', async () => {
    vi.mocked(isElectron).mockReturnValue(true);
    const { list } = makeProviders('user');
    await TestBed.configureTestingModule({ imports: [SettingsComponent], providers: list }).compileComponents();
    const fixture = TestBed.createComponent(SettingsComponent);
    fixture.detectChanges();
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
    await TestBed.configureTestingModule({ imports: [SettingsComponent], providers: list }).compileComponents();
    const fixture = TestBed.createComponent(SettingsComponent);
    fixture.detectChanges();
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
    await TestBed.configureTestingModule({ imports: [SettingsComponent], providers: list }).compileComponents();
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
    vi.mocked(setMusicDir).mockResolvedValue({ ok: false, error: 'Sidecar exited before becoming healthy' });
    const { list } = makeProviders('user');
    await TestBed.configureTestingModule({ imports: [SettingsComponent], providers: list }).compileComponents();
    const fixture = TestBed.createComponent(SettingsComponent);
    fixture.detectChanges();

    await fixture.componentInstance.changeMusicFolder();
    fixture.detectChanges();

    expect(fixture.componentInstance.musicDirChosen()).toBeNull();
    expect(fixture.componentInstance.musicDirChanging()).toBe(false);
    expect(fixture.componentInstance.musicDirError()).toBe('Sidecar exited before becoming healthy');
    const errorEl = fixture.nativeElement.querySelector('[data-testid="settings-change-folder-error"]');
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
    await TestBed.configureTestingModule({ imports: [SettingsComponent], providers: list }).compileComponents();
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
    const buttons = Array.from(
      fixture.nativeElement.querySelectorAll(
        'button[data-testid^="auto-preserve-"]',
      ),
    ) as HTMLButtonElement[];
    const ids = buttons.map((b) => b.getAttribute('data-testid'));
    expect(ids).toEqual(['auto-preserve-off', 'auto-preserve-5', 'auto-preserve-20', 'auto-preserve-full']);
    const labels = buttons.map((b) => b.textContent?.trim());
    expect(labels).toEqual(['Off', 'Next 5', 'Next 20', 'Whole queue']);
    fixture.destroy();
  });

  it('clicking a non-off mode persists the choice without prompting', async () => {
    const fixture = await makeFixture();
    patchPreserve();
    patchConfirm();
    fixture.detectChanges();
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
    (fixture.componentInstance.preserve as unknown as { autoPreservedCount: () => number }).autoPreservedCount = () => 7;
    fixture.detectChanges();
    const offBtn = fixture.nativeElement.querySelector(
      '[data-testid="auto-preserve-off"]',
    ) as HTMLButtonElement;
    offBtn.click();
    await fixture.whenStable();
    expect(confirmAsk).toHaveBeenCalledOnce();
    expect(confirmAsk.mock.calls[0]?.[0]).toContain('7');
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
    (fixture.componentInstance.preserve as unknown as { autoPreservedCount: () => number }).autoPreservedCount = () => 3;
    fixture.detectChanges();
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
    const explain = fixture.nativeElement.querySelector(
      '[data-testid="auto-preserve-explain"]',
    ) as HTMLElement;
    expect(explain.textContent).toContain('200');
    fixture.destroy();
  });
});

describe('SettingsComponent (manual PWA update check)', () => {
  it('hides the control when the service worker is disabled', async () => {
    const { list } = makeProviders('user', { enabled: false });
    await TestBed.configureTestingModule({ imports: [SettingsComponent], providers: list }).compileComponents();
    const fixture = TestBed.createComponent(SettingsComponent);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[data-testid="settings-check-update"]')).toBeNull();
    fixture.destroy();
  });

  it('renders the control when the service worker is enabled', async () => {
    const { list } = makeProviders('user', { enabled: true });
    await TestBed.configureTestingModule({ imports: [SettingsComponent], providers: list }).compileComponents();
    const fixture = TestBed.createComponent(SettingsComponent);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[data-testid="settings-check-update"]')).toBeTruthy();
    fixture.destroy();
  });

  it('hides the control when an update is already staged (banner owns the CTA)', async () => {
    const { list, update } = makeProviders('user', { enabled: true, updateAvailable: true });
    update.checkAvailable.set(false);
    await TestBed.configureTestingModule({ imports: [SettingsComponent], providers: list }).compileComponents();
    const fixture = TestBed.createComponent(SettingsComponent);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[data-testid="settings-check-update"]')).toBeNull();
    fixture.destroy();
  });

  it('clicking toasts success when the SW reports no update', async () => {
    const { list, toast, update } = makeProviders('user', { enabled: true });
    update.checkForUpdate.mockResolvedValueOnce('up-to-date');
    await TestBed.configureTestingModule({ imports: [SettingsComponent], providers: list }).compileComponents();
    const fixture = TestBed.createComponent(SettingsComponent);
    fixture.detectChanges();
    const btn = fixture.nativeElement.querySelector(
      '[data-testid="settings-check-update"]',
    ) as HTMLButtonElement;
    await fixture.componentInstance.searchForUpdates();
    expect(update.checkForUpdate).toHaveBeenCalledTimes(1);
    expect(toast.show).toHaveBeenCalledTimes(1);
    expect(toast.show.mock.calls[0][0].kind).toBe('success');
    expect(toast.show.mock.calls[0][0].message).toContain('9.9.9');
    btn.textContent = 'Check for updates';
    fixture.destroy();
  });

  it('clicking toasts an info + Reload/Later when an update is available', async () => {
    const { list, toast, update } = makeProviders('user', { enabled: true });
    update.checkForUpdate.mockResolvedValueOnce('available');
    await TestBed.configureTestingModule({ imports: [SettingsComponent], providers: list }).compileComponents();
    const fixture = TestBed.createComponent(SettingsComponent);
    fixture.detectChanges();
    await fixture.componentInstance.searchForUpdates();
    expect(toast.show).toHaveBeenCalledTimes(1);
    expect(toast.show.mock.calls[0][0].kind).toBe('info');
    expect(toast.show.mock.calls[0][0].actions?.map((a: { label: string }) => a.label)).toEqual([
      'Reload',
      'Later',
    ]);
    toast.show.mock.calls[0][0].actions![0].callback();
    expect(update.applyUpdate).toHaveBeenCalledTimes(1);
    fixture.destroy();
  });

  it('replaces a stale toast on a new check', async () => {
    const { list, toast, update } = makeProviders('user', { enabled: true });
    update.checkForUpdate.mockResolvedValueOnce('up-to-date').mockResolvedValueOnce('up-to-date');
    await TestBed.configureTestingModule({ imports: [SettingsComponent], providers: list }).compileComponents();
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
    await TestBed.configureTestingModule({ imports: [SettingsComponent], providers: list }).compileComponents();
    const fixture = TestBed.createComponent(SettingsComponent);
    fixture.detectChanges();
    await fixture.componentInstance.searchForUpdates();
    expect(toast.show.mock.calls[0][0].kind).toBe('error');
    expect(toast.show.mock.calls[0][0].message).toContain("Couldn't check");
    fixture.destroy();
  });

  it('disables the button while a check is in flight', async () => {
    const { list, update } = makeProviders('user', { enabled: true });
    update.searching.set(true);
    let resolveCheck!: (v: 'up-to-date' | 'available') => void;
    update.checkForUpdate.mockImplementationOnce(
      () => new Promise((resolve) => {
        resolveCheck = resolve as unknown as (v: 'up-to-date' | 'available') => void;
      }),
    );
    await TestBed.configureTestingModule({ imports: [SettingsComponent], providers: list }).compileComponents();
    const fixture = TestBed.createComponent(SettingsComponent);
    fixture.detectChanges();
    const inFlight = fixture.componentInstance.searchForUpdates();
    fixture.detectChanges();
    const btn = fixture.nativeElement.querySelector(
      '[data-testid="settings-check-update"]',
    ) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(btn.textContent?.trim()).toBe('Checking for updates…');
    update.searching.set(false);
    resolveCheck('up-to-date');
    await inFlight;
    fixture.detectChanges();
    expect(btn.disabled).toBe(false);
    expect(btn.textContent?.trim()).toBe('Check for updates');
    fixture.destroy();
  });
});
