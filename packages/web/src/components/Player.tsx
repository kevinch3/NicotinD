import { useRef, useEffect, useState } from 'react';
import { usePlayerStore } from '@/stores/player';
import { useAuthStore } from '@/stores/auth';

export function Player() {
  const { currentTrack, isPlaying, pause, resume, playNext } = usePlayerStore();
  const token = useAuthStore((s) => s.token);
  const audioRef = useRef<HTMLAudioElement>(null);
  const [progress, setProgress] = useState(0);
  const [duration, setDuration] = useState(0);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    if (currentTrack) {
      const trackDuration = currentTrack.duration ?? 0;
      setProgress(0);
      setDuration(
        Number.isFinite(trackDuration) && trackDuration > 0 ? trackDuration : 0,
      );
      audio.src = `/api/stream/${currentTrack.id}?token=${token}`;
      audio.play().catch(() => {});
    } else {
      audio.pause();
      audio.src = '';
      setProgress(0);
      setDuration(0);
    }
  }, [currentTrack, token]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (isPlaying) audio.play().catch(() => {});
    else audio.pause();
  }, [isPlaying]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    const onTime = () => {
      const value = audio.currentTime;
      setProgress(Number.isFinite(value) && value >= 0 ? value : 0);
    };
    const onDuration = () => {
      const value = audio.duration;
      setDuration(Number.isFinite(value) && value > 0 ? value : 0);
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
  }, [playNext]);

  function seek(e: React.MouseEvent<HTMLDivElement>) {
    const audio = audioRef.current;
    const safeDuration = Number.isFinite(duration) && duration > 0 ? duration : 0;
    if (!audio || !safeDuration) return;
    const rect = e.currentTarget.getBoundingClientRect();
    if (!rect.width) return;
    const pct = (e.clientX - rect.left) / rect.width;
    audio.currentTime = Math.max(0, Math.min(1, pct)) * safeDuration;
  }

  function formatTime(s: number) {
    if (!Number.isFinite(s) || s < 0) return '0:00';
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${sec.toString().padStart(2, '0')}`;
  }

  const safeDuration = Number.isFinite(duration) && duration > 0 ? duration : 0;
  const safeProgress =
    Number.isFinite(progress) && progress >= 0 ? Math.min(progress, safeDuration || progress) : 0;
  const progressPercent = safeDuration > 0 ? Math.max(0, Math.min(100, (safeProgress / safeDuration) * 100)) : 0;

  if (!currentTrack) return <audio ref={audioRef} />;

  return (
    <>
      <audio ref={audioRef} />
      <div className="fixed bottom-0 left-0 right-0 h-18 bg-zinc-900 border-t border-zinc-800 flex items-center px-4 gap-4 z-50">
        {/* Track info */}
        <div className="flex items-center gap-3 w-60 min-w-0">
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

          <div className="flex items-center gap-2 w-full max-w-md">
            <span className="text-xs text-zinc-500 w-10 text-right">{formatTime(safeProgress)}</span>
            <div className="flex-1 h-1 bg-zinc-700 rounded-full cursor-pointer" onClick={seek}>
              <div
                className="h-full bg-zinc-300 rounded-full transition-all"
                style={{ width: `${progressPercent}%` }}
              />
            </div>
            <span className="text-xs text-zinc-500 w-10">{formatTime(safeDuration)}</span>
          </div>
        </div>

        <div className="w-60" />
      </div>
    </>
  );
}
