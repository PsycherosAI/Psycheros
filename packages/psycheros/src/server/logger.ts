/**
 * Log Capture System
 *
 * Ring buffer that intercepts console.log/warn/error/info, preserves stdout
 * behavior, and stores structured entries for the admin log viewer to query.
 *
 * @module
 */

import { join } from "@std/path";

/** Log severity levels. */
export type LogLevel = "debug" | "info" | "warn" | "error";

/** Numeric ranking for level comparison — higher = more severe. */
const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

/** A single captured log entry. */
export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  component: string;
  message: string;
}

/** Filters for querying the log buffer. */
export interface LogFilter {
  /** Filter by log level (exact match). */
  level?: LogLevel;
  /** Filter by component tag (exact match, case-insensitive). */
  component?: string;
  /** Only return entries after this ISO timestamp. */
  since?: string;
  /** Maximum entries to return (default 100, newest first). */
  limit?: number;
}

/** Maximum entries stored in the ring buffer. */
export const LOG_BUFFER_SIZE = 1000;

// Ring buffer state
const buffer: (LogEntry | null)[] = new Array(LOG_BUFFER_SIZE).fill(null);
let writeIndex = 0;
let totalWritten = 0;

// Track unique component tags
const componentsSeen = new Set<string>();

// Track counts per level
const levelCounts: Record<LogLevel, number> = {
  debug: 0,
  info: 0,
  warn: 0,
  error: 0,
};

// ---------------------------------------------------------------------------
// Level-floor filtering
//
// Routine normal operation (every sensor batch, every RAG search, every SSE
// lifecycle tick) should not pollute logs. Entries below the configured floor
// are dropped from both stdout and the ring buffer — the logging layer is the
// single chokepoint, so this applies codebase-wide without per-subsystem edits.
// ---------------------------------------------------------------------------

/** Minimum log level to capture globally. Entries below this are dropped. */
let defaultFloor: LogLevel = "info";

/** Per-component floor overrides (take precedence over defaultFloor). */
const componentFloors = new Map<string, LogLevel>();

// Original console methods (saved during init)
let originalLog: typeof console.log;
let originalWarn: typeof console.warn;
let originalError: typeof console.error;
let originalInfo: typeof console.info;
let originalDebug: typeof console.debug;

let initialized = false;

/**
 * Parse the component tag from a log message.
 * Matches patterns like [DB], [RAG], [MCP], [Server], etc.
 * Falls back to "General" if no bracket prefix is found.
 */
function parseComponent(
  message: string,
): { component: string; stripped: string } {
  const match = message.match(/^\[([A-Za-z][A-Za-z0-9-]*)\]\s*/);
  if (match) {
    return { component: match[1], stripped: message.slice(match[0].length) };
  }
  return { component: "General", stripped: message };
}

/**
 * Convert console arguments to a single string.
 */
function argsToString(args: unknown[]): string {
  return args
    .map((a) => (typeof a === "string" ? a : Deno.inspect(a)))
    .join(" ");
}

/**
 * Check whether a log entry should be captured based on its component and level.
 * Entries at or above the component's configured floor (or the default floor)
 * pass; anything below is dropped from both stdout and the ring buffer.
 */
function shouldLog(component: string, level: LogLevel): boolean {
  const floor = componentFloors.get(component) ?? defaultFloor;
  return LEVEL_RANK[level] >= LEVEL_RANK[floor];
}

/**
 * Add an entry to the ring buffer. Returns false (without writing) when the
 * entry is below the configured level floor for its component.
 */
function addEntry(level: LogLevel, args: unknown[]): boolean {
  const raw = argsToString(args);
  const { component, stripped } = parseComponent(raw);

  if (!shouldLog(component, level)) return false;

  componentsSeen.add(component);
  levelCounts[level]++;

  buffer[writeIndex] = {
    timestamp: new Date().toISOString(),
    level,
    component,
    message: stripped,
  };

  writeIndex = (writeIndex + 1) % LOG_BUFFER_SIZE;
  totalWritten++;
  return true;
}

/**
 * Initialize the log capture system.
 * Call once at startup, before any other code runs.
 * Intercepts console.log/warn/error/info — original stdout behavior is preserved.
 */
export function initLogCapture(): void {
  if (initialized) return;
  initialized = true;

  // Seed the global floor from the environment so it's in place before the
  // first log line. Per-component overrides are loaded later from
  // .psycheros/log-settings.json (see configureLogLevelsFromFile).
  const envLevel = Deno.env.get("PSYCHEROS_LOG_LEVEL");
  if (envLevel && envLevel in LEVEL_RANK) {
    defaultFloor = envLevel as LogLevel;
  }

  originalLog = console.log;
  originalWarn = console.warn;
  originalError = console.error;
  originalInfo = console.info;
  originalDebug = console.debug;

  console.log = (...args: unknown[]) => {
    if (addEntry("info", args)) originalLog.apply(console, args);
  };

  console.info = (...args: unknown[]) => {
    if (addEntry("info", args)) originalInfo.apply(console, args);
  };

  console.warn = (...args: unknown[]) => {
    if (addEntry("warn", args)) originalWarn.apply(console, args);
  };

  console.error = (...args: unknown[]) => {
    if (addEntry("error", args)) originalError.apply(console, args);
  };

  console.debug = (...args: unknown[]) => {
    if (addEntry("debug", args)) originalDebug.apply(console, args);
  };
}

/**
 * Configure log-level floors at runtime.
 * Called during startup from .psycheros/log-settings.json; also available for
 * future admin API use to adjust levels without a daemon restart.
 */
export function configureLogLevels(opts: {
  defaultLevel?: LogLevel;
  components?: Record<string, LogLevel>;
}): void {
  if (opts.defaultLevel) {
    defaultFloor = opts.defaultLevel;
  }
  if (opts.components) {
    for (const [component, level] of Object.entries(opts.components)) {
      componentFloors.set(component, level);
    }
  }
}

/**
 * Snapshot the current level configuration (for debugging / future admin UI).
 */
export function getLogLevelConfig(): {
  defaultLevel: LogLevel;
  components: Record<string, LogLevel>;
} {
  return {
    defaultLevel: defaultFloor,
    components: Object.fromEntries(componentFloors),
  };
}

/**
 * Load per-component log-level overrides from .psycheros/log-settings.json.
 * Silent no-op when the file is absent (the common case). Invalid level values
 * are skipped; a malformed JSON file warns once and falls back to defaults.
 *
 * Expected format:
 * ```json
 * { "defaultLevel": "info", "components": { "Wearable": "warn" } }
 * ```
 */
export async function configureLogLevelsFromFile(
  dataRoot: string,
): Promise<void> {
  const settingsPath = join(dataRoot, ".psycheros", "log-settings.json");

  let raw: string;
  try {
    raw = await Deno.readTextFile(settingsPath);
  } catch {
    return; // No settings file — normal, use defaults
  }

  let parsed: {
    defaultLevel?: string;
    components?: Record<string, string>;
  };
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.warn(
      "[Logger] log-settings.json is malformed — ignoring log level config",
    );
    return;
  }

  const opts: {
    defaultLevel?: LogLevel;
    components?: Record<string, LogLevel>;
  } = {};

  if (parsed.defaultLevel && parsed.defaultLevel in LEVEL_RANK) {
    opts.defaultLevel = parsed.defaultLevel as LogLevel;
  }

  if (parsed.components) {
    const valid: Record<string, LogLevel> = {};
    for (const [component, level] of Object.entries(parsed.components)) {
      if (level in LEVEL_RANK) {
        valid[component] = level as LogLevel;
      }
    }
    if (Object.keys(valid).length > 0) {
      opts.components = valid;
    }
  }

  configureLogLevels(opts);
}

/**
 * Query the log buffer with optional filters.
 * Returns entries newest-first, up to `limit` (default 100).
 */
export function queryLogs(filter?: LogFilter): LogEntry[] {
  const limit = filter?.limit ?? 100;
  const sinceMs = filter?.since ? new Date(filter.since).getTime() : 0;
  const levelFilter = filter?.level;
  const componentFilter = filter?.component?.toLowerCase();

  const results: LogEntry[] = [];
  const count = Math.min(totalWritten, LOG_BUFFER_SIZE);

  // Walk backward from most recent entry
  for (let i = 0; i < count && results.length < limit; i++) {
    const idx = (writeIndex - 1 - i + LOG_BUFFER_SIZE) % LOG_BUFFER_SIZE;
    const entry = buffer[idx];
    if (!entry) continue;

    // Apply filters
    if (levelFilter && entry.level !== levelFilter) continue;
    if (componentFilter && entry.component.toLowerCase() !== componentFilter) {
      continue;
    }
    if (sinceMs && new Date(entry.timestamp).getTime() < sinceMs) continue;

    results.push(entry);
  }

  return results;
}

/**
 * Get the list of all component tags seen so far (sorted).
 */
export function getLogComponents(): string[] {
  return [...componentsSeen].sort();
}

/**
 * Get the count of log entries per level.
 */
export function getLogLevelCounts(): Record<LogLevel, number> {
  return { ...levelCounts };
}
