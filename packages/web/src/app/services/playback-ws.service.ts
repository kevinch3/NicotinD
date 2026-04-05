/**
 * Angular service wrapping a raw WebSocket for remote playback synchronization.
 * Handles connection, reconnection with exponential backoff, device registration,
 * heartbeat, and message routing via RxJS Observables.
 */
import { Injectable } from '@angular/core';
import { Subject, Observable } from 'rxjs';
import { filter, map } from 'rxjs/operators';

interface WsMessage {
  type: string;
  payload: unknown;
}

@Injectable({ providedIn: 'root' })
export class PlaybackWsService {
  private ws: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectDelay = 1000;

  private readonly messageSubject = new Subject<WsMessage>();

  private deviceId: string;
  private deviceName: string;

  constructor() {
    this.deviceId = this.resolveDeviceId();
    this.deviceName = this.resolveDeviceName();
  }

  // ---------------------------------------------------------------------------
  // Device identity
  // ---------------------------------------------------------------------------

  private resolveDeviceId(): string {
    const stored = localStorage.getItem('nicotind_device_id');
    if (stored) return stored;

    let id: string;
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      id = crypto.randomUUID();
    } else {
      id =
        Array.from({ length: 16 }, () =>
          Math.floor(Math.random() * 256)
            .toString(16)
            .padStart(2, '0'),
        ).join('') +
        '-' +
        Date.now().toString(36);
    }

    localStorage.setItem('nicotind_device_id', id);
    return id;
  }

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

    const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const url = `${protocol}://${window.location.host}/api/ws/playback?token=${encodeURIComponent(token)}`;

    if (this.ws && this.ws.readyState === WebSocket.OPEN) return;
    this.ws = new WebSocket(url);

    this.ws.onopen = () => {
      this.reconnectDelay = 1000;
      this.send({
        type: 'REGISTER',
        payload: {
          id: this.deviceId,
          name: this.deviceName,
          deviceType: 'web',
          remoteEnabled: localStorage.getItem('nicotind_remote_enabled') === 'true',
        },
      });
      this.heartbeatTimer = setInterval(() => {
        this.send({ type: 'HEARTBEAT', payload: {} });
      }, 30_000);
    };

    this.ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (typeof data === 'object' && data !== null && 'type' in data && 'payload' in data) {
          this.messageSubject.next({ type: String(data.type), payload: data.payload });
        }
      } catch {
        /* ignore malformed frames */
      }
    };

    this.ws.onerror = () => {
      // Force close so onclose fires and triggers reconnect
      this.ws?.close();
    };

    this.ws.onclose = () => {
      if (this.heartbeatTimer) {
        clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = null;
      }
      // Only reconnect if we still have a token
      if (localStorage.getItem('nicotind_token')) {
        this.reconnectTimer = setTimeout(() => this.connect(), this.reconnectDelay);
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30_000);
      }
    };
  }

  disconnect(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.ws?.close();
    this.ws = null;
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
}
