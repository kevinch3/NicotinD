import { signal } from '@angular/core';
import { vi } from 'vitest';
import { playShelfSong, type ShelfPlayer } from './shelf-play';
import type { Track } from '../services/player.service';

function track(id: string): Track {
  return { id, title: id, artist: 'A' };
}

function makePlayer() {
  const player = {
    startRadio: vi.fn<(track: Track) => void>(),
    playWithContext: vi.fn<ShelfPlayer['playWithContext']>(),
    nowPlayingOpen: signal(false),
  };
  return player satisfies ShelfPlayer;
}

const tracks = [track('a'), track('b'), track('c')];
const context = { type: 'adhoc' as const, name: 'Recently played' };

describe('playShelfSong', () => {
  describe('phone / desktop', () => {
    it('plays the shelf as a queue when the shelf has a context', () => {
      const player = makePlayer();

      playShelfSong(player, tracks, 1, context, false);

      expect(player.playWithContext).toHaveBeenCalledWith(tracks, 1, context);
      expect(player.startRadio).not.toHaveBeenCalled();
    });

    it('seeds radio when the shelf has no context (a recommendation tile)', () => {
      const player = makePlayer();

      playShelfSong(player, tracks, 2, undefined, false);

      expect(player.startRadio).toHaveBeenCalledWith(tracks[2]);
    });

    it("leaves Now Playing closed — opening it is the caller's job, not the shelf's", () => {
      const player = makePlayer();

      playShelfSong(player, tracks, 0, context, false);

      expect(player.nowPlayingOpen()).toBe(false);
    });
  });

  describe('TV', () => {
    it('seeds radio from the pressed song even when the shelf has a context', () => {
      // A finite queue on TV ends in silence: there is no queue view, no radio
      // toggle and no keyboard to restart it with (#1127).
      const player = makePlayer();

      playShelfSong(player, tracks, 1, context, true);

      expect(player.startRadio).toHaveBeenCalledWith(tracks[1]);
      expect(player.playWithContext).not.toHaveBeenCalled();
    });

    it('asks for the player, which the TV shell turns into a route change', () => {
      const player = makePlayer();

      playShelfSong(player, tracks, 0, context, true);

      expect(player.nowPlayingOpen()).toBe(true);
    });
  });

  it('is a no-op for an index the shelf does not have', () => {
    const player = makePlayer();

    playShelfSong(player, tracks, 9, context, true);

    expect(player.startRadio).not.toHaveBeenCalled();
    expect(player.playWithContext).not.toHaveBeenCalled();
    expect(player.nowPlayingOpen()).toBe(false);
  });
});
