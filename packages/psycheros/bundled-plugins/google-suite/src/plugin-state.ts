/**
 * Singleton plugin state — GoogleClient + GoogleSuiteConfig + HookCache
 * instances set by the entrypoint's start(), read by tools/hooks.
 *
 * Lives in its own module (NOT in psycheros.ts) to break the import cycle:
 * tools import `getGoogleClient` from here, the entrypoint sets it via
 * `setPluginState`. Without this separation, the cycle
 *   psycheros.ts → tools → psycheros.ts
 * triggers "Cannot access before initialization" at module load.
 */

import type { GoogleClient } from "./client/google-client.ts";
import type { GoogleSuiteConfig } from "./config.ts";
import type { HookCache } from "./cache/hook-cache.ts";

let googleClient: GoogleClient | undefined;
let config: GoogleSuiteConfig | undefined;
let hookCache: HookCache | undefined;

export function getGoogleClient(): GoogleClient | undefined {
  return googleClient;
}

export function getConfig(): GoogleSuiteConfig | undefined {
  return config;
}

export function getHookCache(): HookCache | undefined {
  return hookCache;
}

/**
 * Set by psycheros.ts start(). Reads `undefined` for client when OAuth hasn't
 * completed — tools/hooks handle that case via `client?.isConfigured()`.
 */
export function setPluginState(
  newClient: GoogleClient | undefined,
  newConfig: GoogleSuiteConfig | undefined,
): void {
  googleClient = newClient;
  config = newConfig;
}

export function setHookCache(cache: HookCache | undefined): void {
  hookCache = cache;
}
