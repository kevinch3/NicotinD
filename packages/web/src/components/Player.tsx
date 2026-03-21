import { useRef, useEffect, useCallback } from 'react';
import { usePlayerStore } from '@/stores/player';
import { useAuthStore } from '@/stores/auth';

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
  } = usePlayerStore();
  const token = useAuthStore((s) => s.token);
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

  // Play/pause sync
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (isPlaying) audio.play().catch(() => {});
    else audio.pause();
  }, [isPlaying]);

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
      if (Number.isFinite(value) && value >= 0) setCurrentTime(value);
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

  const handleSeek = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const audio = audioRef.current;
      const safeDuration = Number.isFinite(duration) && duration > 0 ? duration : 0;
      if (!audio || !safeDuration) return;
      const rect = e.currentTarget.getBoundingClientRect();
      if (!rect.width) return;
      const pct = (e.clientX - rect.left) / rect.width;
      audio.currentTime = Math.max(0, Math.min(1, pct)) * safeDuration;
    },
    [duration],
  );

  const handlePrev = useCallback(() => {
    const audio = audioRef.current;
    if (audio && audio.currentTime > 3) {
      audio.currentTime = 0;
    } else {
      playPrev();
    }
  }, [playPrev]);

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
              <p className="text-xs text-zinc-400 truncate">{currentTrack.artist}</p>
            </div>
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
                onClick={() => (isPlaying ? pause() : resume())}
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
                onClick={playNext}
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

          {/* Right spacer - desktop only */}
          <div className="hidden md:block w-60" />
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
