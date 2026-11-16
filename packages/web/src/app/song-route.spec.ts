import { TestBed } from '@angular/core/testing';
import {
  Router,
  type ActivatedRouteSnapshot,
  type RouterStateSnapshot,
  convertToParamMap,
} from '@angular/router';
import { of, throwError } from 'rxjs';
import { songToAlbumGuard } from './app.routes';
import { inAppShareRoute } from './pages/share/share-view.component';
import { LibraryApiService } from './services/api/library-api.service';

// #2004: TV has no song page, so a song link lands on the song's album there.
describe('songToAlbumGuard', () => {
  const run = (getSong: () => unknown) => {
    const createUrlTree = vi.fn((commands: unknown[]) => commands);
    TestBed.configureTestingModule({
      providers: [
        { provide: Router, useValue: { createUrlTree } },
        { provide: LibraryApiService, useValue: { getSong: vi.fn(getSong) } },
      ],
    });
    const route = { paramMap: convertToParamMap({ id: 's1' }) } as ActivatedRouteSnapshot;
    return TestBed.runInInjectionContext(() => songToAlbumGuard(route, {} as RouterStateSnapshot));
  };

  it('redirects to the album that holds the song', async () => {
    expect(await run(() => of({ id: 's1', albumId: 'al1' }))).toEqual(['/library/albums', 'al1']);
  });

  it('goes home for a song that does not exist', async () => {
    expect(await run(() => throwError(() => ({ status: 404 })))).toEqual(['/']);
  });
});

describe('inAppShareRoute', () => {
  it('sends a logged-in user who opens a song share to the song page', () => {
    expect(inAppShareRoute('song', 's1')).toBe('/library/songs/s1');
    expect(inAppShareRoute('album', 'a1')).toBe('/library/albums/a1');
    expect(inAppShareRoute('playlist', 'p1')).toBe('/library/playlists/p1');
  });
});
