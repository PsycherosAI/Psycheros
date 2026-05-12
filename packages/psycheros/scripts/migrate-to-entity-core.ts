#!/usr/bin/env -S deno run -A
/**
 * Migration Script: SBy to Entity-Core
 *
 * Copies identity files (self/, user/, relationship/) and memories
 * from SBy harness to entity-core data directory.
 *
 * Usage:
 *   deno run -A scripts/migrate-to-entity-core.ts [sby-root] [entity-core-root]
 *
 * Defaults:
 *   sby-root: current directory (assuming run from SBy project root)
 *   entity-core-root: ~/projects/entity-core
 */

import { dirname, fromFileUrl, join, resolve } from "@std/path";
import { copy, ensureDir } from "@std/fs";

const DEFAULT_SBY_ROOT = resolve(dirname(fromFileUrl(import.meta.url)), "..");
const DEFAULT_ENTITY_CORE_ROOT = resolve(
  Deno.env.get("HOME") ?? "~",
  "projects/entity-core",
);

interface MigrationConfig {
  sbyRoot: string;
  entityCoreRoot: string;
  dryRun: boolean;
  verbose: boolean;
}

interface MigrationResult {
  copied: string[];
  skipped: string[];
  errors: Array<{ path: string; error: string }>;
}

/**
 * Parse command line arguments.
 */
function parseArgs(): MigrationConfig {
  const args = Deno.args;
  let sbyRoot = DEFAULT_SBY_ROOT;
  let entityCoreRoot = DEFAULT_ENTITY_CORE_ROOT;
  let dryRun = false;
  let verbose = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--dry-run" || arg === "-n") {
      dryRun = true;
    } else if (arg === "--verbose" || arg === "-v") {
      verbose = true;
    } else if (arg === "--help" || arg === "-h") {
      console.log(`
Migration Script: SBy to Entity-Core

Usage:
  deno run -A scripts/migrate-to-entity-core.ts [options] [sby-root] [entity-core-root]

Options:
  -n, --dry-run    Show what would be copied without actually copying
  -v, --verbose    Show detailed output
  -h, --help       Show this help message

Arguments:
  sby-root         Path to SBy project root (default: current directory)
  entity-core-root Path to entity-core project (default: ~/projects/entity-core)

Examples:
  deno run -A scripts/migrate-to-entity-core.ts
  deno run -A scripts/migrate-to-entity-core.ts --dry-run
  deno run -A scripts/migrate-to-entity-core.ts /path/to/sby /path/to/entity-core
`);
      Deno.exit(0);
    } else if (!arg.startsWith("-") && i === 0) {
      sbyRoot = resolve(arg);
    } else if (!arg.startsWith("-") && i === 1) {
      entityCoreRoot = resolve(arg);
    }
  }

  return { sbyRoot, entityCoreRoot, dryRun, verbose };
}

/**
 * Log a message if verbose mode is enabled.
 */
function log(message: string, config: MigrationConfig): void {
  if (config.verbose || config.dryRun) {
    console.log(message);
  }
}

/**
 * Copy a directory recursively.
 */
async function copyDirectory(
  srcDir: string,
  destDir: string,
  config: MigrationConfig,
  result: MigrationResult,
): Promise<void> {
  try {
    // Check if source directory exists
    const srcInfo = await Deno.stat(srcDir);
    if (!srcInfo.isDirectory) {
      result.skipped.push(srcDir);
      log(`  Skipping ${srcDir} (not a directory)`, config);
      return;
    }

    // Create destination directory
    if (!config.dryRun) {
      await ensureDir(destDir);
    }

    // Copy all .md files
    for await (const entry of Deno.readDir(srcDir)) {
      const srcPath = join(srcDir, entry.name);
      const destPath = join(destDir, entry.name);

      if (entry.isFile && entry.name.endsWith(".md")) {
        if (!config.dryRun) {
          await copy(srcPath, destPath, { overwrite: true });
        }
        result.copied.push(srcPath);
        log(`  Copied: ${srcPath} → ${destPath}`, config);
      } else if (entry.isDirectory) {
        await copyDirectory(srcPath, destPath, config, result);
      }
    }
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      result.skipped.push(srcDir);
      log(`  Skipping ${srcDir} (not found)`, config);
    } else {
      const errorMsg = error instanceof Error ? error.message : String(error);
      result.errors.push({ path: srcDir, error: errorMsg });
      console.error(`  Error copying ${srcDir}: ${errorMsg}`);
    }
  }
}

/**
 * Add instance tagging to memory files.
 * This modifies the content to include the source instance metadata.
 */
async function tagMemoryFiles(
  memoriesDir: string,
  config: MigrationConfig,
): Promise<number> {
  let tagged = 0;

  try {
    for await (const entry of Deno.readDir(memoriesDir)) {
      const subDir = join(memoriesDir, entry.name);

      if (entry.isDirectory && entry.name !== "archive") {
        for await (const file of Deno.readDir(subDir)) {
          if (file.isFile && file.name.endsWith(".md")) {
            const filePath = join(subDir, file.name);

            if (!config.dryRun) {
              let content = await Deno.readTextFile(filePath);

              // Add instance metadata comment if not already present
              if (!content.includes("Source Instance:")) {
                content += `

<!--
Source Instance: sby-harness
Migrated: ${new Date().toISOString()}
-->`;
                await Deno.writeTextFile(filePath, content);
              }
            }
            tagged++;
            log(`  Tagged: ${filePath}`, config);
          }
        }
      }
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) {
      console.error(`  Error tagging memories: ${error}`);
    }
  }

  return tagged;
}

/**
 * Main migration function.
 */
async function migrate(): Promise<void> {
  const config = parseArgs();

  console.log("Entity-Core Migration Script");
  console.log("============================");
  console.log(`SBy root: ${config.sbyRoot}`);
  console.log(`Entity-Core root: ${config.entityCoreRoot}`);
  console.log(
    `Mode: ${
      config.dryRun ? "dry-run (no changes)" : "live (will copy files)"
    }`,
  );
  console.log("");

  const result: MigrationResult = {
    copied: [],
    skipped: [],
    errors: [],
  };

  // Copy identity directories
  console.log("Copying identity files...");
  const identityDirs = ["self", "user", "relationship"];

  for (const dir of identityDirs) {
    const srcDir = join(config.sbyRoot, dir);
    const destDir = join(config.entityCoreRoot, "data", dir);

    log(`\nProcessing ${dir}/...`, config);
    await copyDirectory(srcDir, destDir, config, result);
  }

  // Copy memories
  console.log("\nCopying memories...");
  const memoriesSrc = join(config.sbyRoot, "memories");
  const memoriesDest = join(config.entityCoreRoot, "data", "memories");

  log(`\nProcessing memories/...`, config);
  await copyDirectory(memoriesSrc, memoriesDest, config, result);

  // Tag memory files with instance ID
  if (!config.dryRun) {
    console.log("\nTagging memories with instance ID...");
    const tagged = await tagMemoryFiles(memoriesDest, config);
    console.log(`  Tagged ${tagged} memory files`);
  }

  // Summary
  console.log("\n============================");
  console.log("Migration Summary");
  console.log("============================");
  console.log(`Copied: ${result.copied.length} files`);
  console.log(`Skipped: ${result.skipped.length} directories`);
  console.log(`Errors: ${result.errors.length}`);

  if (result.errors.length > 0) {
    console.log("\nErrors:");
    for (const error of result.errors) {
      console.log(`  ${error.path}: ${error.error}`);
    }
  }

  if (config.dryRun) {
    console.log("\nThis was a dry-run. No files were actually copied.");
    console.log("Run without --dry-run to perform the actual migration.");
  } else {
    console.log("\nMigration complete!");
    console.log("\nNext steps:");
    console.log(
      "1. Start entity-core: cd ~/projects/entity-core && deno run -A src/mod.ts",
    );
    console.log("2. Start SBy with MCP: SBY_MCP_ENABLED=true deno task dev");
  }
}

// Run migration
if (import.meta.main) {
  await migrate();
}
