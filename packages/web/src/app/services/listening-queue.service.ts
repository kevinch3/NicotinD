import { Injectable, effect, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { ServerConfigService } from './server-config.service';
import { NetworkStatusService } from './network-status.service';

/** One finished playback session, as reported to the server. Raw facts only —
 *  whether it *counts* as a play is the server's call (services/play-history.ts). */
export interface PlayEventPayload {
  clientEventId: string;
  songId: string;
  startedAt: number;
  msPlayed: number;
  durationMs: number | null;
  reason: 'ended' | 'skipped' | 'replaced' | 'stopped';
  source: string | null;
  device: string | null;
  title: string | null;
  artist: string | null;
  album: string | null;
}

const STORAGE_KEY = 'nicotind-play-queue';
/** Bounded so a long offline stretch can't grow localStorage without limit.
 *  ~200 events ≈ 13 hours of listening; older ones are dropped oldest-first. */
const MAX_BUFFERED = 200;

/**
 * Durable outbox for listening events.
 *
 * Events are buffered to `localStorage` *before* any network attempt, so a
 * reload, a crash, or a whole offline listening session is never lost — the
 * whole point of tracking history is that it is complete. The server dedupes on
 * `clientEventId`, so retrying a flush that actually succeeded but whose
 * response we never saw is safe.
 *
 * Flushes on three triggers: a session ending, the page going hidden (the last
 * moment we reliably get on mobile), and a device reconnect. The reconnect
 * trigger reads `NetworkStatusService.reconnects` — a monotonic counter rather
 * than a diff on `online`, because signals coalesce a fast offline/online pair
 * into a single flush with no visible transition.
 *
 * See docs/listening-history.md.
 */
@Injectable({ providedIn: 'root' })
export class ListeningQueueService {
  private http = inject(HttpClient);
  private server = inject(ServerConfigService);
  private network = inject(NetworkStatusService);

  private flushing = false;

  /**
   * Set when the server reports collection is off (issue #454). In-memory and
   * reset on reload: the point is to stop buffering and POSTing events that
   * will only be refused, not to cache a policy decision. `resetConsentState`
   * clears it the moment the user turns collection back on.
   */
  private readonly collectionDisabled = signal(false);

  constructor() {
    // Reconnect → drain whatever accumulated while offline.
    effect(() => {
      this.network.reconnects();
      void this.flush();
    });

    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') void this.flush();
      });
    }
  }

  /** Called when the user re-enables collection, so reporting resumes at once. */
  resetConsentState(): void {
    this.collectionDisabled.set(false);
  }

  /** Buffer an event durably, then try to send. */
  enqueue(event: PlayEventPayload): void {
    // The server refused last time — don't accumulate what it will refuse again.
    if (this.collectionDisabled()) return;
    const buffered = [...this.read(), event];
    this.write(buffered.slice(-MAX_BUFFERED));
    void this.flush();
  }

  /**
   * Send everything buffered. Non-throwing: a failure leaves the buffer intact
   * for the next trigger, because losing history is worse than a retry.
   */
  async flush(): Promise<void> {
    if (this.flushing) return;
    const events = this.read();
    if (events.length === 0) return;
    if (!this.network.online()) return;

    this.flushing = true;
    try {
      const res = (await firstValueFrom(
        this.http.post(this.server.apiUrl('/api/history/plays'), { events }),
      )) as { collection?: { enabled: boolean } } | null;
      // Drop exactly what we sent — anything enqueued mid-flight survives.
      // A refusal counts as sent: retrying rejected events forever is worse
      // than losing history the user asked us not to keep.
      const sent = new Set(events.map((e) => e.clientEventId));
      this.write(this.read().filter((e) => !sent.has(e.clientEventId)));
      if (res?.collection?.enabled === false) this.collectionDisabled.set(true);
    } catch {
      // Keep the buffer; the next enqueue/hidden/reconnect retries it.
    } finally {
      this.flushing = false;
    }
  }

  /** Buffered-but-unsent count. Exposed for tests and diagnostics. */
  pendingCount(): number {
    return this.read().length;
  }

  private read(): PlayEventPayload[] {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      const parsed: unknown = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? (parsed as PlayEventPayload[]) : [];
    } catch {
      // Corrupt or unavailable storage must not break playback.
      return [];
    }
  }

  private write(events: PlayEventPayload[]): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(events));
    } catch {
      // Quota or private-mode failure — history is best-effort, playback is not.
    }
  }
}
