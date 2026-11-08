import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { signal } from '@angular/core';
import { of, throwError } from 'rxjs';
import { describe, it, expect, vi } from 'vitest';
import { EmptyLibraryComponent } from './empty-library.component';
import { AuthService } from '../../services/auth.service';
import { SystemApiService } from '../../services/api/system-api.service';

async function setup(opts: { admin?: boolean; canImport?: boolean; scanFails?: boolean } = {}) {
  const triggerScan = vi.fn(() =>
    opts.scanFails ? throwError(() => new Error('503')) : of({ ok: true }),
  );
  const getLibraryLocation = vi.fn(() => of({ musicDir: '/srv/music' }));
  TestBed.configureTestingModule({
    imports: [EmptyLibraryComponent],
    providers: [
      provideRouter([]),
      {
        provide: AuthService,
        useValue: {
          isAdmin: signal(opts.admin ?? false),
          canImport: signal(opts.canImport ?? true),
        },
      },
      { provide: SystemApiService, useValue: { triggerScan, getLibraryLocation } },
    ],
  });
  const fixture = TestBed.createComponent(EmptyLibraryComponent);
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
  const el = fixture.nativeElement as HTMLElement;
  const q = (id: string) => el.querySelector(`[data-testid="${id}"]`);
  return { fixture, el, q, triggerScan, getLibraryLocation };
}

describe('EmptyLibraryComponent (#1739)', () => {
  it('shows the music folder to an admin', async () => {
    const { q } = await setup({ admin: true });
    expect(q('empty-library-path')?.textContent).toContain('/srv/music');
  });

  it('never asks a non-admin server for the path', async () => {
    const { q, getLibraryLocation } = await setup({ admin: false });
    expect(getLibraryLocation).not.toHaveBeenCalled();
    expect(q('empty-library-path')).toBeNull();
  });

  it('links to Add only for users who can add music', async () => {
    expect((await setup({ canImport: true })).q('empty-library-add')?.getAttribute('href')).toBe(
      '/get',
    );
    TestBed.resetTestingModule();
    expect((await setup({ canImport: false })).q('empty-library-add')).toBeNull();
  });

  it('starts a scan and says so', async () => {
    const { fixture, q, triggerScan } = await setup();
    (q('empty-library-scan') as HTMLButtonElement).click();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(triggerScan).toHaveBeenCalledTimes(1);
    expect(q('empty-library-scan-status')?.textContent).toContain('library.empty.scanStarted');
  });

  it('reports a scan that could not start', async () => {
    const { fixture, q } = await setup({ scanFails: true });
    (q('empty-library-scan') as HTMLButtonElement).click();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(q('empty-library-scan-status')?.textContent).toContain('library.empty.scanFailed');
  });
});
