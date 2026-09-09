import { PlaybackStateManager } from './playback-state.js';

/** How long a session survives its output's socket going away, overridable
 *  so a test server can shorten it: a browser context torn down by a test
 *  runner fires no `pagehide`, and every spec would otherwise inherit the
 *  previous spec's session for the full grace. */
function activeGraceMs(): number | undefined {
  const raw = process.env['NICOTIND_PLAYBACK_GRACE_MS'];
  const ms = raw === undefined ? NaN : Number(raw);
  return Number.isFinite(ms) && ms >= 0 ? ms : undefined;
}

class PlaybackManagerRegistry {
  private managers = new Map<string, PlaybackStateManager>();

  getOrCreate(userId: string): PlaybackStateManager {
    let manager = this.managers.get(userId);
    if (!manager) {
      manager = new PlaybackStateManager({ activeGraceMs: activeGraceMs() });
      this.managers.set(userId, manager);
    }
    return manager;
  }
}

export const playbackRegistry = new PlaybackManagerRegistry();
