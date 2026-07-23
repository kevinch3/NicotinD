import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting, HttpTestingController } from '@angular/common/http/testing';
import { PlaylistsApiService } from './playlists-api.service';

describe('PlaylistsApiService', () => {
  let service: PlaylistsApiService;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    service = TestBed.inject(PlaylistsApiService);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('GETs the playlist list', () => {
    service.getPlaylists().subscribe();
    const req = http.expectOne('/api/playlists');
    expect(req.request.method).toBe('GET');
    req.flush({ playlists: [] });
  });

  it('POSTs a new playlist with name/songIds/description', () => {
    service.createPlaylist('Mix', ['s1'], 'desc').subscribe();
    const req = http.expectOne('/api/playlists');
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual({ name: 'Mix', songIds: ['s1'], description: 'desc' });
    req.flush({ playlist: {} });
  });

  it('PUTs a patch to a specific playlist', () => {
    service.updatePlaylist('pl1', { reorder: ['s2', 's1'] }).subscribe();
    const req = http.expectOne('/api/playlists/pl1');
    expect(req.request.method).toBe('PUT');
    expect(req.request.body).toEqual({ reorder: ['s2', 's1'] });
    req.flush({ ok: true });
  });

  it('GETs proposals for a playlist with a limit param', () => {
    service.getProposals('pl1', 10).subscribe();
    const req = http.expectOne((r) => r.url === '/api/playlists/pl1/proposals');
    expect(req.request.method).toBe('GET');
    expect(req.request.params.get('limit')).toBe('10');
    req.flush([]);
  });

  it('defaults the proposals limit to 20', () => {
    service.getProposals('pl1').subscribe();
    const req = http.expectOne((r) => r.url === '/api/playlists/pl1/proposals');
    expect(req.request.params.get('limit')).toBe('20');
    req.flush([]);
  });
});
