import { TestBed } from '@angular/core/testing';
import { PlaybackWsService } from './playback-ws.service';
import { ServerConfigService } from './server-config.service';
import * as platform from '../lib/platform';

// The REGISTER frame's `remoteEnabled` field used to be computed by an
// independent, ad-hoc copy of the TV-default logic that lived only in this
// file (`localStorage.getItem(...) === 'true'`) — so a fresh TV build's
// signal-level `RemotePlaybackService.remoteEnabled` read `true` while the
// WS payload this file sent still read `false`, and the server never listed
// the TV as a controllable device. These tests pin the REGISTER payload to
// the shared `resolveTvDefaultedPreference` helper so the two call sites
// can't drift apart again.
vi.mock('../lib/platform', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/platform')>();
  return {
    ...actual,
    isTvBuild: vi.fn().mockReturnValue(false),
  };
});

/** Minimal fake WebSocket that captures every sent frame and lets the test
 * trigger `onopen` manually, without touching the network. */
class FakeWebSocket {
  static OPEN = 1;
  static instances: FakeWebSocket[] = [];
  readyState = FakeWebSocket.OPEN;
  sent: unknown[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;

  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }

  close(): void {
    this.onclose?.();
  }
}

const storageStub = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, value: string) => {
      store[key] = value;
    },
    removeItem: (key: string) => {
      delete store[key];
    },
    clear: () => {
      store = {};
    },
    get length() {
      return Object.keys(store).length;
    },
    key: (i: number) => Object.keys(store)[i] ?? null,
  };
})();

Object.defineProperty(globalThis, 'localStorage', {
  value: storageStub,
  writable: true,
  configurable: true,
});

describe('PlaybackWsService REGISTER payload', () => {
  let originalWebSocket: unknown;

  beforeEach(() => {
    storageStub.clear();
    FakeWebSocket.instances = [];
    originalWebSocket = globalThis.WebSocket;
    (globalThis as { WebSocket: unknown }).WebSocket = FakeWebSocket;

    TestBed.configureTestingModule({
      providers: [PlaybackWsService, ServerConfigService],
    });
  });

  afterEach(() => {
    (globalThis as { WebSocket: unknown }).WebSocket = originalWebSocket;
    vi.mocked(platform.isTvBuild).mockReturnValue(false);
  });

  function connectAndCaptureRegister(): Record<string, unknown> {
    storageStub.setItem('nicotind_token', 'test-token');
    const service = TestBed.inject(PlaybackWsService);
    service.connect();
    const socket = FakeWebSocket.instances[0];
    socket.onopen?.();
    const registerFrame = socket.sent.find(
      (f): f is { type: string; payload: Record<string, unknown> } =>
        typeof f === 'object' && f !== null && (f as { type?: string }).type === 'REGISTER',
    );
    if (!registerFrame) throw new Error('REGISTER frame was not sent');
    return registerFrame.payload;
  }

  it('a TV registers as "NicotinD TV", not the UA-derived browser name (issue #393)', () => {
    // The UA default ("Chrome on Android") is what other devices see in the
    // cast device selector — meaningless for a television.
    document.documentElement.classList.add('tv-build');
    try {
      const payload = connectAndCaptureRegister();
      expect(payload['name']).toBe('NicotinD TV');
    } finally {
      document.documentElement.classList.remove('tv-build');
    }
  });

  it('a stored custom name still wins on a TV (explicit choice beats the default)', () => {
    document.documentElement.classList.add('tv-build');
    try {
      storageStub.setItem('nicotind_device_name', 'Living room');
      const payload = connectAndCaptureRegister();
      expect(payload['name']).toBe('Living room');
    } finally {
      document.documentElement.classList.remove('tv-build');
    }
  });

  it('sends remoteEnabled: false on a non-TV build with no stored preference', () => {
    vi.mocked(platform.isTvBuild).mockReturnValue(false);
    const payload = connectAndCaptureRegister();
    expect(payload['remoteEnabled']).toBe(false);
  });

  it('sends remoteEnabled: true on a TV build with no stored preference', () => {
    vi.mocked(platform.isTvBuild).mockReturnValue(true);
    const payload = connectAndCaptureRegister();
    expect(payload['remoteEnabled']).toBe(true);
  });

  it('an explicit stored "false" always wins over a TV-build default', () => {
    vi.mocked(platform.isTvBuild).mockReturnValue(true);
    storageStub.setItem('nicotind_remote_enabled', 'false');
    const payload = connectAndCaptureRegister();
    expect(payload['remoteEnabled']).toBe(false);
  });

  it('an explicit stored "true" wins on a non-TV build too', () => {
    vi.mocked(platform.isTvBuild).mockReturnValue(false);
    storageStub.setItem('nicotind_remote_enabled', 'true');
    const payload = connectAndCaptureRegister();
    expect(payload['remoteEnabled']).toBe(true);
  });
});
