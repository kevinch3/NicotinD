import { useRef, useEffect, useCallback } from 'react';
import { usePlayerStore } from '@/stores/player';
import { useAuthStore } from '@/stores/auth';
import { PreserveButton } from '@/components/PreserveButton';
import { DeviceSwitcher } from '@/components/DeviceSwitcher';
import { useRemotePlaybackStore } from '@/stores/remote-playback';
import { wsClient } from '@/services/ws-client';
import { useNavigateAndSearch } from '@/hooks/useNavigateAndSearch';

export function Player() {
  const {
    currentTrack,
    isPlaying,
    pause,
    resume,
    playNext,
    playPrev,
    shuffle,
    toggleShuffle,
    repeat,
    cycleRepeat,
    setCurrentTime,
    setDuration,
    currentTime,
    duration,
    seekTo,
    clearSeek,
    setNowPlayingOpen,
    queue,
    history,
  } = usePlayerStore();
  const token = useAuthStore((s) => s.token);
  const navigateAndSearch = useNavigateAndSearch();
  const { remoteEnabled, setRemoteEnabled, activeDeviceId } = useRemotePlaybackStore();
  const myId = wsClient.getDeviceId();
  const isActiveDevice = !activeDeviceId || activeDeviceId === myId;
  const audioRef = useRef<HTMLAudioElement>(null);

  // Load track
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    if (currentTrack) {
      setCurrentTime(0);
      setDuration(currentTrack.duration ?? 0);
      audio.src = `/api/stream/${currentTrack.id}?token=${token}`;
      audio.play().catch(() => {});
    } else {
      audio.pause();
      audio.src = '';
      setCurrentTime(0);
      setDuration(0);
    }
  }, [currentTrack, token, setCurrentTime, setDuration]);

  // Media Session: update metadata when track changes
  useEffect(() => {
    if (!('mediaSession' in navigator)) return;

    if (!currentTrack) {
      navigator.mediaSession.metadata = null;
      navigator.mediaSession.playbackState = 'none';
      return;
    }

    navigator.mediaSession.metadata = new MediaMetadata({
      title: currentTrack.title,
      artist: currentTrack.artist,
      album: currentTrack.album ?? '',
      artwork: currentTrack.coverArt
        ? [
            { src: `/api/cover/${currentTrack.coverArt}?size=96&token=${token}`, sizes: '96x96', type: 'image/jpeg' },
            { src: `/api/cover/${currentTrack.coverArt}?size=256&token=${token}`, sizes: '256x256', type: 'image/jpeg' },
            { src: `/api/cover/${currentTrack.coverArt}?size=512&token=${token}`, sizes: '512x512', type: 'image/jpeg' },
          ]
        : [],
    });
  }, [currentTrack, token]);

  // Media Session: sync playback state
  useEffect(() => {
    if (!('mediaSession' in navigator)) return;
    navigator.mediaSession.playbackState = isPlaying ? 'playing' : 'paused';
  }, [isPlaying]);

  // Media Session: action handlers + conditional next/prev
  useEffect(() => {
    if (!('mediaSession' in navigator)) return;

    const canGoNext = queue.length > 0 || repeat === 'all' || repeat === 'one';
    const canGoPrev = history.length > 0;

    navigator.mediaSession.setActionHandler('play', () => usePlayerStore.getState().resume());
    navigator.mediaSession.setActionHandler('pause', () => usePlayerStore.getState().pause());
    navigator.mediaSession.setActionHandler('nexttrack', canGoNext
      ? () => usePlayerStore.getState().playNext()
      : null
    );
    navigator.mediaSession.setActionHandler('previoustrack', canGoPrev
      ? () => {
          const audio = audioRef.current;
          if (audio && audio.currentTime > 3) {
            audio.currentTime = 0;
          } else {
            usePlayerStore.getState().playPrev();
          }
        }
      : null
    );
    navigator.mediaSession.setActionHandler('seekto', (details) => {
      if (details.seekTime != null) usePlayerStore.getState().seek(details.seekTime);
    });
    navigator.mediaSession.setActionHandler('seekforward', () => {
      const current = usePlayerStore.getState().currentTime;
      usePlayerStore.getState().seek(current + 10);
    });
    navigator.mediaSession.setActionHandler('seekbackward', () => {
      const current = usePlayerStore.getState().currentTime;
      usePlayerStore.getState().seek(Math.max(0, current - 10));
    });
  }, [queue, history, repeat]);

  // Play/pause sync — only drive <audio> if we are the active device
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !isActiveDevice) return;
    if (isPlaying) audio.play().catch(() => {});
    else audio.pause();
  }, [isPlaying, isActiveDevice]);

  // Seek from store
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || seekTo === null) return;
    audio.currentTime = seekTo;
    clearSeek();
  }, [seekTo, clearSeek]);

  // Audio events
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    const onTime = () => {
      const value = audio.currentTime;
      if (Number.isFinite(value) && value >= 0) {
        setCurrentTime(value);
        // After setCurrentTime(value):
        if ('mediaSession' in navigator && audio.duration > 0 && Number.isFinite(audio.duration)) {
          try {
            navigator.mediaSession.setPositionState({
              duration: audio.duration,
              playbackRate: 1,
              position: value,
            });
          } catch {
            // Older WebKit may throw — silently ignore
          }
        }
      }
    };
    const onDuration = () => {
      const value = audio.duration;
      if (Number.isFinite(value) && value > 0) setDuration(value);
    };
    const onEnded = () => playNext();

    audio.addEventListener('timeupdate', onTime);
    audio.addEventListener('loadedmetadata', onDuration);
    audio.addEventListener('durationchange', onDuration);
    audio.addEventListener('ended', onEnded);
    return () => {
      audio.removeEventListener('timeupdate', onTime);
      audio.removeEventListener('loadedmetadata', onDuration);
      audio.removeEventListener('durationchange', onDuration);
      audio.removeEventListener('ended', onEnded);
    };
  }, [playNext, setCurrentTime, setDuration]);

  const handlePlayPause = useCallback(() => {
    if (isActiveDevice) {
      if (isPlaying) pause();
      else resume();
    } else {
      wsClient.sendCommand(isPlaying ? 'PAUSE' : 'PLAY');
    }
  }, [isActiveDevice, isPlaying, pause, resume]);

  const handleNext = useCallback(() => {
    if (isActiveDevice) playNext();
    else wsClient.sendCommand('COMMAND', { action: 'NEXT' }); // Note: API needs to handle 'NEXT' in COMMAND switch
  }, [isActiveDevice, playNext]);

  const handleSeek = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const audio = audioRef.current;
      const safeDuration = Number.isFinite(duration) && duration > 0 ? duration : 0;
      if (!safeDuration) return;

      const rect = e.currentTarget.getBoundingClientRect();
      if (!rect.width) return;
      const pct = (e.clientX - rect.left) / rect.width;
      const newTime = Math.max(0, Math.min(1, pct)) * safeDuration;

      if (isActiveDevice && audio) {
        audio.currentTime = newTime;
      } else {
        wsClient.sendCommand('SEEK', { position: newTime });
      }
    },
    [duration, isActiveDevice],
  );

  const handlePrev = useCallback(() => {
    const audio = audioRef.current;
    if (isActiveDevice) {
      if (audio && audio.currentTime > 3) {
        audio.currentTime = 0;
      } else {
        playPrev();
      }
    } else {
      wsClient.sendCommand('COMMAND', { action: 'PREV' });
    }
  }, [isActiveDevice, playPrev]);

  const toggleRemote = useCallback(() => {
    if (!remoteEnabled && audioRef.current) {
      // User gesture to unlock audio for future remote commands
      audioRef.current.play().then(() => {
        if (!isPlaying) audioRef.current?.pause();
      }).catch(() => {});
    }
    setRemoteEnabled(!remoteEnabled);
  }, [remoteEnabled, setRemoteEnabled, isPlaying]);

  function formatTime(s: number) {
    if (!Number.isFinite(s) || s < 0) return '0:00';
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${sec.toString().padStart(2, '0')}`;
  }

  const safeDuration = Number.isFinite(duration) && duration > 0 ? duration : 0;
  const safeProgress =
    Number.isFinite(currentTime) && currentTime >= 0
      ? Math.min(currentTime, safeDuration || currentTime)
      : 0;
  const progressPercent =
    safeDuration > 0 ? Math.max(0, Math.min(100, (safeProgress / safeDuration) * 100)) : 0;

  if (!currentTrack) return <audio ref={audioRef} />;

  return (
    <>
      <audio ref={audioRef} />
      <div className="fixed bottom-0 left-0 right-0 bg-zinc-900 border-t border-zinc-800 z-50">
        {/* Clickable area to open Now Playing */}
        <div
          className="flex items-center px-3 md:px-4 gap-2 md:gap-4 h-16 md:h-18 cursor-pointer"
          onClick={(e) => {
            // Only open panel if clicking the background, not buttons
            if ((e.target as HTMLElement).closest('button')) return;
            setNowPlayingOpen(true);
          }}
        >
          {/* Track info */}
          <div className="flex items-center gap-3 min-w-0 flex-shrink md:w-60 md:flex-shrink-0">
            {currentTrack.coverArt && (
              <img
                src={`/api/cover/${currentTrack.coverArt}?size=80&token=${token}`}
                alt=""
                className="w-10 h-10 rounded object-cover flex-shrink-0"
              />
            )}
            <div className="min-w-0">
              <p className="text-sm font-medium text-zinc-100 truncate">{currentTrack.title}</p>
              <p
                className="text-xs text-zinc-400 truncate cursor-pointer hover:underline hover:text-zinc-200 transition"
                onClick={(e) => { e.stopPropagation(); navigateAndSearch(currentTrack.artist); }}
              >
                {currentTrack.artist}
              </p>
            </div>
            <PreserveButton track={currentTrack} size="sm" className="hidden md:flex flex-shrink-0" />
          </div>

          {/* Controls */}
          <div className="flex-1 flex flex-col items-center gap-1">
            <div className="flex items-center gap-2 md:gap-3">
              {/* Shuffle - desktop only */}
              <button
                onClick={toggleShuffle}
                className={`hidden md:flex w-7 h-7 items-center justify-center rounded-full transition ${
                  shuffle ? 'text-emerald-400' : 'text-zinc-500 hover:text-zinc-300'
                }`}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M16 3h5v5" />
                  <path d="M4 20 21 3" />
                  <path d="M21 16v5h-5" />
                  <path d="M15 15l6 6" />
                  <path d="M4 4l5 5" />
                </svg>
              </button>

              {/* Previous */}
              <button
                onClick={handlePrev}
                className="w-7 h-7 flex items-center justify-center text-zinc-400 hover:text-zinc-100 transition"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                  <rect x="3" y="5" width="3" height="14" />
                  <polygon points="21,5 9,12 21,19" />
                </svg>
              </button>

              {/* Play/Pause */}
              <button
                onClick={handlePlayPause}
                className="w-8 h-8 rounded-full bg-zinc-100 text-zinc-900 flex items-center justify-center hover:bg-zinc-200 transition"
              >
                {isPlaying ? (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                    <rect x="6" y="4" width="4" height="16" />
                    <rect x="14" y="4" width="4" height="16" />
                  </svg>
                ) : (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                    <polygon points="5,3 19,12 5,21" />
                  </svg>
                )}
              </button>

              {/* Next */}
              <button
                onClick={handleNext}
                className="w-7 h-7 flex items-center justify-center text-zinc-400 hover:text-zinc-100 transition"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                  <polygon points="3,5 15,12 3,19" />
                  <rect x="18" y="5" width="3" height="14" />
                </svg>
              </button>

              {/* Repeat - desktop only */}
              <button
                onClick={cycleRepeat}
                className={`hidden md:flex w-7 h-7 items-center justify-center rounded-full transition relative ${
                  repeat !== 'off' ? 'text-emerald-400' : 'text-zinc-500 hover:text-zinc-300'
                }`}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M17 2l4 4-4 4" />
                  <path d="M3 11v-1a4 4 0 014-4h14" />
                  <path d="M7 22l-4-4 4-4" />
                  <path d="M21 13v1a4 4 0 01-4 4H3" />
                </svg>
                {repeat === 'one' && (
                  <span className="absolute -top-1 -right-1 text-[9px] font-bold text-emerald-400">1</span>
                )}
              </button>
            </div>

            {/* Progress bar */}
            <div className="hidden md:flex items-center gap-2 w-full max-w-md">
              <span className="text-xs text-zinc-500 w-10 text-right">{formatTime(safeProgress)}</span>
              <div className="flex-1 h-1 bg-zinc-700 rounded-full cursor-pointer" onClick={handleSeek}>
                <div
                  className="h-full bg-zinc-300 rounded-full transition-all"
                  style={{ width: `${progressPercent}%` }}
                />
              </div>
              <span className="text-xs text-zinc-500 w-10">{formatTime(safeDuration)}</span>
            </div>
          </div>

          {/* Right side: device switcher + remote toggle */}
          <div className="hidden md:flex items-center gap-2 w-60 justify-end flex-shrink-0">
            <button
              onClick={toggleRemote}
              title={remoteEnabled ? 'Opt out of remote playback' : 'Opt in for remote playback'}
              className={`w-7 h-7 flex items-center justify-center rounded-full transition ${
                remoteEnabled ? 'text-emerald-400' : 'text-zinc-500 hover:text-zinc-300'
              }`}
            >
              {/* Radio tower / remote icon */}
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M5 12.55a11 11 0 0 1 14.08 0" />
                <path d="M1.42 9a16 16 0 0 1 21.16 0" />
                <path d="M8.53 16.11a6 6 0 0 1 6.95 0" />
                <circle cx="12" cy="20" r="1" fill="currentColor" />
              </svg>
            </button>
            <DeviceSwitcher />
          </div>
        </div>

        {/* Mobile progress bar */}
        <div className="md:hidden h-0.5 bg-zinc-800">
          <div
            className="h-full bg-zinc-400 transition-all"
            style={{ width: `${progressPercent}%` }}
          />
        </div>
      </div>
    </>
  );
}
