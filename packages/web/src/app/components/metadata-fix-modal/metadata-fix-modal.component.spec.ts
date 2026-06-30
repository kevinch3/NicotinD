import { TestBed } from '@angular/core/testing';
import { vi } from 'vitest';
import { of } from 'rxjs';
import type { AlbumCoverCandidate } from '../../../types/core';
import { MetadataFixModalComponent } from './metadata-fix-modal.component';
import { LibraryApiService } from '../../services/api/library-api.service';
import { AuthService } from '../../services/auth.service';
import { ServerConfigService } from '../../services/server-config.service';

// Instantiated without detectChanges (so ngOnInit, which reads required inputs,
// never runs); the cover-apply logic is exercised directly. Input binding is
// unreliable under the optimized JIT test build, so albumId is set explicitly.
describe('MetadataFixModalComponent cover picker', () => {
  const getCoverCandidates = vi.fn(() => of({ current: null, lidarr: [], files: [] }));
  const applyCover = vi.fn(() => of({ ok: true }));

  function create() {
    getCoverCandidates.mockClear();
    applyCover.mockClear();
    getCoverCandidates.mockReturnValue(of({ current: null, lidarr: [], files: [] }));
    applyCover.mockReturnValue(of({ ok: true }));

    TestBed.configureTestingModule({
      imports: [MetadataFixModalComponent],
      providers: [
        {
          provide: LibraryApiService,
          useValue: { getCoverCandidates, applyCover, getMetadataCandidates: vi.fn() },
        },
        { provide: AuthService, useValue: { token: () => 'tok' } },
        { provide: ServerConfigService, useValue: { apiUrl: (p: string) => p } },
      ],
    });
    const fixture = TestBed.createComponent(MetadataFixModalComponent);
    const c = fixture.componentInstance;
    // Input binding is unreliable under the optimized JIT test build, so stub the
    // required albumId signal directly on the instance.
    (c as unknown as { albumId: () => string }).albumId = () => 'album-1';
    return c;
  }

  const lidarr: AlbumCoverCandidate = { source: 'lidarr', url: 'https://img/x.jpg', label: 'X' };
  const current: AlbumCoverCandidate = {
    source: 'current',
    url: '/api/cover/album-1',
    label: 'Current',
  };

  it('applies a Lidarr cover by URL and emits coverChanged', async () => {
    const c = create();
    const emitted = vi.fn();
    c.coverChanged.subscribe(emitted);

    await c.selectCover(lidarr);

    expect(applyCover).toHaveBeenCalledWith('album-1', { coverUrl: 'https://img/x.jpg' });
    expect(emitted).toHaveBeenCalledTimes(1);
  });

  it('does not apply when the current cover is selected', async () => {
    const c = create();
    await c.selectCover(current);
    expect(applyCover).not.toHaveBeenCalled();
  });

  it('applies a pasted custom URL and clears the input', async () => {
    const c = create();
    c.customCoverUrl.set('  https://img/custom.jpg ');
    await c.applyCustomCover();
    expect(applyCover).toHaveBeenCalledWith('album-1', { coverUrl: 'https://img/custom.jpg' });
    expect(c.customCoverUrl()).toBe('');
  });

  it('refuses a blank custom URL with a message', async () => {
    const c = create();
    c.customCoverUrl.set('   ');
    await c.applyCustomCover();
    expect(applyCover).not.toHaveBeenCalled();
    expect(c.msg()).toBeTruthy();
  });
});
