/**
 * File-based Storage
 *
 * Handles reading and writing identity files and memories from disk.
 * All files are stored from my first-person perspective.
 */

import { join } from "@std/path";
import { ensureDir } from "@std/fs";
import type {
  Granularity,
  IdentityContent,
  IdentityFile,
  MemoryEntry,
} from "../types.ts";
import { getPromptLabel, loadIdentityMeta } from "../tools/identity-meta.ts";

/**
 * Write a file atomically: write to a temp file in the same directory, then rename.
 * This prevents corruption if the process crashes mid-write (e.g. power loss).
 */
async function atomicWriteTextFile(
  filePath: string,
  content: string,
): Promise<void> {
  const tmpPath = `${filePath}.tmp.${crypto.randomUUID().slice(0, 8)}`;
  try {
    await Deno.writeTextFile(tmpPath, content);
    await Deno.rename(tmpPath, filePath);
  } catch (error) {
    // Clean up temp file on failure
    try {
      await Deno.remove(tmpPath);
    } catch { /* ignore */ }
    throw error;
  }
}

/**
 * Write a file atomically and verify the result by comparing file size.
 * Logs a warning if the written size doesn't match the expected content length.
 */
async function atomicWriteAndVerify(
  filePath: string,
  content: string,
  label: string,
): Promise<void> {
  await atomicWriteTextFile(filePath, content);

  // Verify the file was written correctly
  try {
    const stat = await Deno.stat(filePath);
    const encoder = new TextEncoder();
    const expectedBytes = encoder.encode(content).byteLength;
    if (stat.size !== expectedBytes) {
      console.error(
        `[Storage] WARNING: ${label} written size mismatch — expected ${expectedBytes} bytes, got ${stat.size} bytes at ${filePath}`,
      );
    }
  } catch (error) {
    console.error(
      `[Storage] WARNING: Could not verify ${label} write at ${filePath}:`,
      error,
    );
  }
}

/**
 * Merge incoming daily memory content with existing content.
 * Deduplicates by [chat:id] tag — bullets referencing the same chat are skipped.
 * Bullets without a chat ID are always appended (cannot deduplicate).
 * Preserves the existing title line.
 */
function mergeDailyContent(existing: string, incoming: string): string {
  // Extract title from whichever source has one
  const titleMatch = existing.match(/^#.+/) ?? incoming.match(/^#.+/);
  const title = titleMatch ? titleMatch[0] : "";

  // Collect existing bullets
  const existingBullets = existing.split("\n").filter((l) =>
    l.trimStart().startsWith("- ")
  );

  // Index existing chat IDs for dedup
  const seenChatIds = new Set<string>();
  for (const bullet of existingBullets) {
    for (const m of bullet.matchAll(/\[chat:([^\]]+)\]/g)) {
      seenChatIds.add(m[1]);
    }
  }

  // Append incoming bullets that aren't duplicates
  const incomingBullets = incoming.split("\n").filter((l) =>
    l.trimStart().startsWith("- ")
  );
  for (const bullet of incomingBullets) {
    const chatIds = [...bullet.matchAll(/\[chat:([^\]]+)\]/g)].map((m) => m[1]);
    // Keep if no chat ID (can't dedup) or none of its chat IDs already exist
    if (chatIds.length === 0 || !chatIds.some((id) => seenChatIds.has(id))) {
      existingBullets.push(bullet);
      for (const id of chatIds) seenChatIds.add(id);
    }
  }

  const parts: string[] = [];
  if (title) parts.push(title);
  parts.push("", ...existingBullets);
  return parts.join("\n");
}

/**
 * File store for my identity and memories.
 */
export class FileStore {
  private readonly dataDir: string;

  constructor(dataDir: string) {
    this.dataDir = dataDir;
  }

  /**
   * Get the data directory path.
   */
  get dataDirectory(): string {
    return this.dataDir;
  }

  /**
   * Initialize the storage directories.
   */
  async initialize(): Promise<void> {
    const dirs = [
      join(this.dataDir, "self"),
      join(this.dataDir, "user"),
      join(this.dataDir, "relationship"),
      join(this.dataDir, "custom"),
      join(this.dataDir, "memories", "daily"),
      join(this.dataDir, "memories", "weekly"),
      join(this.dataDir, "memories", "monthly"),
      join(this.dataDir, "memories", "yearly"),
      join(this.dataDir, "memories", "significant"),
      join(this.dataDir, "memories", "archive", "daily"),
    ];

    for (const dir of dirs) {
      await ensureDir(dir);
    }
  }

  // ===== Identity Files =====

  /**
   * Read all identity files from a category.
   */
  async readIdentityCategory(
    category: "self" | "user" | "relationship" | "custom",
  ): Promise<IdentityFile[]> {
    const dir = join(this.dataDir, category);
    const files: IdentityFile[] = [];

    // Load prompt labels for this category
    const meta = await loadIdentityMeta(this.dataDir);

    try {
      for await (const entry of Deno.readDir(dir)) {
        if (entry.isFile && entry.name.endsWith(".md")) {
          const filePath = join(dir, entry.name);
          const content = await Deno.readTextFile(filePath);
          const stat = await Deno.stat(filePath);

          files.push({
            category,
            filename: entry.name,
            content,
            version: 1, // TODO: Track actual versions
            lastModified: stat.mtime?.toISOString() ?? new Date().toISOString(),
            modifiedBy: "unknown", // TODO: Track modifier
            promptLabel: getPromptLabel(meta, category, entry.name),
          });
        }
      }
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) {
        throw error;
      }
    }

    // Custom files are sorted alphabetically; others use predefined order
    if (category === "custom") {
      files.sort((a, b) => a.filename.localeCompare(b.filename));
    } else {
      const order =
        IDENTITY_FILE_ORDER[category as "self" | "user" | "relationship"];
      files.sort((a, b) => {
        const aIndex = order.indexOf(a.filename);
        const bIndex = order.indexOf(b.filename);
        if (aIndex !== -1 && bIndex !== -1) return aIndex - bIndex;
        if (aIndex !== -1) return -1;
        if (bIndex !== -1) return 1;
        return a.filename.localeCompare(b.filename);
      });
    }

    return files;
  }

  /**
   * Read all identity files.
   */
  async readAllIdentity(): Promise<IdentityContent> {
    const [self, user, relationship, custom] = await Promise.all([
      this.readIdentityCategory("self"),
      this.readIdentityCategory("user"),
      this.readIdentityCategory("relationship"),
      this.readIdentityCategory("custom"),
    ]);

    return { self, user, relationship, custom };
  }

  /**
   * Write an identity file atomically.
   */
  async writeIdentityFile(file: IdentityFile): Promise<void> {
    const dir = join(this.dataDir, file.category);
    await ensureDir(dir);
    const filePath = join(dir, file.filename);
    await atomicWriteAndVerify(
      filePath,
      file.content,
      `identity/${file.category}/${file.filename}`,
    );
  }

  /**
   * Delete a custom identity file.
   * Only custom files can be deleted; predefined files in other categories cannot.
   */
  async deleteIdentityFile(
    category: "custom",
    filename: string,
  ): Promise<boolean> {
    if (category !== "custom") {
      throw new Error("Only custom files can be deleted");
    }

    const filePath = join(this.dataDir, category, filename);

    try {
      await Deno.remove(filePath);
      return true;
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        return false;
      }
      throw error;
    }
  }

  // ===== Memory Files =====

  /**
   * Get the file path for a memory entry.
   * Daily memories use instance-scoped filenames: YYYY-MM-DD_{instance}.md
   * Other granularities use the date directly: {date}.md
   */
  getMemoryPath(
    entry: {
      granularity: Granularity;
      date: string;
      sourceInstance?: string;
      slug?: string;
    },
  ): string {
    const { granularity, date, sourceInstance, slug } = entry;
    let filename: string;
    if (granularity === "daily" && sourceInstance) {
      filename = `${date}_${sourceInstance}.md`;
    } else if (granularity === "significant" && slug) {
      filename = `${date}_${slug}.md`;
    } else {
      filename = `${date}.md`;
    }
    return join(this.dataDir, "memories", granularity, filename);
  }

  /**
   * Read a memory file by granularity, date, and optionally instance/slug.
   * For daily memories, sourceInstance identifies the file suffix.
   * For significant memories, slug identifies the file suffix.
   */
  async readMemory(
    granularity: Granularity,
    date: string,
    sourceInstance?: string,
    slug?: string,
  ): Promise<MemoryEntry | null> {
    const filePath = this.getMemoryPath({
      granularity,
      date,
      sourceInstance,
      slug,
    });

    try {
      const content = await Deno.readTextFile(filePath);
      const stat = await Deno.stat(filePath);

      return {
        id: `${granularity}-${date}`,
        granularity,
        date,
        content,
        chatIds: [], // TODO: Parse from content
        sourceInstance: sourceInstance ?? "",
        version: 1,
        createdAt: stat.birthtime?.toISOString() ?? new Date().toISOString(),
        updatedAt: stat.mtime?.toISOString() ?? new Date().toISOString(),
        ...(slug ? { slug } : {}),
      };
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        return null;
      }
      throw error;
    }
  }

  /**
   * Find a memory entry by date, searching across all instance/slug variants.
   * For daily memories, this checks for any file matching YYYY-MM-DD_*.md.
   * For significant memories, this checks for any file matching YYYY-MM-DD_*.md (slug-based).
   * For other granularities, behaves the same as readMemory.
   * Returns the first match found, or null if none exists.
   */
  async findMemoryByDate(
    granularity: Granularity,
    date: string,
  ): Promise<MemoryEntry | null> {
    // First try without instance suffix (works for non-daily)
    const direct = await this.readMemory(granularity, date);
    if (direct) return direct;

    // For daily and significant, scan the directory for any file matching the date prefix
    // Daily uses instance suffixes (e.g., 2026-04-06_psycheros.md)
    // Significant uses slug suffixes (e.g., 2026-04-06_first-conversation.md)
    if (granularity === "daily" || granularity === "significant") {
      const dir = join(this.dataDir, "memories", granularity);
      try {
        const prefix = `${date}_`;
        for await (const entry of Deno.readDir(dir)) {
          if (
            entry.isFile && entry.name.endsWith(".md") &&
            entry.name.startsWith(prefix)
          ) {
            const suffixPart = entry.name.replace(/\.md$/, "").slice(
              date.length + 1,
            );
            // Daily: suffix is sourceInstance (3rd arg). Significant: suffix is slug (4th arg).
            if (granularity === "significant") {
              return await this.readMemory(
                granularity,
                date,
                undefined,
                suffixPart,
              );
            }
            return await this.readMemory(granularity, date, suffixPart);
          }
        }
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
      }
    }

    return null;
  }

  /**
   * Read a memory by its file key (filename stem without .md extension).
   * E.g., "2026-04-15_psycheros" or "2026-W15" or "2026-03-20_first-conversation".
   * Searches each granularity directory for the matching file.
   */
  async readMemoryByKey(memoryKey: string): Promise<MemoryEntry | null> {
    const granularities: Granularity[] = [
      "daily",
      "weekly",
      "monthly",
      "yearly",
      "significant",
    ];

    for (const granularity of granularities) {
      const filePath = join(
        this.dataDir,
        "memories",
        granularity,
        `${memoryKey}.md`,
      );

      try {
        const content = await Deno.readTextFile(filePath);
        const stat = await Deno.stat(filePath);

        // Parse the memoryKey back into date + suffix
        const dateMatch = memoryKey.match(
          /^(\d{4}(?:-W\d{2}|-\d{2}(?:-\d{2})?)?)/,
        );
        if (!dateMatch) continue;
        const date = dateMatch[1];
        const suffix = memoryKey.slice(date.length).replace(/^_/, ""); // everything after the date (strip leading _)

        const isSignificant = granularity === "significant" && suffix;

        return {
          id: `${granularity}-${date}`,
          granularity,
          date,
          content,
          chatIds: [],
          sourceInstance: isSignificant ? "" : (suffix || ""),
          version: 1,
          createdAt: stat.birthtime?.toISOString() ?? new Date().toISOString(),
          updatedAt: stat.mtime?.toISOString() ?? new Date().toISOString(),
          ...(isSignificant ? { slug: suffix } : {}),
        };
      } catch (error) {
        if (error instanceof Deno.errors.NotFound) continue;
        throw error;
      }
    }

    return null;
  }

  /**
   * List all memories of a granularity.
   * Parses instance suffix from filenames (e.g., 2026-03-20_psycheros.md).
   */
  async listMemories(granularity: Granularity): Promise<MemoryEntry[]> {
    const dir = join(this.dataDir, "memories", granularity);
    const memories: MemoryEntry[] = [];

    try {
      for await (const entry of Deno.readDir(dir)) {
        if (entry.isFile && entry.name.endsWith(".md")) {
          // Parse filename:
          //   Daily:       YYYY-MM-DD_instance.md
          //   Significant: YYYY-MM-DD_slug-with-hyphens.md
          //   Weekly:      YYYY-Www.md
          //   Monthly:     YYYY-MM.md
          //   Yearly:      YYYY.md
          const stem = entry.name.replace(/\.md$/, "");
          const dateMatch = stem.match(
            /^(\d{4}(?:-W\d{2}|-\d{2}(?:-\d{2})?)?)/,
          );
          if (!dateMatch) continue;
          const date = dateMatch[1];
          const suffix = stem.slice(date.length).replace(/^_/, ""); // everything after the date (strip leading _)

          // For significant memories, the suffix is the slug; for daily, it's the instance ID
          const isSignificant = granularity === "significant" && suffix;
          const memory = await this.readMemory(
            granularity,
            date,
            isSignificant ? undefined : (suffix || undefined),
            isSignificant ? suffix : undefined,
          );
          if (memory) {
            memories.push(memory);
          }
        }
      }
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) {
        throw error;
      }
    }

    return memories.sort((a, b) => b.date.localeCompare(a.date));
  }

  /**
   * Write a memory entry atomically.
   * Uses sourceInstance from the entry for daily filenames.
   * Writes to a temp file then renames to prevent corruption on crash.
   */
  async writeMemory(entry: MemoryEntry): Promise<void> {
    const dir = join(this.dataDir, "memories", entry.granularity);
    await ensureDir(dir);
    const filePath = this.getMemoryPath(entry);
    await atomicWriteAndVerify(
      filePath,
      entry.content,
      `memory/${entry.granularity}`,
    );
  }

  /**
   * Write a daily memory, merging with existing content if the file already exists.
   * Deduplicates bullets by [chat:id] tag to prevent overwriting when importing
   * daily memories from multiple sources (e.g., entity-loom runs for different
   * platforms at different times).
   * Returns the final content that was written (merged or original).
   */
  async createOrMergeDailyMemory(entry: MemoryEntry): Promise<string> {
    const dir = join(this.dataDir, "memories", entry.granularity);
    await ensureDir(dir);
    const filePath = this.getMemoryPath(entry);

    let finalContent = entry.content;

    try {
      const existingContent = await Deno.readTextFile(filePath);
      finalContent = mergeDailyContent(existingContent, entry.content);
      console.error(
        `[Storage] Merged daily memory for ${entry.date} (instance: ${entry.sourceInstance})`,
      );
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
      // File doesn't exist yet — write as-is
    }

    await atomicWriteAndVerify(
      filePath,
      finalContent,
      `memory/${entry.granularity}`,
    );
    return finalContent;
  }

  /**
   * Archive a memory file (move to archive directory).
   */
  async archiveMemory(
    granularity: Granularity,
    date: string,
    sourceInstance?: string,
  ): Promise<void> {
    if (granularity !== "daily") {
      throw new Error("Only daily memories can be archived");
    }

    const sourcePath = this.getMemoryPath({
      granularity,
      date,
      sourceInstance,
    });
    const archiveDir = join(this.dataDir, "memories", "archive", "daily");
    await ensureDir(archiveDir);
    const filename = sourceInstance
      ? `${date}_${sourceInstance}.md`
      : `${date}.md`;
    const destPath = join(archiveDir, filename);

    try {
      await Deno.rename(sourcePath, destPath);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) {
        throw error;
      }
    }
  }

  /**
   * Delete a memory file by granularity, date, and optionally instance/slug.
   * For daily memories with instance-scope, pass sourceInstance to target the correct file.
   */
  async deleteMemory(
    granularity: Granularity,
    date: string,
    sourceInstance?: string,
    slug?: string,
  ): Promise<boolean> {
    const filePath = this.getMemoryPath({
      granularity,
      date,
      sourceInstance,
      slug,
    });

    try {
      await Deno.stat(filePath);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        return false;
      }
      throw error;
    }

    await Deno.remove(filePath);
    return true;
  }

  /**
   * Get all memory content for RAG indexing.
   */
  async getAllMemoryContent(): Promise<string[]> {
    const granularities: Granularity[] = [
      "daily",
      "weekly",
      "monthly",
      "yearly",
      "significant",
    ];
    const contents: string[] = [];

    for (const granularity of granularities) {
      const memories = await this.listMemories(granularity);
      for (const memory of memories) {
        contents.push(
          `# ${memory.granularity} - ${memory.date}\n\n${memory.content}`,
        );
      }
    }

    return contents;
  }
}

/**
 * File order for identity files.
 * Custom files have no predefined order (sorted alphabetically instead).
 */
const IDENTITY_FILE_ORDER: Record<"self" | "user" | "relationship", string[]> =
  {
    self: [
      "my_identity.md",
      "my_persona.md",
      "my_personhood.md",
      "my_wants.md",
      "my_mechanics.md",
    ],
    user: [
      "user_identity.md",
      "user_life.md",
      "user_beliefs.md",
      "user_preferences.md",
      "user_patterns.md",
      "user_notes.md",
    ],
    relationship: [
      "relationship_dynamics.md",
      "relationship_history.md",
      "relationship_notes.md",
    ],
  };

/**
 * Create a file store instance.
 */
export function createFileStore(dataDir: string): FileStore {
  return new FileStore(dataDir);
}
