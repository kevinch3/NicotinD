import { PlaybackStateManager } from './playback-state.js';

class PlaybackManagerRegistry {
  private managers = new Map<string, PlaybackStateManager>();

  getOrCreate(userId: string): PlaybackStateManager {
    let manager = this.managers.get(userId);
    if (!manager) {
      manager = new PlaybackStateManager();
      this.managers.set(userId, manager);
    }
    return manager;
  }
}

export const playbackRegistry = new PlaybackManagerRegistry();
