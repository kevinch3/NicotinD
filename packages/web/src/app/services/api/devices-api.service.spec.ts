import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting, HttpTestingController } from '@angular/common/http/testing';
import { DevicesApiService } from './devices-api.service';

describe('DevicesApiService', () => {
  let service: DevicesApiService;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    service = TestBed.inject(DevicesApiService);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('POSTs to /api/devices/pair to mint a pairing token', () => {
    service.mintPairing().subscribe();
    const req = http.expectOne('/api/devices/pair');
    expect(req.request.method).toBe('POST');
    req.flush({
      token: 't',
      code: 'ABC234',
      expiresAt: Date.now() + 300_000,
      name: 'desk',
      urls: [],
      remoteAccess: null,
    });
  });

  it('GETs the paired-device list', () => {
    service.getDevices().subscribe();
    const req = http.expectOne('/api/devices');
    expect(req.request.method).toBe('GET');
    req.flush({ devices: [] });
  });

  it('DELETEs a device to revoke it', () => {
    service.revokeDevice('d1').subscribe();
    const req = http.expectOne('/api/devices/d1');
    expect(req.request.method).toBe('DELETE');
    req.flush({ ok: true });
  });

  it('GETs and POSTs the admin remote-access setting', () => {
    service.getRemoteAccess().subscribe();
    const get = http.expectOne('/api/admin/remote-access');
    expect(get.request.method).toBe('GET');
    get.flush({ enabled: false, state: { kind: 'not-installed' } });

    service.setRemoteAccess(true).subscribe();
    const post = http.expectOne('/api/admin/remote-access');
    expect(post.request.method).toBe('POST');
    expect(post.request.body).toEqual({ enabled: true });
    post.flush({ enabled: true, state: { kind: 'active', publicUrl: 'https://d.ts.net' } });
  });
});
