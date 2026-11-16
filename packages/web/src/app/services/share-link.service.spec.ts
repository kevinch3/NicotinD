import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ShareLinkService, nativeShare } from './share-link.service';
import { ToastService } from './toast.service';
import { TranslateService } from './translate.service';

function setup() {
  const show = vi.fn();
  TestBed.configureTestingModule({
    providers: [
      provideHttpClient(),
      provideHttpClientTesting(),
      { provide: ToastService, useValue: { show } },
      { provide: TranslateService, useValue: { t: (k: string) => k } },
    ],
  });
  return {
    svc: TestBed.inject(ShareLinkService),
    http: TestBed.inject(HttpTestingController),
    show,
  };
}

describe('ShareLinkService', () => {
  const writeText = vi.fn(async () => {});
  beforeEach(() => {
    writeText.mockClear();
    writeText.mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  });

  it('asks for a link to the resource and copies it', async () => {
    const { svc, http, show } = setup();
    const done = svc.share('song', 's1', 'Opening Static', null);
    const req = http.expectOne('/api/share');
    expect(req.request.body).toEqual({ resourceType: 'song', resourceId: 's1' });
    req.flush({ url: 'https://host/share/abc' });
    await done;
    expect(writeText).toHaveBeenCalledWith('https://host/share/abc');
    expect(show).toHaveBeenCalledWith({ kind: 'success', message: 'share.copied' });
  });

  it('uses the share sheet when the device has one, and copies nothing', async () => {
    const { svc, http, show } = setup();
    const sheet = vi.fn(async () => {});
    const done = svc.share('song', 's1', 'Opening Static', sheet);
    http.expectOne('/api/share').flush({ url: 'https://host/share/abc' });
    await done;
    expect(sheet).toHaveBeenCalledWith({ title: 'Opening Static', url: 'https://host/share/abc' });
    expect(writeText).not.toHaveBeenCalled();
    expect(show).not.toHaveBeenCalled();
  });

  it('a dismissed share sheet is not an error', async () => {
    const { svc, http, show } = setup();
    const done = svc.share('song', 's1', 'T', async () => {
      throw new DOMException('cancelled', 'AbortError');
    });
    http.expectOne('/api/share').flush({ url: 'u' });
    await expect(done).resolves.toBeUndefined();
    expect(show).not.toHaveBeenCalled();
  });

  it('shows the link itself when the clipboard refuses', async () => {
    const { svc, http, show } = setup();
    writeText.mockRejectedValue(new Error('denied'));
    const done = svc.share('song', 's1', 'T', null);
    http.expectOne('/api/share').flush({ url: 'https://host/share/abc' });
    await done;
    expect(show).toHaveBeenCalledWith({ kind: 'info', message: 'https://host/share/abc' });
  });

  it('says so when the link could not be made', async () => {
    const { svc, http, show } = setup();
    const done = svc.share('song', 's1', 'T', null);
    http.expectOne('/api/share').flush('no', { status: 500, statusText: 'Server Error' });
    await done;
    expect(show).toHaveBeenCalledWith({ kind: 'error', message: 'share.failed' });
    expect(writeText).not.toHaveBeenCalled();
  });
});

describe('nativeShare', () => {
  const pointer = (coarse: boolean) =>
    vi.stubGlobal('matchMedia', () => ({ matches: coarse }) as MediaQueryList);
  afterEach(() => vi.unstubAllGlobals());

  it('is the share sheet on a touch device that has one', () => {
    pointer(true);
    expect(nativeShare({ share: async () => {} } as unknown as Navigator)).not.toBeNull();
  });

  it('is absent on a desktop, and on a touch device without the API', () => {
    pointer(false);
    expect(nativeShare({ share: async () => {} } as unknown as Navigator)).toBeNull();
    pointer(true);
    expect(nativeShare({} as Navigator)).toBeNull();
  });
});
