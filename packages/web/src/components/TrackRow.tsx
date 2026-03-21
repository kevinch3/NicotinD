import type { ReactNode } from 'react';
import { useAuthStore } from '@/stores/auth';
import { usePreserveStore } from '@/stores/preserve';
import type { Track } from '@/stores/player';

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
  const preserve = usePreserveStore((s) => s.preserve);
  const removePreserved = usePreserveStore((s) => s.remove);
  const preserving = usePreserveStore((s) => s.preserving.has(track.id));
  const preserved = usePreserveStore((s) => s.preservedIds.has(track.id));

  return (
    <div
      className={`flex items-center gap-2 px-3 py-2.5 rounded-lg hover:bg-zinc-800/50 transition group ${
        disabled ? 'opacity-40 pointer-events-none' : ''
      }`}
    >
      <span className="text-xs text-zinc-600 w-6 text-right">{indexLabel ?? ''}</span>
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
      <button
        type="button"
        onClick={() => {
          if (preserved) {
            removePreserved(track.id);
            return;
          }
          preserve(track, token);
        }}
        disabled={preserving || (!preserved && !token)}
        className={`px-2.5 py-1 rounded-md text-xs font-medium transition flex-shrink-0 ${
          preserved
            ? 'bg-emerald-500/15 text-emerald-300 hover:bg-emerald-500/25'
            : 'bg-zinc-800 text-zinc-300 hover:bg-zinc-700'
        } disabled:opacity-40 disabled:cursor-not-allowed`}
        title={preserved ? 'Remove from preserved' : 'Preserve for offline'}
      >
        {preserving ? 'Preserving...' : preserved ? 'Unpreserve' : 'Preserve'}
      </button>
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
