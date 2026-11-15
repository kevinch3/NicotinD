/**
 * `xcrun simctl list devices available -j | bun run packages/e2e/ios/pick-simulator.ts`
 * prints `udid=…` and `name=…` for `$GITHUB_OUTPUT`. See lane.ts `pickSimulator`.
 */
import { pickSimulator, type SimctlList } from './lane.js';

const sim = pickSimulator(JSON.parse(await Bun.stdin.text()) as SimctlList);
console.log(`udid=${sim.udid}`);
console.log(`name=${sim.name} (${sim.runtime.replace(/^.*SimRuntime\./, '')})`);
