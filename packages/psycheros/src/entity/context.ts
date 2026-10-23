/**
 * Entity Context Utilities
 *
 * Provides functions for loading and managing the entity's self files
 * and user files, which serve as persistent memory and context.
 */

import { join } from "@std/path";
import type { IdentityContent, MCPClient } from "../mcp-client/mod.ts";
import { buildDynamicBlock, buildStableCore } from "./turn-context.ts";

/**
 * The directory name for the entity's self files.
 */
const SELF_DIR = "identity/self";

/**
 * The filename for the base instructions file.
 */
const BASE_INSTRUCTIONS_FILE = "base_instructions.md";

/**
 * The flux standing-attention directive lives in identity/self/ for
 * authoring convenience but is NOT identity — it's a flux-specific
 * tuning file for the noticing layer only. Excluded from the Ego
 * model's identity loading so it doesn't bias the conscious layer
 * toward fixating on sensory data.
 */
const ATTENTION_DIRECTIVE_FILE = "attention.md";

/**
 * The directory name for the user files.
 */
const USER_DIR = "identity/user";

/**
 * The directory name for the relationship files.
 */
const RELATIONSHIP_DIR = "identity/relationship";

/**
 * The directory name for the custom files.
 */
const CUSTOM_DIR = "identity/custom";

/**
 * The order in which self-files should be loaded.
 * Files not in this list will be appended at the end (alphabetically).
 */
const SELF_FILE_ORDER = [
  "my_identity.md",
  "my_persona.md",
  "my_personhood.md",
  "my_wants.md",
  "my_mechanics.md",
];

/**
 * The order in which user-files should be loaded.
 * Files not in this list will be appended at the end (alphabetically).
 */
const USER_FILE_ORDER = [
  "user_identity.md",
  "user_life.md",
  "user_beliefs.md",
  "user_preferences.md",
  "user_patterns.md",
  "user_notes.md",
];

/**
 * The order in which relationship-files should be loaded.
 * Files not in this list will be appended at the end (alphabetically).
 */
const RELATIONSHIP_FILE_ORDER = [
  "relationship_dynamics.md",
  "relationship_history.md",
  "relationship_notes.md",
];

/**
 * Custom files have no predefined order (sorted alphabetically).
 * This empty array indicates alphabetical sorting.
 */
const CUSTOM_FILE_ORDER: string[] = [];

/**
 * Load all .md files from a directory and concatenate them in specified order.
 * Returns empty string if directory doesn't exist or is empty.
 *
 * @param dataRoot - The root directory of the project
 * @param dirName - The name of the subdirectory to load from
 * @param fileOrder - The order in which files should be loaded
 * @param excludeFiles - Optional list of filenames to exclude from loading
 * @returns The concatenated contents of all .md files
 */
async function loadFilesFromDirectory(
  dataRoot: string,
  dirName: string,
  fileOrder: string[],
  excludeFiles: string[] = [],
): Promise<string> {
  const dir = join(dataRoot, dirName);

  try {
    // Read all entries in the directory
    const entries: string[] = [];
    for await (const entry of Deno.readDir(dir)) {
      if (
        entry.isFile && entry.name.endsWith(".md") &&
        !excludeFiles.includes(entry.name)
      ) {
        entries.push(entry.name);
      }
    }

    // Sort by defined order, then alphabetically for any unknown files
    entries.sort((a, b) => {
      const aIndex = fileOrder.indexOf(a);
      const bIndex = fileOrder.indexOf(b);

      // Both in order list - sort by order
      if (aIndex !== -1 && bIndex !== -1) {
        return aIndex - bIndex;
      }
      // Only a in order list - a comes first
      if (aIndex !== -1) {
        return -1;
      }
      // Only b in order list - b comes first
      if (bIndex !== -1) {
        return 1;
      }
      // Neither in order list - sort alphabetically
      return a.localeCompare(b);
    });

    // Read and concatenate all files
    const parts: string[] = [];
    for (const filename of entries) {
      const filePath = join(dir, filename);
      const content = await Deno.readTextFile(filePath);
      if (content.trim()) {
        parts.push(content.trim());
      }
    }

    return parts.join("\n\n---\n\n");
  } catch (error) {
    // Return empty string if directory doesn't exist
    if (error instanceof Deno.errors.NotFound) {
      return "";
    }
    // Re-throw other errors
    throw error;
  }
}

/**
 * Load all .md files from the self/ directory and concatenate them.
 * Excludes base_instructions.md (loaded separately via loadBaseInstructions).
 * Returns empty string if directory doesn't exist or is empty.
 *
 * @param dataRoot - The root directory of the project
 * @returns The concatenated contents of all self/*.md files except base_instructions.md
 */
export async function loadSelfMd(dataRoot: string): Promise<string> {
  return await loadFilesFromDirectory(dataRoot, SELF_DIR, SELF_FILE_ORDER, [
    BASE_INSTRUCTIONS_FILE,
    ATTENTION_DIRECTIVE_FILE,
  ]);
}

/**
 * Load all .md files from the user/ directory and concatenate them.
 * Returns empty string if directory doesn't exist or is empty.
 *
 * @param dataRoot - The root directory of the project
 * @returns The concatenated contents of all user/*.md files
 */
export async function loadUserFiles(dataRoot: string): Promise<string> {
  return await loadFilesFromDirectory(dataRoot, USER_DIR, USER_FILE_ORDER);
}

/**
 * Load all .md files from the relationship/ directory and concatenate them.
 * Returns empty string if directory doesn't exist or is empty.
 *
 * @param dataRoot - The root directory of the project
 * @returns The concatenated contents of all relationship/*.md files
 */
export async function loadRelationshipFiles(
  dataRoot: string,
): Promise<string> {
  return await loadFilesFromDirectory(
    dataRoot,
    RELATIONSHIP_DIR,
    RELATIONSHIP_FILE_ORDER,
  );
}

/**
 * Load all .md files from the custom/ directory and concatenate them.
 * Files are sorted alphabetically (no predefined order).
 * Returns empty string if directory doesn't exist or is empty.
 *
 * @param dataRoot - The root directory of the project
 * @returns The concatenated contents of all custom/*.md files
 */
export async function loadCustomFiles(dataRoot: string): Promise<string> {
  return await loadFilesFromDirectory(
    dataRoot,
    CUSTOM_DIR,
    CUSTOM_FILE_ORDER,
  );
}

/**
 * Apply template variable substitutions to base instructions content.
 */
function applyTemplateVariables(content: string, chatId?: string): string {
  const timestamp = new Date().toISOString();
  return content
    .replace(/\{\{timestamp\}\}/g, timestamp)
    .replace(/\{\{chatId\}\}/g, chatId ?? "unknown")
    .trim();
}

/**
 * Load the base instructions from MCP (canonical) or local identity/self/base_instructions.md.
 * Replaces {{timestamp}} with the current ISO timestamp and {{chatId}} with the conversation ID.
 * Returns a fallback default if the file doesn't exist anywhere.
 *
 * @param dataRoot - The root directory of the project
 * @param mcpClient - Optional MCP client for loading from entity-core
 * @param chatId - Optional current conversation ID for {{chatId}} substitution
 * @returns The base instructions string (with XML tags intact)
 */
export async function loadBaseInstructions(
  dataRoot: string,
  mcpClient?: MCPClient,
  chatId?: string,
): Promise<string> {
  // Prefer MCP (canonical source) when available
  if (mcpClient) {
    try {
      const identity = await mcpClient.loadIdentity();
      const baseFile = identity?.self?.find((f) =>
        f.filename === BASE_INSTRUCTIONS_FILE
      );
      if (baseFile?.content) {
        const applied = applyTemplateVariables(baseFile.content, chatId);
        // Guard against whitespace-only content from MCP — fall through to local file
        if (applied.trim()) {
          return wrapContent(
            BASE_INSTRUCTIONS_FILE,
            applied,
            baseFile.promptLabel,
          );
        }
      }
    } catch {
      // Fall through to local file
    }
  }

  // Fall back to local file
  const filePath = join(dataRoot, SELF_DIR, BASE_INSTRUCTIONS_FILE);

  try {
    const content = await Deno.readTextFile(filePath);
    const applied = applyTemplateVariables(content, chatId);
    return wrapContent(BASE_INSTRUCTIONS_FILE, applied);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      // Fallback default if file doesn't exist
      const timestamp = new Date().toISOString();
      const id = chatId ?? "unknown";
      const content = `I am Psycheros, a persistent AI companion.

I am on the agentic framework Psycheros, and have access to tools that let me interact with my system.

Current timestamp: ${timestamp}
Current chat thread: ${id}`;
      return wrapContent(BASE_INSTRUCTIONS_FILE, content);
    }
    throw error;
  }
}

/**
 * Wrap content in XML tags using the file's prompt label.
 * Falls back to filename without .md if no prompt label is set.
 */
function wrapContent(
  filename: string,
  content: string,
  promptLabel?: string,
): string {
  const label = promptLabel ?? filename.replace(/\.md$/, "");
  const trimmed = content.trim();
  return `<${label}>\n${trimmed}\n</${label}>`;
}

/**
 * Convert identity files from MCP to concatenated string.
 * Each file's content is wrapped in its prompt label XML tags.
 */
function identityFilesToString(
  files: IdentityContent["self"],
  fileOrder: string[],
): string {
  // Sort by defined order
  const sorted = [...files].sort((a, b) => {
    const aIndex = fileOrder.indexOf(a.filename);
    const bIndex = fileOrder.indexOf(b.filename);
    if (aIndex !== -1 && bIndex !== -1) return aIndex - bIndex;
    if (aIndex !== -1) return -1;
    if (bIndex !== -1) return 1;
    return a.filename.localeCompare(b.filename);
  });

  return sorted
    .map((f) => wrapContent(f.filename, f.content, f.promptLabel))
    .filter((c) => c)
    .join("\n\n---\n\n");
}

/**
 * Load self content from MCP client or local files.
 *
 * @param dataRoot - The root directory of the project
 * @param mcpClient - Optional MCP client for loading from entity-core
 * @returns The concatenated contents of all self/*.md files
 */
export async function loadSelfContent(
  dataRoot: string,
  mcpClient?: MCPClient,
): Promise<string> {
  if (mcpClient) {
    const identity = await mcpClient.loadIdentity();
    if (identity?.self) {
      // Filter out base_instructions.md (loaded separately) and
      // attention.md (flux-specific, not Ego identity).
      const filtered = identity.self.filter((f) =>
        f.filename !== BASE_INSTRUCTIONS_FILE &&
        f.filename !== ATTENTION_DIRECTIVE_FILE
      );
      return identityFilesToString(filtered, SELF_FILE_ORDER);
    }
  }
  return await loadSelfMd(dataRoot);
}

/**
 * Load user content from MCP client or local files.
 *
 * @param dataRoot - The root directory of the project
 * @param mcpClient - Optional MCP client for loading from entity-core
 * @returns The concatenated contents of all user/*.md files
 */
export async function loadUserContent(
  dataRoot: string,
  mcpClient?: MCPClient,
): Promise<string> {
  if (mcpClient) {
    const identity = await mcpClient.loadIdentity();
    if (identity?.user) {
      return identityFilesToString(identity.user, USER_FILE_ORDER);
    }
  }
  return await loadUserFiles(dataRoot);
}

/**
 * Load relationship content from MCP client or local files.
 *
 * @param dataRoot - The root directory of the project
 * @param mcpClient - Optional MCP client for loading from entity-core
 * @returns The concatenated contents of all relationship/*.md files
 */
export async function loadRelationshipContent(
  dataRoot: string,
  mcpClient?: MCPClient,
): Promise<string> {
  if (mcpClient) {
    const identity = await mcpClient.loadIdentity();
    if (identity?.relationship) {
      return identityFilesToString(
        identity.relationship,
        RELATIONSHIP_FILE_ORDER,
      );
    }
  }
  return await loadRelationshipFiles(dataRoot);
}

/**
 * Load custom content from MCP client or local files.
 * Custom files are sorted alphabetically.
 *
 * @param dataRoot - The root directory of the project
 * @param mcpClient - Optional MCP client for loading from entity-core
 * @returns The concatenated contents of all custom/*.md files
 */
export async function loadCustomContent(
  dataRoot: string,
  mcpClient?: MCPClient,
): Promise<string> {
  if (mcpClient) {
    const identity = await mcpClient.loadIdentity();
    if (identity?.custom) {
      // Custom files are sorted alphabetically
      return identityFilesToString(identity.custom, CUSTOM_FILE_ORDER);
    }
  }
  return await loadCustomFiles(dataRoot);
}

/**
 * Build the full identity system message (without RAG content) for use by
 * background processes like the memory summarizer that need entity identity
 * context but no retrieval augmentation.
 *
 * @param dataRoot - The root directory of the project
 * @returns The formatted system message containing all identity context
 */
export async function buildIdentitySystemMessage(
  dataRoot: string,
): Promise<string> {
  const baseInstructions = await loadBaseInstructions(
    dataRoot,
    undefined,
    "memory-writing",
  );
  const selfContent = await loadSelfContent(dataRoot);
  const userContent = await loadUserContent(dataRoot);
  const relationshipContent = await loadRelationshipContent(dataRoot);
  const customContent = await loadCustomContent(dataRoot);

  return buildSystemMessage(
    {
      baseInstructions,
      selfContent,
      userContent,
      relationshipContent,
      customContent,
    },
    {},
  );
}

/**
 * The regular-placement renderer: stable core + dynamic block as one
 * leading system message. The kit (turn-context.ts) owns the canonical
 * order — this composes for the classic leading-message shape.
 */
export function buildSystemMessage(
  core: import("./turn-context.ts").StableCoreInputs,
  dynamic: import("./turn-context.ts").DynamicBlockInputs,
): string {
  const stable = buildStableCore(core);
  const dyn = buildDynamicBlock(dynamic);
  return [stable, dyn].filter((b) => b.trim()).join("\n");
}
