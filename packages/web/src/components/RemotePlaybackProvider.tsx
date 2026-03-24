/**
 * RemotePlaybackProvider
 *
 * Mount this once near the top of the app. It:
 * 1. Opens the WebSocket connection.
 * 2. Subscribes to server events and updates the remote-playback store.
 * 3. Bridges incoming playback commands → the local player store
 *    ONLY when this device is the active player.
 */
import { useEffect } from 'react';
import { wsClient } from '@/services/ws-client';
import { useRemotePlaybackStore, RemoteDevice } from '@/stores/remote-playback';
import { usePlayerStore } from '@/stores/player';

export function RemotePlaybackProvider({ children }: { children: React.ReactNode }) {
  const setDevices = useRemotePlaybackStore(s => s.setDevices);
  const setActiveDeviceId = useRemotePlaybackStore(s => s.setActiveDeviceId);
  const remoteEnabled = useRemotePlaybackStore(s => s.remoteEnabled);
  const activeDeviceId = useRemotePlaybackStore(s => s.activeDeviceId);

  const playerPlay = usePlayerStore(s => s.play);
  const playerPause = usePlayerStore(s => s.pause);
  const playerResume = usePlayerStore(s => s.resume);
  const playerSeek = usePlayerStore(s => s.seek);
  const playerPlayNext = usePlayerStore(s => s.playNext);
  const playerPlayPrev = usePlayerStore(s => s.playPrev);
  const isPlaying = usePlayerStore(s => s.isPlaying);
  const currentTrack = usePlayerStore(s => s.currentTrack);

  const myId = wsClient.getDeviceId();
  const isActiveDevice = activeDeviceId === myId;

  // Connect WS on mount, disconnect on unmount
  useEffect(() => {
    wsClient.connect();
    return () => wsClient.disconnect();
  }, []);

  // Handle full state sync (sent on initial connection and on each change)
  useEffect(() => {
    return wsClient.on<{
      state: { activeDeviceId?: string | null };
      devices?: RemoteDevice[];
    }>('STATE_SYNC', (payload) => {
      const { state, devices } = payload;
      if (state?.activeDeviceId !== undefined) {
        setActiveDeviceId(state.activeDeviceId ?? null);
      }
      if (devices) setDevices(devices);
    });
  }, [setActiveDeviceId, setDevices]);

  // Handle device list updates
  useEffect(() => {
    return wsClient.on<{ devices: RemoteDevice[] }>('DEVICES_SYNC', (payload) => {
      const { devices } = payload;
      setDevices(devices);
    });
  }, [setDevices]);

  // Handle playback commands forwarded to us (only if we are the active device AND opted in)
  useEffect(() => {
    if (!isActiveDevice || !remoteEnabled) return;

    return wsClient.on<{
      state: { isPlaying?: boolean; position?: number };
    }>('STATE_SYNC', (payload) => {
      const { state } = payload;
      if (state?.isPlaying !== undefined) {
        if (state.isPlaying) playerResume();
        else playerPause();
      }
      if (state?.position !== undefined) {
        playerSeek(state.position);
      }
    });
  }, [isActiveDevice, remoteEnabled, playerResume, playerPause, playerSeek]);

  // Handle explicit commands (NEXT, PREV)
  useEffect(() => {
    if (!isActiveDevice || !remoteEnabled) return;

    return wsClient.on<{ action: string }>('COMMAND', (payload) => {
      const { action } = payload;
      if (action === 'NEXT') playerPlayNext();
      if (action === 'PREV') playerPlayPrev();
    });
  }, [isActiveDevice, remoteEnabled, playerPlayNext, playerPlayPrev]);

  // Broadcast our playback state to server when we ARE the active device
  useEffect(() => {
    if (!isActiveDevice) return;
    wsClient.sendStateUpdate({
      isPlaying,
      trackId: currentTrack?.id ?? null,
    });
  }, [isPlaying, currentTrack, isActiveDevice]);

  return <>{children}</>;
}
