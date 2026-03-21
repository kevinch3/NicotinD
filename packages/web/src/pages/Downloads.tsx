import { useState, useEffect, useCallback } from 'react';
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

export function DownloadsPage() {
  const [downloads, setDownloads] = useState<Transfer[]>([]);
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [deleting, setDeleting] = useState<Set<string>>(new Set());

  const handleScan = useCallback(async () => {
    setScanning(true);
    try {
      await api.triggerScan();
    } catch {
      // ignore
    } finally {
      setTimeout(() => setScanning(false), 2000);
    }
  }, []);

  const fetchDownloads = useCallback(async () => {
    try {
      const data = (await api.getDownloads()) as Transfer[];
      setDownloads(data);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let active = true;
    async function poll() {
      if (!active) return;
      await fetchDownloads();
    }
    poll();
    const interval = setInterval(poll, 3000);
    return () => { active = false; clearInterval(interval); };
  }, [fetchDownloads]);

  async function handleDelete(username: string, id: string) {
    const key = `${username}:${id}`;
    setDeleting((prev) => new Set(prev).add(key));
    try {
      await api.cancelDownload(username, id);
      await fetchDownloads();
    } catch {
      // ignore
    } finally {
      setDeleting((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }
  }

  function stateLabel(state: string) {
    const map: Record<string, string> = {
      Completed: 'Done',
      'Completed, Succeeded': 'Done',
      InProgress: 'Downloading',
      Queued: 'Queued',
      'Queued, Remotely': 'Remote Queue',
      Errored: 'Error',
      Cancelled: 'Cancelled',
    };
    return map[state] ?? state;
  }

  function stateColor(state: string) {
    if (state.includes('Completed') || state.includes('Succeeded')) return 'text-emerald-400';
    if (state.includes('InProgress')) return 'text-blue-400';
    if (state.includes('Error') || state.includes('Cancelled')) return 'text-red-400';
    return 'text-zinc-500';
  }

  function extractName(filepath: string) {
    const parts = filepath.split('\\');
    return parts[parts.length - 1];
  }

  const totalFiles = downloads.reduce(
    (sum, d) => sum + d.directories.reduce((s, dir) => s + dir.files.length, 0),
    0,
  );

  return (
    <div className="max-w-4xl mx-auto px-6 py-8">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-lg font-semibold text-zinc-100">Downloads</h1>
        <div className="flex items-center gap-3">
          <span className="text-sm text-zinc-500">{totalFiles} files</span>
          <button
            onClick={handleScan}
            disabled={scanning}
            className="px-3 py-1.5 rounded-md text-xs font-medium bg-zinc-800 text-zinc-300 hover:bg-zinc-700 transition disabled:opacity-50"
          >
            {scanning ? 'Scanning...' : 'Scan Library'}
          </button>
        </div>
      </div>

      {loading && (
        <div className="text-center py-20">
          <span className="inline-block w-5 h-5 border-2 border-zinc-600 border-t-zinc-300 rounded-full animate-spin" />
        </div>
      )}

      {!loading && downloads.length === 0 && (
        <p className="text-center text-zinc-600 py-20">No downloads yet</p>
      )}

      {downloads.map((transfer) => (
        <div key={transfer.username} className="mb-6">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-zinc-500 mb-2 px-3">
            {transfer.username}
          </h2>
          {transfer.directories.map((dir) =>
            dir.files.map((file) => {
              const isDeleting = deleting.has(`${transfer.username}:${file.id}`);
              const isDone = file.state.includes('Completed') || file.state.includes('Succeeded') || file.state.includes('Cancelled') || file.state.includes('Errored');
              return (
                <div
                  key={file.id}
                  className="flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-zinc-800/30 transition group"
                >
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-zinc-200 truncate">{extractName(file.filename)}</p>
                    <div className="flex items-center gap-2 mt-1">
                      <span className={`text-xs font-medium ${stateColor(file.state)}`}>
                        {stateLabel(file.state)}
                      </span>
                      {file.state.includes('InProgress') && (
                        <div className="flex-1 max-w-32 h-1 bg-zinc-800 rounded-full">
                          <div
                            className="h-full bg-blue-500 rounded-full transition-all"
                            style={{ width: `${file.percentComplete}%` }}
                          />
                        </div>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-4">
                    <span className="text-xs text-zinc-600">
                      {(file.size / 1_000_000).toFixed(1)} MB
                    </span>
                    <button
                      onClick={() => handleDelete(transfer.username, file.id)}
                      disabled={isDeleting}
                      className="p-1.5 text-zinc-500 hover:text-red-400 hover:bg-red-500/10 rounded-md transition disabled:opacity-50 opacity-0 group-hover:opacity-100"
                      title={isDone ? 'Remove' : 'Cancel'}
                    >
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <line x1="18" y1="6" x2="6" y2="18" />
                        <line x1="6" y1="6" x2="18" y2="18" />
                      </svg>
                    </button>
                  </div>
                </div>
              );
            }),
          )}
        </div>
      ))}
    </div>
  );
}
