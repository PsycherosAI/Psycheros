/**
 * Initialization module for Psycheros
 *
 * Handles setup of user data directories from templates on first run.
 * Ensures fresh installations have the necessary identity file structure.
 */

import { join } from "@std/path";

const IDENTITY_SUBDIRS = ["self", "user", "relationship", "custom"] as const;

/**
 * Load the entity's display name from general-settings.json, falling back to
 * "Assistant" (the launcher's default) when the file is missing or malformed.
 * Used to substitute {{entityName}} placeholders when seeding identity
 * templates on first run.
 */
async function loadEntityName(dataRoot: string): Promise<string> {
  try {
    const text = await Deno.readTextFile(
      join(dataRoot, ".psycheros", "general-settings.json"),
    );
    const settings = JSON.parse(text) as { entityName?: string };
    return settings.entityName?.trim() || "Assistant";
  } catch {
    return "Assistant";
  }
}

/**
 * Check if a directory is empty (contains no files, only . and ..)
 */
async function isDirectoryEmpty(dirPath: string): Promise<boolean> {
  try {
    const entries = [];
    for await (const entry of Deno.readDir(dirPath)) {
      // Skip .snapshots directory and hidden files
      if (entry.name === ".snapshots" || entry.name.startsWith(".")) {
        continue;
      }
      entries.push(entry);
    }
    return entries.length === 0;
  } catch {
    // Directory doesn't exist, consider it empty
    return true;
  }
}

/**
 * Ensure a directory exists, creating it if necessary
 */
async function ensureDir(dirPath: string): Promise<void> {
  try {
    await Deno.mkdir(dirPath, { recursive: true });
  } catch (error) {
    if (!(error instanceof Deno.errors.AlreadyExists)) {
      throw error;
    }
  }
}

/**
 * Copy all files from a template directory to a target directory
 * Only copies if target directory is empty
 */
async function copyTemplateFiles(
  templateDir: string,
  targetDir: string,
  substitutions: Record<string, string> = {},
): Promise<{ copied: number; skipped: boolean }> {
  // Check if target is empty
  if (!(await isDirectoryEmpty(targetDir))) {
    return { copied: 0, skipped: true };
  }

  // Ensure target directory exists
  await ensureDir(targetDir);

  let copied = 0;

  try {
    for await (const entry of Deno.readDir(templateDir)) {
      if (entry.isFile && entry.name.endsWith(".md")) {
        const srcPath = join(templateDir, entry.name);
        const destPath = join(targetDir, entry.name);

        let content = await Deno.readTextFile(srcPath);
        for (const [key, value] of Object.entries(substitutions)) {
          content = content.replaceAll(`{{${key}}}`, value);
        }
        await Deno.writeTextFile(destPath, content);
        copied++;
      }
    }
  } catch (error) {
    // Template directory doesn't exist, skip silently
    if (!(error instanceof Deno.errors.NotFound)) {
      console.error(`[Init] Error copying from ${templateDir}:`, error);
    }
  }

  return { copied, skipped: false };
}

/**
 * Initialize identity directories from templates
 *
 * For each subdirectory (self, user, relationship, custom):
 * - If the directory is empty, copy template files into it
 * - If the directory has files, leave it untouched (user data exists)
 *
 * This allows fresh installations to start with default identity files,
 * while preserving any existing user data.
 */
export async function initializeFromTemplates(
  projectRoot: string,
  dataRoot: string,
): Promise<void> {
  const templatesDir = join(projectRoot, "templates", "identity");
  const identityDir = join(dataRoot, "identity");
  const substitutions = { entityName: await loadEntityName(dataRoot) };

  let totalCopied = 0;

  for (const subdir of IDENTITY_SUBDIRS) {
    const templatePath = join(templatesDir, subdir);
    const targetPath = join(identityDir, subdir);

    const result = await copyTemplateFiles(
      templatePath,
      targetPath,
      substitutions,
    );

    if (result.skipped) {
      console.log(`[Init] identity/${subdir}/ already has files, skipping`);
    } else if (result.copied > 0) {
      console.log(
        `[Init] Copied ${result.copied} file(s) to identity/${subdir}/`,
      );
      totalCopied += result.copied;
    }
  }

  if (totalCopied > 0) {
    console.log(
      `[Init] Initialized ${totalCopied} identity file(s) from templates`,
    );
  }
}

/**
 * Seed the custom-tools/ directory with template files if it doesn't exist.
 */
async function initializeCustomToolsDir(
  projectRoot: string,
  dataRoot: string,
): Promise<void> {
  const templateDir = join(projectRoot, "templates", "custom-tools");
  const targetDir = join(dataRoot, "custom-tools");

  try {
    const entries = Array.from(Deno.readDirSync(templateDir));
    if (entries.length === 0) return;

    const result = await copyTemplateFiles(templateDir, targetDir);
    if (result.copied > 0) {
      console.log(
        `[Init] Seeded custom-tools/ with ${result.copied} template file(s)`,
      );
    }
  } catch {
    // Template dir doesn't exist, skip
  }
}

/**
 * Run all initialization tasks
 *
 * @param projectRoot - Source root, where `templates/` lives
 * @param dataRoot - Runtime state root, where seeded files are written
 *   (typically equal to projectRoot unless PSYCHEROS_DATA_DIR is set)
 */
export async function initialize(
  projectRoot: string,
  dataRoot: string,
): Promise<void> {
  await initializeFromTemplates(projectRoot, dataRoot);
  await initializeCustomToolsDir(projectRoot, dataRoot);
}
