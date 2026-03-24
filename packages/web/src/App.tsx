import { useState, useEffect } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { useAuthStore } from '@/stores/auth';
import { usePreserveStore } from '@/stores/preserve';
import { useTransferStore } from '@/stores/transfers';
import { api, type SetupStatus } from '@/lib/api';
import { Layout } from '@/components/Layout';
import { LoginPage } from '@/pages/Login';
import { SetupPage } from '@/pages/Setup';
import { SearchPage } from '@/pages/Search';
import { DownloadsPage } from '@/pages/Downloads';
import { PlaylistsPage } from '@/pages/Playlists';
import { LibraryPage } from '@/pages/Library';
import { SettingsPage } from '@/pages/Settings';
import { AdminPage } from '@/pages/Admin';
import { RemotePlaybackProvider } from '@/components/RemotePlaybackProvider';

export function App() {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const role = useAuthStore((s) => s.role);
  const [setupStatus, setSetupStatus] = useState<SetupStatus | null>(null);
  const [setupChecked, setSetupChecked] = useState(false);

  useEffect(() => {
    api.getSetupStatus()
      .then((status) => {
        setSetupStatus(status);
        setSetupChecked(true);
      })
      .catch(() => {
        // API not available or setup endpoint missing — skip setup
        setSetupChecked(true);
      });
  }, []);

  // Hydrate preserve store from IndexedDB once authenticated
  useEffect(() => {
    if (isAuthenticated) {
      usePreserveStore.getState().init();
    }
  }, [isAuthenticated]);

  // Start/stop global transfer polling on auth state change
  useEffect(() => {
    if (isAuthenticated) {
      useTransferStore.getState().startPolling();
    } else {
      useTransferStore.getState().stopPolling();
    }
  }, [isAuthenticated]);

  if (!setupChecked) {
    return null;
  }

  if (setupStatus?.needsSetup) {
    return <SetupPage setupStatus={setupStatus} />;
  }

  if (!isAuthenticated) {
    return <LoginPage />;
  }

  return (
    <RemotePlaybackProvider>
      <BrowserRouter>
        <Routes>
          <Route element={<Layout />}>
            <Route path="/" element={<SearchPage />} />
            <Route path="/downloads" element={<DownloadsPage />} />
            <Route path="/playlists" element={<PlaylistsPage />} />
            <Route path="/library" element={<LibraryPage />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="/admin" element={role === 'admin' ? <AdminPage /> : <Navigate to="/" />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </RemotePlaybackProvider>
  );
}
