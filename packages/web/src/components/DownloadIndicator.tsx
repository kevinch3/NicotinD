import { useState, useEffect, useCallback, useRef } from 'react';
import { api } from '@/lib/api';

interface Transfer {
  username: string;
  directories: Array<{
    directory: string;
    files: Array<{
      id: string;
      filename: string;
      state: string;
      size: number;
      bytesTransferred: number;
      percentComplete: number;
    }>;
  }>;
}

interface AlbumGroup {
  key: string;
  name: string;
  totalFiles: number;
  completedFiles: number;
  activeFiles: number;
  overallPercent: number;
  state: 'downloading' | 'queued' | 'done' | 'error';
}

function extractAlbumName(directory: string): string {
  const segments = directory.split('\\').filter(Boolean);
  return segments[segments.length - 1] ?? directory;
}

function groupByAlbum(downloads: Transfer[]): AlbumGroup[] {
  const groups: AlbumGroup[] = [];

  for (const transfer of downloads) {
    for (const dir of transfer.directories) {
      const name = extractAlbumName(dir.directory);
      const key = `${transfer.username}:${dir.directory}`;
      const files = dir.files;

      const completed = files.filter(f => f.state.includes('Succeeded')).length;
      const active = files.filter(f => f.state === 'InProgress').length;
      const errored = files.filter(f => f.state.includes('Errored') || f.state.includes('Cancelled')).length;

      const totalBytes = files.reduce((s, f) => s + f.size, 0);
      const transferredBytes = files.reduce((s, f) => s + f.bytesTransferred, 0);
      const overallPercent = totalBytes > 0 ? Math.round((transferredBytes / totalBytes) * 100) : 0;

      let state: AlbumGroup['state'] = 'queued';
      if (completed === files.length) state = 'done';
      else if (active > 0) state = 'downloading';
      else if (errored > 0 && completed + errored === files.length) state = 'error';

      groups.push({ key, name, totalFiles: files.length, completedFiles: completed, activeFiles: active, overallPercent, state });
    }
  }

  // Active/downloading first, then queued, then done
  const order: Record<string, number> = { downloading: 0, queued: 1, error: 2, done: 3 };
  return groups.sort((a, b) => order[a.state] - order[b.state]);
}

export function DownloadIndicator() {
  const [downloads, setDownloads] = useState<Transfer[]>([]);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const fetchDownloads = useCallback(async () => {
    try {
      const data = (await api.getDownloads()) as Transfer[];
      setDownloads(data);
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    fetchDownloads();
    const interval = setInterval(fetchDownloads, 3000);
    return () => clearInterval(interval);
  }, [fetchDownloads]);

  // Close dropdown on click outside
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    if (open) document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open]);

  const groups = groupByAlbum(downloads);
  const activeCount = groups.filter(g => g.state === 'downloading' || g.state === 'queued').length;

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen(o => !o)}
        className="relative p-1.5 text-zinc-400 hover:text-zinc-200 transition rounded-md hover:bg-zinc-800/50"
        title={activeCount > 0 ? `${activeCount} active downloads` : 'Downloads'}
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
          <polyline points="7 10 12 15 17 10" />
          <line x1="12" y1="15" x2="12" y2="3" />
        </svg>
        {activeCount > 0 && (
          <span className="absolute -top-1 -right-1 bg-blue-500 text-white text-[10px] font-bold rounded-full w-4 h-4 flex items-center justify-center">
            {activeCount}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-2 w-80 bg-zinc-900 border border-zinc-800 rounded-lg shadow-xl z-50 overflow-hidden">
          <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-800">
            <span className="text-sm font-semibold text-zinc-100">Downloads</span>
            <span className="text-xs text-zinc-500">
              {activeCount > 0 ? `${activeCount} active` : 'No active downloads'}
            </span>
          </div>

          <div className="max-h-80 overflow-y-auto">
            {groups.length === 0 && (
              <p className="text-center text-zinc-600 text-sm py-8">No downloads</p>
            )}

            {groups.map((group) => (
              <div
                key={group.key}
                className={`px-4 py-3 border-b border-zinc-800/50 last:border-0 ${group.state === 'done' ? 'opacity-60' : ''}`}
              >
                <div className="flex items-center justify-between mb-1">
                  <span className="text-sm text-zinc-200 truncate max-w-[200px]">
                    {group.name}
                  </span>
                  <span className={`text-xs font-medium ${stateColor(group.state)}`}>
                    {stateLabel(group)}
                  </span>
                </div>

                {group.state === 'downloading' && (
                  <div className="mt-1.5">
                    <div className="h-1 bg-zinc-800 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-blue-500 rounded-full transition-all"
                        style={{ width: `${group.overallPercent}%` }}
                      />
                    </div>
                  </div>
                )}

                <div className="text-xs text-zinc-500 mt-1">
                  {group.completedFiles} of {group.totalFiles} tracks
                  {group.state === 'done' && ' \u00b7 Playlist created'}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function stateColor(state: AlbumGroup['state']): string {
  switch (state) {
    case 'downloading': return 'text-blue-400';
    case 'queued': return 'text-zinc-500';
    case 'done': return 'text-emerald-400';
    case 'error': return 'text-red-400';
  }
}

function stateLabel(group: AlbumGroup): string {
  switch (group.state) {
    case 'downloading': return `${group.overallPercent}%`;
    case 'queued': return 'Queued';
    case 'done': return 'Done';
    case 'error': return 'Error';
  }
}
