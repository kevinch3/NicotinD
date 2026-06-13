import { TestBed } from '@angular/core/testing';
import { NO_ERRORS_SCHEMA, signal } from '@angular/core';
import { provideRouter, ActivatedRoute } from '@angular/router';
import { HttpClient } from '@angular/common/http';
import { of } from 'rxjs';
import { vi } from 'vitest';
import { AlbumDetailComponent } from './album-detail.component';
import { ApiService, type AlbumDetail } from '../../services/api.service';
import { AuthService } from '../../services/auth.service';
import { PlayerService } from '../../services/player.service';
import { PlaylistService } from '../../services/playlist.service';
import { ListControlsService } from '../../services/list-controls.service';

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

function setup(opts: { deleteSongs?: ReturnType<typeof vi.fn> } = {}) {
  const deleteSongs = opts.deleteSongs ?? vi.fn(() => of({ ok: true, deletedCount: 0 }));

  TestBed.configureTestingModule({
    imports: [AlbumDetailComponent],
    providers: [
      provideRouter([]),
      { provide: ActivatedRoute, useValue: { snapshot: { paramMap: { get: () => 'a1' } } } },
      { provide: ApiService, useValue: { getAlbum: () => of(ALBUM), deleteSongs } },
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
  return { component: fixture.componentInstance, deleteSongs };
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
