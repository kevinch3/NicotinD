import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { signal } from '@angular/core';
import { vi } from 'vitest';
import { TvSettingsComponent } from './tv-settings.component';
import { TvProfileService } from '../../services/tv-profile.service';
import { APP_VERSION } from '../../app.config';
import { AuthService } from '../../services/auth.service';
import { TranslateService } from '../../services/translate.service';

describe('TvSettingsComponent', () => {
  it('Sign out names the person and hands the box to TvProfileService (#1406)', () => {
    const profiles = { signOut: vi.fn().mockResolvedValue(undefined), active: signal('ana') };
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        { provide: APP_VERSION, useValue: '0.0.1' },
        { provide: TvProfileService, useValue: profiles },
        // A real catalog for the sign-out label, so the assertion below reads
        // what a viewer reads rather than an un-interpolated key (#1106).
        {
          provide: TranslateService,
          useValue: {
            t: (key: string, params?: Record<string, string>) =>
              key === 'tv.signOutAs' ? `Sign out ${params?.['name']}` : key,
            lang: () => 'en',
            revision: () => 0,
          },
        },
      ],
    });
    TestBed.inject(AuthService).username.set('ana');
    const fixture = TestBed.createComponent(TvSettingsComponent);
    fixture.detectChanges();
    const btn = (fixture.nativeElement as HTMLElement).querySelector<HTMLButtonElement>(
      '[data-testid="tv-settings-signout"]',
    )!;
    expect(btn.textContent).toContain('ana');
    btn.click();
    expect(profiles.signOut).toHaveBeenCalled();
  });
});
