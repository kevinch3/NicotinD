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
      audio.src = `/api/stream/${currentTrack.id}?token=${token}`;
      audio.play().catch(() => {});
    } else {
      audio.pause();
      audio.src = '';
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

    const onTime = () => setProgress(audio.currentTime);
    const onDuration = () => setDuration(audio.duration || 0);
    const onEnded = () => playNext();

    audio.addEventListener('timeupdate', onTime);
    audio.addEventListener('loadedmetadata', onDuration);
    audio.addEventListener('ended', onEnded);
    return () => {
      audio.removeEventListener('timeupdate', onTime);
      audio.removeEventListener('loadedmetadata', onDuration);
      audio.removeEventListener('ended', onEnded);
    };
  }, [playNext]);

  function seek(e: React.MouseEvent<HTMLDivElement>) {
    const audio = audioRef.current;
    if (!audio || !duration) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const pct = (e.clientX - rect.left) / rect.width;
    audio.currentTime = pct * duration;
  }

  function formatTime(s: number) {
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${sec.toString().padStart(2, '0')}`;
  }

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
            <span className="text-xs text-zinc-500 w-10 text-right">{formatTime(progress)}</span>
            <div className="flex-1 h-1 bg-zinc-700 rounded-full cursor-pointer" onClick={seek}>
              <div
                className="h-full bg-zinc-300 rounded-full transition-all"
                style={{ width: duration ? `${(progress / duration) * 100}%` : '0%' }}
              />
            </div>
            <span className="text-xs text-zinc-500 w-10">{formatTime(duration)}</span>
          </div>
        </div>

        <div className="w-60" />
      </div>
    </>
  );
}
