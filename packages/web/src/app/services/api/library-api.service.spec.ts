import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting, HttpTestingController } from '@angular/common/http/testing';
import { LibraryApiService } from './library-api.service';

describe('LibraryApiService', () => {
  let service: LibraryApiService;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    service = TestBed.inject(LibraryApiService);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('GETs albums with type/size/offset and optional flags', () => {
    service.getAlbums('newest', 20, 40, { includeHidden: true }).subscribe();
    const req = http.expectOne((r) => r.url === '/api/library/albums');
    expect(req.request.params.get('type')).toBe('newest');
    expect(req.request.params.get('size')).toBe('20');
    expect(req.request.params.get('offset')).toBe('40');
    expect(req.request.params.get('includeHidden')).toBe('true');
    req.flush([]);
  });

  it('POSTs a genre to the song genre endpoint', () => {
    service.applyGenre('song-1', 'Reggae').subscribe();
    const req = http.expectOne('/api/library/songs/song-1/genre');
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual({ genre: 'Reggae' });
    req.flush({ ok: true, genre: 'Reggae' });
  });

  it('resolveArtistIdByName maps a hit to the id', () => {
    let result: string | null | undefined;
    service.resolveArtistIdByName('Natiruts').subscribe((v) => (result = v));
    const req = http.expectOne((r) => r.url === '/api/library/artists/by-name');
    expect(req.request.params.get('name')).toBe('Natiruts');
    req.flush({ id: 'ar1' });
    expect(result).toBe('ar1');
  });

  it('resolveArtistIdByName swallows a 404 into null', () => {
    let result: string | null | undefined;
    service.resolveArtistIdByName('Nobody').subscribe((v) => (result = v));
    const req = http.expectOne((r) => r.url === '/api/library/artists/by-name');
    req.flush('not found', { status: 404, statusText: 'Not Found' });
    expect(result).toBeNull();
  });

  it('caches getArtists so a repeat read shares one HTTP request', () => {
    const captured: string[] = [];
    service.getArtists().subscribe((a) => captured.push('first:' + a.length));
    const req = http.expectOne('/api/library/artists');
    req.flush([{ id: 'a1', name: 'A' }]);

    // Second read within the TTL must NOT hit the network — expectNone verifies it.
    service.getArtists().subscribe((a) => captured.push('second:' + a.length));
    http.expectNone('/api/library/artists');
    expect(captured).toEqual(['first:1', 'second:1']);
  });

  it('invalidateLibraryReads() forces the next getArtists/getGenres to re-fetch', () => {
    service.getArtists().subscribe();
    http.expectOne('/api/library/artists').flush([]);
    service.getGenres().subscribe();
    http.expectOne('/api/library/genres').flush([]);

    service.invalidateLibraryReads();

    service.getArtists().subscribe();
    http.expectOne('/api/library/artists').flush([]);
    service.getGenres().subscribe();
    http.expectOne('/api/library/genres').flush([]);
  });
});
