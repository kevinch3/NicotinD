import { TestBed } from '@angular/core/testing';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { signal } from '@angular/core';
import { HttpClientTestingModule } from '@angular/common/http/testing';
import { WelcomeBannerComponent } from './welcome-banner.component';
import { AuthService } from '../../services/auth.service';
import { AuthApiService } from '../../services/api/auth-api.service';

describe('WelcomeBannerComponent', () => {
  const mockDismissWelcome = vi.fn().mockReturnValue({ subscribe: (cb: any) => cb.next() });

  function setup(opts: { role: string; welcomeDismissed: boolean }) {
    TestBed.configureTestingModule({
      imports: [WelcomeBannerComponent, HttpClientTestingModule],
      providers: [
        {
          provide: AuthService,
          useValue: {
            role: signal(opts.role),
            welcomeDismissed: signal(opts.welcomeDismissed),
          },
        },
        {
          provide: AuthApiService,
          useValue: {
            dismissWelcome: mockDismissWelcome,
          },
        },
      ],
    });
    return TestBed.createComponent(WelcomeBannerComponent);
  }

  beforeEach(() => {
    mockDismissWelcome.mockClear();
  });

  it('does not show banner for admin role', () => {
    const fixture = setup({ role: 'admin', welcomeDismissed: false });
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('div')).toBeNull();
  });

  it('shows banner for user role with welcomeDismissed false', () => {
    const fixture = setup({ role: 'user', welcomeDismissed: false });
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('Welcome!');
    expect(fixture.nativeElement.textContent).toContain('Got it');
  });

  it('does not show banner when welcomeDismissed is true', () => {
    const fixture = setup({ role: 'user', welcomeDismissed: true });
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('div')).toBeNull();
  });

  it('calls dismissWelcome and hides banner on Got it click', () => {
    const fixture = setup({ role: 'user', welcomeDismissed: false });
    fixture.detectChanges();
    const btn = fixture.nativeElement.querySelector('button') as HTMLButtonElement;
    btn.click();
    expect(mockDismissWelcome).toHaveBeenCalled();
  });
});
