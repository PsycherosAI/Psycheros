/**
 * Entity Loom — Logger
 *
 * Per-run log file that captures all wizard operations.
 * Logs are written to logs/YYYY-MM-DDTHH-MM-SS.log in the project directory.
 */

import { join } from "@std/path";

let logStream: Deno.FsFile | null = null;
let logPath: string | null = null;

/** Initialize the log file for this run */
export async function initLogger(projectDir: string): Promise<string> {
  const now = new Date();
  const ts = now.toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const logsDir = join(projectDir, "logs");
  await Deno.mkdir(logsDir, { recursive: true });
  logPath = join(logsDir, `${ts}.log`);
  logStream = await Deno.open(logPath, {
    write: true,
    create: true,
    append: true,
  });
  return logPath;
}

/** Write a log entry */
export function log(
  level: string,
  message: string,
  meta?: Record<string, unknown>,
): void {
  const timestamp = new Date().toISOString();
  const entry = `[${timestamp}] [${level.toUpperCase()}] ${message}${
    meta ? " " + JSON.stringify(meta) : ""
  }\n`;
  if (logStream) {
    logStream.write(new TextEncoder().encode(entry));
  }
  // Also write to stderr for the server console
  console.error(entry.trimEnd());
}

/** Get the current log file path */
export function getLogPath(): string | null {
  return logPath;
}

/** Close the log file */
export async function closeLogger(): Promise<void> {
  if (logStream) {
    logStream.close();
    logStream = null;
  }
}
