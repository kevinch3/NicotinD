import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { signal } from '@angular/core';
import { vi } from 'vitest';
import { TvWhoComponent } from './tv-who.component';
import { TvProfileService } from '../../services/tv-profile.service';
import { TranslateService } from '../../services/translate.service';

describe('TvWhoComponent', () => {
  function create(active: string | null = 'ana') {
    const profiles = {
      profiles: signal([
        { username: 'ana', role: 'user', token: 'a', lastUsedAt: 2 },
        { username: 'ben', role: 'user', token: 'b', lastUsedAt: 1 },
      ]),
      active: signal(active),
      stale: signal(new Set(['ben'])),
      switchTo: vi.fn().mockResolvedValue(undefined),
      beginAdd: vi.fn(),
    };
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        { provide: TvProfileService, useValue: profiles },
        // A real catalog for the one key the spec asserts on, matching
        // tv-player/tv-karaoke's spec convention: the pipe falls back to the
        // raw key with no catalog loaded, so an un-stubbed TranslateService
        // would make `toContain('Sign in again')` meaningless.
        {
          provide: TranslateService,
          useValue: {
            t: (key: string) => (key === 'tv.signInAgain' ? 'Sign in again' : key),
            lang: () => 'en',
            revision: () => 0,
          },
        },
      ],
    });
    const fixture = TestBed.createComponent(TvWhoComponent);
    fixture.detectChanges();
    return { fixture, profiles, el: fixture.nativeElement as HTMLElement };
  }

  it('lists every person as a button, the active one marked, and Add person last', () => {
    const { el } = create();
    const rows = Array.from(el.querySelectorAll<HTMLButtonElement>('[data-testid="tv-who-row"]'));
    expect(rows.map((r) => r.dataset['username'])).toEqual(['ana', 'ben']);
    expect(rows[0].getAttribute('aria-current')).toBe('true');
    expect(rows[1].getAttribute('aria-current')).toBeNull();
    // A stale token says so instead of pretending the switch will work.
    expect(rows[1].textContent).toContain('Sign in again');
    expect(el.querySelector('[data-testid="tv-who-add"]')).not.toBeNull();
    expect(el.querySelector('select, input')).toBeNull();
  });

  it('pressing a person switches; pressing Add person begins the QR flow', () => {
    const { el, profiles } = create();
    el.querySelector<HTMLButtonElement>('[data-testid="tv-who-row"][data-username="ben"]')!.click();
    expect(profiles.switchTo).toHaveBeenCalledWith('ben');
    el.querySelector<HTMLButtonElement>('[data-testid="tv-who-add"]')!.click();
    expect(profiles.beginAdd).toHaveBeenCalled();
  });
});
