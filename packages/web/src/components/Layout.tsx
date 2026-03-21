import { useState, useEffect } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { Player } from './Player';
import { NowPlaying } from './NowPlaying';
import { DownloadIndicator } from './DownloadIndicator';
import { useAuthStore } from '@/stores/auth';
import { usePlayerStore } from '@/stores/player';

const navItems = [
  { to: '/', label: 'Search' },
  { to: '/downloads', label: 'Downloads' },
  { to: '/playlists', label: 'Playlists' },
  { to: '/library', label: 'Library' },
  { to: '/settings', label: 'Settings' },
];

export function Layout() {
  const logout = useAuthStore((s) => s.logout);
  const username = useAuthStore((s) => s.username);
  const hasTrack = usePlayerStore((s) => !!s.currentTrack);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const location = useLocation();

  // Close drawer on navigation
  useEffect(() => {
    setDrawerOpen(false);
  }, [location.pathname]);

  return (
    <div className="min-h-screen flex flex-col bg-zinc-950">
      {/* Top nav */}
      <header className="flex items-center justify-between px-4 md:px-6 py-3 border-b border-zinc-800 bg-zinc-950/80 backdrop-blur-sm sticky top-0 z-40">
        <div className="flex items-center gap-4 md:gap-6">
          <span className="text-lg font-bold text-zinc-100">NicotinD</span>
          {/* Desktop nav */}
          <nav className="hidden md:flex gap-1">
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
          <span className="hidden md:inline text-sm text-zinc-500">{username}</span>
          <button
            onClick={logout}
            className="hidden md:inline text-sm text-zinc-500 hover:text-zinc-300 transition"
          >
            Sign out
          </button>
          {/* Hamburger - mobile only */}
          <button
            onClick={() => setDrawerOpen(true)}
            className="md:hidden w-8 h-8 flex items-center justify-center text-zinc-400 hover:text-zinc-100 transition"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <line x1="3" y1="6" x2="21" y2="6" />
              <line x1="3" y1="12" x2="21" y2="12" />
              <line x1="3" y1="18" x2="21" y2="18" />
            </svg>
          </button>
        </div>
      </header>

      {/* Mobile drawer backdrop */}
      {drawerOpen && (
        <div
          className="fixed inset-0 z-[45] bg-black/50 md:hidden"
          onClick={() => setDrawerOpen(false)}
        />
      )}

      {/* Mobile drawer */}
      <div
        className={`fixed top-0 left-0 h-full w-64 bg-zinc-900 z-50 transform transition-transform duration-200 ease-out md:hidden flex flex-col ${
          drawerOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <div className="px-4 py-4 border-b border-zinc-800">
          <span className="text-lg font-bold text-zinc-100">NicotinD</span>
        </div>
        <nav className="flex-1 py-2">
          {navItems.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === '/'}
              className={({ isActive }) =>
                `block px-4 py-3 text-sm font-medium transition ${
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
        <div className="px-4 py-4 border-t border-zinc-800">
          <p className="text-sm text-zinc-500 mb-2">{username}</p>
          <button
            onClick={logout}
            className="text-sm text-zinc-500 hover:text-zinc-300 transition"
          >
            Sign out
          </button>
        </div>
      </div>

      {/* Content */}
      <main className={`flex-1 ${hasTrack ? 'pb-20' : ''}`}>
        <Outlet />
      </main>

      {/* Bottom player */}
      <Player />

      {/* Now Playing overlay */}
      <NowPlaying />
    </div>
  );
}
