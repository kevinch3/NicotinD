/**
 * Singleton WebSocket client for remote playback synchronization.
 * Handles connection, reconnection, device registration, and message routing.
 */

type MessageHandler<T = any> = (payload: T) => void;

class PlaybackWSClient {
  private ws: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private handlers = new Map<string, MessageHandler<any>[]>();
  private deviceId: string;
  private deviceName: string;
  private url: string = '';

  constructor() {
    this.deviceId = this.resolveDeviceId();
    this.deviceName = this.resolveDeviceName();
  }

  private resolveDeviceId(): string {
    const stored = localStorage.getItem('nicotind_device_id');
    if (stored) return stored;
    
    let id: string;
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      id = crypto.randomUUID();
    } else {
      // Fallback for non-secure contexts (HTTP with custom hostname)
      id = Array.from({ length: 16 }, () => 
        Math.floor(Math.random() * 256).toString(16).padStart(2, '0')
      ).join('') + '-' + Date.now().toString(36);
    }
    
    localStorage.setItem('nicotind_device_id', id);
    return id;
  }

  private resolveDeviceName(): string {
    const stored = localStorage.getItem('nicotind_device_name');
    if (stored) return stored;
    const ua = navigator.userAgent;
    const name = ua.includes('Mobile') ? '📱 Mobile' : '🖥️ Desktop';
    localStorage.setItem('nicotind_device_name', name);
    return name;
  }

  getDeviceId() { return this.deviceId; }
  getDeviceName() { return this.deviceName; }

  setDeviceName(name: string) {
    this.deviceName = name;
    localStorage.setItem('nicotind_device_name', name);
  }

  connect() {
    const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
    this.url = `${protocol}://${window.location.host}/api/ws/playback`;

    if (this.ws && this.ws.readyState === WebSocket.OPEN) return;
    this.ws = new WebSocket(this.url);

    this.ws.onopen = () => {
      this.send({ type: 'REGISTER', payload: { id: this.deviceId, name: this.deviceName, deviceType: 'web' } });
    };

    this.ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (typeof data === 'object' && data !== null && 'type' in data && 'payload' in data) {
          const handlers = this.handlers.get(String(data.type)) ?? [];
          handlers.forEach(h => h(data.payload));
        }
      } catch { /* ignore */ }
    };

    this.ws.onclose = () => {
      // Reconnect after 3s
      this.reconnectTimer = setTimeout(() => this.connect(), 3000);
    };
  }

  disconnect() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
    this.ws = null;
  }

  send(msg: object) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  on<T = any>(type: string, handler: MessageHandler<T>) {
    const existing = this.handlers.get(type) ?? [];
    this.handlers.set(type, [...existing, handler]);
    return () => {
      this.handlers.set(type, (this.handlers.get(type) ?? []).filter(h => h !== handler));
    };
  }

  sendCommand(action: string, extra?: Record<string, unknown>) {
    this.send({ type: 'COMMAND', payload: { action, ...extra } });
  }

  sendStateUpdate(state: Partial<Record<string, unknown>>) {
    this.send({ type: 'STATE_UPDATE', payload: { state } });
  }

  setActiveDevice(id: string) {
    this.send({ type: 'SET_ACTIVE_DEVICE', payload: { id } });
  }
}

export const wsClient = new PlaybackWSClient();
