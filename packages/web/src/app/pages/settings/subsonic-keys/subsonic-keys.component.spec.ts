import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { describe, it, expect } from 'vitest';
import { of, throwError } from 'rxjs';
import { provideRouter } from '@angular/router';
import { expandAllGroups } from '../../../../testing/expand-groups';
import { SubsonicKeysComponent } from './subsonic-keys.component';
import { SubsonicKeysApiService } from '../../../services/api/subsonic-keys-api.service';
import { AuthService } from '../../../services/auth.service';
import { ServerConfigService } from '../../../services/server-config.service';
import type { SubsonicKeyMintResponse, SubsonicKeyRow } from '../../../services/api/api-types';
import BASE_CATALOG from '../../../../../public/i18n/en.json';

const KEYS: SubsonicKeyRow[] = [
  { id: 'k1', name: 'Music Assistant', createdAt: Date.now(), lastUsedAt: null },
];
const MINT: SubsonicKeyMintResponse = { id: 'k2', name: 'Symfonium', key: 'nss_secret' };

function setup(
  overrides: Partial<Record<keyof SubsonicKeysApiService, unknown>> = {},
  baseUrl = '',
) {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    imports: [SubsonicKeysComponent],
    providers: [
      provideRouter([]),
      { provide: AuthService, useValue: { username: signal('ana') } },
      { provide: ServerConfigService, useValue: { baseUrl: signal(baseUrl) } },
      {
        provide: SubsonicKeysApiService,
        useValue: {
          listKeys: () => of({ keys: KEYS }),
          mintKey: () => of(MINT),
          revokeKey: () => of({ ok: true }),
          ...overrides,
        },
      },
    ],
  });
  const fixture = TestBed.createComponent(SubsonicKeysComponent);
  fixture.detectChanges();
  return fixture;
}

describe('SubsonicKeysComponent', () => {
  it('loads keys on init', () => {
    expect(setup().componentInstance.keys()).toEqual(KEYS);
  });

  it('surfaces a load error from the base catalog', () => {
    const fixture = setup({ listKeys: () => throwError(() => new Error('boom')) });
    expect(fixture.componentInstance.error()).toBe('subsonicKeys.errorLoad');
    expect(BASE_CATALOG).toHaveProperty(['subsonicKeys.errorLoad']);
  });

  it('mints a key, shows the once-only secret, and clears the name', () => {
    const fixture = setup();
    const c = fixture.componentInstance;
    c.name = 'Symfonium';
    c.mint();
    expect(c.minted()).toEqual(MINT);
    expect(c.name).toBe('');
    fixture.detectChanges();
    const secret = fixture.nativeElement.querySelector('[data-testid="subsonic-key-secret"]');
    expect(secret?.textContent).toBe('nss_secret');
  });

  it('does not mint with a blank name', () => {
    let called = false;
    const fixture = setup({
      mintKey: () => {
        called = true;
        return of(MINT);
      },
    });
    fixture.componentInstance.name = '   ';
    fixture.componentInstance.mint();
    expect(called).toBe(false);
  });

  it('surfaces a mint error and releases busy', () => {
    const fixture = setup({ mintKey: () => throwError(() => new Error('boom')) });
    const c = fixture.componentInstance;
    c.name = 'x';
    c.mint();
    expect(c.error()).toBe('subsonicKeys.errorCreate');
    expect(BASE_CATALOG).toHaveProperty(['subsonicKeys.errorCreate']);
    expect(c.busy()).toBe(false);
  });

  it('revokes a key, and keeps the list on a revoke error', () => {
    const ok = setup();
    ok.componentInstance.revoke(KEYS[0]!);
    expect(ok.componentInstance.keys()).toEqual([]);

    const bad = setup({ revokeKey: () => throwError(() => new Error('boom')) });
    bad.componentInstance.revoke(KEYS[0]!);
    expect(bad.componentInstance.error()).toBe('subsonicKeys.errorRevoke');
    expect(bad.componentInstance.keys()).toEqual(KEYS);
  });

  it('shows the configured server URL, falling back to this origin on the web', () => {
    expect(setup({}, 'https://music.example').componentInstance.serverUrl()).toBe(
      'https://music.example',
    );
    const web = setup();
    expect(web.componentInstance.serverUrl()).toBe(window.location.origin);
    expandAllGroups(web);
    const details: HTMLElement = web.nativeElement.querySelector(
      '[data-testid="subsonic-connect-details"]',
    );
    expect(details.textContent).toContain('ana');
  });

  it('renders the key list as an appTvNavGroup of appTvNavItem revoke buttons', () => {
    const fixture = setup();
    expandAllGroups(fixture);
    const button = fixture.nativeElement.querySelector('[data-testid="subsonic-key-revoke"]');
    expect(button?.matches('[appTvNavItem]')).toBe(true);
    expect(button?.closest('[appTvNavGroup]')?.getAttribute('axis')).toBe('vertical');
  });
});
