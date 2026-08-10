/**
 * Answers every `/api` request a story makes from the fixture set.
 *
 * The API wrappers (`LibraryApiService`, `HistoryApiService`, `AuthApiService`) are thin
 * HttpClient shells, so stories run the *real* service and fake the transport instead of
 * substituting fake classes. A fake class can stay green while the service it stands in
 * for is broken; faking the transport cannot.
 *
 * Anything unmatched returns 404 rather than passing through — a story must never be able
 * to reach a real network.
 */
import type { HttpEvent, HttpInterceptorFn, HttpRequest } from '@angular/common/http';
import { HttpErrorResponse, HttpResponse } from '@angular/common/http';
import { type Observable, of, throwError } from 'rxjs';
import { demoGenreSlices, demoSongs, DEMO_ARTIST_ID } from './fixtures';

/** URL suffix → response body. First match wins, so put specific routes first. */
const ROUTES: Array<[RegExp, () => unknown]> = [
  [/\/api\/auth\/me$/, () => ({ role: 'admin', username: 'storybook', welcomeDismissed: true })],
  [/\/api\/library\/liked-ids$/, () => ({ ids: [demoSongs[0].id] })],
  [
    /\/api\/library\/artists\/[^/]+\/genre-distribution$/,
    () => ({ slices: demoGenreSlices, trackCount: 47, genreCount: 9 }),
  ],
  [
    /\/api\/library\/albums\/[^/]+\/genre-distribution$/,
    () => ({ slices: demoGenreSlices.slice(0, 3), trackCount: 7, genreCount: 3 }),
  ],
  [
    /\/api\/library\/artists\/[^/]+$/,
    () => ({ id: DEMO_ARTIST_ID, name: 'Nocturnal Signal', albumCount: 4, songCount: 47 }),
  ],
  [/\/api\/library\/songs/, () => ({ songs: demoSongs, total: demoSongs.length })],
  [/\/api\/search/, () => ({ songs: demoSongs, albums: [], artists: [] })],
  [/\/api\/history\/plays/, () => ({ accepted: 0, collection: 'on' })],
  [/\/api\/history\/recent/, () => ({ songs: demoSongs.slice(0, 4) })],
  [/\/api\/playlists$/, () => ({ playlists: [] })],
];

export const fixtureHttpInterceptor: HttpInterceptorFn = (
  req: HttpRequest<unknown>,
): Observable<HttpEvent<unknown>> => {
  const match = ROUTES.find(([pattern]) => pattern.test(req.url));
  if (match) return of(new HttpResponse({ status: 200, body: match[1](), url: req.url }));
  return throwError(
    () =>
      new HttpErrorResponse({
        status: 404,
        statusText: 'Not Found (no Storybook fixture)',
        url: req.url,
      }),
  );
};
