/**
 * Log Capture System
 *
 * Ring buffer that intercepts console.log/warn/error/info, preserves stdout
 * behavior, and stores structured entries for the admin log viewer to query.
 *
 * @module
 */

/** Log severity levels. */
export type LogLevel = "debug" | "info" | "warn" | "error";

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
 * Add an entry to the ring buffer.
 */
function addEntry(level: LogLevel, args: unknown[]): void {
  const raw = argsToString(args);
  const { component, stripped } = parseComponent(raw);

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
}

/**
 * Initialize the log capture system.
 * Call once at startup, before any other code runs.
 * Intercepts console.log/warn/error/info — original stdout behavior is preserved.
 */
export function initLogCapture(): void {
  if (initialized) return;
  initialized = true;

  originalLog = console.log;
  originalWarn = console.warn;
  originalError = console.error;
  originalInfo = console.info;
  originalDebug = console.debug;

  console.log = (...args: unknown[]) => {
    addEntry("info", args);
    originalLog.apply(console, args);
  };

  console.info = (...args: unknown[]) => {
    addEntry("info", args);
    originalInfo.apply(console, args);
  };

  console.warn = (...args: unknown[]) => {
    addEntry("warn", args);
    originalWarn.apply(console, args);
  };

  console.error = (...args: unknown[]) => {
    addEntry("error", args);
    originalError.apply(console, args);
  };

  console.debug = (...args: unknown[]) => {
    addEntry("debug", args);
    originalDebug.apply(console, args);
  };
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
