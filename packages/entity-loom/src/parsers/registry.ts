/**
 * Entity Loom — Parser Registry
 *
 * Manages platform parser registration and factory creation.
 */

import type { PlatformParser, PlatformParserConstructor } from "./interface.ts";
import type { PlatformType } from "../types.ts";
import { ChatGPTParser } from "./chatgpt.ts";
import { ClaudeParser } from "./claude.ts";
import { SillyTavernParser } from "./sillytavern.ts";
import { KindroidParser } from "./kindroid.ts";
import { LettaParser } from "./letta.ts";
import { LoomStandardParser } from "./loom-standard.ts";

/**
 * Registry mapping platform types to parser constructors.
 *
 * Loom Standard is registered FIRST because it relies on an explicit
 * `"format": "loom-standard"` marker rather than structural heuristics.
 * Native parsers (ChatGPT, Claude, etc.) detect by shape and could
 * theoretically false-positive on a standard-format file, so checking
 * the marker before anything else eliminates ambiguity.
 */
const registry = new Map<PlatformType, PlatformParserConstructor>([
  ["loom-standard", LoomStandardParser],
  ["chatgpt", ChatGPTParser],
  ["claude", ClaudeParser],
  ["sillytavern", SillyTavernParser],
  ["kindroid", KindroidParser],
  ["letta", LettaParser],
]);

/** Register a custom parser for a platform type */
export function registerParser(
  platform: PlatformType,
  constructor: PlatformParserConstructor,
): void {
  registry.set(platform, constructor);
}

/** Create a parser instance for the given platform */
export function createParser(platform: PlatformType): PlatformParser {
  const Constructor = registry.get(platform);
  if (!Constructor) {
    throw new Error(`No parser registered for platform: ${platform}`);
  }
  return new Constructor();
}

/**
 * Get a parser instance for a known platform type.
 * Same as createParser but uses a different name for clarity.
 */
export function getParserForPlatform(platform: PlatformType): PlatformParser {
  return createParser(platform);
}

/**
 * Auto-detect the platform from a file by trying all parsers.
 * Returns the first parser that reports it can handle the file.
 */
export async function detectPlatform(
  filePath: string,
): Promise<PlatformType | null> {
  for (const [platform, Constructor] of registry) {
    const parser = new Constructor();
    try {
      if (await parser.detect(filePath)) {
        return platform;
      }
    } catch {
      // Detection failure doesn't mean wrong parser — skip
      continue;
    }
  }
  return null;
}

/** Get all registered platform types */
export function getRegisteredPlatforms(): PlatformType[] {
  return Array.from(registry.keys());
}
