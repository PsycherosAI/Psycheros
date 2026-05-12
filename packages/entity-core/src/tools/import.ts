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
 * Create import handler.
 */
export function createEntityImportHandler(
  store: FileStore,
  graphStore: GraphStore,
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
      const zip = await JSZip.loadAsync(zipBytes);

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
          const folder = zip.folder(`entity-core/identity/${category}`);
          if (!folder) continue;

          const categoryDir = join(dataDir, category);
          await ensureDir(categoryDir);

          // Clear existing files
          for await (const entry of Deno.readDir(categoryDir)) {
            if (entry.isFile && entry.name.endsWith(".md")) {
              await Deno.remove(join(categoryDir, entry.name));
            }
          }

          // Restore from zip
          for (const [filename, file] of Object.entries(folder.files)) {
            if (file.dir) continue;
            const basename = filename.replace(
              /^entity-core\/identity\/[^/]+\//,
              "",
            );
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
          const folder = zip.folder(`entity-core/memories/${granularity}`);
          if (!folder) continue;

          const granularityDir = join(dataDir, "memories", granularity);
          await ensureDir(granularityDir);

          // Clear existing files
          for await (const entry of Deno.readDir(granularityDir)) {
            if (entry.isFile && entry.name.endsWith(".md")) {
              await Deno.remove(join(granularityDir, entry.name));
            }
          }

          // Restore from zip
          for (const [filename, file] of Object.entries(folder.files)) {
            if (file.dir) continue;
            const basename = filename.replace(
              /^entity-core\/memories\/[^/]+\//,
              "",
            );
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
            await Deno.writeFile(dbPath, dbBytes);
            graphRestored = true;

            // Re-initialize graph store with the new database
            graphStore.close();
            await graphStore.initialize();
          } catch (error) {
            console.error("[Import] Failed to replace graph.db:", error);
            graphRestored = false;
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
