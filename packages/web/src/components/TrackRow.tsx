import type { ReactNode } from 'react';
import { useAuthStore } from '@/stores/auth';
import { PreserveButton } from '@/components/PreserveButton';
import type { Track } from '@/stores/player';
import { CoverArt } from '@/components/CoverArt';

interface TrailingAction {
  title: string;
  onClick: () => void;
  icon: ReactNode;
}

interface TrackRowProps {
  track: Track;
  indexLabel?: string | number;
  subtitle?: string;
  onPlay: () => void;
  duration?: number;
  disabled?: boolean;
  trailingAction?: TrailingAction;
}

function formatDuration(seconds?: number) {
  if (!seconds) return '';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export function TrackRow({
  track,
  indexLabel,
  subtitle,
  onPlay,
  duration,
  disabled = false,
  trailingAction,
}: TrackRowProps) {
  const token = useAuthStore((s) => s.token);

  return (
    <div
      className={`flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-zinc-800/50 transition group ${
        disabled ? 'opacity-40 pointer-events-none' : ''
      }`}
    >
      <span className="text-xs text-zinc-600 w-6 text-right">{indexLabel ?? ''}</span>
      <CoverArt
        src={track.coverArt ? `/api/cover/${track.coverArt}?size=40&token=${token}` : undefined}
        artist={track.artist}
        album={track.album ?? ''}
        size={36}
        rounded="rounded"
      />
      <button type="button" onClick={onPlay} className="flex-1 min-w-0 text-left">
        <p className="text-sm text-zinc-200 truncate">{track.title}</p>
        {subtitle && <p className="text-xs text-zinc-500 truncate">{subtitle}</p>}
      </button>
      <span className="text-xs text-zinc-600">{formatDuration(duration ?? track.duration)}</span>
      <button
        type="button"
        onClick={onPlay}
        className="p-1 text-zinc-700 group-hover:text-zinc-300 transition flex-shrink-0"
        title="Play"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
          <polygon points="5,3 19,12 5,21" />
        </svg>
      </button>
      <PreserveButton track={track} className="flex-shrink-0" />
      {trailingAction && (
        <button
          type="button"
          onClick={trailingAction.onClick}
          className="p-1 text-zinc-700 hover:text-red-400 transition flex-shrink-0 opacity-0 group-hover:opacity-100"
          title={trailingAction.title}
        >
          {trailingAction.icon}
        </button>
      )}
    </div>
  );
}
