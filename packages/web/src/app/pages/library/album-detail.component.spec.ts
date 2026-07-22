import { TestBed } from '@angular/core/testing';
import { NO_ERRORS_SCHEMA, signal } from '@angular/core';
import { provideRouter, ActivatedRoute } from '@angular/router';
import { HttpClient } from '@angular/common/http';
import { of } from 'rxjs';
import { vi } from 'vitest';
import { AlbumDetailComponent } from './album-detail.component';
import { LibraryApiService } from '../../services/api/library-api.service';
import type { AlbumDetail } from '../../services/api/api-types';
import { AuthService } from '../../services/auth.service';
import { PlayerService } from '../../services/player.service';
import { PlaylistService } from '../../services/playlist.service';
import { ListControlsService } from '../../services/list-controls.service';
import { TransferService } from '../../services/transfer.service';

const ALBUM: AlbumDetail = {
  id: 'a1',
  name: 'Natiruts',
  artist: 'Natiruts',
  artistId: 'ar1',
  song: [
    { id: 's1', title: 'One', artist: 'Natiruts' },
    { id: 's2', title: 'Two', artist: 'Natiruts' },
    { id: 's3', title: 'Three', artist: 'Natiruts' },
  ],
} as unknown as AlbumDetail;

function setup(
  opts: {
    deleteSongs?: ReturnType<typeof vi.fn>;
    optimizeAlbumMetadata?: ReturnType<typeof vi.fn>;
  } = {},
) {
  const deleteSongs = opts.deleteSongs ?? vi.fn(() => of({ ok: true, deletedCount: 0 }));
  const optimizeAlbumMetadata =
    opts.optimizeAlbumMetadata ??
    vi.fn(() =>
      of({ matched: true, coverUpdated: true, yearUpdated: true, releaseTypeUpdated: false }),
    );

  TestBed.configureTestingModule({
    imports: [AlbumDetailComponent],
    providers: [
      provideRouter([]),
      { provide: ActivatedRoute, useValue: { snapshot: { paramMap: { get: () => 'a1' } } } },
      {
        provide: LibraryApiService,
        useValue: { getAlbum: () => of(ALBUM), deleteSongs, optimizeAlbumMetadata },
      },
      { provide: AuthService, useValue: { token: signal('tok'), role: () => 'admin' } },
      { provide: PlayerService, useValue: { play: () => {}, playWithContext: () => {} } },
      { provide: PlaylistService, useValue: { openPicker: vi.fn() } },
      // The list-controls connect() result is only read through the (unrendered)
      // template here; a minimal stub keeps construction cheap.
      { provide: ListControlsService, useValue: { connect: () => ({ filtered: () => ALBUM.song }) } },
      { provide: HttpClient, useValue: {} },
    ],
    schemas: [NO_ERRORS_SCHEMA],
  });

  // No detectChanges(): we drive the delete handler directly rather than render
  // the toolbar-heavy template.
  const fixture = TestBed.createComponent(AlbumDetailComponent);
  return { component: fixture.componentInstance, deleteSongs, optimizeAlbumMetadata };
}

describe('AlbumDetailComponent — bulk delete', () => {
  it('deletes the selected songs, prunes the album, and exits select mode', async () => {
    const deleteSongs = vi.fn(() => of({ ok: true, deletedCount: 2 }));
    const { component } = setup({ deleteSongs });
    component.selectedAlbum.set(ALBUM);

    component.selection.enter();
    component.selection.toggle('s1');
    component.selection.toggle('s3');
    component.deleteSelectedSongs();
    await component.confirmCallback()!();

    expect(deleteSongs).toHaveBeenCalledWith(['s1', 's3']);
    expect(component.selectedAlbum()?.song.map((s) => s.id)).toEqual(['s2']);
    expect(component.selection.active()).toBe(false);
    expect(component.deleteError()).toBeNull();
  });

  it('reports a partial failure when not all songs were removed', async () => {
    const deleteSongs = vi.fn(() => of({ ok: true, deletedCount: 1 }));
    const { component } = setup({ deleteSongs });
    component.selectedAlbum.set(ALBUM);

    component.selection.enter();
    component.selection.toggle('s1');
    component.selection.toggle('s2');
    component.deleteSelectedSongs();
    await component.confirmCallback()!();

    expect(component.deleteError()).toContain('1 of 2');
  });
});

describe('AlbumDetailComponent — deletedSongIds filter', () => {
  it('drops a row whose id is marked deleted elsewhere in the app', () => {
    const { component } = setup();
    component.selectedAlbum.set(ALBUM);
    expect(component.detailSongs().map((s) => s.id)).toEqual(['s1', 's2', 's3']);

    TestBed.inject(TransferService).deletedSongIds.set(new Set(['s2']));

    expect(component.detailSongs().map((s) => s.id)).toEqual(['s1', 's3']);
  });
});

describe('AlbumDetailComponent — licence label', () => {
  it('maps a licence code to its human label, passing unknowns through', () => {
    const { component } = setup();
    expect(component.licenceLabel('public-domain')).toBe('Public Domain');
    expect(component.licenceLabel('cc-by-sa')).toBe('CC BY-SA');
    expect(component.licenceLabel('mystery')).toBe('mystery');
  });
});

describe('AlbumDetailComponent — fix metadata', () => {
  it('opens the fix modal only when an album is loaded', () => {
    const { component } = setup();
    component.openMetadataFix();
    expect(component.showMetadataFix()).toBe(false);

    component.selectedAlbum.set(ALBUM);
    component.openMetadataFix();
    expect(component.showMetadataFix()).toBe(true);
  });

  it('re-fetches in place and busts the cover when the album id is unchanged', async () => {
    const { component } = setup();
    component.selectedAlbum.set(ALBUM);
    component.showMetadataFix.set(true);

    await component.onMetadataApplied({ albumId: 'a1' });

    expect(component.showMetadataFix()).toBe(false);
    expect(component.coverBust()).toBe(1);
    expect(component.selectedAlbum()?.id).toBe('a1');
  });

  it('navigates to the new album when a correction changes its id', async () => {
    const { component } = setup();
    const navigate = vi
      .spyOn(
        (component as unknown as { router: { navigate: (c: unknown[]) => Promise<boolean> } })
          .router,
        'navigate',
      )
      .mockResolvedValue(true);
    component.selectedAlbum.set(ALBUM);

    await component.onMetadataApplied({ albumId: 'a2-new' });

    expect(navigate).toHaveBeenCalledWith(['/library', 'albums', 'a2-new']);
    expect(component.showMetadataFix()).toBe(false);
  });
});
