import { useRemotePlaybackStore } from '@/stores/remote-playback';
import { wsClient } from '@/services/ws-client';
import { useEffect, useRef } from 'react';

function deviceEmoji(name: string, type: string): string {
  if (type !== 'web') return '🎵';
  return /iPhone|iPad|Android/i.test(name) ? '📱' : '🖥️';
}

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

  const myDevice = devices.find(d => d.id === myId);
  const otherDevices = devices.filter(d => d.id !== myId);
  const isRemoteActive = activeDeviceId !== null && activeDeviceId !== myId;
  const activeDevice = devices.find(d => d.id === activeDeviceId);

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setSwitcherOpen(!switcherOpen)}
        title="Play on a device"
        className={`w-7 h-7 flex items-center justify-center rounded-full transition ${
          isRemoteActive
            ? 'text-emerald-400'
            : 'text-zinc-500 hover:text-zinc-300'
        }`}
      >
        {/* Cast icon */}
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="2" y="7" width="8" height="10" rx="1" />
          <polygon points="14,5 22,3 22,21 14,19" />
        </svg>
      </button>

      {switcherOpen && (
        <div className="absolute bottom-10 right-0 w-64 bg-zinc-800 border border-zinc-700 rounded-xl shadow-2xl overflow-hidden z-50">
          <div className="px-4 py-3 border-b border-zinc-700">
            <p className="text-xs font-semibold text-zinc-400 uppercase tracking-widest">Play on...</p>
          </div>

          {/* This device — always shown at top */}
          <div className="border-b border-zinc-700/60">
            <button
              className={`w-full flex items-center gap-3 px-4 py-2.5 text-sm transition hover:bg-zinc-700 ${
                activeDeviceId === null || activeDeviceId === myId ? 'text-zinc-100' : 'text-zinc-400'
              }`}
              onClick={() => {
                switchToDevice(myId);
                setSwitcherOpen(false);
              }}
            >
              <span className="text-base leading-none">
                {myDevice ? deviceEmoji(myDevice.name, myDevice.type) : '🖥️'}
              </span>
              <span className="flex-1 text-left truncate">
                {myDevice?.name ?? wsClient.getDeviceName()}
              </span>
              <span className="text-[10px] text-zinc-500 flex-shrink-0">this device</span>
              {(activeDeviceId === null || activeDeviceId === myId) && (
                <span className="w-2 h-2 rounded-full bg-emerald-400 flex-shrink-0 animate-pulse" />
              )}
            </button>
          </div>

          {/* Other remote devices */}
          <ul className="py-1 max-h-52 overflow-y-auto">
            {otherDevices.length === 0 && (
              <li className="px-4 py-3 text-sm text-zinc-500 text-center">No other devices online</li>
            )}
            {otherDevices.map(device => {
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
                      {deviceEmoji(device.name, device.type)}
                    </span>
                    <span className="flex-1 text-left truncate">{device.name}</span>
                    {isActive && (
                      <span className="flex-shrink-0 text-[10px] font-semibold tracking-wide px-1.5 py-0.5 rounded bg-emerald-900/70 text-emerald-400">
                        NOW PLAYING
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>

          {isRemoteActive && activeDevice && (
            <div className="px-4 py-2 border-t border-zinc-700 text-xs text-zinc-500 truncate">
              Playing on: <span className="text-zinc-400">{activeDevice.name}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
