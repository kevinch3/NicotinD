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

  describe('getAllSongs', () => {
    const matchSongs = (r: { url: string }) => r.url === '/api/library/songs';

    it('GETs /api/library/songs with size + offset', () => {
      service.getAllSongs(60, 0).subscribe();
      const req = http.expectOne(matchSongs);
      expect(req.request.method).toBe('GET');
      expect(req.request.params.get('size')).toBe('60');
      expect(req.request.params.get('offset')).toBe('0');
      req.flush([]);
    });

    it('forwards `q` as a query param when provided', () => {
      service.getAllSongs(60, 0, { q: 'alpha house' }).subscribe();
      const req = http.expectOne(matchSongs);
      expect(req.request.params.get('q')).toBe('alpha house');
      req.flush([]);
    });

    it('trims `q` and omits the param when the trimmed value is empty', () => {
      service.getAllSongs(60, 0, { q: '   ' }).subscribe();
      const req = http.expectOne(matchSongs);
      // HttpParams.toString() drops empty values, so the param is absent.
      expect(req.request.params.has('q')).toBe(false);
      req.flush([]);
    });

    it('omits `q` entirely when not provided (no empty-string param leaks)', () => {
      service.getAllSongs(60, 0).subscribe();
      const req = http.expectOne(matchSongs);
      expect(req.request.params.has('q')).toBe(false);
      req.flush([]);
    });

    it('combines `q` + `sort` + `filter` into one request', () => {
      service
        .getAllSongs(20, 40, {
          sort: 'title',
          filter: { bpmMin: 120, genres: ['House'] },
          q: 'alpha',
        })
        .subscribe();
      const req = http.expectOne(matchSongs);
      expect(req.request.params.get('q')).toBe('alpha');
      expect(req.request.params.get('sort')).toBe('title');
      expect(req.request.params.get('bpmMin')).toBe('120');
      // LibraryFilter.genres serializes as repeated `genre` query params.
      expect(req.request.params.getAll('genre')).toEqual(['House']);
      req.flush([]);
    });
  });
});
