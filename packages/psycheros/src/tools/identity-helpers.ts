/**
 * Identity File Helpers
 *
 * Shared utilities for identity file manipulation.
 * Provides XML parsing, content manipulation, and MCP fallback logic.
 */

import { join } from "@std/path";
import type { MCPClient } from "../mcp-client/mod.ts";

// =============================================================================
// Type Definitions
// =============================================================================

export type IdentityCategory = "self" | "user" | "relationship" | "custom";

export interface IdentityFileInfo {
  category: IdentityCategory;
  filename: string;
}

/**
 * Result of an identity file operation.
 */
export interface IdentityOperationResult {
  success: boolean;
  message: string;
  error?: string;
}

/**
 * Valid filenames for each category.
 * Custom category accepts any valid .md filename.
 */
export const VALID_FILES: Record<IdentityCategory, readonly string[]> = {
  self: [
    "base_instructions.md",
    "my_identity.md",
    "my_persona.md",
    "my_personhood.md",
    "my_wants.md",
    "my_mechanics.md",
  ] as const,
  user: [
    "user_identity.md",
    "user_life.md",
    "user_beliefs.md",
    "user_preferences.md",
    "user_patterns.md",
    "user_notes.md",
  ] as const,
  relationship: [
    "relationship_dynamics.md",
    "relationship_history.md",
    "relationship_notes.md",
  ] as const,
  custom: [] as const, // Custom files can have any valid filename
};

// =============================================================================
// Content Utilities
// =============================================================================

/**
 * Append content to the end of existing content.
 */
export function appendToXmlContent(
  existingContent: string,
  newContent: string,
): string {
  const addition = `\n\n${newContent.trim()}`;
  return existingContent.trim() + addition + "\n";
}

/**
 * Prepend content to the beginning of existing content.
 */
export function prependToXmlContent(
  existingContent: string,
  newContent: string,
): string {
  const addition = `${newContent.trim()}\n\n`;
  return addition + existingContent.trim() + "\n";
}

/**
 * Append content within a specific markdown section.
 * Section is identified by a heading (e.g., "## Preferences").
 * New content is added after any existing content in the section.
 * If the section doesn't exist, it is created at the end of the file.
 */
export function updateSection(
  existingContent: string,
  sectionName: string,
  newSectionContent: string,
): { content: string; found: boolean; created: boolean } {
  const content = existingContent.trim();
  const safeContent = stripLeadingHeading(newSectionContent, sectionName);

  const headingPattern = new RegExp(
    `^(#{2,3})\\s*${escapeRegex(sectionName)}\\s*$`,
    "m",
  );
  const match = content.match(headingPattern);

  if (!match) {
    // Section doesn't exist — create it at the end of the file
    const newSection = `\n\n## ${sectionName}\n${safeContent}`;
    return {
      content: (content + newSection).trim() + "\n",
      found: false,
      created: true,
    };
  }

  const headingLevel = match[1];
  const startIndex = match.index!;
  const headingEndIndex = startIndex + match[0].length;

  const nextHeadingPattern = new RegExp(
    `^${headingLevel}\\s+.+$`,
    "m",
  );

  let endIndex = content.length;
  const remainingContent = content.slice(headingEndIndex);
  const nextMatch = remainingContent.match(nextHeadingPattern);

  if (nextMatch && nextMatch.index !== undefined) {
    endIndex = headingEndIndex + nextMatch.index;
  }

  const existingSectionContent = content.slice(headingEndIndex, endIndex)
    .trim();
  const newSection = existingSectionContent
    ? `${match[0]}\n${existingSectionContent}\n\n${safeContent}`
    : `${match[0]}\n${safeContent}`;

  const newContent = content.slice(0, startIndex) +
    newSection +
    "\n\n" +
    content.slice(endIndex);

  return { content: newContent.trim() + "\n", found: true, created: false };
}

/**
 * Rewrite content within a specific markdown section.
 * Replaces everything between the heading and the next same/higher-level heading
 * with the new content. The heading line itself is preserved.
 * If the section doesn't exist, it is created at the end of the file.
 */
export function rewriteSectionContent(
  existingContent: string,
  sectionName: string,
  newSectionContent: string,
): { content: string; found: boolean; created: boolean } {
  const content = existingContent.trim();
  const safeContent = stripLeadingHeading(newSectionContent, sectionName);

  const headingPattern = new RegExp(
    `^(#{2,3})\\s*${escapeRegex(sectionName)}\\s*$`,
    "m",
  );
  const match = content.match(headingPattern);

  if (!match) {
    // Section doesn't exist — create it at the end of the file
    const newSection = `\n\n## ${sectionName}\n${safeContent}`;
    return {
      content: (content + newSection).trim() + "\n",
      found: false,
      created: true,
    };
  }

  const headingLevel = match[1];
  const startIndex = match.index!;
  const headingEndIndex = startIndex + match[0].length;

  const nextHeadingPattern = new RegExp(
    `^${headingLevel}\\s+.+$`,
    "m",
  );

  let endIndex = content.length;
  const remainingContent = content.slice(headingEndIndex);
  const nextMatch = remainingContent.match(nextHeadingPattern);

  if (nextMatch && nextMatch.index !== undefined) {
    endIndex = headingEndIndex + nextMatch.index;
  }

  const newSection = `${match[0]}\n${safeContent}`;

  const newContent = content.slice(0, headingEndIndex) +
    newSection +
    "\n\n" +
    content.slice(endIndex);

  return { content: newContent.trim() + "\n", found: true, created: false };
}

/**
 * Escape special regex characters in a string.
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Strip a leading ## or ### heading line from content that matches
 * the given section name. Prevents duplication when the caller
 * accidentally includes the heading in the content parameter.
 */
function stripLeadingHeading(content: string, sectionName: string): string {
  const trimmed = content.trim();
  const pattern = new RegExp(
    `^#{2,3}\\s*${escapeRegex(sectionName)}\\s*\n?`,
    "",
  );
  return trimmed.replace(pattern, "").trim();
}

// =============================================================================
// Identity File Manager (MCP + Local Fallback)
// =============================================================================

/**
 * Manages identity file operations with MCP fallback to local files.
 */
export class IdentityFileManager {
  constructor(
    private mcpClient: MCPClient | null,
    private projectRoot: string,
  ) {}

  /**
   * Validate that a category and filename are valid.
   */
  validateFile(
    category: IdentityCategory,
    filename: string,
  ): IdentityOperationResult | null {
    const validFiles = VALID_FILES[category];
    if (!validFiles) {
      return {
        success: false,
        message:
          `Invalid category: ${category}. Must be "self", "user", "relationship", or "custom".`,
        error: "invalid_category",
      };
    }

    // Custom category accepts any valid .md filename
    if (category === "custom") {
      if (!filename.endsWith(".md")) {
        return {
          success: false,
          message: `Invalid filename "${filename}". Must end with .md`,
          error: "invalid_filename",
        };
      }
      // Check for path traversal and invalid characters
      if (
        filename.includes("/") || filename.includes("\\") ||
        filename.includes("..")
      ) {
        return {
          success: false,
          message:
            `Invalid filename "${filename}". Path separators not allowed.`,
          error: "invalid_filename",
        };
      }
      // Must be a single word (letters, numbers, underscores only - no spaces or hyphens)
      const baseName = filename.slice(0, -3); // Remove .md
      if (!/^[a-zA-Z0-9_]+$/.test(baseName)) {
        return {
          success: false,
          message:
            `Invalid filename "${filename}". Use only letters, numbers, and underscores (no spaces).`,
          error: "invalid_filename",
        };
      }
      return null; // Valid custom filename
    }

    if (!validFiles.includes(filename as never)) {
      return {
        success: false,
        message:
          `Invalid filename "${filename}" for category "${category}". Valid files: ${
            validFiles.join(", ")
          }`,
        error: "invalid_filename",
      };
    }

    return null; // Valid
  }

  /**
   * Get the full path to an identity file.
   */
  getFilePath(category: IdentityCategory, filename: string): string {
    return join(this.projectRoot, "identity", category, filename);
  }

  /**
   * Read an identity file.
   */
  async readFile(
    category: IdentityCategory,
    filename: string,
  ): Promise<string> {
    const filePath = this.getFilePath(category, filename);
    try {
      return await Deno.readTextFile(filePath);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        // Return placeholder content
        return "[I am still learning. As I learn more, I will update this file.]";
      }
      throw error;
    }
  }

  /**
   * Write an identity file directly (local only).
   */
  async writeFile(
    category: IdentityCategory,
    filename: string,
    content: string,
  ): Promise<void> {
    const filePath = this.getFilePath(category, filename);

    // Ensure directory exists
    const dirPath = join(this.projectRoot, "identity", category);
    await Deno.mkdir(dirPath, { recursive: true });

    await Deno.writeTextFile(filePath, content);
  }

  /**
   * Append content to an identity file.
   * Routes through MCP if connected, falls back to local otherwise.
   */
  async append(
    category: IdentityCategory,
    filename: string,
    content: string,
  ): Promise<IdentityOperationResult> {
    // Validate first
    const validation = this.validateFile(category, filename);
    if (validation) return validation;

    // Try MCP append tool first (server-side manipulation)
    if (this.mcpClient?.isConnected()) {
      try {
        const result = await this.mcpClient.appendIdentityFile(
          category,
          filename,
          content,
          this.projectRoot,
        );

        if (result.success) {
          console.log(`[Identity] Appended to ${category}/${filename} via MCP`);
          return {
            success: true,
            message: result.message ??
              `I've added this to my ${category}/${filename} file.`,
          };
        }
        // MCP call failed, fall through to local
        console.warn(
          `[Identity] MCP append failed: ${result.message}, falling back to local`,
        );
      } catch (e) {
        console.warn(`[Identity] MCP append error, falling back to local:`, e);
      }
    }

    // Fallback: local manipulation
    const existingContent = await this.readFile(category, filename);
    const newContent = appendToXmlContent(existingContent, content);

    try {
      await this.writeFile(category, filename, newContent);

      // Queue for later MCP sync
      if (this.mcpClient) {
        this.mcpClient.queueIdentityChange(category, filename, newContent);
      }

      console.log(`[Identity] Appended to ${category}/${filename} locally`);
      return {
        success: true,
        message:
          `I've added this to my ${category}/${filename} file (saved locally).`,
      };
    } catch (error) {
      const errorMessage = error instanceof Error
        ? error.message
        : String(error);
      return {
        success: false,
        message: `Failed to update ${category}/${filename}: ${errorMessage}`,
        error: "write_failed",
      };
    }
  }

  /**
   * Prepend content to an identity file (high-priority context).
   * Routes through MCP if connected, falls back to local otherwise.
   */
  async prepend(
    category: IdentityCategory,
    filename: string,
    content: string,
  ): Promise<IdentityOperationResult> {
    // Validate first
    const validation = this.validateFile(category, filename);
    if (validation) return validation;

    // Try MCP prepend tool first (server-side manipulation)
    if (this.mcpClient?.isConnected()) {
      try {
        const result = await this.mcpClient.prependIdentityFile(
          category,
          filename,
          content,
          this.projectRoot,
        );

        if (result.success) {
          console.log(
            `[Identity] Prepended to ${category}/${filename} via MCP`,
          );
          return {
            success: true,
            message: result.message ??
              `I've added this to the top of my ${category}/${filename} file.`,
          };
        }
        console.warn(
          `[Identity] MCP prepend failed: ${result.message}, falling back to local`,
        );
      } catch (e) {
        console.warn(`[Identity] MCP prepend error, falling back to local:`, e);
      }
    }

    // Fallback: local manipulation
    const existingContent = await this.readFile(category, filename);
    const newContent = prependToXmlContent(existingContent, content);

    try {
      await this.writeFile(category, filename, newContent);

      // Queue for later MCP sync
      if (this.mcpClient) {
        this.mcpClient.queueIdentityChange(category, filename, newContent);
      }

      console.log(`[Identity] Prepended to ${category}/${filename} locally`);
      return {
        success: true,
        message:
          `I've added this to the top of my ${category}/${filename} file (saved locally).`,
      };
    } catch (error) {
      const errorMessage = error instanceof Error
        ? error.message
        : String(error);
      return {
        success: false,
        message: `Failed to update ${category}/${filename}: ${errorMessage}`,
        error: "write_failed",
      };
    }
  }

  /**
   * Update a specific section within an identity file.
   */
  async updateSection(
    category: IdentityCategory,
    filename: string,
    sectionName: string,
    content: string,
  ): Promise<IdentityOperationResult> {
    // Validate first
    const validation = this.validateFile(category, filename);
    if (validation) return validation;

    // Try MCP update_section tool first (server-side manipulation)
    if (this.mcpClient?.isConnected()) {
      try {
        const result = await this.mcpClient.updateIdentitySection(
          category,
          filename,
          sectionName,
          content,
          this.projectRoot,
        );

        if (result.success) {
          console.log(
            `[Identity] Updated section "${sectionName}" in ${category}/${filename} via MCP`,
          );
          return {
            success: true,
            message: result.message ??
              `I've updated the "${sectionName}" section in my ${category}/${filename} file.`,
          };
        }
        console.warn(
          `[Identity] MCP section update failed: ${result.message}, falling back to local`,
        );
      } catch (e) {
        console.warn(
          `[Identity] MCP section update error, falling back to local:`,
          e,
        );
      }
    }

    // Fallback: local manipulation
    const existingContent = await this.readFile(category, filename);
    const { content: newContent, created } = updateSection(
      existingContent,
      sectionName,
      content,
    );

    try {
      await this.writeFile(category, filename, newContent);

      // Queue for later MCP sync
      if (this.mcpClient) {
        this.mcpClient.queueIdentityChange(category, filename, newContent);
      }

      const action = created ? "Created" : "Updated";
      console.log(
        `[Identity] ${action} section "${sectionName}" in ${category}/${filename} locally`,
      );
      return {
        success: true,
        message:
          `I've ${action.toLowerCase()} the "${sectionName}" section in my ${category}/${filename} file (saved locally).`,
      };
    } catch (error) {
      const errorMessage = error instanceof Error
        ? error.message
        : String(error);
      return {
        success: false,
        message: `Failed to update ${category}/${filename}: ${errorMessage}`,
        error: "write_failed",
      };
    }
  }

  /**
   * Rewrite a specific section within an identity file.
   * Replaces the section's content entirely while preserving the heading.
   */
  async rewriteSection(
    category: IdentityCategory,
    filename: string,
    sectionName: string,
    content: string,
  ): Promise<IdentityOperationResult> {
    // Validate first
    const validation = this.validateFile(category, filename);
    if (validation) return validation;

    // Try MCP rewrite_section tool first (server-side, atomic)
    if (this.mcpClient?.isConnected()) {
      try {
        const result = await this.mcpClient.rewriteIdentitySection(
          category,
          filename,
          sectionName,
          content,
          this.projectRoot,
        );

        if (result.success) {
          console.log(
            `[Identity] Rewrote section "${sectionName}" in ${category}/${filename} via MCP`,
          );
          return {
            success: true,
            message: result.message ??
              `I've rewritten the "${sectionName}" section in my ${category}/${filename} file.`,
          };
        }
        console.warn(
          `[Identity] MCP rewrite failed: ${result.message}, falling back to local`,
        );
      } catch (e) {
        console.warn(`[Identity] MCP rewrite error, falling back to local:`, e);
      }
    }

    // Fallback: local manipulation
    const existingContent = await this.readFile(category, filename);
    const { content: newContent, created } = rewriteSectionContent(
      existingContent,
      sectionName,
      content,
    );

    try {
      await this.writeFile(category, filename, newContent);

      // Queue for later MCP sync
      if (this.mcpClient) {
        this.mcpClient.queueIdentityChange(category, filename, newContent);
      }

      const action = created ? "Created" : "Rewrote";
      console.log(
        `[Identity] ${action} section "${sectionName}" in ${category}/${filename} locally`,
      );
      return {
        success: true,
        message:
          `I've ${action.toLowerCase()} the "${sectionName}" section in my ${category}/${filename} file (saved locally).`,
      };
    } catch (error) {
      const errorMessage = error instanceof Error
        ? error.message
        : String(error);
      return {
        success: false,
        message: `Failed to update ${category}/${filename}: ${errorMessage}`,
        error: "write_failed",
      };
    }
  }

  /**
   * Create a snapshot of an identity file.
   */
  async createSnapshot(
    category: IdentityCategory,
    filename: string,
    content: string,
    reason: string,
  ): Promise<void> {
    const today = new Date().toISOString().split("T")[0];
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const snapshotFilename = `${filename.replace(/\.md$/, "")}_${timestamp}.md`;
    const snapshotDir = join(this.projectRoot, ".snapshots", category);
    const snapshotPath = join(snapshotDir, snapshotFilename);

    try {
      await Deno.mkdir(snapshotDir, { recursive: true });

      const snapshotContent = `# Snapshot: ${category}/${filename}
# Date: ${today}
# Reason: ${reason}

${content}
`;

      await Deno.writeTextFile(snapshotPath, snapshotContent);
      console.log(`[Identity] Created snapshot: ${snapshotFilename}`);
    } catch (error) {
      console.error(`[Identity] Failed to create snapshot:`, error);
      // Don't fail the operation if snapshot fails
    }
  }

  /**
   * List available snapshots.
   */
  async listSnapshots(
    category?: IdentityCategory,
    filename?: string,
  ): Promise<
    Array<{ category: string; filename: string; date: string; path: string }>
  > {
    const snapshots: Array<
      { category: string; filename: string; date: string; path: string }
    > = [];
    const snapshotsDir = join(this.projectRoot, ".snapshots");

    try {
      const categories = category
        ? [category]
        : (["self", "user", "relationship"] as IdentityCategory[]);

      for (const cat of categories) {
        const catDir = join(snapshotsDir, cat);
        try {
          const entries = Deno.readDir(catDir);
          for await (const entry of entries) {
            if (!entry.isFile || !entry.name.endsWith(".md")) continue;

            // Filter by filename if specified
            if (filename) {
              const baseName = filename.replace(/\.md$/, "");
              if (!entry.name.startsWith(baseName)) continue;
            }

            // Extract date from filename
            const dateMatch = entry.name.match(/(\d{4}-\d{2}-\d{2})/);
            const date = dateMatch ? dateMatch[1] : "unknown";

            snapshots.push({
              category: cat,
              filename: entry.name,
              date,
              path: join(catDir, entry.name),
            });
          }
        } catch {
          // Directory doesn't exist, skip
        }
      }

      // Sort by date descending
      snapshots.sort((a, b) => b.date.localeCompare(a.date));

      return snapshots;
    } catch {
      return [];
    }
  }

  /**
   * Restore an identity file from a local snapshot.
   * Strips the snapshot header (lines starting with #) and writes the content.
   */
  async restoreFromSnapshot(
    snapshotPath: string,
  ): Promise<IdentityOperationResult> {
    try {
      const snapshotContent = await Deno.readTextFile(snapshotPath);

      // Parse the snapshot header to extract category and filename
      const headerMatch = snapshotContent.match(/^# Snapshot: (.+)\/(.+)$/m);
      if (!headerMatch) {
        return {
          success: false,
          message: "Invalid snapshot file: missing header",
          error: "invalid_snapshot",
        };
      }

      const category = headerMatch[1] as IdentityCategory;
      const filename = headerMatch[2];

      // Strip header lines and extract actual content
      const lines = snapshotContent.split("\n");
      let contentStart = 0;
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].trim() === "" && i > 2) {
          contentStart = i + 1;
          break;
        }
      }
      const content = lines.slice(contentStart).join("\n");

      // Create a snapshot of the current file before restoring
      const currentContent = await this.readFile(category, filename).catch(() =>
        ""
      );
      if (currentContent) {
        await this.createSnapshot(
          category,
          filename,
          currentContent,
          "pre-restore",
        );
      }

      // Write restored content
      await this.writeFile(category, filename, content);

      // Queue for MCP sync if connected
      if (this.mcpClient) {
        this.mcpClient.queueIdentityChange(category, filename, content);
      }

      console.log(
        `[Identity] Restored ${category}/${filename} from local snapshot`,
      );
      return {
        success: true,
        message:
          `I've restored my ${category}/${filename} file from a local snapshot.`,
      };
    } catch (error) {
      const errorMessage = error instanceof Error
        ? error.message
        : String(error);
      return {
        success: false,
        message: `Failed to restore snapshot: ${errorMessage}`,
        error: "restore_failed",
      };
    }
  }

  /**
   * Check if an identity file exists.
   */
  async exists(category: IdentityCategory, filename: string): Promise<boolean> {
    const filePath = this.getFilePath(category, filename);
    try {
      await Deno.stat(filePath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Create a new identity file.
   * Fails if the file already exists. Routes through MCP if connected.
   */
  async create(
    category: IdentityCategory,
    filename: string,
    content: string,
  ): Promise<IdentityOperationResult> {
    const validation = this.validateFile(category, filename);
    if (validation) return validation;

    if (await this.exists(category, filename)) {
      return {
        success: false,
        message:
          `File ${category}/${filename} already exists. Use append, prepend, update_section, or rewrite_section to modify it.`,
        error: "already_exists",
      };
    }

    // Try MCP first
    if (this.mcpClient?.isConnected()) {
      try {
        const success = await this.mcpClient.writeIdentityFile(
          category,
          filename,
          content,
          this.projectRoot,
        );
        if (success) {
          console.log(`[Identity] Created ${category}/${filename} via MCP`);
          return {
            success: true,
            message: `I've created my ${category}/${filename} file.`,
          };
        }
      } catch (e) {
        console.warn(`[Identity] MCP create failed, falling back to local:`, e);
      }
    }

    // Fallback to local write
    try {
      await this.writeFile(category, filename, content);

      if (this.mcpClient) {
        this.mcpClient.queueIdentityChange(category, filename, content);
      }

      console.log(`[Identity] Created ${category}/${filename} locally`);
      return {
        success: true,
        message:
          `I've created my ${category}/${filename} file (saved locally).`,
      };
    } catch (error) {
      const errorMessage = error instanceof Error
        ? error.message
        : String(error);
      return {
        success: false,
        message: `Failed to create ${category}/${filename}: ${errorMessage}`,
        error: "write_failed",
      };
    }
  }

  /**
   * Delete a custom identity file.
   * Only custom files can be deleted; predefined files in other categories cannot.
   */
  async deleteCustomFile(filename: string): Promise<IdentityOperationResult> {
    // Validate filename
    const validation = this.validateFile("custom", filename);
    if (validation) return validation;

    // Try MCP first
    if (this.mcpClient?.isConnected()) {
      try {
        const result = await this.mcpClient.deleteCustomFile(
          filename,
          this.projectRoot,
        );
        if (result.success) {
          console.log(`[Identity] Deleted custom file ${filename} via MCP`);
          return {
            success: true,
            message: result.message ??
              `I've deleted my custom file: ${filename}`,
          };
        }
        return {
          success: false,
          message: result.message ?? "Failed to delete custom file",
        };
      } catch (e) {
        console.warn(`[Identity] MCP delete failed, falling back to local:`, e);
      }
    }

    // Fallback: local delete
    try {
      const filePath = this.getFilePath("custom", filename);
      await Deno.remove(filePath);
      console.log(`[Identity] Deleted custom file ${filename} locally`);
      return {
        success: true,
        message: `I've deleted my custom file: ${filename} (deleted locally).`,
      };
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        return {
          success: false,
          message: `Custom file ${filename} not found`,
          error: "not_found",
        };
      }
      const errorMessage = error instanceof Error
        ? error.message
        : String(error);
      return {
        success: false,
        message: `Failed to delete custom file ${filename}: ${errorMessage}`,
        error: "delete_failed",
      };
    }
  }
}
