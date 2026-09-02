import { TestBed } from '@angular/core/testing';
import { PlaybackWsService } from './playback-ws.service';
import { ServerConfigService } from './server-config.service';
import * as platform from '../lib/platform';
import { profileIdOf, TAB_ID_KEY } from '../lib/device-id';
import { TAB_CHANNEL } from '../lib/tab-id-guard';

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
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 3;
  static instances: FakeWebSocket[] = [];
  readyState = FakeWebSocket.CONNECTING;
  sent: unknown[] = [];
  closed = false;
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

  /** The browser fires `close` asynchronously, after the handshake — a stale
   *  socket's close can land after a newer socket opened. Tests fire it. */
  close(): void {
    this.closed = true;
    this.readyState = FakeWebSocket.CLOSED;
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  emitClose(): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.();
  }

  receive(frame: object): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }

  frames(type: string): unknown[] {
    return this.sent.filter((f) => (f as { type?: string }).type === type);
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

/** `sessionStorage` is per-TAB: the two-tab tests swap it while leaving
 *  `localStorage` (the shared profile) in place. */
function freshSessionStorage() {
  let store: Record<string, string> = {};
  const stub = {
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
  Object.defineProperty(globalThis, 'sessionStorage', {
    value: stub,
    writable: true,
    configurable: true,
  });
  return stub;
}
freshSessionStorage();

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
    socket.open();
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

describe('PlaybackWsService device identity across tabs (#882)', () => {
  let originalWebSocket: unknown;

  beforeEach(() => {
    storageStub.clear();
    FakeWebSocket.instances = [];
    originalWebSocket = globalThis.WebSocket;
    (globalThis as { WebSocket: unknown }).WebSocket = FakeWebSocket;
  });

  afterEach(() => {
    (globalThis as { WebSocket: unknown }).WebSocket = originalWebSocket;
  });

  /** One tab: a fresh sessionStorage, the SHARED localStorage, a new service. */
  function openTab(): string {
    freshSessionStorage();
    storageStub.setItem('nicotind_token', 'test-token');
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ providers: [PlaybackWsService, ServerConfigService] });
    const service = TestBed.inject(PlaybackWsService);
    service.connect();
    const socket = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
    socket.open();
    const register = socket.sent.find(
      (f): f is { type: string; payload: Record<string, unknown> } =>
        (f as { type?: string }).type === 'REGISTER',
    );
    if (!register) throw new Error('REGISTER frame was not sent');
    return register.payload['id'] as string;
  }

  it('two tabs of one browser register as two devices', () => {
    expect(openTab()).not.toBe(openTab());
  });

  it('both tabs share the profile id, so the UI can tell siblings from strangers', () => {
    expect(profileIdOf(openTab())).toBe(profileIdOf(openTab()));
  });

  it('a tab told its id is taken re-registers under a fresh one (duplicated tab)', async () => {
    const first = openTab();
    const twin = new BroadcastChannel(TAB_CHANNEL);
    try {
      // What a sibling holding this tab id replies to the newcomer's claim.
      twin.postMessage({ kind: 'taken', tabId: sessionStorage.getItem(TAB_ID_KEY) });
      await new Promise((r) => setTimeout(r, 0));

      const socket = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
      socket.open();
      const ids = socket
        .frames('REGISTER')
        .map((f) => (f as { payload: { id: string } }).payload.id);
      expect(ids.at(-1)).not.toBe(first);
      expect(profileIdOf(ids.at(-1)!)).toBe(profileIdOf(first));
    } finally {
      twin.close();
    }
  });

  it('an id minted before #882 becomes the profile half, keeping the stored name', () => {
    storageStub.setItem('nicotind_device_id', 'legacy-uuid');
    expect(profileIdOf(openTab())).toBe('legacy-uuid');
  });
});

describe('PlaybackWsService connection lifecycle (#877)', () => {
  let originalWebSocket: unknown;
  let service: PlaybackWsService;

  beforeEach(() => {
    vi.useFakeTimers();
    storageStub.clear();
    storageStub.setItem('nicotind_token', 'test-token');
    FakeWebSocket.instances = [];
    originalWebSocket = globalThis.WebSocket;
    (globalThis as { WebSocket: unknown }).WebSocket = FakeWebSocket;
    TestBed.configureTestingModule({ providers: [PlaybackWsService, ServerConfigService] });
    service = TestBed.inject(PlaybackWsService);
  });

  afterEach(() => {
    (globalThis as { WebSocket: unknown }).WebSocket = originalWebSocket;
    vi.useRealTimers();
  });

  it('connect() while a socket is still connecting does not open a second one', () => {
    // The boot-time token refresh re-runs the connect effect within ms of the
    // first connect; two sockets would register the same device twice.
    service.connect();
    service.connect();
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it('disconnect() does not schedule a reconnect', () => {
    service.connect();
    FakeWebSocket.instances[0].open();
    service.disconnect();
    FakeWebSocket.instances[0].emitClose();
    vi.advanceTimersByTime(60_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it('a deliberate disconnect is not a connection failure', () => {
    for (let i = 0; i < 6; i++) {
      service.connect();
      const socket = FakeWebSocket.instances.at(-1)!;
      socket.open();
      service.disconnect();
      socket.emitClose();
    }
    expect(service.persistentFailure()).toBeNull();
  });

  it("a stale socket's late close does not stop the live socket's heartbeat", () => {
    service.connect();
    const stale = FakeWebSocket.instances[0];
    service.disconnect(); // never opened; its close lands later
    service.connect();
    const live = FakeWebSocket.instances[1];
    live.open();
    stale.emitClose();
    vi.advanceTimersByTime(30_000);
    expect(live.frames('HEARTBEAT')).toHaveLength(1);
    expect(live.closed).toBe(false);
  });

  it('two unacknowledged heartbeats close the socket so it reconnects', () => {
    // A half-open socket (proxy or Wi-Fi dropped the TCP path silently) never
    // errors client-side; without an ack watchdog the receiver keeps reporting
    // into the void until TCP gives up, minutes later.
    service.connect();
    const socket = FakeWebSocket.instances[0];
    socket.open();
    vi.advanceTimersByTime(30_000);
    expect(socket.closed).toBe(false);
    vi.advanceTimersByTime(30_000);
    expect(socket.closed).toBe(true);
    socket.emitClose();
    vi.advanceTimersByTime(1_000);
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it('an acknowledged heartbeat keeps the socket open', () => {
    service.connect();
    const socket = FakeWebSocket.instances[0];
    socket.open();
    for (let i = 0; i < 4; i++) {
      vi.advanceTimersByTime(30_000);
      socket.receive({ type: 'HEARTBEAT_ACK', payload: {} });
    }
    expect(socket.closed).toBe(false);
    expect(socket.frames('HEARTBEAT')).toHaveLength(4);
  });
});
