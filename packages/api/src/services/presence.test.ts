import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { PresenceService } from './presence.js';

describe('PresenceService', () => {
  let presence: PresenceService;

  beforeEach(() => {
    presence = new PresenceService();
  });

  afterEach(() => {
    presence.stop();
  });

  describe('heartbeat + getUserPresence', () => {
    it('reports offline / zero for an unknown user', () => {
      expect(presence.getUserPresence('nobody')).toEqual({
        isConnected: false,
        amountOfDevices: 0,
        amountOfSessions: 0,
      });
    });

    it('counts a single tab as 1 device / 1 session', () => {
      presence.heartbeat('u1', 'dev-a', 'tab-1');
      expect(presence.getUserPresence('u1')).toEqual({
        isConnected: true,
        amountOfDevices: 1,
        amountOfSessions: 1,
      });
    });

    it('3 tabs on one device → 1 device, 3 sessions', () => {
      presence.heartbeat('u1', 'dev-a', 'tab-1');
      presence.heartbeat('u1', 'dev-a', 'tab-2');
      presence.heartbeat('u1', 'dev-a', 'tab-3');
      expect(presence.getUserPresence('u1')).toEqual({
        isConnected: true,
        amountOfDevices: 1,
        amountOfSessions: 3,
      });
    });

    it('two devices → 2 devices, 2 sessions', () => {
      presence.heartbeat('u1', 'phone', 'tab-1');
      presence.heartbeat('u1', 'laptop', 'tab-2');
      expect(presence.getUserPresence('u1')).toEqual({
        isConnected: true,
        amountOfDevices: 2,
        amountOfSessions: 2,
      });
    });

    it('re-heartbeating the same tab does not inflate counts', () => {
      presence.heartbeat('u1', 'dev-a', 'tab-1');
      presence.heartbeat('u1', 'dev-a', 'tab-1');
      expect(presence.getUserPresence('u1')).toEqual({
        isConnected: true,
        amountOfDevices: 1,
        amountOfSessions: 1,
      });
    });

    it('isolates presence between users', () => {
      presence.heartbeat('u1', 'dev-a', 'tab-1');
      presence.heartbeat('u2', 'dev-b', 'tab-2');
      expect(presence.getUserPresence('u1').amountOfSessions).toBe(1);
      expect(presence.getUserPresence('u2').amountOfSessions).toBe(1);
    });
  });

  describe('getActiveUsers', () => {
    it('is empty when nobody is active', () => {
      expect(presence.getActiveUsers().size).toBe(0);
    });

    it('aggregates every active user', () => {
      presence.heartbeat('u1', 'dev-a', 'tab-1');
      presence.heartbeat('u1', 'dev-a', 'tab-2');
      presence.heartbeat('u2', 'phone', 'tab-3');
      presence.heartbeat('u2', 'laptop', 'tab-4');

      const active = presence.getActiveUsers();
      expect(active.get('u1')).toEqual({
        isConnected: true,
        amountOfDevices: 1,
        amountOfSessions: 2,
      });
      expect(active.get('u2')).toEqual({
        isConnected: true,
        amountOfDevices: 2,
        amountOfSessions: 2,
      });
    });
  });

  describe('removeSession', () => {
    it('deletes a specific session by composite key', () => {
      presence.heartbeat('u1', 'dev-a', 'tab-1');
      presence.heartbeat('u1', 'dev-a', 'tab-2');
      presence.removeSession('u1:dev-a:tab-1');
      expect(presence.getUserPresence('u1').amountOfSessions).toBe(1);
    });

    it('is safe for an unknown session', () => {
      presence.removeSession('nope:nope:nope');
      expect(presence.getActiveUsers().size).toBe(0);
    });
  });

  describe('cleanupStale', () => {
    it('evicts sessions past the stale timeout', () => {
      presence.heartbeat('u1', 'dev-a', 'tab-1');
      // Backdate lastSeen beyond the 120s stale window via a fresh heartbeat is not enough;
      // reach into the map through a second stale-only session and verify eviction.
      presence.heartbeat('u1', 'dev-a', 'tab-stale');
      const sessions = (presence as unknown as { sessions: Map<string, { lastSeen: number }> })
        .sessions;
      sessions.get('u1:dev-a:tab-stale')!.lastSeen = Date.now() - 130_000;

      presence.cleanupStale();

      // Fresh session survives, stale one is gone → 1 session remains.
      expect(presence.getUserPresence('u1').amountOfSessions).toBe(1);
    });

    it('keeps fresh sessions', () => {
      presence.heartbeat('u1', 'dev-a', 'tab-1');
      presence.cleanupStale();
      expect(presence.getUserPresence('u1').amountOfSessions).toBe(1);
    });

    it('is safe with no sessions', () => {
      presence.cleanupStale();
      expect(presence.getActiveUsers().size).toBe(0);
    });
  });
});
