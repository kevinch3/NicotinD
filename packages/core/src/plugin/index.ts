import type { PluginManifest } from './manifest.js';
import type { PluginHostContext } from './context.js';
import type {
  SearchCapability,
  BrowseCapability,
  ResolveCapability,
  DownloadCapability,
  LyricsCapability,
  GenreCapability,
  ConnectivityCapability,
} from './capabilities.js';

/**
 * A NicotinD plugin. First-party plugins are workspace modules registered at
 * build time and toggled on/off via the registry (the public, dynamically-loaded
 * SDK is a later milestone — these contracts are designed to outlive that change).
 *
 * Capability accessors are present iff the manifest declares them; the host
 * checks `manifest.capabilities` and uses the matching accessor.
 */
export interface Plugin {
  readonly manifest: PluginManifest;
  /** Called once when the plugin is enabled (or at boot if already enabled). */
  init(ctx: PluginHostContext): Promise<void>;
  /** Requirements satisfied + ready to serve right now (binary present, etc.). */
  isAvailable(): Promise<boolean>;
  /** Called when disabled or on shutdown. */
  dispose?(): Promise<void>;

  readonly search?: SearchCapability;
  readonly browse?: BrowseCapability;
  readonly resolve?: ResolveCapability;
  readonly download?: DownloadCapability;
  readonly lyrics?: LyricsCapability;
  readonly genre?: GenreCapability;
  readonly connectivity?: ConnectivityCapability;
}

export * from './manifest.js';
export * from './capabilities.js';
export * from './context.js';
