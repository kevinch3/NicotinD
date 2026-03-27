/**
 * RemotePlaybackProvider
 *
 * Mount this once near the top of the app. It:
 * 1. Opens the WebSocket connection.
 * 2. Subscribes to server events and updates the remote-playback store.
 * 3. Bridges incoming COMMAND messages → the local player store
 *    ONLY when this device is the active player and has opted in.
 */
import { useEffect, useRef } from 'react';
import { wsClient } from '@/services/ws-client';
import { useRemotePlaybackStore, RemoteDevice } from '@/stores/remote-playback';
import { usePlayerStore } from '@/stores/player';
import type { Track } from '@/stores/player';


export function RemotePlaybackProvider({ children }: { children: React.ReactNode }) {
  const setDevices = useRemotePlaybackStore(s => s.setDevices);
  const setActiveDeviceId = useRemotePlaybackStore(s => s.setActiveDeviceId);
  const setRemoteIsPlaying = useRemotePlaybackStore(s => s.setRemoteIsPlaying);
  const setRemoteProgress = useRemotePlaybackStore(s => s.setRemoteProgress);
  const activeDeviceId = useRemotePlaybackStore(s => s.activeDeviceId);
  const playerPlay = usePlayerStore(s => s.play);
  const playerPause = usePlayerStore(s => s.pause);
  const playerResume = usePlayerStore(s => s.resume);
  const playerSeek = usePlayerStore(s => s.seek);
  const playerPlayNext = usePlayerStore(s => s.playNext);
  const playerPlayPrev = usePlayerStore(s => s.playPrev);
  const setCurrentTrackMetadata = usePlayerStore(s => s.setCurrentTrackMetadata);
  const currentTrack = usePlayerStore(s => s.currentTrack);

  const myId = wsClient.getDeviceId();
  const isActiveDevice = !activeDeviceId || activeDeviceId === myId;

  // Tracks whether the initial late-join STATE_SYNC has been applied.
  // Prevents playerPlay from re-triggering on every subsequent STATE_SYNC.
  const lateJoinApplied = useRef(false);
  // Last track ID applied from an incoming COMMAND — used to suppress echo
  // when the resulting currentTrack change would otherwise send a redundant SET_TRACK.
  const lastRemoteTrackIdRef = useRef<string | null>(null);

  // Connect WS on mount, disconnect on unmount
  useEffect(() => {
    wsClient.connect();
    return () => wsClient.disconnect();
  }, []);

  // Handle full state sync — updates metadata visible to ALL devices (active or not).
  // Also applies initial track/state when this device is the active player on connect.
  useEffect(() => {
    return wsClient.on<{
      state: { activeDeviceId?: string | null; isPlaying?: boolean; track?: Track | null; position?: number; duration?: number };
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

      // Sync remote progress for seek bar interpolation on controller.
      // Prefer actual audio duration from PROGRESS_REPORT over track metadata.
      if (state?.position !== undefined) {
        const dur = state?.duration ?? state?.track?.duration ?? 0;
        setRemoteProgress(state.position, dur);
      }

      const amActive = state?.activeDeviceId === myId;

      // Late-join: if this device is already the active device when it first connects
      // and the server has a track stored, load it now. Only runs ONCE.
      if (amActive && state?.track && !lateJoinApplied.current) {
        lateJoinApplied.current = true;
        playerPlay(state.track);
        if (state.isPlaying === false) playerPause();
      }

      // Controller: sync remote track metadata so the player bar shows current info.
      // Uses setCurrentTrackMetadata to avoid clearing queue/history or loading audio.
      if (!amActive && state?.track) {
        const localTrack = usePlayerStore.getState().currentTrack;
        if (state.track.id !== localTrack?.id) {
          lastRemoteTrackIdRef.current = state.track.id;
          setCurrentTrackMetadata(state.track);
        }
      }
    });
  }, [setActiveDeviceId, setDevices, setRemoteIsPlaying, setRemoteProgress, playerPlay, playerPause, setCurrentTrackMetadata, myId]);

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
    return wsClient.on<{ action: string; track?: Track; position?: number }>('COMMAND', (payload) => {
      // Re-check at call time (not closure time) to avoid race where the
      // old effect closure is still active when a COMMAND arrives during a
      // device switch.
      const currentActiveId = useRemotePlaybackStore.getState().activeDeviceId;
      if (currentActiveId !== myId) return;

      const { action } = payload;
      if (action === 'PLAY')  playerResume();
      if (action === 'PAUSE') playerPause();
      if (action === 'SEEK' && payload.position !== undefined) playerSeek(payload.position);
      if (action === 'SET_TRACK' && payload.track) {
        lastRemoteTrackIdRef.current = payload.track.id;
        playerPlay(payload.track);
      }
      if (action === 'NEXT')  playerPlayNext();
      if (action === 'PREV')  playerPlayPrev();
    });
  }, [myId, playerResume, playerPause, playerSeek, playerPlay, playerPlayNext, playerPlayPrev]);

  // Scenario A: Controller picks a new song → send SET_TRACK to the active device.
  // Echo protection: skip if this track was just applied from an incoming COMMAND/STATE_SYNC.
  useEffect(() => {
    if (isActiveDevice || !currentTrack) return;
    if (currentTrack.id === lastRemoteTrackIdRef.current) return;
    wsClient.sendCommand('SET_TRACK', { track: currentTrack });
  }, [currentTrack, isActiveDevice]);

  // Scenario B: Active device changes track locally → push metadata to server so controllers
  // see the new song info immediately (server will broadcast STATE_SYNC on STATE_UPDATE).
  useEffect(() => {
    if (!isActiveDevice || !currentTrack) return;
    wsClient.sendStateUpdate({ track: currentTrack, trackId: currentTrack.id, isPlaying: true, position: 0 });
  }, [currentTrack, isActiveDevice]);

  return <>{children}</>;
}
