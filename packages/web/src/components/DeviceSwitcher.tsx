import { useRemotePlaybackStore } from '@/stores/remote-playback';
import { wsClient } from '@/services/ws-client';
import { useEffect, useRef } from 'react';

export function DeviceSwitcher() {
  const { devices, activeDeviceId, switcherOpen, setSwitcherOpen, switchToDevice } =
    useRemotePlaybackStore();
  const myId = wsClient.getDeviceId();
  const ref = useRef<HTMLDivElement>(null);

  // Close on outside click
  useEffect(() => {
    if (!switcherOpen) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setSwitcherOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [switcherOpen, setSwitcherOpen]);

  const activeDevice = devices.find(d => d.id === activeDeviceId);

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setSwitcherOpen(!switcherOpen)}
        title="Switch playback device"
        className={`w-7 h-7 flex items-center justify-center rounded-full transition ${
          activeDeviceId && activeDeviceId !== myId
            ? 'text-emerald-400'
            : 'text-zinc-500 hover:text-zinc-300'
        }`}
      >
        {/* Speaker / Cast icon */}
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="2" y="7" width="8" height="10" rx="1" />
          <polygon points="14,5 22,3 22,21 14,19" />
        </svg>
      </button>

      {switcherOpen && (
        <div className="absolute bottom-10 right-0 w-64 bg-zinc-800 border border-zinc-700 rounded-xl shadow-2xl overflow-hidden z-50">
          <div className="px-4 py-3 border-b border-zinc-700">
            <p className="text-xs font-semibold text-zinc-400 uppercase tracking-widest">Output Device</p>
          </div>
          <ul className="py-1 max-h-64 overflow-y-auto">
            {devices.length === 0 && (
              <li className="px-4 py-3 text-sm text-zinc-500 text-center">No devices online</li>
            )}
            {devices.map(device => {
              const isMe = device.id === myId;
              const isActive = device.id === activeDeviceId;
              return (
                <li key={device.id}>
                  <button
                    className={`w-full flex items-center gap-3 px-4 py-2.5 text-sm transition hover:bg-zinc-700 ${
                      isActive ? 'text-zinc-100' : 'text-zinc-400'
                    }`}
                    onClick={() => {
                      switchToDevice(device.id);
                      setSwitcherOpen(false);
                    }}
                  >
                    <span className="text-base leading-none">
                      {device.type === 'web' ? (device.name.includes('Mobile') ? '📱' : '🖥️') : '🎵'}
                    </span>
                    <span className="flex-1 text-left truncate">
                      {device.name} {isMe ? <span className="text-zinc-600">(this device)</span> : ''}
                    </span>
                    {isActive && (
                      <span className="w-2 h-2 rounded-full bg-emerald-400 flex-shrink-0 animate-pulse" />
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
          <div className="px-4 py-2 border-t border-zinc-700 text-xs text-zinc-600 truncate">
            Playing on: {activeDevice?.name ?? 'None'}
          </div>
        </div>
      )}
    </div>
  );
}
