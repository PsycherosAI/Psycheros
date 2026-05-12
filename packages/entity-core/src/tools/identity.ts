/**
 * Identity Tools
 *
 * MCP tools for reading and writing my identity files.
 * All tools operate from my first-person perspective.
 */

import { z } from "zod";
import type { FileStore } from "../storage/mod.ts";
import type { IdentityFile } from "../types.ts";
import { createSnapshot } from "../snapshot/mod.ts";
import {
  getPromptLabel,
  loadIdentityMeta,
  saveIdentityMeta,
} from "./identity-meta.ts";

/**
 * Schema for identity category.
 */
const IdentityCategorySchema = z.enum([
  "self",
  "user",
  "relationship",
  "custom",
]);

/** Safe filename: alphanumeric, underscores, hyphens, must end with .md. Prevents path traversal. */
const SafeFilenameSchema = z.string().min(1).regex(
  /^[a-zA-Z0-9_-]+\.md$/,
  "Filename must be alphanumeric (with underscores/hyphens) and end with .md",
);

/**
 * Input schema for identity/get_all tool.
 */
export const IdentityGetAllSchema = z.object({});

/**
 * Input schema for identity/write tool.
 */
export const IdentityWriteSchema = z.object({
  category: IdentityCategorySchema,
  filename: SafeFilenameSchema,
  content: z.string(),
  instanceId: z.string().min(1),
});

/**
 * Input schema for identity_append tool.
 */
export const IdentityAppendSchema = z.object({
  category: IdentityCategorySchema,
  filename: SafeFilenameSchema,
  content: z.string(),
  instanceId: z.string().min(1),
});

/**
 * Input schema for identity_prepend tool.
 */
export const IdentityPrependSchema = z.object({
  category: IdentityCategorySchema,
  filename: SafeFilenameSchema,
  content: z.string(),
  instanceId: z.string().min(1),
});

/**
 * Input schema for identity_update_section tool.
 */
export const IdentityUpdateSectionSchema = z.object({
  category: IdentityCategorySchema,
  filename: SafeFilenameSchema,
  section: z.string().min(1),
  content: z.string(),
  instanceId: z.string().min(1),
});

/**
 * Input schema for identity_delete_custom tool.
 */
export const IdentityDeleteCustomSchema = z.object({
  filename: SafeFilenameSchema,
});

/**
 * Input schema for identity/rewrite_section tool.
 */
export const IdentityRewriteSectionSchema = z.object({
  category: IdentityCategorySchema,
  filename: SafeFilenameSchema,
  section: z.string().min(1),
  content: z.string(),
  instanceId: z.string().min(1),
});

/**
 * Input schema for identity/get_meta tool.
 */
export const IdentityGetMetaSchema = z.object({
  category: IdentityCategorySchema.optional(),
  filename: z.string().optional(),
});

/**
 * Input schema for identity/set_meta tool.
 */
export const IdentitySetMetaSchema = z.object({
  category: IdentityCategorySchema,
  filename: SafeFilenameSchema,
  promptLabel: z.string().min(1),
});

/**
 * Output type for identity/get_all tool.
 */
export interface IdentityGetAllOutput {
  self: Array<{ filename: string; content: string; promptLabel?: string }>;
  user: Array<{ filename: string; content: string; promptLabel?: string }>;
  relationship: Array<
    { filename: string; content: string; promptLabel?: string }
  >;
  custom: Array<{ filename: string; content: string; promptLabel?: string }>;
}

/**
 * Output type for identity operations.
 */
export interface IdentityOperationOutput {
  success: boolean;
  message: string;
  content?: string; // The resulting content
}

// =============================================================================
// Content Utilities
// =============================================================================

/**
 * Append content to the end of a file's content.
 */
function appendContent(
  existingContent: string,
  newContent: string,
): string {
  const addition = `\n\n${newContent.trim()}`;
  return existingContent.trim() + addition + "\n";
}

/**
 * Prepend content to the beginning of a file's content.
 */
function prependContent(
  existingContent: string,
  newContent: string,
): string {
  const addition = `${newContent.trim()}\n\n`;
  return addition + existingContent.trim() + "\n";
}

/**
 * Append content within a specific markdown section.
 * New content is added after any existing content in the section.
 * If the section doesn't exist, it is created at the end of the file.
 */
function updateSection(
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

  // Find the next heading of same or higher level
  const nextHeadingPattern = new RegExp(`^${headingLevel}\\s+.+$`, "m");
  let endIndex = content.length;
  const remainingContent = content.slice(headingEndIndex);
  const nextMatch = remainingContent.match(nextHeadingPattern);

  if (nextMatch && nextMatch.index !== undefined) {
    endIndex = headingEndIndex + nextMatch.index;
  }

  // Preserve existing content in the section and append new content after it
  const existingSectionContent = content.slice(headingEndIndex, endIndex)
    .trim();
  const newSection = existingSectionContent
    ? `${match[0]}\n${existingSectionContent}\n\n${safeContent}`
    : `${match[0]}\n${safeContent}`;
  const newContent = content.slice(0, startIndex) + newSection + "\n\n" +
    content.slice(endIndex);

  return { content: newContent.trim() + "\n", found: true, created: false };
}

/**
 * Replace content within a specific markdown section.
 * Everything between the heading and the next same/higher-level heading
 * is replaced. The heading line itself is preserved.
 * If the section doesn't exist, it is created at the end of the file.
 */
function rewriteSectionContent(
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

  // Find the next heading of same or higher level, or end of content
  const nextHeadingPattern = new RegExp(`^${headingLevel}\\s+.+$`, "m");
  let endIndex = content.length;
  const remainingContent = content.slice(headingEndIndex);
  const nextMatch = remainingContent.match(nextHeadingPattern);

  if (nextMatch && nextMatch.index !== undefined) {
    endIndex = headingEndIndex + nextMatch.index;
  }

  // Replace section content (keep the heading, replace everything after it)
  const newSection = `${match[0]}\n${safeContent}`;
  const newContent = content.slice(0, headingEndIndex) +
    newSection +
    "\n\n" +
    content.slice(endIndex);

  return { content: newContent.trim() + "\n", found: true, created: false };
}

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
// Tool Handlers
// =============================================================================

/**
 * Create the identity/get_all tool handler.
 */
export function createIdentityGetAllHandler(store: FileStore) {
  return async (): Promise<IdentityGetAllOutput> => {
    const identity = await store.readAllIdentity();
    const meta = await loadIdentityMeta(store.dataDirectory);

    const attachLabel = (f: IdentityFile) => ({
      filename: f.filename,
      content: f.content,
      promptLabel: getPromptLabel(meta, f.category, f.filename),
    });

    return {
      self: identity.self.map(attachLabel),
      user: identity.user.map(attachLabel),
      relationship: identity.relationship.map(attachLabel),
      custom: identity.custom.map(attachLabel),
    };
  };
}

/**
 * Create the identity/write tool handler.
 */
export function createIdentityWriteHandler(store: FileStore) {
  return async (
    input: z.infer<typeof IdentityWriteSchema>,
  ): Promise<IdentityOperationOutput> => {
    const { category, filename, content, instanceId } = input;

    if (!filename.endsWith(".md")) {
      return { success: false, message: "Filename must end with .md" };
    }

    // Create pre-replace snapshot if file already exists
    try {
      const existingFiles = await store.readIdentityCategory(category);
      const existing = existingFiles.find((f) => f.filename === filename);
      if (existing && existing.content.trim().length > 0) {
        await createSnapshot(
          store,
          category,
          filename,
          existing.content,
          "pre-replace",
          instanceId === "psycheros" ? "psycheros" : "entity-core",
        );
      }
    } catch (error) {
      console.error("[Identity] Pre-replace snapshot failed:", error);
      // Continue with write even if snapshot fails
    }

    const file: IdentityFile = {
      category,
      filename,
      content,
      version: 1,
      lastModified: new Date().toISOString(),
      modifiedBy: instanceId,
    };

    await store.writeIdentityFile(file);

    return {
      success: true,
      message: `I have updated my ${category} file: ${filename}`,
      content,
    };
  };
}

/**
 * Create the identity_append tool handler.
 */
export function createIdentityAppendHandler(store: FileStore) {
  return async (
    input: z.infer<typeof IdentityAppendSchema>,
  ): Promise<IdentityOperationOutput> => {
    const { category, filename, content, instanceId } = input;

    if (!filename.endsWith(".md")) {
      return { success: false, message: "Filename must end with .md" };
    }

    // Read existing file
    const files = await store.readIdentityCategory(category);
    const existingFile = files.find((f) => f.filename === filename);

    const existingContent = existingFile?.content ?? "";
    const newContent = appendContent(existingContent, content);

    const file: IdentityFile = {
      category,
      filename,
      content: newContent,
      version: (existingFile?.version ?? 0) + 1,
      lastModified: new Date().toISOString(),
      modifiedBy: instanceId,
    };

    await store.writeIdentityFile(file);

    return {
      success: true,
      message: `I have appended to my ${category} file: ${filename}`,
      content: newContent,
    };
  };
}

/**
 * Create the identity_prepend tool handler.
 */
export function createIdentityPrependHandler(store: FileStore) {
  return async (
    input: z.infer<typeof IdentityPrependSchema>,
  ): Promise<IdentityOperationOutput> => {
    const { category, filename, content, instanceId } = input;

    if (!filename.endsWith(".md")) {
      return { success: false, message: "Filename must end with .md" };
    }

    // Read existing file
    const files = await store.readIdentityCategory(category);
    const existingFile = files.find((f) => f.filename === filename);

    const existingContent = existingFile?.content ?? "";
    const newContent = prependContent(existingContent, content);

    const file: IdentityFile = {
      category,
      filename,
      content: newContent,
      version: (existingFile?.version ?? 0) + 1,
      lastModified: new Date().toISOString(),
      modifiedBy: instanceId,
    };

    await store.writeIdentityFile(file);

    return {
      success: true,
      message: `I have prepended to my ${category} file: ${filename}`,
      content: newContent,
    };
  };
}

/**
 * Create the identity_update_section tool handler.
 */
export function createIdentityUpdateSectionHandler(store: FileStore) {
  return async (
    input: z.infer<typeof IdentityUpdateSectionSchema>,
  ): Promise<IdentityOperationOutput> => {
    const { category, filename, section, content, instanceId } = input;

    if (!filename.endsWith(".md")) {
      return { success: false, message: "Filename must end with .md" };
    }

    // Read existing file
    const files = await store.readIdentityCategory(category);
    const existingFile = files.find((f) => f.filename === filename);

    if (!existingFile) {
      return {
        success: false,
        message: `File ${category}/${filename} not found`,
      };
    }

    const result = updateSection(existingFile.content, section, content);

    const file: IdentityFile = {
      category,
      filename,
      content: result.content,
      version: existingFile.version + 1,
      lastModified: new Date().toISOString(),
      modifiedBy: instanceId,
    };

    await store.writeIdentityFile(file);

    if (result.created) {
      return {
        success: true,
        message:
          `I have created the "${section}" section in my ${category} file: ${filename}`,
        content: result.content,
      };
    }

    return {
      success: true,
      message:
        `I have updated the "${section}" section in my ${category} file: ${filename}`,
      content: result.content,
    };
  };
}

/**
 * Create the identity_delete_custom tool handler.
 * Only custom files can be deleted.
 */
export function createIdentityDeleteCustomHandler(store: FileStore) {
  return async (
    input: z.infer<typeof IdentityDeleteCustomSchema>,
  ): Promise<IdentityOperationOutput> => {
    const { filename } = input;

    if (!filename.endsWith(".md")) {
      return { success: false, message: "Filename must end with .md" };
    }

    // Validate filename - no path traversal
    if (
      filename.includes("/") || filename.includes("\\") ||
      filename.includes("..")
    ) {
      return {
        success: false,
        message: "Invalid filename: path separators not allowed",
      };
    }

    const deleted = await store.deleteIdentityFile("custom", filename);

    if (!deleted) {
      return {
        success: false,
        message: `Custom file ${filename} not found`,
      };
    }

    return {
      success: true,
      message: `I have deleted my custom file: ${filename}`,
    };
  };
}

/**
 * Create the identity/rewrite_section tool handler.
 * Replaces all content within a markdown section while preserving the heading.
 */
export function createIdentityRewriteSectionHandler(store: FileStore) {
  return async (
    input: z.infer<typeof IdentityRewriteSectionSchema>,
  ): Promise<IdentityOperationOutput> => {
    const { category, filename, section, content, instanceId } = input;

    if (!filename.endsWith(".md")) {
      return { success: false, message: "Filename must end with .md" };
    }

    const files = await store.readIdentityCategory(category);
    const existingFile = files.find((f) => f.filename === filename);

    if (!existingFile) {
      return {
        success: false,
        message: `File ${category}/${filename} not found`,
      };
    }

    // Create pre-rewrite snapshot
    try {
      await createSnapshot(
        store,
        category,
        filename,
        existingFile.content,
        "pre-replace",
        instanceId === "psycheros" ? "psycheros" : "entity-core",
      );
    } catch (error) {
      console.error("[Identity] Pre-rewrite snapshot failed:", error);
    }

    const result = rewriteSectionContent(
      existingFile.content,
      section,
      content,
    );

    const file: IdentityFile = {
      category,
      filename,
      content: result.content,
      version: existingFile.version + 1,
      lastModified: new Date().toISOString(),
      modifiedBy: instanceId,
    };

    await store.writeIdentityFile(file);

    if (result.created) {
      return {
        success: true,
        message:
          `I have created the "${section}" section in my ${category} file: ${filename}`,
        content: result.content,
      };
    }

    return {
      success: true,
      message:
        `I have rewritten the "${section}" section in my ${category} file: ${filename}`,
      content: result.content,
    };
  };
}

/**
 * Create the identity/get_meta tool handler.
 * Returns prompt labels for identity files.
 */
export function createIdentityGetMetaHandler(store: FileStore) {
  return async (
    input: z.infer<typeof IdentityGetMetaSchema>,
  ): Promise<{ success: boolean; meta: Record<string, string> }> => {
    const meta = await loadIdentityMeta(store.dataDirectory);

    if (input.category) {
      // Filter to specific category
      const identity = await store.readIdentityCategory(input.category);
      const filtered: Record<string, string> = {};
      for (const file of identity) {
        const key = `${file.category}/${file.filename}`;
        filtered[key] = getPromptLabel(meta, file.category, file.filename);
      }
      return { success: true, meta: filtered };
    }

    if (input.filename) {
      // Return all labels (filename param ignored for get_meta — returns everything)
      return { success: true, meta };
    }

    return { success: true, meta };
  };
}

/**
 * Create the identity/set_meta tool handler.
 * Sets the prompt label for an identity file.
 */
export function createIdentitySetMetaHandler(store: FileStore) {
  return async (
    input: z.infer<typeof IdentitySetMetaSchema>,
  ): Promise<{ success: boolean; message: string }> => {
    const { category, filename, promptLabel } = input;

    const meta = await loadIdentityMeta(store.dataDirectory);
    const key = `${category}/${filename}`;
    meta[key] = promptLabel;
    await saveIdentityMeta(store.dataDirectory, meta);

    return {
      success: true,
      message:
        `I have set the prompt label for ${category}/${filename} to "${promptLabel}"`,
    };
  };
}

// Legacy type alias for backward compatibility
export type IdentityWriteOutput = IdentityOperationOutput;

/**
 * Tool definitions for MCP registration.
 */
export const identityTools = {
  "identity/get_all": {
    description:
      "Get all my identity files (self, user, relationship, custom). These define who I am, who I'm talking to, and our relationship. Each file includes a promptLabel used for context wrapping.",
    inputSchema: IdentityGetAllSchema,
  },
  "identity/write": {
    description:
      "Update one of my identity files by replacing the entire content. Creates an automatic pre-replace snapshot. For section-level changes, prefer identity/update_section or identity/rewrite_section.",
    inputSchema: IdentityWriteSchema,
  },
  "identity/append": {
    description:
      "Append content to one of my identity files. The content is added at the end. XML wrapper tags are handled automatically by the system — I only need to provide the content to add.",
    inputSchema: IdentityAppendSchema,
  },
  "identity/prepend": {
    description:
      "Prepend content to one of my identity files. The content is added at the beginning. XML wrapper tags are handled automatically by the system.",
    inputSchema: IdentityPrependSchema,
  },
  "identity/update_section": {
    description:
      "Append content to a specific section in one of my identity files. The section is identified by its ## markdown heading. Existing content in the section is preserved. If the section doesn't exist, it is created automatically at the end of the file. The content parameter must NOT include the ## heading line — the system adds it automatically.",
    inputSchema: IdentityUpdateSectionSchema,
  },
  "identity/rewrite_section": {
    description:
      "DESTRUCTIVE: Replace ALL content within a specific section of one of my identity files. The section is identified by its ## markdown heading. The heading line is preserved but everything under it is permanently replaced. A pre-replace snapshot is created automatically, but this operation should still be used sparingly. The content parameter must NOT include the ## heading line — the system adds it automatically. Prefer identity/update_section unless the existing content is outdated, redundant, or needs to be fundamentally restructured.",
    inputSchema: IdentityRewriteSectionSchema,
  },
  "identity/delete_custom": {
    description:
      "Delete a custom identity file. Only custom files can be deleted; predefined files in other categories cannot.",
    inputSchema: IdentityDeleteCustomSchema,
  },
  "identity/get_meta": {
    description:
      "Get the prompt labels for my identity files. Prompt labels are the XML tag names used to wrap content in the context.",
    inputSchema: IdentityGetMetaSchema,
  },
  "identity/set_meta": {
    description:
      "Set the prompt label for an identity file. The prompt label is used as the XML tag name when wrapping the file's content in the context.",
    inputSchema: IdentitySetMetaSchema,
  },
};
