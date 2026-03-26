import { useState, useEffect } from 'react';
import { usePlayerStore } from '@/stores/player';
import { useRemotePlaybackStore } from '@/stores/remote-playback';
import { wsClient } from '@/services/ws-client';

/**
 * Returns the current playback position and duration, handling both
 * local playback and remote-controlled playback with smooth interpolation.
 */
export function usePlaybackProgress() {
  const currentTime = usePlayerStore(s => s.currentTime);
  const duration = usePlayerStore(s => s.duration);
  const activeDeviceId = useRemotePlaybackStore(s => s.activeDeviceId);
  const remotePosition = useRemotePlaybackStore(s => s.remotePosition);
  const remotePositionTs = useRemotePlaybackStore(s => s.remotePositionTs);
  const remoteDuration = useRemotePlaybackStore(s => s.remoteDuration);
  const remoteIsPlaying = useRemotePlaybackStore(s => s.remoteIsPlaying);

  const myId = wsClient.getDeviceId();
  const isActiveDevice = !activeDeviceId || activeDeviceId === myId;

  const [interpolatedTime, setInterpolatedTime] = useState(0);

  useEffect(() => {
    if (isActiveDevice) {
      setInterpolatedTime(currentTime);
      return;
    }

    if (!remoteIsPlaying) {
      setInterpolatedTime(remotePosition);
      return;
    }

    let raf: number;
    const tick = () => {
      const elapsed = (Date.now() - remotePositionTs) / 1000;
      const maxTime = remoteDuration || Infinity;
      setInterpolatedTime(Math.min(remotePosition + elapsed, maxTime));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [isActiveDevice, currentTime, remoteIsPlaying, remotePosition, remotePositionTs, remoteDuration]);

  return {
    displayTime: interpolatedTime,
    displayDuration: isActiveDevice ? duration : (remoteDuration || duration),
    isActiveDevice,
  };
}
