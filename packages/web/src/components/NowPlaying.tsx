import { usePlayerStore } from '@/stores/player';
import { useAuthStore } from '@/stores/auth';

export function NowPlaying() {
  const {
    currentTrack,
    isPlaying,
    pause,
    resume,
    playNext,
    playPrev,
    queue,
    shuffle,
    toggleShuffle,
    repeat,
    cycleRepeat,
    nowPlayingOpen,
    setNowPlayingOpen,
    currentTime,
    duration,
    seek,
    play,
  } = usePlayerStore();
  const token = useAuthStore((s) => s.token);

  function formatTime(s: number) {
    if (!Number.isFinite(s) || s < 0) return '0:00';
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${sec.toString().padStart(2, '0')}`;
  }

  function handleSeek(e: React.MouseEvent<HTMLDivElement>) {
    const safeDuration = Number.isFinite(duration) && duration > 0 ? duration : 0;
    if (!safeDuration) return;
    const rect = e.currentTarget.getBoundingClientRect();
    if (!rect.width) return;
    const pct = (e.clientX - rect.left) / rect.width;
    seek(Math.max(0, Math.min(1, pct)) * safeDuration);
  }

  function handlePrev() {
    // In the panel we always go to previous track (Player component handles the 3s check for the mini bar)
    // Here we just call playPrev directly since user explicitly tapped the button
    playPrev();
  }

  function jumpToTrack(index: number) {
    const track = queue[index];
    if (track) play(track);
  }

  const safeDuration = Number.isFinite(duration) && duration > 0 ? duration : 0;
  const safeProgress =
    Number.isFinite(currentTime) && currentTime >= 0
      ? Math.min(currentTime, safeDuration || currentTime)
      : 0;
  const progressPercent =
    safeDuration > 0 ? Math.max(0, Math.min(100, (safeProgress / safeDuration) * 100)) : 0;

  if (!currentTrack) return null;

  return (
    <div
      className={`fixed inset-0 z-[60] bg-zinc-950 transition-transform duration-300 ease-out flex flex-col ${
        nowPlayingOpen ? 'translate-y-0' : 'translate-y-full'
      }`}
    >
      {/* Header */}
      <div className="flex items-center justify-center px-4 py-3 relative">
        <button
          onClick={() => setNowPlayingOpen(false)}
          className="absolute left-4 w-8 h-8 flex items-center justify-center text-zinc-400 hover:text-zinc-100 transition"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M6 9l6 6 6-6" />
          </svg>
        </button>
        <span className="text-xs text-zinc-500 uppercase tracking-wider">Now Playing</span>
      </div>

      {/* Cover art */}
      <div className="flex-shrink-0 flex justify-center px-8 py-4">
        {currentTrack.coverArt ? (
          <img
            src={`/api/cover/${currentTrack.coverArt}?size=600&token=${token}`}
            alt=""
            className="w-[60vw] max-w-80 aspect-square rounded-lg object-cover"
          />
        ) : (
          <div className="w-[60vw] max-w-80 aspect-square rounded-lg bg-zinc-800 flex items-center justify-center">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-zinc-600">
              <path d="M9 18V5l12-2v13" />
              <circle cx="6" cy="18" r="3" />
              <circle cx="18" cy="16" r="3" />
            </svg>
          </div>
        )}
      </div>

      {/* Track info */}
      <div className="text-center px-8 mb-4">
        <h2 className="text-xl font-semibold text-zinc-100 truncate">{currentTrack.title}</h2>
        <p className="text-sm text-zinc-400 truncate mt-1">{currentTrack.artist}</p>
      </div>

      {/* Seek bar */}
      <div className="px-8 mb-4">
        <div className="h-1.5 bg-zinc-700 rounded-full cursor-pointer" onClick={handleSeek}>
          <div
            className="h-full bg-zinc-200 rounded-full transition-all"
            style={{ width: `${progressPercent}%` }}
          />
        </div>
        <div className="flex justify-between mt-1.5">
          <span className="text-xs text-zinc-500">{formatTime(safeProgress)}</span>
          <span className="text-xs text-zinc-500">{formatTime(safeDuration)}</span>
        </div>
      </div>

      {/* Transport controls */}
      <div className="flex items-center justify-center gap-6 mb-6">
        {/* Shuffle */}
        <button
          onClick={toggleShuffle}
          className={`w-8 h-8 flex items-center justify-center rounded-full transition ${
            shuffle ? 'text-emerald-400' : 'text-zinc-500 hover:text-zinc-300'
          }`}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
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
          className="w-10 h-10 flex items-center justify-center text-zinc-300 hover:text-zinc-100 transition"
        >
          <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor">
            <rect x="3" y="5" width="3" height="14" />
            <polygon points="21,5 9,12 21,19" />
          </svg>
        </button>

        {/* Play/Pause */}
        <button
          onClick={() => (isPlaying ? pause() : resume())}
          className="w-14 h-14 rounded-full bg-zinc-100 text-zinc-900 flex items-center justify-center hover:bg-zinc-200 transition"
        >
          {isPlaying ? (
            <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor">
              <rect x="6" y="4" width="4" height="16" />
              <rect x="14" y="4" width="4" height="16" />
            </svg>
          ) : (
            <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor">
              <polygon points="6,3 20,12 6,21" />
            </svg>
          )}
        </button>

        {/* Next */}
        <button
          onClick={playNext}
          className="w-10 h-10 flex items-center justify-center text-zinc-300 hover:text-zinc-100 transition"
        >
          <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor">
            <polygon points="3,5 15,12 3,19" />
            <rect x="18" y="5" width="3" height="14" />
          </svg>
        </button>

        {/* Repeat */}
        <button
          onClick={cycleRepeat}
          className={`w-8 h-8 flex items-center justify-center rounded-full transition relative ${
            repeat !== 'off' ? 'text-emerald-400' : 'text-zinc-500 hover:text-zinc-300'
          }`}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M17 2l4 4-4 4" />
            <path d="M3 11v-1a4 4 0 014-4h14" />
            <path d="M7 22l-4-4 4-4" />
            <path d="M21 13v1a4 4 0 01-4 4H3" />
          </svg>
          {repeat === 'one' && (
            <span className="absolute -top-1 -right-1 text-[10px] font-bold text-emerald-400">1</span>
          )}
        </button>
      </div>

      {/* Queue section */}
      <div className="flex-1 min-h-0 flex flex-col px-4">
        <div className="flex items-center gap-2 mb-3 px-2">
          <span className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">Next up</span>
          <span className="text-xs text-zinc-600">{queue.length} tracks</span>
        </div>

        {queue.length === 0 ? (
          <div className="flex-1 flex items-center justify-center">
            <p className="text-sm text-zinc-600">Queue is empty</p>
          </div>
        ) : (
          <div className="flex-1 overflow-y-auto pb-4">
            {queue.map((track, index) => (
              <button
                key={`${track.id}-${index}`}
                onClick={() => jumpToTrack(index)}
                className="w-full flex items-center gap-3 px-2 py-2.5 rounded-lg hover:bg-zinc-800/50 transition text-left"
              >
                <span className="text-xs text-zinc-600 w-6 text-right">{index + 1}</span>
                {track.coverArt ? (
                  <img
                    src={`/api/cover/${track.coverArt}?size=40&token=${token}`}
                    alt=""
                    className="w-8 h-8 rounded object-cover flex-shrink-0"
                  />
                ) : (
                  <div className="w-8 h-8 rounded bg-zinc-800 flex-shrink-0" />
                )}
                <div className="min-w-0 flex-1">
                  <p className="text-sm text-zinc-200 truncate">{track.title}</p>
                  <p className="text-xs text-zinc-500 truncate">{track.artist}</p>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
