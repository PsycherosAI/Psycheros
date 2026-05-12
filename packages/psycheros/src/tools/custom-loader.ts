/**
 * Custom Tools Loader
 *
 * Dynamically loads user-written tools from the `custom-tools/` directory.
 * Each `.js` file should export a default `Tool` object matching the Tool interface.
 */

import type { Tool } from "./types.ts";
import { join } from "@std/path";

/**
 * Load custom tools from the `custom-tools/` directory at project root.
 *
 * Scans for `.js` files, dynamically imports each, validates it exports
 * a Tool object, and returns a record of tool name -> Tool.
 *
 * Logs warnings for invalid files but doesn't crash.
 * Returns empty record if the directory doesn't exist.
 */
export async function loadCustomTools(
  projectRoot: string,
): Promise<Record<string, Tool>> {
  const customDir = join(projectRoot, "custom-tools");
  const tools: Record<string, Tool> = {};

  let entries;
  try {
    entries = Array.from(Deno.readDirSync(customDir));
  } catch {
    // Directory doesn't exist — no custom tools
    return tools;
  }

  for (const entry of entries) {
    if (!entry.isFile || !entry.name.endsWith(".js")) {
      continue;
    }

    const filePath = join(customDir, entry.name);

    try {
      const module = await import(`file://${filePath}`);
      const tool = module.default as Tool | undefined;

      if (!tool || typeof tool !== "object") {
        console.warn(
          `[CustomTools] ${entry.name}: no default export — skipped`,
        );
        continue;
      }

      if (!tool.definition?.function?.name) {
        console.warn(
          `[CustomTools] ${entry.name}: missing definition.function.name — skipped`,
        );
        continue;
      }

      if (typeof tool.execute !== "function") {
        console.warn(
          `[CustomTools] ${entry.name}: execute is not a function — skipped`,
        );
        continue;
      }

      const name = tool.definition.function.name;
      tools[name] = tool;
      console.log(`[CustomTools] Loaded: ${name} (${entry.name})`);
    } catch (error) {
      console.warn(
        `[CustomTools] ${entry.name}: failed to load —`,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  return tools;
}
