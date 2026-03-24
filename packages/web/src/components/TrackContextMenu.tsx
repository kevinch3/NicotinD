import { useNavigateAndSearch } from '@/hooks/useNavigateAndSearch';

interface TrackContextMenuProps {
  artist: string;
  trackId?: string;
  trackTitle?: string;
  onFindSimilar?: (id: string) => void;
  onClose: () => void;
  position: { x: number; y: number };
}

export function TrackContextMenu({
  artist,
  trackId,
  trackTitle,
  onFindSimilar,
  onClose,
  position,
}: TrackContextMenuProps) {
  const navigateAndSearch = useNavigateAndSearch();

  return (
    <>
      <div className="fixed inset-0 z-[70]" onClick={onClose} />
      <div
        className="fixed z-[80] bg-zinc-900 border border-zinc-700 rounded-lg shadow-xl py-1 min-w-[180px]"
        style={{ top: position.y, left: position.x }}
      >
        <button
          onClick={() => { navigateAndSearch(artist); onClose(); }}
          className="w-full text-left px-4 py-2 text-sm text-zinc-300 hover:bg-zinc-800 transition"
        >
          Search more by artist
        </button>
        {onFindSimilar && trackId && (
          <button
            onClick={() => { onFindSimilar(trackId); onClose(); }}
            className="w-full text-left px-4 py-2 text-sm text-zinc-300 hover:bg-zinc-800 transition"
          >
            Find similar to "{trackTitle ?? 'this track'}"
          </button>
        )}
      </div>
    </>
  );
}
