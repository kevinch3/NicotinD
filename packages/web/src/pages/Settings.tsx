import { useState, useEffect } from 'react';
import { api, type TailscaleStatus } from '@/lib/api';
import { useAuthStore } from '@/stores/auth';
import { PasswordField } from '@/components/PasswordField';

export function SettingsPage() {
  const role = useAuthStore((s) => s.role);
  const isAdmin = role === 'admin';

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [configured, setConfigured] = useState(false);
  const [connected, setConnected] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [loading, setLoading] = useState(true);

  // Tailscale state
  const [tsStatus, setTsStatus] = useState<TailscaleStatus | null>(null);
  const [tsAuthKey, setTsAuthKey] = useState('');
  const [tsSaving, setTsSaving] = useState(false);
  const [tsMessage, setTsMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  useEffect(() => {
    loadSettings();
    loadTailscaleStatus();
  }, []);

  async function loadTailscaleStatus() {
    try {
      const status = await api.getTailscaleStatus();
      setTsStatus(status);
    } catch {
      // Tailscale endpoint not available
    }
  }

  async function loadSettings() {
    setLoading(true);
    try {
      if (isAdmin) {
        const data = await api.getSoulseekSettings();
        setUsername(data.username);
        setConfigured(data.configured);
        setConnected(data.connected);
      } else {
        const data = await api.getSoulseekStatus();
        setConfigured(data.configured);
        setConnected(data.connected);
        setUsername(data.username ?? '');
      }
    } catch {
      // settings endpoint not available
    } finally {
      setLoading(false);
    }
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (!username.trim() || !password.trim()) return;

    setSaving(true);
    setMessage(null);

    try {
      await api.saveSoulseekSettings(username.trim(), password.trim());
      setMessage({ type: 'success', text: 'Credentials saved — connecting to Soulseek network...' });
      setPassword('');

      // Poll status after a short delay to let slskd connect
      setTimeout(async () => {
        try {
          const status = await api.getSoulseekStatus();
          setConfigured(status.configured);
          setConnected(status.connected);
          if (status.connected) {
            setMessage({ type: 'success', text: 'Connected to Soulseek network' });
          } else {
            setMessage({ type: 'success', text: 'Service started — connection may take a moment' });
          }
        } catch {
          // ignore
        }
      }, 3000);
    } catch (err) {
      setMessage({ type: 'error', text: err instanceof Error ? err.message : 'Failed to save settings' });
    } finally {
      setSaving(false);
    }
  }

  // Status indicator
  function StatusDot() {
    if (!configured) {
      return <span className="inline-block w-2.5 h-2.5 rounded-full bg-zinc-600" title="Not configured" />;
    }
    if (connected) {
      return <span className="inline-block w-2.5 h-2.5 rounded-full bg-emerald-500" title="Connected" />;
    }
    return <span className="inline-block w-2.5 h-2.5 rounded-full bg-amber-500" title="Disconnected" />;
  }

  function statusLabel() {
    if (!configured) return 'Not configured';
    if (connected) return 'Connected';
    return 'Disconnected';
  }

  if (loading) {
    return (
      <div className="max-w-2xl mx-auto px-6 py-8">
        <p className="text-zinc-500">Loading settings...</p>
      </div>
    );
  }

  return (
    <div className="max-w-2xl mx-auto px-6 py-8">
      <h1 className="text-xl font-bold text-zinc-100 mb-8">Settings</h1>

      {/* Soulseek Network Section */}
      <section className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-6">
        <div className="flex items-center gap-3 mb-6">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-zinc-400">
            Soulseek Network
          </h2>
          <div className="flex items-center gap-2">
            <StatusDot />
            <span className="text-xs text-zinc-500">{statusLabel()}</span>
          </div>
        </div>

        {isAdmin ? (
          <form onSubmit={handleSave} className="space-y-4">
            <div>
              <label className="block text-sm text-zinc-400 mb-1.5">Username</label>
              <input
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="Soulseek username"
                className="w-full px-4 py-2.5 rounded-lg bg-zinc-800 border border-zinc-700 text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-zinc-500 transition text-sm"
              />
            </div>
            <div>
              <label className="block text-sm text-zinc-400 mb-1.5">Password</label>
              <PasswordField
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={configured ? '••••••••' : 'Soulseek password'}
                autoComplete="new-password"
                inputClassName="px-4 py-2.5 rounded-lg bg-zinc-800 border border-zinc-700 text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-zinc-500 transition text-sm"
              />
            </div>

            {message && (
              <div
                className={`px-4 py-2.5 rounded-lg text-sm ${
                  message.type === 'success'
                    ? 'bg-emerald-950/50 border border-emerald-900/50 text-emerald-400'
                    : 'bg-red-950/50 border border-red-900/50 text-red-400'
                }`}
              >
                {message.text}
              </div>
            )}

            <button
              type="submit"
              disabled={saving || !username.trim() || !password.trim()}
              className="px-5 py-2.5 rounded-lg bg-zinc-100 text-zinc-900 text-sm font-semibold hover:bg-zinc-200 transition disabled:opacity-50"
            >
              {saving ? 'Saving...' : configured ? 'Update & Reconnect' : 'Save & Connect'}
            </button>
          </form>
        ) : (
          <div className="text-sm text-zinc-500">
            <p>Only administrators can change Soulseek settings.</p>
            {configured && username && (
              <p className="mt-2 text-zinc-400">Connected as: {username}</p>
            )}
          </div>
        )}
      </section>

      {/* Tailscale Section */}
      {tsStatus?.available && (
        <section className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-6 mt-6">
          <div className="flex items-center gap-3 mb-6">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-zinc-400">
              Tailscale Remote Access
            </h2>
            <div className="flex items-center gap-2">
              <span
                className={`inline-block w-2.5 h-2.5 rounded-full ${
                  tsStatus.connected ? 'bg-emerald-500' : 'bg-zinc-600'
                }`}
                title={tsStatus.connected ? 'Connected' : 'Not connected'}
              />
              <span className="text-xs text-zinc-500">
                {tsStatus.connected ? 'Connected' : 'Not connected'}
              </span>
            </div>
          </div>

          {tsStatus.connected && (
            <div className="space-y-2 mb-4">
              {tsStatus.hostname && (
                <div>
                  <span className="text-xs text-zinc-500">Hostname: </span>
                  <span className="text-sm text-zinc-200 font-mono">{tsStatus.hostname}</span>
                </div>
              )}
              {tsStatus.ip && (
                <div>
                  <span className="text-xs text-zinc-500">IP: </span>
                  <span className="text-sm text-zinc-300 font-mono">{tsStatus.ip}</span>
                </div>
              )}
            </div>
          )}

          {isAdmin && (
            <>
              {tsStatus.connected ? (
                <button
                  onClick={async () => {
                    setTsSaving(true);
                    setTsMessage(null);
                    try {
                      await api.disconnectTailscale();
                      setTsStatus({ ...tsStatus, connected: false, hostname: undefined, ip: undefined });
                      setTsMessage({ type: 'success', text: 'Disconnected from Tailscale' });
                    } catch (err) {
                      setTsMessage({ type: 'error', text: err instanceof Error ? err.message : 'Failed to disconnect' });
                    } finally {
                      setTsSaving(false);
                    }
                  }}
                  disabled={tsSaving}
                  className="px-5 py-2.5 rounded-lg border border-zinc-700 text-zinc-300 text-sm font-medium hover:border-zinc-500 transition disabled:opacity-50"
                >
                  {tsSaving ? 'Disconnecting...' : 'Disconnect'}
                </button>
              ) : (
                <div className="space-y-3">
                  <PasswordField
                    value={tsAuthKey}
                    onChange={(e) => setTsAuthKey(e.target.value)}
                    placeholder="tskey-auth-..."
                    autoComplete="off"
                    inputClassName="w-full px-4 py-2.5 rounded-lg bg-zinc-800 border border-zinc-700 text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-zinc-500 transition text-sm font-mono"
                  />
                  <button
                    onClick={async () => {
                      if (!tsAuthKey.trim()) return;
                      setTsSaving(true);
                      setTsMessage(null);
                      try {
                        const status = await api.connectTailscale(tsAuthKey.trim());
                        setTsStatus(status);
                        setTsAuthKey('');
                        setTsMessage({ type: 'success', text: `Connected as ${status.hostname ?? 'nicotind'}` });
                      } catch (err) {
                        setTsMessage({ type: 'error', text: err instanceof Error ? err.message : 'Failed to connect' });
                      } finally {
                        setTsSaving(false);
                      }
                    }}
                    disabled={tsSaving || !tsAuthKey.trim()}
                    className="px-5 py-2.5 rounded-lg bg-zinc-100 text-zinc-900 text-sm font-semibold hover:bg-zinc-200 transition disabled:opacity-50"
                  >
                    {tsSaving ? 'Connecting...' : 'Connect'}
                  </button>
                </div>
              )}

              {tsMessage && (
                <div
                  className={`mt-3 px-4 py-2.5 rounded-lg text-sm ${
                    tsMessage.type === 'success'
                      ? 'bg-emerald-950/50 border border-emerald-900/50 text-emerald-400'
                      : 'bg-red-950/50 border border-red-900/50 text-red-400'
                  }`}
                >
                  {tsMessage.text}
                </div>
              )}
            </>
          )}

          {!isAdmin && !tsStatus.connected && (
            <p className="text-sm text-zinc-500">
              Only administrators can manage Tailscale connection.
            </p>
          )}
        </section>
      )}
    </div>
  );
}
