import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { signal } from '@angular/core';
import { vi } from 'vitest';
import { SettingsComponent } from './settings.component';
import { AuthService } from '../../services/auth.service';
import { ThemeService } from '../../services/theme.service';
import { RemotePlaybackService } from '../../services/remote-playback.service';
import { PlaybackWsService } from '../../services/playback-ws.service';
import { PreserveService } from '../../services/preserve.service';
import { MediaControlsService } from '../../services/media-controls.service';
import { APP_VERSION } from '../../app.config';

/**
 * Guards the post-refactor Settings page: it renders only universal prefs and
 * must NOT surface admin/extension coupling (Soulseek/streaming/processing/
 * shares/duplicates). The Extensions/Admin links appear for admins only.
 */
function providers(role: 'admin' | 'user') {
  return [
    provideRouter([]),
    { provide: APP_VERSION, useValue: '9.9.9' },
    { provide: AuthService, useValue: {
        username: signal('kev'),
        role: signal(role),
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
        clearAll: vi.fn(),
      },
    },
    { provide: MediaControlsService, useValue: { getDiagnostics: vi.fn() } },
  ];
}

describe('SettingsComponent (universal prefs only)', () => {
  it('renders universal sections without any admin/extension coupling', async () => {
    await TestBed.configureTestingModule({
      imports: [SettingsComponent],
      providers: providers('user'),
    }).compileComponents();
    const fixture = TestBed.createComponent(SettingsComponent);
    fixture.detectChanges();
    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('Appearance');
    expect(text).toContain('Offline storage');
    expect(text).toContain('Remote Playback');
    // The new per-user Playback section containing the autoplay-on-load toggle.
    expect(text).toContain('Resume playback when opening the app');
    // Extension/admin surfaces must be gone from Settings.
    expect(text).not.toContain('Soulseek');
    expect(text).not.toContain('Shared Folders');
    expect(text).not.toContain('Library processing');
    expect(text).not.toContain('Find Duplicates');
    // Non-admin sees no Extensions/Admin links.
    expect(fixture.nativeElement.querySelector('[data-testid="settings-extensions-link"]')).toBeNull();
    fixture.destroy();
  });

  it('shows Admin + Extensions links for admins', async () => {
    await TestBed.configureTestingModule({
      imports: [SettingsComponent],
      providers: providers('admin'),
    }).compileComponents();
    const fixture = TestBed.createComponent(SettingsComponent);
    fixture.detectChanges();
    expect(
      fixture.nativeElement.querySelector('[data-testid="settings-extensions-link"]'),
    ).toBeTruthy();
    expect(fixture.nativeElement.textContent).toContain('Admin panel');
    fixture.destroy();
  });

  it('autoplay toggle routes through AuthService.setAutoplayOnLoad', async () => {
    await TestBed.configureTestingModule({
      imports: [SettingsComponent],
      providers: providers('user'),
    }).compileComponents();
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
