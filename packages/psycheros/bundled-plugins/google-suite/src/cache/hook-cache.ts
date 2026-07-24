/**
 * Background-refresh cache for plugin prompt hooks.
 *
 * Each hook that needs ambient data (today_schedule, pending_tasks,
 * fitness_today) registers here with a refresh function + interval. The
 * cache manager handles:
 *   - In-memory storage with disk persistence (atomic write via temp+rename)
 *   - setInterval-based periodic refresh (no scheduler DB pollution)
 *   - Deduplication of concurrent refreshes (don't fire 5 refreshes if 5
 *     invalidations happen in quick succession)
 *   - Invalidation API for tool mutations to call after they succeed
 *
 * Hook code reads via `cache.read<T>(key)` — synchronous, no network.
 * Refresh failures set `lastError` on the entry; the hook decides whether
 * to fall back to stale data or silent-skip.
 *
 * Log discipline: routine refreshes (success or transient failure) are
 * silent. Persistent failures (401/403) bubble up to the caller — they
 * log via PluginEventLogRegistry if appropriate.
 */

import { join } from "@std/path";

interface HookCacheEntry<T> {
  data?: T;
  fetchedAt?: string; // ISO timestamp of last successful refresh
  lastError?: string; // populated when last refresh attempt failed
}

export interface HookCacheMeta {
  fetchedAt?: string;
  lastError?: string;
  hasData: boolean;
}

export class HookCache {
  private entries = new Map<string, HookCacheEntry<unknown>>();
  private refreshFns = new Map<string, () => Promise<void>>();
  private refreshInFlight = new Map<string, Promise<void>>();
  private intervals: ReturnType<typeof setInterval>[] = [];
  private persistTimer: ReturnType<typeof setTimeout> | undefined;
  private dirty = false;

  constructor(private statePath: string) {}

  /**
   * Register a hook with its refresh function and refresh interval.
   * The interval starts immediately — call register() during plugin start()
   * to begin periodic refreshes.
   */
  register(
    key: string,
    refreshFn: () => Promise<void>,
    intervalMs: number,
  ): void {
    this.refreshFns.set(key, refreshFn);
    const interval = setInterval(() => {
      void this.refresh(key);
    }, intervalMs);
    this.intervals.push(interval);
  }

  /**
   * Read cached data for a hook. Returns undefined if no data is cached
   * (first run before initial refresh completes, or after invalidation).
   *
   * Synchronous — never blocks on network. Hook code calls this every turn.
   */
  read<T>(key: string): T | undefined {
    const entry = this.entries.get(key);
    return entry?.data as T | undefined;
  }

  /** Metadata for staleness checks + debugging. */
  meta(key: string): HookCacheMeta {
    const entry = this.entries.get(key);
    return {
      fetchedAt: entry?.fetchedAt,
      lastError: entry?.lastError,
      hasData: entry?.data !== undefined,
    };
  }

  /**
   * Write fresh data + mark clean. Persisted to disk on a debounce (default
   * 1s) so multiple refreshes in quick succession don't thrash the FS.
   */
  async write<T>(key: string, data: T): Promise<void> {
    this.entries.set(key, {
      data,
      fetchedAt: new Date().toISOString(),
      lastError: undefined,
    });
    this.dirty = true;
    this.schedulePersist();
  }

  /**
   * Mark entry as stale + trigger immediate async refresh. Returns
   * immediately — caller (typically a tool mutation) doesn't wait.
   *
   * Used by google_calendar create/update/delete, google_tasks mutations,
   * etc. — anything that changes the data a hook would surface.
   */
  invalidate(key: string): void {
    const entry = this.entries.get(key);
    if (entry) {
      entry.data = undefined;
    }
    void this.refresh(key);
  }

  /**
   * Run a registered refresh function. Deduplicates concurrent calls per
   * key: if a refresh for this key is already in flight, returns the
   * existing promise rather than starting another.
   *
   * Catches errors internally — refresh failures don't propagate to caller.
   * The error is recorded on the cache entry's `lastError` so hooks can
   * decide how to surface.
   */
  async refresh(key: string): Promise<void> {
    if (this.refreshInFlight.has(key)) {
      return this.refreshInFlight.get(key);
    }
    const fn = this.refreshFns.get(key);
    if (!fn) return;

    const promise = (async () => {
      try {
        await fn();
      } catch (error) {
        const entry = this.entries.get(key) ?? {};
        entry.lastError = error instanceof Error
          ? error.message
          : String(error);
        this.entries.set(key, entry);
        this.dirty = true;
        this.schedulePersist();
      }
    })();

    this.refreshInFlight.set(key, promise);
    try {
      await promise;
    } finally {
      this.refreshInFlight.delete(key);
    }
  }

  /** Refresh all registered hooks. Called on plugin start(). */
  async refreshAll(): Promise<void> {
    await Promise.all(
      Array.from(this.refreshFns.keys()).map((k) => this.refresh(k)),
    );
  }

  /** Load persisted cache from disk into memory. Silent no-op if file absent. */
  async load(): Promise<void> {
    try {
      const raw = await Deno.readTextFile(
        join(this.statePath, "hook-cache.json"),
      );
      const parsed = JSON.parse(raw) as Record<string, HookCacheEntry<unknown>>;
      for (const [key, entry] of Object.entries(parsed)) {
        this.entries.set(key, entry);
      }
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return;
      // Corrupt cache file — start fresh.
      console.warn(
        `[google-suite] hook-cache.json could not be parsed (${
          error instanceof Error ? error.message : String(error)
        }); starting with empty cache`,
      );
    }
  }

  /**
   * Stop all intervals + flush pending persist. Called from plugin stop().
   * Returns a Promise so callers can await the final flush (avoids leak
   * warnings when the daemon is shutting down).
   */
  async stop(): Promise<void> {
    for (const interval of this.intervals) clearInterval(interval);
    this.intervals = [];
    this.refreshFns.clear();
    this.refreshInFlight.clear();
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = undefined;
    }
    // Final flush — await so any in-flight debounced write lands.
    await this.persist();
  }

  private schedulePersist(): void {
    // Debounce — collapse multiple write() calls in quick succession into
    // one disk write. 1s window is plenty.
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = undefined;
      void this.persist();
    }, 1000);
  }

  private async persist(): Promise<void> {
    if (!this.dirty) return;
    this.dirty = false;
    await Deno.mkdir(this.statePath, { recursive: true });
    const obj: Record<string, unknown> = {};
    for (const [key, entry] of this.entries) {
      obj[key] = entry;
    }
    const tmp = join(this.statePath, "hook-cache.json.tmp");
    const final = join(this.statePath, "hook-cache.json");
    try {
      await Deno.writeTextFile(tmp, JSON.stringify(obj, null, 2));
      await Deno.rename(tmp, final);
    } catch (error) {
      // Persistence is best-effort — if disk write fails, in-memory cache
      // still works for this daemon lifetime, just doesn't survive restart.
      console.warn(
        `[google-suite] hook-cache.json persist failed (${
          error instanceof Error ? error.message : String(error)
        }); in-memory cache still active for this session`,
      );
    }
  }
}
