/**
 * RemotePlaybackProvider
 *
 * Mount this once near the top of the app. It:
 * 1. Opens the WebSocket connection.
 * 2. Subscribes to server events and updates the remote-playback store.
 * 3. Bridges incoming COMMAND messages → the local player store
 *    ONLY when this device is the active player and has opted in.
 */
import { useEffect } from 'react';
import { wsClient } from '@/services/ws-client';
import { useRemotePlaybackStore, RemoteDevice } from '@/stores/remote-playback';
import { usePlayerStore } from '@/stores/player';
import type { Track } from '@/stores/player';

export function RemotePlaybackProvider({ children }: { children: React.ReactNode }) {
  const setDevices = useRemotePlaybackStore(s => s.setDevices);
  const setActiveDeviceId = useRemotePlaybackStore(s => s.setActiveDeviceId);
  const setRemoteIsPlaying = useRemotePlaybackStore(s => s.setRemoteIsPlaying);
  const remoteEnabled = useRemotePlaybackStore(s => s.remoteEnabled);
  const activeDeviceId = useRemotePlaybackStore(s => s.activeDeviceId);

  const playerPlay = usePlayerStore(s => s.play);
  const playerPause = usePlayerStore(s => s.pause);
  const playerResume = usePlayerStore(s => s.resume);
  const playerSeek = usePlayerStore(s => s.seek);
  const playerPlayNext = usePlayerStore(s => s.playNext);
  const playerPlayPrev = usePlayerStore(s => s.playPrev);

  const myId = wsClient.getDeviceId();
  const isActiveDevice = activeDeviceId === myId;

  // Connect WS on mount, disconnect on unmount
  useEffect(() => {
    wsClient.connect();
    return () => wsClient.disconnect();
  }, []);

  // Handle full state sync — updates metadata visible to ALL devices (active or not).
  // Also applies initial track/state when this device is the active player on connect.
  useEffect(() => {
    return wsClient.on<{
      state: { activeDeviceId?: string | null; isPlaying?: boolean; track?: Track | null };
      devices?: RemoteDevice[];
    }>('STATE_SYNC', (payload) => {
      const { state, devices } = payload;

      if (state?.activeDeviceId !== undefined) {
        setActiveDeviceId(state.activeDeviceId ?? null);
      }
      if (devices) setDevices(devices);

      // Keep the controller's UI in sync with the remote device's playing state
      if (state?.isPlaying !== undefined) {
        setRemoteIsPlaying(state.isPlaying);
      }

      // Late-join: if this device is already the active device when it first connects
      // and the server has a track stored, load it now.
      const amActive = state?.activeDeviceId === myId;
      if (amActive && state?.track) {
        playerPlay(state.track);
        if (state.isPlaying === false) playerPause();
      }
    });
  }, [setActiveDeviceId, setDevices, setRemoteIsPlaying, playerPlay, playerPause, myId]);

  // Handle device list updates
  useEffect(() => {
    return wsClient.on<{ devices: RemoteDevice[] }>('DEVICES_SYNC', (payload) => {
      setDevices(payload.devices);
    });
  }, [setDevices]);

  // Handle explicit commands — only executed on the active, opted-in device.
  // PLAY/PAUSE/SEEK/SET_TRACK are all routed through COMMAND (not STATE_SYNC)
  // to avoid the echo loop that STATE_UPDATE caused.
  useEffect(() => {
    if (!isActiveDevice || !remoteEnabled) return;

    return wsClient.on<{ action: string; track?: Track; position?: number }>('COMMAND', (payload) => {
      const { action } = payload;
      if (action === 'PLAY')  playerResume();
      if (action === 'PAUSE') playerPause();
      if (action === 'SEEK' && payload.position !== undefined) playerSeek(payload.position);
      if (action === 'SET_TRACK' && payload.track) playerPlay(payload.track);
      if (action === 'NEXT')  playerPlayNext();
      if (action === 'PREV')  playerPlayPrev();
    });
  }, [isActiveDevice, remoteEnabled, playerResume, playerPause, playerSeek, playerPlay, playerPlayNext, playerPlayPrev]);

  return <>{children}</>;
}
