import { usePreserveStore } from '@/stores/preserve';
import { useAuthStore } from '@/stores/auth';
import type { Track } from '@/stores/player';

interface PreserveButtonProps {
  track: Track;
  className?: string;
  size?: 'sm' | 'md';
}

export function PreserveButton({ track, className = '', size = 'sm' }: PreserveButtonProps) {
  const token = useAuthStore((s) => s.token);
  const preserve = usePreserveStore((s) => s.preserve);
  const remove = usePreserveStore((s) => s.remove);
  const preserved = usePreserveStore((s) => s.preservedIds.has(track.id));
  const preserving = usePreserveStore((s) => s.preserving.has(track.id));

  const iconSize = size === 'sm' ? 14 : 18;
  const btnSize = size === 'sm' ? 'w-7 h-7' : 'w-8 h-8';

  function handleClick(e: React.MouseEvent) {
    e.stopPropagation();
    if (preserving) return;
    if (preserved) {
      remove(track.id);
    } else {
      preserve(track, token!);
    }
  }

  // Spinner while preserving
  if (preserving) {
    return (
      <button
        className={`${btnSize} flex items-center justify-center text-zinc-400 ${className}`}
        title="Preserving..."
        disabled
      >
        <svg
          width={iconSize}
          height={iconSize}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="animate-spin"
        >
          <path d="M21 12a9 9 0 1 1-3-6.7" />
          <polyline points="21 3 21 9 15 9" />
        </svg>
      </button>
    );
  }

  // Preserved — filled icon
  if (preserved) {
    return (
      <button
        onClick={handleClick}
        className={`${btnSize} flex items-center justify-center text-emerald-400 hover:text-emerald-300 transition ${className}`}
        title="Remove from preserved"
      >
        <svg
          width={iconSize}
          height={iconSize}
          viewBox="0 0 24 24"
          fill="currentColor"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
          <polyline points="7 10 12 15 17 10" />
          <line x1="12" y1="15" x2="12" y2="3" />
        </svg>
      </button>
    );
  }

  // Not preserved — outline icon
  return (
    <button
      onClick={handleClick}
      className={`${btnSize} flex items-center justify-center text-zinc-500 hover:text-zinc-300 transition ${className}`}
      title="Preserve for offline"
    >
      <svg
        width={iconSize}
        height={iconSize}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
        <polyline points="7 10 12 15 17 10" />
        <line x1="12" y1="15" x2="12" y2="3" />
      </svg>
    </button>
  );
}
