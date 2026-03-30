import { useState, useEffect } from 'react';
import { api, type TailscaleStatus } from '@/lib/api';
import { useAuthStore } from '@/stores/auth';
import { PasswordField } from '@/components/PasswordField';
import { useRemotePlaybackStore } from '@/stores/remote-playback';
import { wsClient } from '@/services/ws-client';
import { useThemeStore, THEME_PRESETS, type ThemeId } from '@/stores/theme';

interface ThemeSwatchProps {
  preset: { id: string; name: string };
  selected: boolean;
  onSelect: () => void;
}

function ThemeSwatch({ preset, selected, onSelect }: ThemeSwatchProps) {
  return (
    <button
      onClick={onSelect}
      data-theme={preset.id}
      className={`rounded-lg overflow-hidden border-2 transition-all text-left ${
        selected ? 'border-indigo-500' : 'border-transparent hover:border-theme'
      }`}
      aria-label={`Switch to ${preset.name} theme`}
    >
      <div
        className="h-10 flex flex-col gap-1 p-1.5"
        style={{ background: `var(--theme-bg, #09090b)` }}
      >
        <div
          className="h-2 rounded-sm w-full"
          style={{ background: `var(--theme-surface, #18181b)` }}
        />
        <div
          className="h-1.5 rounded-sm w-3/4"
          style={{ background: `var(--theme-surface-2, #27272a)` }}
        />
      </div>
      <div
        className="px-2 py-1.5 flex items-center justify-between"
        style={{ background: `var(--theme-surface, #18181b)` }}
      >
        <span
          className="text-xs font-semibold"
          style={{ color: `var(--theme-text-primary, #f4f4f5)` }}
        >
          {preset.name}
        </span>
        {selected && (
          <span className="text-indigo-400 text-xs">✓</span>
        )}
      </div>
    </button>
  );
}

export function SettingsPage() {
  const role = useAuthStore((s) => s.role);
  const isAdmin = role === 'admin';

  const theme = useThemeStore((s) => s.theme);
  const systemTheme = useThemeStore((s) => s.systemTheme);
  const setTheme = useThemeStore((s) => s.setTheme);
  const setSystemTheme = useThemeStore((s) => s.setSystemTheme);

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [listeningPort, setListeningPort] = useState(50000);
  const [enableUPnP, setEnableUPnP] = useState(true);
  const [isNewAccount, setIsNewAccount] = useState(false);
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

  // Remote playback state
  const { remoteEnabled, setRemoteEnabled, devices, activeDeviceId } = useRemotePlaybackStore();
  const myDeviceId = wsClient.getDeviceId();
  const [deviceName, setDeviceName] = useState(wsClient.getDeviceName());
  const [deviceNameSaved, setDeviceNameSaved] = useState(false);

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
        setListeningPort(data.listeningPort ?? 50000);
        setEnableUPnP(data.enableUPnP ?? true);
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
    if (isNewAccount && password !== confirmPassword) {
      setMessage({ type: 'error', text: 'Passwords do not match' });
      return;
    }

    setSaving(true);
    setMessage(null);

    try {
      const result = await api.saveSoulseekSettings(username.trim(), password.trim(), {
        listeningPort,
        enableUPnP,
      });
      setPassword('');
      setConfirmPassword('');

      if (result.connected) {
        setConfigured(true);
        setConnected(true);
        setMessage({
          type: 'success',
          text: isNewAccount
            ? `Account created — connected as ${result.username ?? username.trim()}`
            : `Connected as ${result.username ?? username.trim()}`,
        });
      } else {
        setConfigured(true);
        setMessage({
          type: isNewAccount ? 'error' : 'success',
          text: isNewAccount
            ? 'Connection failed — username may already be taken'
            : 'Service started — connection may take a moment',
        });
        // Poll once more after a delay
        setTimeout(async () => {
          try {
            const status = await api.getSoulseekStatus();
            setConnected(status.connected);
            if (status.connected) {
              setMessage({ type: 'success', text: 'Connected to Soulseek network' });
            }
          } catch {
            // ignore
          }
        }, 5000);
      }
    } catch (err) {
      setMessage({ type: 'error', text: err instanceof Error ? err.message : 'Failed to save settings' });
    } finally {
      setSaving(false);
    }
  }

  // Status indicator
  function StatusDot() {
    if (!configured) {
      return <span className="inline-block w-2.5 h-2.5 rounded-full bg-theme-muted" title="Not configured" />;
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
      <div className="max-w-2xl mx-auto px-4 py-5 md:px-6 md:py-8">
        <p className="text-theme-muted">Loading settings...</p>
      </div>
    );
  }

  return (
    <div className="max-w-2xl mx-auto px-4 py-5 md:px-6 md:py-8">
      <h1 className="text-xl font-bold text-theme-primary mb-8">Settings</h1>

      {/* ── Appearance ─────────────────────────────────────────────────── */}
      <section className="rounded-xl border border-theme bg-theme-surface/50 p-6 mb-6">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-theme-secondary mb-5">
          Appearance
        </h2>

        {/* System preference toggle */}
        <div className="flex items-start gap-3 mb-5">
          <button
            role="switch"
            aria-checked={systemTheme}
            onClick={() => setSystemTheme(!systemTheme)}
            className={`relative mt-0.5 w-9 h-5 rounded-full transition-colors flex-shrink-0 ${
              systemTheme ? 'bg-emerald-600' : 'bg-theme-hover'
            }`}
          >
            <span
              className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${
                systemTheme ? 'translate-x-4' : 'translate-x-0'
              }`}
            />
          </button>
          <div>
            <p className="text-sm text-theme-primary">Follow system theme</p>
            <p className="text-xs text-theme-muted mt-0.5">
              Automatically use light or dark based on your OS setting.
            </p>
          </div>
        </div>

        {/* Theme swatch grid */}
        <div className={`grid grid-cols-3 gap-2 transition-opacity ${systemTheme ? 'opacity-40 pointer-events-none' : ''}`}>
          {THEME_PRESETS.map((preset) => (
            <ThemeSwatch
              key={preset.id}
              preset={preset}
              selected={theme === preset.id}
              onSelect={() => setTheme(preset.id as ThemeId)}
            />
          ))}
        </div>
      </section>

      {/* Soulseek Network Section */}
      <section className="rounded-xl border border-theme bg-theme-surface/50 p-6">
        <div className="flex items-center gap-3 mb-6">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-theme-secondary">
            Soulseek Network
          </h2>
          <div className="flex items-center gap-2">
            <StatusDot />
            <span className="text-xs text-theme-muted">{statusLabel()}</span>
          </div>
        </div>

        {isAdmin ? (
          <form onSubmit={handleSave} className="space-y-4">
            {/* Account mode toggle */}
            <div className="flex gap-1 p-1 rounded-lg bg-theme-surface-2/50 w-fit">
              <button
                type="button"
                onClick={() => { setIsNewAccount(false); setConfirmPassword(''); setMessage(null); }}
                className={`px-3 py-1.5 rounded-md text-xs font-medium transition ${
                  !isNewAccount ? 'bg-theme-hover text-theme-primary' : 'text-theme-secondary hover:text-theme-primary'
                }`}
              >
                I have an account
              </button>
              <button
                type="button"
                onClick={() => { setIsNewAccount(true); setMessage(null); }}
                className={`px-3 py-1.5 rounded-md text-xs font-medium transition ${
                  isNewAccount ? 'bg-theme-hover text-theme-primary' : 'text-theme-secondary hover:text-theme-primary'
                }`}
              >
                Create new account
              </button>
            </div>

            <div>
              <label className="block text-sm text-theme-secondary mb-1.5">Username</label>
              <input
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="Soulseek username"
                className="w-full px-4 py-2.5 rounded-lg bg-theme-surface-2 border border-theme text-theme-primary placeholder-zinc-600 focus:outline-none focus:border-zinc-500 transition text-sm"
              />
            </div>
            <div>
              <label className="block text-sm text-theme-secondary mb-1.5">Password</label>
              <PasswordField
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={configured && !isNewAccount ? '••••••••' : 'Soulseek password'}
                autoComplete="new-password"
                inputClassName="px-4 py-2.5 rounded-lg bg-theme-surface-2 border border-theme text-theme-primary placeholder-zinc-600 focus:outline-none focus:border-zinc-500 transition text-sm"
              />
            </div>

            {isNewAccount && (
              <div>
                <label className="block text-sm text-theme-secondary mb-1.5">Confirm Password</label>
                <PasswordField
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  placeholder="Confirm password"
                  autoComplete="new-password"
                  inputClassName="px-4 py-2.5 rounded-lg bg-theme-surface-2 border border-theme text-theme-primary placeholder-zinc-600 focus:outline-none focus:border-zinc-500 transition text-sm"
                />
                {confirmPassword && password !== confirmPassword && (
                  <p className="text-xs text-red-400 mt-1">Passwords do not match</p>
                )}
              </div>
            )}

            {/* Network Settings */}
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm text-theme-secondary mb-1.5">Listening Port</label>
                <input
                  type="number"
                  value={listeningPort}
                  onChange={(e) => setListeningPort(Number(e.target.value))}
                  placeholder="50000"
                  className="w-full px-4 py-2.5 rounded-lg bg-theme-surface-2 border border-theme text-theme-primary placeholder-zinc-600 focus:outline-none focus:border-zinc-500 transition text-sm"
                />
                <p className="text-xs text-theme-muted mt-1">Port for incoming P2P connections.</p>
              </div>
              <div className="flex flex-col justify-center">
                <label className="flex items-center gap-2 cursor-pointer mt-2">
                  <input
                    type="checkbox"
                    checked={enableUPnP}
                    onChange={(e) => setEnableUPnP(e.target.checked)}
                    className="w-4 h-4 rounded border-theme bg-theme-surface-2 text-theme-primary focus:ring-0 focus:ring-offset-0"
                  />
                  <span className="text-sm text-theme-secondary">Enable UPnP</span>
                </label>
                <p className="text-xs text-theme-muted mt-1">Auto-forward port (requires router support).</p>
              </div>
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
              disabled={saving || !username.trim() || !password.trim() || (isNewAccount && password !== confirmPassword)}
              className="px-5 py-2.5 rounded-lg bg-zinc-100 text-zinc-900 text-sm font-semibold hover:bg-zinc-200 transition disabled:opacity-50"
            >
              {saving
                ? (isNewAccount ? 'Creating account...' : 'Saving...')
                : isNewAccount
                  ? 'Create Account & Connect'
                  : configured
                    ? 'Update & Reconnect'
                    : 'Save & Connect'}
            </button>
          </form>
        ) : (
          <div className="text-sm text-theme-muted">
            <p>Only administrators can change Soulseek settings.</p>
            {configured && username && (
              <p className="mt-2 text-theme-secondary">Connected as: {username}</p>
            )}
          </div>
        )}
      </section>

      {/* Tailscale Section */}
      {tsStatus?.available && (
        <section className="rounded-xl border border-theme bg-theme-surface/50 p-6 mt-6">
          <div className="flex items-center gap-3 mb-6">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-theme-secondary">
              Tailscale Remote Access
            </h2>
            <div className="flex items-center gap-2">
              <span
                className={`inline-block w-2.5 h-2.5 rounded-full ${
                  tsStatus.connected ? 'bg-emerald-500' : 'bg-theme-muted'
                }`}
                title={tsStatus.connected ? 'Connected' : 'Not connected'}
              />
              <span className="text-xs text-theme-muted">
                {tsStatus.connected ? 'Connected' : 'Not connected'}
              </span>
            </div>
          </div>

          {tsStatus.connected && (
            <div className="space-y-2 mb-4">
              {tsStatus.hostname && (
                <div>
                  <span className="text-xs text-theme-muted">Hostname: </span>
                  <span className="text-sm text-theme-primary font-mono">{tsStatus.hostname}</span>
                </div>
              )}
              {tsStatus.ip && (
                <div>
                  <span className="text-xs text-theme-muted">IP: </span>
                  <span className="text-sm text-theme-secondary font-mono">{tsStatus.ip}</span>
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
                  className="px-5 py-2.5 rounded-lg border border-theme text-theme-secondary text-sm font-medium hover:border-zinc-500 transition disabled:opacity-50"
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
                    inputClassName="w-full px-4 py-2.5 rounded-lg bg-theme-surface-2 border border-theme text-theme-primary placeholder-zinc-600 focus:outline-none focus:border-zinc-500 transition text-sm font-mono"
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
            <p className="text-sm text-theme-muted">
              Only administrators can manage Tailscale connection.
            </p>
          )}
        </section>
      )}

      {/* Remote Playback Section — available to all users */}
      <section className="rounded-xl border border-theme bg-theme-surface/50 p-6 mt-6">
        <div className="flex items-center gap-3 mb-6">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-theme-secondary">
            Remote Playback
          </h2>
        </div>

        <div className="space-y-5">
          {/* Opt-in toggle */}
          <div className="flex items-start gap-3">
            <button
              role="switch"
              aria-checked={remoteEnabled}
              onClick={async () => {
                const enabled = !remoteEnabled;
                if (enabled) {
                  // User-gesture audio unlock required for browser autoplay policy
                  const audio = document.querySelector('audio');
                  if (audio && audio.paused) {
                    try { await audio.play(); audio.pause(); } catch { /* ignore */ }
                  }
                }
                setRemoteEnabled(enabled);
              }}
              className={`relative mt-0.5 w-9 h-5 rounded-full transition-colors flex-shrink-0 ${
                remoteEnabled ? 'bg-emerald-600' : 'bg-theme-hover'
              }`}
            >
              <span
                className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${
                  remoteEnabled ? 'translate-x-4' : 'translate-x-0'
                }`}
              />
            </button>
            <div>
              <p className="text-sm text-theme-primary">Make this device available as an audio output</p>
              <p className="text-xs text-theme-muted mt-0.5">
                When enabled, other devices on your account can cast audio to this device.
              </p>
              {!remoteEnabled && (
                <p className="text-xs text-amber-500/80 mt-1">
                  This device is hidden from the device selector on other devices.
                </p>
              )}
            </div>
          </div>

          {/* Device name */}
          <div>
            <label className="block text-sm text-theme-secondary mb-1.5">This device's name</label>
            <div className="flex gap-2">
              <input
                type="text"
                value={deviceName}
                onChange={(e) => { setDeviceName(e.target.value); setDeviceNameSaved(false); }}
                placeholder="e.g. Living Room TV"
                className="flex-1 px-4 py-2.5 rounded-lg bg-theme-surface-2 border border-theme text-theme-primary placeholder-zinc-600 focus:outline-none focus:border-zinc-500 transition text-sm"
              />
              <button
                onClick={() => {
                  if (!deviceName.trim()) return;
                  wsClient.setDeviceName(deviceName.trim());
                  setDeviceNameSaved(true);
                }}
                disabled={!deviceName.trim() || deviceNameSaved}
                className="px-4 py-2.5 rounded-lg bg-theme-hover text-theme-primary text-sm font-medium hover:bg-theme-hover transition disabled:opacity-50"
              >
                {deviceNameSaved ? 'Saved' : 'Save'}
              </button>
            </div>
            <p className="text-xs text-theme-muted mt-1">Shown to other users when they switch playback devices.</p>
          </div>

          {/* Connected devices list */}
          <div>
            <p className="text-sm text-theme-secondary mb-2">Connected devices</p>
            {devices.length === 0 ? (
              <p className="text-sm text-theme-muted">No devices online</p>
            ) : (
              <ul className="space-y-1">
                {devices.map(device => {
                  const isMe = device.id === myDeviceId;
                  const isHost = device.id === activeDeviceId;
                  const emoji = device.type === 'web'
                    ? (/iPhone|iPad|Android/i.test(device.name) ? '📱' : '🖥️')
                    : '🎵';
                  return (
                    <li key={device.id} className="flex items-center gap-2 text-sm">
                      <span>{emoji}</span>
                      <span className={isMe ? 'text-theme-primary' : 'text-theme-secondary'}>
                        {device.name}
                      </span>
                      {isMe && <span className="text-xs text-theme-muted">(this device)</span>}
                      {isHost && (
                        <span className="ml-auto text-xs font-semibold tracking-wide px-1.5 py-0.5 rounded bg-emerald-900/60 text-emerald-400">
                          HOST
                        </span>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
