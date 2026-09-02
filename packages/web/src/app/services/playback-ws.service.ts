/**
 * Angular service wrapping a raw WebSocket for remote playback synchronization.
 * Handles connection, reconnection with exponential backoff, device registration,
 * heartbeat, and message routing via RxJS Observables.
 */
import { Injectable, inject, signal } from '@angular/core';
import { Subject, Observable } from 'rxjs';
import { filter, map } from 'rxjs/operators';
import { ServerConfigService } from './server-config.service';
import { isTvBuild, isTvUi, resolveTvDefaultedPreference } from '../lib/platform';
import { deviceIdFor, profileIdOf, resolveDeviceId, TAB_ID_KEY } from '../lib/device-id';
import { guardTabId, TAB_CHANNEL } from '../lib/tab-id-guard';

interface WsMessage {
  type: string;
  payload: unknown;
}

const HEARTBEAT_INTERVAL_MS = 30_000;

@Injectable({ providedIn: 'root' })
export class PlaybackWsService {
  private server = inject(ServerConfigService);
  private ws: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectDelay = 1000;
  private consecutiveFailures = 0;
  /** Beats sent since the last HEARTBEAT_ACK — the half-open socket detector. */
  private unansweredBeats = 0;
  readonly persistentFailure = signal<string | null>(null);

  private readonly messageSubject = new Subject<WsMessage>();

  private deviceId: string;
  private deviceName: string;

  constructor() {
    this.deviceId = resolveDeviceId(localStorage, sessionStorage);
    this.deviceName = this.resolveDeviceName();
    this.guardTabIdentity();
  }

  /** "Duplicate tab" copies sessionStorage, so the copy boots holding this
   *  tab's id. The newcomer re-mints and re-registers; the original keeps its
   *  id and any cast pointed at it (issue #882). */
  private guardTabIdentity(): void {
    if (typeof BroadcastChannel !== 'function') return;
    guardTabId({
      channel: new BroadcastChannel(TAB_CHANNEL),
      tabId: sessionStorage.getItem(TAB_ID_KEY) ?? '',
      persist: (id) => sessionStorage.setItem(TAB_ID_KEY, id),
      onRemint: (id) => {
        this.deviceId = deviceIdFor(profileIdOf(this.deviceId), id);
        if (!this.ws) return;
        this.disconnect();
        this.connect();
      },
    });
  }

  // ---------------------------------------------------------------------------
  // Device identity
  // ---------------------------------------------------------------------------

  private resolveDeviceName(): string {
    const stored = localStorage.getItem('nicotind_device_name');
    if (stored) {
      const stripped = stored.replace(/^📱\s*/, '').replace(/^🖥️\s*/, '');
      if (stripped === 'Mobile' || stripped === 'Desktop') {
        localStorage.removeItem('nicotind_device_name');
      } else {
        if (stripped !== stored) localStorage.setItem('nicotind_device_name', stripped);
        return stripped;
      }
    }
    const name = this.detectDeviceName();
    localStorage.setItem('nicotind_device_name', name);
    return name;
  }

  private detectDeviceName(): string {
    // The UA on a TV says "Chrome on Android" — meaningless in the cast
    // device selector other devices see (issue #393).
    if (isTvUi()) return 'NicotinD TV';

    const ua = navigator.userAgent;

    let device: string;
    if (/iPhone/.test(ua)) device = 'iPhone';
    else if (/iPad/.test(ua)) device = 'iPad';
    else if (/Android/.test(ua) && /Mobile/.test(ua)) device = 'Android';
    else if (/Android/.test(ua)) device = 'Android Tablet';
    else if (/Windows/.test(ua)) device = 'Windows';
    else if (/Macintosh|Mac OS X/.test(ua)) device = 'Mac';
    else if (/CrOS/.test(ua)) device = 'ChromeOS';
    else if (/Linux/.test(ua)) device = 'Linux';
    else device = 'Device';

    let browser: string;
    if (/SamsungBrowser/.test(ua)) browser = 'Samsung Internet';
    else if (/Edg\//.test(ua)) browser = 'Edge';
    else if (/OPR\//.test(ua)) browser = 'Opera';
    else if (/Firefox\//.test(ua)) browser = 'Firefox';
    else if (/Chrome\//.test(ua)) browser = 'Chrome';
    else if (/Version\/.*Safari/.test(ua)) browser = 'Safari';
    else browser = 'Browser';

    return `${browser} on ${device}`;
  }

  getDeviceId(): string {
    return this.deviceId;
  }

  getDeviceName(): string {
    return this.deviceName;
  }

  setDeviceName(name: string): void {
    this.deviceName = name;
    localStorage.setItem('nicotind_device_name', name);
  }

  // ---------------------------------------------------------------------------
  // Observable-based message stream
  // ---------------------------------------------------------------------------

  /**
   * Returns an Observable that emits payloads for a given message type.
   * Replaces the React version's `on(type, handler)` pattern.
   */
  messages<T = unknown>(type: string): Observable<T> {
    return this.messageSubject.asObservable().pipe(
      filter((msg) => msg.type === type),
      map((msg) => msg.payload as T),
    );
  }

  // ---------------------------------------------------------------------------
  // Connection lifecycle
  // ---------------------------------------------------------------------------

  connect(): void {
    const token = localStorage.getItem('nicotind_token');
    if (!token) return;

    // CONNECTING counts as connected: the boot-time token refresh re-runs the
    // connect effect within milliseconds of the first connect, and a second
    // socket would register the same device twice (#877).
    const state = this.ws?.readyState;
    if (state === WebSocket.CONNECTING || state === WebSocket.OPEN) return;

    const url = this.server.wsUrl(`/api/ws/playback?token=${encodeURIComponent(token)}`);
    const socket = new WebSocket(url);
    this.ws = socket;
    let opened = false;

    // Every handler closes over ITS socket and checks it is still the live
    // one: after `disconnect()` (or a superseded connect) the old socket's
    // late `close` used to schedule a reconnect, count as a failure and clear
    // the live socket's heartbeat (#877).
    socket.onopen = () => {
      if (socket !== this.ws) return;
      opened = true;
      this.consecutiveFailures = 0;
      this.persistentFailure.set(null);
      this.reconnectDelay = 1000;
      this.send({
        type: 'REGISTER',
        payload: {
          id: this.deviceId,
          name: this.deviceName,
          deviceType: 'web',
          remoteEnabled: resolveTvDefaultedPreference(
            localStorage.getItem('nicotind_remote_enabled'),
            isTvBuild(),
          ),
        },
      });
      this.startHeartbeat(socket);
    };

    socket.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (typeof data === 'object' && data !== null && 'type' in data && 'payload' in data) {
          if (data.type === 'HEARTBEAT_ACK') this.unansweredBeats = 0;
          this.messageSubject.next({ type: String(data.type), payload: data.payload });
        }
      } catch {
        /* ignore malformed frames */
      }
    };

    socket.onerror = () => {
      // Force close so onclose fires and triggers reconnect
      socket.close();
    };

    socket.onclose = () => {
      if (socket !== this.ws) return;
      this.ws = null;
      this.stopHeartbeat();
      if (!opened) {
        this.consecutiveFailures++;
        if (this.consecutiveFailures >= 5) {
          this.persistentFailure.set(
            'Connection failed — remote playback may be unavailable in this environment',
          );
          return; // stop reconnecting
        }
      }
      if (localStorage.getItem('nicotind_token')) {
        this.reconnectTimer = setTimeout(() => this.connect(), this.reconnectDelay);
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30_000);
      }
    };
  }

  /** A beat every 30s, each answered by HEARTBEAT_ACK. A beat still
   *  unanswered when the next one is due means the socket is half-open (a
   *  proxy or Wi-Fi dropped the TCP path without telling us): close it so the
   *  normal reconnect takes over, instead of reporting into the void until
   *  TCP gives up minutes later (#877). */
  private startHeartbeat(socket: WebSocket): void {
    this.stopHeartbeat();
    this.unansweredBeats = 0;
    this.heartbeatTimer = setInterval(() => {
      if (this.unansweredBeats > 0) {
        this.unansweredBeats = 0;
        socket.close();
        return;
      }
      this.unansweredBeats++;
      this.send({ type: 'HEARTBEAT', payload: {} });
    }, HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  disconnect(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.stopHeartbeat();
    // Detach before closing: the socket's own `close` handler then sees it is
    // no longer the live socket and neither reconnects nor counts a failure.
    const socket = this.ws;
    this.ws = null;
    socket?.close();
    this.consecutiveFailures = 0;
    this.persistentFailure.set(null);
  }

  // ---------------------------------------------------------------------------
  // Send helpers
  // ---------------------------------------------------------------------------

  send(msg: object): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  sendProgressReport(position: number, duration: number): void {
    this.send({ type: 'PROGRESS_REPORT', payload: { position, duration } });
  }

  sendCommand(action: string, extra?: Record<string, unknown>): void {
    this.send({ type: 'COMMAND', payload: { action, ...extra } });
  }

  sendStateUpdate(state: Partial<Record<string, unknown>>): void {
    this.send({ type: 'STATE_UPDATE', payload: { state } });
  }

  setActiveDevice(id: string): void {
    this.send({ type: 'SET_ACTIVE_DEVICE', payload: { id } });
  }

  updateDevice(fields: { remoteEnabled?: boolean; name?: string }): void {
    this.send({ type: 'UPDATE_DEVICE', payload: fields });
  }

  clearPersistentFailure(): void {
    this.persistentFailure.set(null);
    this.consecutiveFailures = 0;
  }
}
