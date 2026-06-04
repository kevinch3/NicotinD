import { TestBed } from '@angular/core/testing';
import { HttpClient } from '@angular/common/http';
import { of } from 'rxjs';
import { vi } from 'vitest';
import { PluginService, type PluginInfo } from './plugin.service';

function plugin(over: Partial<PluginInfo>): PluginInfo {
  return {
    id: 'slskd',
    name: 'slskd',
    description: 'p2p',
    kind: 'acquisition',
    capabilities: ['search', 'download'],
    enabled: false,
    available: true,
    needsConfig: false,
    ...over,
  };
}

describe('PluginService', () => {
  const get = vi.fn();
  const post = vi.fn();
  const put = vi.fn();
  let svc: PluginService;

  beforeEach(() => {
    get.mockReset();
    post.mockReset();
    put.mockReset();
    get.mockReturnValue(of([]));
    post.mockReturnValue(of({ ok: true }));
    put.mockReturnValue(of({ ok: true }));
    TestBed.configureTestingModule({
      providers: [PluginService, { provide: HttpClient, useValue: { get, post, put } }],
    });
    svc = TestBed.inject(PluginService);
  });

  it('derives capability flags only from enabled plugins', async () => {
    get.mockReturnValue(
      of([
        plugin({ id: 'slskd', capabilities: ['search', 'download'], enabled: false }),
        plugin({ id: 'ytdlp', kind: 'acquisition', capabilities: ['resolve'], enabled: true }),
      ]),
    );
    await svc.refresh();
    expect(svc.hasResolve()).toBe(true); // ytdlp enabled
    expect(svc.hasSearch()).toBe(false); // slskd disabled
    expect(svc.hasDownload()).toBe(false);
  });

  it('groups plugins by kind', async () => {
    get.mockReturnValue(
      of([
        plugin({ id: 'slskd', kind: 'acquisition' }),
        plugin({ id: 'tailscale', kind: 'connectivity', capabilities: ['connectivity'] }),
      ]),
    );
    await svc.refresh();
    expect(svc.acquisition().map((p) => p.id)).toEqual(['slskd']);
    expect(svc.connectivity().map((p) => p.id)).toEqual(['tailscale']);
  });

  it('enable posts the consent flag and refreshes', async () => {
    await svc.enable('slskd', true);
    expect(post).toHaveBeenCalledWith('/api/plugins/slskd/enable', { consent: true });
    expect(get).toHaveBeenCalled();
  });

  it('disable posts and refreshes', async () => {
    await svc.disable('slskd');
    expect(post).toHaveBeenCalledWith('/api/plugins/slskd/disable', {});
  });
});
