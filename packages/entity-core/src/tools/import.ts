/**
 * Entity Import Tool
 *
 * Imports entity-core data from a base64-encoded zip file.
 * Performs a full overwrite of identity, memories, and knowledge graph.
 */

import { z } from "zod";
import JSZip from "jszip";
import { join } from "@std/path";
import { ensureDir } from "@std/fs";
import type { FileStore } from "../storage/file-store.ts";
import type { GraphStore } from "../graph/store.ts";
import type { EmbeddingCache } from "../embeddings/cache.ts";
import { saveIdentityMeta } from "./identity-meta.ts";
import { createFullSnapshot } from "../snapshot/mod.ts";
import type { SnapshotReason, SnapshotSource } from "../snapshot/types.ts";

export const EntityImportSchema = z.object({
  data: z.string().describe(
    "Base64-encoded zip file containing entity-core data",
  ),
  mode: z.enum(["overwrite"]).describe(
    "Import mode (only overwrite supported)",
  ),
});

export type EntityImportOutput = {
  success: boolean;
  error?: string;
  details?: {
    identity_files_restored: number;
    memories_restored: number;
    graph_restored: boolean;
    meta_restored: boolean;
    snapshot_id?: string;
  };
};

/**
 * Detect a single top-level wrapper folder around the expected entity-core
 * export structure. Some Windows workflows (right-click → "Send to →
 * Compressed folder" on an extracted folder) and certain cloud-sync tools
 * wrap exports one level deep — `manifest.json` ends up at
 * `<wrapper>/manifest.json` instead of `/manifest.json`, and the importer's
 * root-manifest lookup fails. Detect and strip.
 *
 * Returns the wrapper prefix (e.g. `"export-folder/"`) when there is exactly
 * one top-level folder containing `manifest.json`, otherwise null.
 */
function detectWrapperPrefix(zip: JSZip): string | null {
  const entries = Object.entries(zip.files);
  if (entries.some(([path, file]) => !file.dir && !path.includes("/"))) {
    return null;
  }
  const topLevel = new Set<string>();
  for (const [path, file] of entries) {
    if (file.dir) continue;
    const idx = path.indexOf("/");
    if (idx === -1) continue;
    topLevel.add(path.slice(0, idx + 1));
  }
  if (topLevel.size !== 1) return null;
  const prefix = [...topLevel][0];
  if (!zip.file(`${prefix}manifest.json`)) return null;
  return prefix;
}

/**
 * Strip a wrapper folder if one is detected, otherwise return the original
 * zip. Re-builds without the prefix so the rest of the importer can use
 * root-relative paths unchanged.
 */
async function unwrapSingletonFolder(zip: JSZip): Promise<JSZip> {
  const prefix = detectWrapperPrefix(zip);
  if (!prefix) return zip;
  console.log(
    `[entity-core] Wrapper folder "${prefix}" detected — stripping.`,
  );
  const cleaned = new JSZip();
  for (const [path, file] of Object.entries(zip.files)) {
    if (file.dir || !path.startsWith(prefix)) continue;
    const content = await file.async("uint8array");
    cleaned.file(path.slice(prefix.length), content);
  }
  return cleaned;
}

/**
 * Create import handler.
 */
export function createEntityImportHandler(
  store: FileStore,
  graphStore: GraphStore,
  embeddingCache?: EmbeddingCache,
) {
  return async (
    input: { data: string; mode: string },
  ): Promise<EntityImportOutput> => {
    try {
      // Decode base64
      const zipBytes = Uint8Array.from(
        atob(input.data),
        (c) => c.charCodeAt(0),
      );
      const rawZip = await JSZip.loadAsync(zipBytes);
      const zip = await unwrapSingletonFolder(rawZip);

      // Validate manifest
      const manifestFile = zip.file("manifest.json");
      if (!manifestFile) {
        return {
          success: false,
          error: "Invalid export package: missing manifest.json",
        };
      }

      const manifest = JSON.parse(await manifestFile.async("string"));
      if (manifest.schema_version !== 1) {
        return {
          success: false,
          error: `Unsupported schema version: ${manifest.schema_version}`,
        };
      }

      const dataDir = store.dataDirectory;
      const parts = manifest.parts?.entity_core ?? {};

      // Take a snapshot before overwriting
      let snapshotId: string | undefined;
      try {
        const snapshots = await createFullSnapshot(
          store,
          "pre-replace" as SnapshotReason,
          "entity-core" as SnapshotSource,
        );
        if (snapshots.length > 0) {
          snapshotId = snapshots[0].id;
        }
      } catch {
        // Best-effort snapshot
      }

      let identityFilesRestored = 0;
      let memoriesRestored = 0;
      let graphRestored = false;
      let metaRestored = false;

      // --- Identity files ---
      if (parts.identity) {
        const categories = ["self", "user", "relationship", "custom"] as const;
        for (const category of categories) {
          const prefix = `entity-core/identity/${category}/`;

          const categoryDir = join(dataDir, category);
          await ensureDir(categoryDir);

          // Clear existing files
          for await (const entry of Deno.readDir(categoryDir)) {
            if (entry.isFile && entry.name.endsWith(".md")) {
              await Deno.remove(join(categoryDir, entry.name));
            }
          }

          // Restore from zip — iterate the full file map and filter by prefix
          // (JSZip folder().files returns ALL entries, not just the subfolder)
          for (const [filename, file] of Object.entries(zip.files)) {
            if (file.dir || !filename.startsWith(prefix)) continue;
            const basename = filename.slice(prefix.length);
            if (!basename || basename.includes("/")) continue;
            const content = await file.async("string");
            await Deno.writeTextFile(join(categoryDir, basename), content);
            identityFilesRestored++;
          }
        }
      }

      // --- identity-meta.json ---
      if (parts.identity) {
        const metaFile = zip.file("entity-core/identity-meta.json");
        if (metaFile) {
          const metaContent = await metaFile.async("string");
          const meta = JSON.parse(metaContent);
          await saveIdentityMeta(dataDir, meta);
          metaRestored = true;
        }
      }

      // --- Memories ---
      if (parts.memories) {
        const granularities = [
          "daily",
          "weekly",
          "monthly",
          "yearly",
          "significant",
        ] as const;
        for (const granularity of granularities) {
          const prefix = `entity-core/memories/${granularity}/`;

          const granularityDir = join(dataDir, "memories", granularity);
          await ensureDir(granularityDir);

          // Clear existing files
          for await (const entry of Deno.readDir(granularityDir)) {
            if (entry.isFile && entry.name.endsWith(".md")) {
              await Deno.remove(join(granularityDir, entry.name));
            }
          }

          // Restore from zip — iterate the full file map and filter by prefix
          // (JSZip folder().files returns ALL entries, not just the subfolder)
          for (const [filename, file] of Object.entries(zip.files)) {
            if (file.dir || !filename.startsWith(prefix)) continue;
            const basename = filename.slice(prefix.length);
            if (!basename || basename.includes("/")) continue;
            const content = await file.async("string");
            await Deno.writeTextFile(join(granularityDir, basename), content);
            memoriesRestored++;
          }
        }
      }

      // --- Knowledge Graph ---
      if (parts.knowledge_graph) {
        // Try replacing graph.db directly
        const sqliteFile = zip.file("entity-core/knowledge-graph/graph.sqlite");
        if (sqliteFile) {
          try {
            const dbBytes = await sqliteFile.async("uint8array");
            const dbPath = join(dataDir, "graph.db");
            // Write to a temp file then rename — avoids corrupting the DB
            // if the write fails partway through.
            const tmpPath = join(dataDir, "graph.db.tmp");
            await Deno.writeFile(tmpPath, dbBytes);

            // On Windows, any open file handle blocks rename(). Close
            // all connections to graph.db before swapping the file.
            graphStore.close();
            if (embeddingCache) embeddingCache.close();

            await Deno.rename(tmpPath, dbPath);
            graphRestored = true;

            // Re-open connections with the new database
            graphStore.reopen();
            await graphStore.initialize();
            if (embeddingCache) {
              embeddingCache.reopen();
              await embeddingCache.initialize();
            }
          } catch (error) {
            console.error("[Import] Failed to replace graph.db:", error);
            graphRestored = false;
            // Best-effort recovery: reopen with whatever is on disk
            try {
              graphStore.reopen();
              await graphStore.initialize();
            } catch {
              // Connection is truly broken — caller must restart
            }
          }
        }

        // If sqlite replacement failed, attempt to rebuild from JSON export
        if (!graphRestored) {
          const jsonFile = zip.file(
            "entity-core/knowledge-graph/graph-export.json",
          );
          if (jsonFile) {
            console.log(
              "[Import] graph.db replacement failed, rebuilding from graph-export.json is not supported in-place. The JSON export is preserved for manual recovery.",
            );
          }
        }
      }

      return {
        success: true,
        details: {
          identity_files_restored: identityFilesRestored,
          memories_restored: memoriesRestored,
          graph_restored: graphRestored,
          meta_restored: metaRestored,
          snapshot_id: snapshotId,
        },
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  };
}
