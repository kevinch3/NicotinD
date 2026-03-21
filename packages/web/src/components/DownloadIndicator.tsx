import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '@/lib/api';

interface Transfer {
  username: string;
  directories: Array<{
    directory: string;
    files: Array<{
      id: string;
      state: string;
    }>;
  }>;
}

export function DownloadIndicator() {
  const [activeCount, setActiveCount] = useState(0);
  const navigate = useNavigate();

  const fetchDownloads = useCallback(async () => {
    try {
      const data = (await api.getDownloads()) as Transfer[];
      let count = 0;
      for (const t of data) {
        for (const dir of t.directories) {
          const hasActive = dir.files.some(
            (f) => f.state === 'InProgress' || f.state === 'Queued' || f.state === 'Initializing',
          );
          if (hasActive) count++;
        }
      }
      setActiveCount(count);
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    fetchDownloads();
    const interval = setInterval(fetchDownloads, 3000);
    return () => clearInterval(interval);
  }, [fetchDownloads]);

  return (
    <button
      onClick={() => navigate('/downloads')}
      className="relative p-1.5 text-zinc-400 hover:text-zinc-200 transition rounded-md hover:bg-zinc-800/50"
      title={activeCount > 0 ? `${activeCount} active downloads` : 'Downloads'}
    >
      <svg
        width="18"
        height="18"
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
      {activeCount > 0 && (
        <span className="absolute -top-1 -right-1 bg-blue-500 text-white text-[10px] font-bold rounded-full w-4 h-4 flex items-center justify-center">
          {activeCount}
        </span>
      )}
    </button>
  );
}
