/**
 * PresenceService — in-memory, ephemeral registry of who is currently active.
 *
 * Admin-only visibility feature: tracks per-user connection state via lightweight
 * 60s HTTP heartbeats (see routes/presence.ts). Deliberately NOT persisted — presence
 * is high-churn and correct-on-restart only if it resets when the server (and thus all
 * client sessions) restart. Follows the `playbackRegistry` module-level-singleton
 * precedent (services/playback-registry.ts).
 *
 * See docs/presence-tracking.md for the full design rationale.
 */

/** A single browser tab / app instance reporting presence. */
interface Session {
  userId: string;
  deviceId: string;
  tabId: string;
  lastSeen: number; // Date.now()
}

/** Aggregated presence for one user, merged into the admin user list. */
export interface UserPresence {
  isConnected: boolean;
  amountOfDevices: number;
  amountOfSessions: number;
}

/** A session is evicted once it hasn't reported in this long (2 missed 60s heartbeats). */
const STALE_TIMEOUT = 120_000;
/** How often the stale-eviction sweep runs. */
const CLEANUP_INTERVAL = 60_000;

export class PresenceService {
  // key = `${userId}:${deviceId}:${tabId}`
  private sessions = new Map<string, Session>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.cleanupTimer = setInterval(() => this.cleanupStale(), CLEANUP_INTERVAL);
    // Don't keep the process alive solely for presence cleanup (mirrors idle-timer intent).
    this.cleanupTimer.unref?.();
  }

  private static keyFor(userId: string, deviceId: string, tabId: string): string {
    return `${userId}:${deviceId}:${tabId}`;
  }

  /** Upsert a session and refresh its lastSeen. Called on every heartbeat. */
  heartbeat(userId: string, deviceId: string, tabId: string): void {
    const key = PresenceService.keyFor(userId, deviceId, tabId);
    this.sessions.set(key, { userId, deviceId, tabId, lastSeen: Date.now() });
  }

  /** Delete a specific session by its composite key. */
  removeSession(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  /** Aggregate presence for one user. Absent users read as offline / zero. */
  getUserPresence(userId: string): UserPresence {
    const devices = new Set<string>();
    let amountOfSessions = 0;
    for (const s of this.sessions.values()) {
      if (s.userId !== userId) continue;
      devices.add(s.deviceId);
      amountOfSessions++;
    }
    return {
      isConnected: amountOfSessions > 0,
      amountOfDevices: devices.size,
      amountOfSessions,
    };
  }

  /** Aggregated presence for every user with at least one active session. */
  getActiveUsers(): Map<string, UserPresence> {
    // Group sessions by user, counting distinct devices and total sessions in one pass.
    const byUser = new Map<string, { devices: Set<string>; sessions: number }>();
    for (const s of this.sessions.values()) {
      let agg = byUser.get(s.userId);
      if (!agg) {
        agg = { devices: new Set(), sessions: 0 };
        byUser.set(s.userId, agg);
      }
      agg.devices.add(s.deviceId);
      agg.sessions++;
    }

    const result = new Map<string, UserPresence>();
    for (const [userId, agg] of byUser) {
      result.set(userId, {
        isConnected: true,
        amountOfDevices: agg.devices.size,
        amountOfSessions: agg.sessions,
      });
    }
    return result;
  }

  /** Evict sessions that haven't reported within STALE_TIMEOUT. Public for direct testing. */
  cleanupStale(): void {
    const cutoff = Date.now() - STALE_TIMEOUT;
    for (const [key, session] of this.sessions) {
      if (session.lastSeen < cutoff) this.sessions.delete(key);
    }
  }

  /** Stop the cleanup timer — for test teardown. */
  stop(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }
}

/** Module-level singleton (mirrors `playbackRegistry`). */
export const presenceService = new PresenceService();
