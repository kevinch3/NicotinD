import { useState, useEffect } from 'react';
import { api } from '@/lib/api';

interface Transfer {
  username: string;
  directories: Array<{
    directory: string;
    files: Array<{
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

  useEffect(() => {
    let active = true;
    async function poll() {
      try {
        const data = (await api.getDownloads()) as Transfer[];
        if (active) setDownloads(data);
      } catch {
        // ignore
      } finally {
        if (active) setLoading(false);
      }
    }
    poll();
    const interval = setInterval(poll, 3000);
    return () => { active = false; clearInterval(interval); };
  }, []);

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
        <span className="text-sm text-zinc-500">{totalFiles} files</span>
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
            dir.files.map((file) => (
              <div
                key={file.filename}
                className="flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-zinc-800/30 transition"
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
                <span className="text-xs text-zinc-600">
                  {(file.size / 1_000_000).toFixed(1)} MB
                </span>
              </div>
            )),
          )}
        </div>
      ))}
    </div>
  );
}
