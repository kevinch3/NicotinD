import { getCapacitorPlugin, isNativePlatform } from './platform';

/** `@capacitor/haptics`, reached through the Capacitor global so no
 *  `@capacitor/*` import lands in the web bundle (native-capabilities pattern).
 *  The plugin ships in packages/mobile. */
interface HapticsPlugin {
  impact(options: { style: 'LIGHT' | 'MEDIUM' | 'HEAVY' }): Promise<void>;
}

/** A light impact on the Capacitor shells; a no-op on the web, on Electron and
 *  wherever the plugin is missing. Fire-and-forget: a failed tick is silent. */
export function hapticTick(): void {
  if (!isNativePlatform()) return;
  const haptics = getCapacitorPlugin<HapticsPlugin>('Haptics');
  haptics?.impact({ style: 'LIGHT' }).catch(() => undefined);
}
