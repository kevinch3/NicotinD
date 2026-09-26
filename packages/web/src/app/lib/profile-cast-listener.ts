/**
 * One stored-but-inactive person's line to the server on a shared TV (#1406).
 *
 * It registers the TV's OWN device id under that person's token — the server's
 * registry is per user, so the same id under several people never collides —
 * which puts "NicotinD TV" in that person's phone picker. It tracks only the
 * session's `activeDeviceId`: this device becoming the output is a cast, and
 * the owner switches the TV to that person. It never plays anything itself;
 * after the switch the main socket re-registers as that person and the server's
 * reply carries the cast track.
 *
 * The first STATE_SYNC carrying `devices` after each open is the registration
 * echo. It seeds the state and is never a cast: a session that named this TV
 * before a reboot must not switch profiles on its own. An echo that names this
 * device is stale — the listener owns no audio — so it releases the output
 * (`releaseStaleOutput`), which ends that person's session on the server.
 */

export interface ListenerRegistration {
  id: string;
  name: string;
  remoteEnabled: boolean;
  activated: boolean;
}

export interface ProfileCastListenerOptions {
  url: string;
  registration: () => ListenerRegistration;
  onCast: () => void;
  /** Five closes in a row without an open: the token may be dead, or the
   *  server unreachable — the owner tells the two apart. */
  onRefused: () => void;
  /** Whether a registration echo naming this device may release the output.
   *  Default true; false for the person the TV is switching TO, whose fresh
   *  cast the echo may be describing. */
  releaseStaleOutput?: () => boolean;
  createSocket?: (url: string) => WebSocket;
}

export const LISTENER_MAX_FAILURES = 5;
const HEARTBEAT_MS = 30_000;
const MAX_DELAY_MS = 30_000;

export class ProfileCastListener {
  private socket: WebSocket | null = null;
  private stopped = false;
  private failures = 0;
  private delay = 1_000;
  private seeded = false;
  private unansweredBeats = 0;
  private activeDeviceId: string | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private reconnect: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly opts: ProfileCastListenerOptions) {}

  start(): void {
    this.stopped = false;
    this.failures = 0;
    this.delay = 1_000;
    this.open();
  }

  stop(): void {
    this.stopped = true;
    this.clearTimers();
    const s = this.socket;
    this.socket = null;
    s?.close();
  }

  update(fields: Partial<Pick<ListenerRegistration, 'activated' | 'remoteEnabled'>>): void {
    this.send({ type: 'UPDATE_DEVICE', payload: fields });
  }

  private open(): void {
    const create = this.opts.createSocket ?? ((url: string) => new WebSocket(url));
    const socket = create(this.opts.url);
    this.socket = socket;
    let opened = false;

    socket.onopen = () => {
      if (socket !== this.socket) return;
      opened = true;
      this.failures = 0;
      this.delay = 1_000;
      this.seeded = false;
      const r = this.opts.registration();
      this.send({
        type: 'REGISTER',
        payload: {
          id: r.id,
          name: r.name,
          deviceType: 'web',
          remoteEnabled: r.remoteEnabled,
          activated: r.activated,
          compactProgress: true,
        },
      });
      // A beat still unanswered when the next is due means a half-open
      // socket: close it and let the normal reconnect take over.
      this.unansweredBeats = 0;
      this.heartbeat = setInterval(() => {
        if (this.unansweredBeats > 0) {
          this.unansweredBeats = 0;
          socket.close();
          return;
        }
        this.unansweredBeats++;
        this.send({ type: 'HEARTBEAT', payload: {} });
      }, HEARTBEAT_MS);
    };

    socket.onmessage = (event: MessageEvent) => {
      if (socket !== this.socket) return;
      let msg: { type?: unknown; payload?: unknown };
      try {
        msg = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (msg.type === 'HEARTBEAT_ACK') {
        this.unansweredBeats = 0;
        return;
      }
      if (msg.type !== 'STATE_SYNC' || typeof msg.payload !== 'object' || msg.payload === null)
        return;
      const payload = msg.payload as {
        state?: { activeDeviceId?: string | null };
        devices?: unknown;
      };
      const next = payload.state?.activeDeviceId;
      const myId = this.opts.registration().id;
      if (!this.seeded) {
        if (payload.devices === undefined) return;
        this.seeded = true;
        if (next !== undefined) this.activeDeviceId = next;
        if (next === myId && (this.opts.releaseStaleOutput?.() ?? true)) {
          this.send({ type: 'RELEASE_OUTPUT', payload: {} });
        }
        return;
      }
      if (next === undefined) return;
      const becameOutput = this.activeDeviceId !== myId && next === myId;
      this.activeDeviceId = next;
      if (becameOutput) this.opts.onCast();
    };

    socket.onerror = () => socket.close();

    socket.onclose = () => {
      if (socket !== this.socket) return;
      this.socket = null;
      this.clearTimers();
      if (this.stopped) return;
      if (!opened && ++this.failures >= LISTENER_MAX_FAILURES) {
        this.stopped = true;
        this.opts.onRefused();
        return;
      }
      this.reconnect = setTimeout(() => this.open(), this.delay);
      this.delay = Math.min(this.delay * 2, MAX_DELAY_MS);
    };
  }

  private send(msg: unknown): void {
    if (this.socket?.readyState === 1) this.socket.send(JSON.stringify(msg));
  }

  private clearTimers(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.reconnect) clearTimeout(this.reconnect);
    this.heartbeat = null;
    this.reconnect = null;
  }
}
