import { TestBed } from '@angular/core/testing';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { of, throwError } from 'rxjs';
import { SetupComponent } from './setup.component';
import { SystemApiService } from '../../services/api/system-api.service';
import { AuthService } from '../../services/auth.service';
import { SetupService } from '../../services/setup.service';

describe('SetupComponent', () => {
  const mockCompleteSetup = vi.fn();
  const mockLogin = vi.fn();
  const mockCheck = vi.fn().mockReturnValue(of({}));

  function setup() {
    TestBed.configureTestingModule({
      imports: [SetupComponent],
      providers: [
        {
          provide: SystemApiService,
          useValue: {
            completeSetup: mockCompleteSetup,
            getSetupStatus: vi.fn().mockReturnValue(of({ needsSetup: true })),
          },
        },
        {
          provide: AuthService,
          useValue: { login: mockLogin },
        },
        {
          provide: SetupService,
          useValue: { check: mockCheck, status: vi.fn().mockReturnValue({ needsSetup: true }) },
        },
      ],
    });
    const fixture = TestBed.createComponent(SetupComponent);
    fixture.detectChanges();
    return fixture;
  }

  beforeEach(() => {
    mockCompleteSetup.mockClear();
    mockLogin.mockClear();
  });

  it('shows admin step by default', () => {
    const fixture = setup();
    expect(fixture.nativeElement.textContent).toContain('Create Admin Account');
  });

  it('navigates to library step after admin credentials', () => {
    const comp = TestBed.createComponent(SetupComponent).componentInstance;
    comp.adminUsername = 'admin';
    comp.adminPassword = 'password123';
    comp.handleAdminNext();
    expect(comp.step()).toBe('library');
  });

  it('navigates to quality step after library', () => {
    const comp = TestBed.createComponent(SetupComponent).componentInstance;
    comp.step.set('library');
    comp.handleLibraryNext();
    expect(comp.step()).toBe('quality');
  });

  it('navigates to soulseek step after quality', () => {
    const comp = TestBed.createComponent(SetupComponent).componentInstance;
    comp.step.set('quality');
    comp.handleQualityNext();
    expect(comp.step()).toBe('soulseek');
  });

  it('submits setup with admin + library dir + transcode settings', () => {
    const comp = TestBed.createComponent(SetupComponent).componentInstance;
    (comp as any).adminData = { username: 'admin', password: 'password123' };
    comp.musicDir = '/mnt/music';
    comp.transcodeLosslessEnabled = true;
    comp.transcodeBitrate = 256;

    const spy = vi.spyOn(comp.api, 'completeSetup').mockReturnValue(
      of({ token: 'tok', user: { id: '1', username: 'admin', role: 'admin' }, needsRestart: false }),
    );

    comp.handleSoulseekNext();

    expect(spy).toHaveBeenCalledWith({
      admin: { username: 'admin', password: 'password123' },
      musicDir: '/mnt/music',
      transcodeLossless: { enabled: true, bitRate: 256 },
    });
  });

  it('shows restart notice on done screen when needsRestart is true', () => {
    const comp = TestBed.createComponent(SetupComponent).componentInstance;
    (comp as any).adminData = { username: 'admin', password: 'password' };

    vi.spyOn(comp.api, 'completeSetup').mockReturnValue(
      of({ token: 'tok', user: { id: '1', username: 'admin', role: 'admin' }, needsRestart: true }),
    );

    comp.handleSoulseekNext();

    expect(comp.needsRestart()).toBe(true);
    expect(comp.step()).toBe('done');
  });

  it('shows error on API failure', () => {
    const comp = TestBed.createComponent(SetupComponent).componentInstance;
    (comp as any).adminData = { username: 'admin', password: 'password' };

    vi.spyOn(comp.api, 'completeSetup').mockReturnValue(
      throwError(() => ({ message: 'Server error' })),
    );

    comp.handleSoulseekNext();

    expect(comp.error()).toBe('Server error');
  });

  it('toggles lidarr panel visibility', () => {
    const comp = TestBed.createComponent(SetupComponent).componentInstance;
    expect(comp.showLidarr()).toBe(false);
    comp.showLidarr.set(true);
    expect(comp.showLidarr()).toBe(true);
  });

  it('returns correct step number for each step', () => {
    const comp = TestBed.createComponent(SetupComponent).componentInstance;
    comp.step.set('admin');
    expect(comp.stepNumber()).toBe(1);
    comp.step.set('library');
    expect(comp.stepNumber()).toBe(2);
    comp.step.set('quality');
    expect(comp.stepNumber()).toBe(3);
    comp.step.set('soulseek');
    expect(comp.stepNumber()).toBe(4);
  });

  it('has 4 step dots', () => {
    const comp = TestBed.createComponent(SetupComponent).componentInstance;
    expect(comp.stepDots()).toEqual([1, 2, 3, 4]);
  });
});
