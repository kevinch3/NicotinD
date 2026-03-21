import { NavLink, Outlet } from 'react-router-dom';
import { Player } from './Player';
import { DownloadIndicator } from './DownloadIndicator';
import { useAuthStore } from '@/stores/auth';
import { usePlayerStore } from '@/stores/player';

const navItems = [
  { to: '/', label: 'Search' },
  { to: '/playlists', label: 'Playlists' },
  { to: '/library', label: 'Library' },
  { to: '/settings', label: 'Settings' },
];

export function Layout() {
  const logout = useAuthStore((s) => s.logout);
  const username = useAuthStore((s) => s.username);
  const hasTrack = usePlayerStore((s) => !!s.currentTrack);

  return (
    <div className="min-h-screen flex flex-col bg-zinc-950">
      {/* Top nav */}
      <header className="flex items-center justify-between px-6 py-3 border-b border-zinc-800 bg-zinc-950/80 backdrop-blur-sm sticky top-0 z-40">
        <div className="flex items-center gap-6">
          <span className="text-lg font-bold text-zinc-100">NicotinD</span>
          <nav className="flex gap-1">
            {navItems.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.to === '/'}
                className={({ isActive }) =>
                  `px-3 py-1.5 rounded-md text-sm font-medium transition ${
                    isActive
                      ? 'bg-zinc-800 text-zinc-100'
                      : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/50'
                  }`
                }
              >
                {item.label}
              </NavLink>
            ))}
          </nav>
        </div>
        <div className="flex items-center gap-3">
          <DownloadIndicator />
          <span className="text-sm text-zinc-500">{username}</span>
          <button
            onClick={logout}
            className="text-sm text-zinc-500 hover:text-zinc-300 transition"
          >
            Sign out
          </button>
        </div>
      </header>

      {/* Content */}
      <main className={`flex-1 ${hasTrack ? 'pb-20' : ''}`}>
        <Outlet />
      </main>

      {/* Bottom player */}
      <Player />
    </div>
  );
}
