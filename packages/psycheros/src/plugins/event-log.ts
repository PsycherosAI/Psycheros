/**
 * Plugin event logging — my diagnostic surface for plugin activity.
 *
 * Two sinks, one source of truth:
 *   - In-memory ring buffer per plugin, surfaced live in the Plugins Settings
 *     page (the "Recent activity" panel per installed plugin).
 *   - Plain-text append file at `<dataRoot>/.psycheros/plugin-logs/<id>.log`,
 *     rotating at ${ROTATE_BYTES} (~5 MB) so it stays shareable. The file is
 *     the one users paste into support chats; the format is human-readable
 *     one-line-per-event so it survives a `cat` paste without reformatting.
 *
 * Always on by default — when something goes wrong, the operator needs the
 * log to already exist, not to have to enable debug and reproduce. The host
 * may disable logging via the manager's `enabled` flag (e.g., a future
 * `pluginLoggingEnabled` setting).
 */

import { ensureDir, ensureFile } from "@std/fs";
import { join } from "@std/path";

export type PluginEventLevel = "info" | "warn" | "error";

/**
 * Semantic category of an event. Used by UI filters and to keep messages
 * consistent within a category (e.g., all "load" events describe the same
 * lifecycle step).
 */
export type PluginEventCategory =
  | "load" // manifest validation, entrypoint import, env application
  | "lifecycle" // start()/stop() calls and their outcomes
  | "hook" // prompt-hook execution (success, timeout, error, truncation)
  | "env" // env-file denylist refusals
  | "route" // plugin-owned HTTP route hits (verbose, off by default)
  | "tool" // plugin-owned tool registration / call (verbose, off by default)
  | "budget" // aggregate prompt-hook budget truncations or skip
  | "system"; // manager-level events (startup, shutdown, configuration)

export interface PluginEvent {
  /** ISO 8601 timestamp */
  timestamp: string;
  pluginId: string;
  level: PluginEventLevel;
  category: PluginEventCategory;
  message: string;
  /** Optional structured fields, rendered compactly in the file format. */
  details?: Record<string, unknown>;
}

/**
 * Maximum events retained per plugin in the in-memory ring buffer. The buffer
 * powers the live UI; deeper history lives in the file.
 */
const RING_BUFFER_MAX = 200;

/**
 * File rotation threshold. When the active log exceeds this size, it is
 * renamed to `<id>.log.1` (replacing any prior rotation) and a fresh file
 * starts. ~5 MB keeps multi-day histories readable in a support chat paste.
 */
const ROTATE_BYTES = 5 * 1024 * 1024;

/**
 * One-line text representation of an event. Format:
 *   [2026-07-17T14:23:01.123Z] [WARN] [load] env file refused 2 vars {"names":["HTTP_PROXY","NODE_TLS_REJECT_UNAUTHORIZED"]}
 *
 * Stable, greppable, and parses cleanly with a one-line regex if a future
 * tool needs to ingest it. The JSON details blob is optional and only
 * appended when the event carries structured fields.
 */
export function formatEventForFile(event: PluginEvent): string {
  const head =
    `[${event.timestamp}] [${event.level.toUpperCase()}] [${event.category}] ${
      event.message.replace(/\n/g, " ")
    }`;
  if (!event.details || Object.keys(event.details).length === 0) return head;
  try {
    return `${head} ${JSON.stringify(event.details)}`;
  } catch {
    // If details can't be JSON-serialized (cyclic, exotic), drop them rather
    // than corrupt the log line. Caller can re-emit with simpler details.
    return head;
  }
}

/**
 * Per-plugin event log. Owns both the in-memory ring buffer and the file
 * rotation. Not thread-safe in the JS sense — assumes the daemon's
 * single-threaded event loop, which is the model everywhere else in the
 * plugin manager.
 */
export class PluginEventLog {
  private buffer: PluginEvent[] = [];
  private readonly bufferMax: number;
  private readonly logPath: string;
  private readonly rotatedPath: string;
  private readonly rotateBytes: number;
  private rotationCheckCounter = 0;
  /**
   * After every ROTATION_CHECK_INTERVAL appends, stat the file to see if it
   * needs rotating. Avoids a stat() per write.
   */
  private readonly rotationCheckInterval = 64;

  constructor(
    private readonly pluginId: string,
    private readonly pluginLogsDir: string,
    options?: {
      bufferMax?: number;
      rotateBytes?: number;
    },
  ) {
    this.bufferMax = options?.bufferMax ?? RING_BUFFER_MAX;
    this.rotateBytes = options?.rotateBytes ?? ROTATE_BYTES;
    this.logPath = join(pluginLogsDir, `${pluginId}.log`);
    this.rotatedPath = `${this.logPath}.1`;
  }

  /** Path to the active log file — exposed for UI download/copy affordances. */
  get filePath(): string {
    return this.logPath;
  }

  /** Snapshot of the in-memory ring buffer (newest last). */
  snapshot(): PluginEvent[] {
    return [...this.buffer];
  }

  /**
   * Record an event. Writes to both the ring buffer and the file (unless
   * `enabled` is false on the parent manager, in which case neither).
   *
   * Errors during file writes are swallowed — a logging failure must not
   * cascade into breaking the host's plugin behavior. The buffer still
   * captures the event so the live UI continues to work even if the disk
   * is full or permissions changed.
   */
  async record(
    event: Omit<PluginEvent, "timestamp" | "pluginId">,
  ): Promise<void> {
    const full: PluginEvent = {
      ...event,
      timestamp: new Date().toISOString(),
      pluginId: this.pluginId,
    };
    this.pushBuffer(full);
    try {
      await this.appendFile(full);
    } catch (error) {
      // Last-resort: emit to host stderr so the failure isn't silent, but
      // don't propagate — logging must never break the host's request path.
      console.error(
        `[Plugins] event-log file write failed for ${this.pluginId}:`,
        error,
      );
    }
  }

  /** Clear the in-memory buffer. File history is preserved. */
  clearBuffer(): void {
    this.buffer = [];
  }

  private pushBuffer(event: PluginEvent): void {
    this.buffer.push(event);
    if (this.buffer.length > this.bufferMax) {
      this.buffer.splice(0, this.buffer.length - this.bufferMax);
    }
  }

  private async appendFile(event: PluginEvent): Promise<void> {
    await ensureDir(this.pluginLogsDir);
    // Touch on first write — ensures the file exists even if the first event
    // happens before any directory-walk has reason to create it.
    await ensureFile(this.logPath);
    const line = formatEventForFile(event) + "\n";
    await Deno.writeTextFile(this.logPath, line, { append: true });
    this.rotationCheckCounter++;
    if (this.rotationCheckCounter >= this.rotationCheckInterval) {
      this.rotationCheckCounter = 0;
      await this.maybeRotate();
    }
  }

  private async maybeRotate(): Promise<void> {
    try {
      const stat = await Deno.stat(this.logPath);
      if (stat.size < this.rotateBytes) return;
      // Atomic-ish: rename current to .1 (overwrites any prior rotation),
      // then the next append recreates a fresh active file.
      try {
        await Deno.remove(this.rotatedPath);
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
      }
      await Deno.rename(this.logPath, this.rotatedPath);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) {
        // Rotation failure is non-fatal — log to stderr and move on.
        console.error(
          `[Plugins] event-log rotation failed for ${this.pluginId}:`,
          error,
        );
      }
    }
  }
}

/**
 * Registry of per-plugin event logs. The host owns one of these and looks
 * up logs by plugin ID. Disabling logging globally (via `enabled = false`)
 * drops incoming events on the floor for every plugin.
 */
export class PluginEventLogRegistry {
  private logs = new Map<string, PluginEventLog>();
  enabled = true;

  constructor(private readonly pluginLogsDir: string) {}

  /**
   * Get or create the event log for a plugin ID. Plugin IDs are validated
   * upstream (manifest validation), so we trust the ID is safe to use in a
   * filename here.
   */
  for(pluginId: string): PluginEventLog {
    let log = this.logs.get(pluginId);
    if (!log) {
      log = new PluginEventLog(pluginId, this.pluginLogsDir);
      this.logs.set(pluginId, log);
    }
    return log;
  }

  /**
   * Convenience: record an event without making the caller look up the log.
   * When the registry is disabled, this is a no-op.
   */
  async record(
    pluginId: string,
    event: Omit<PluginEvent, "timestamp" | "pluginId">,
  ): Promise<void> {
    if (!this.enabled) return;
    await this.for(pluginId).record(event);
  }

  /** Snapshot a plugin's recent events, or empty if the plugin has no log yet. */
  snapshot(pluginId: string): PluginEvent[] {
    return this.logs.get(pluginId)?.snapshot() ?? [];
  }

  /** File path for a plugin's log, regardless of whether it has events yet. */
  filePath(pluginId: string): string {
    return this.for(pluginId).filePath;
  }

  /** Drop in-memory state. Used on manager shutdown. File history is preserved. */
  clear(): void {
    this.logs.clear();
  }
}
