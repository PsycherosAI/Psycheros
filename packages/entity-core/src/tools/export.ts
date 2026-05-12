/**
 * Entity Export Tool
 *
 * Exports all entity-core data (identity, memories, knowledge graph) as a zip file.
 * Returns base64-encoded zip content for transport over MCP stdio.
 */

import { z } from "zod";
import JSZip from "jszip";
import { join } from "@std/path";
import type { FileStore } from "../storage/file-store.ts";
import type { GraphStore } from "../graph/store.ts";
import { loadIdentityMeta } from "./identity-meta.ts";

/**
 * Convert a Uint8Array to a base64 string without blowing the call stack.
 * String.fromCharCode(...largeArray) exceeds max call stack size.
 */
function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 8192;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

export const EntityExportSchema = z.object({});

export type EntityExportOutput = {
  success: boolean;
  error?: string;
  data?: string; // base64-encoded zip
  manifest?: Record<string, unknown>;
};

/**
 * Create export handler.
 */
export function createEntityExportHandler(
  store: FileStore,
  graphStore: GraphStore,
) {
  return async (_input: Record<string, never>): Promise<EntityExportOutput> => {
    try {
      const dataDir = store.dataDirectory;
      const zip = new JSZip();

      let identityFiles = 0;
      let memoryEntries = 0;
      let graphNodes = 0;
      let graphEdges = 0;

      // --- Identity files ---
      const categories = ["self", "user", "relationship", "custom"] as const;
      for (const category of categories) {
        const files = await store.readIdentityCategory(category);
        const folder = zip.folder(`entity-core/identity/${category}`)!;
        for (const file of files) {
          folder.file(file.filename, file.content);
          identityFiles++;
        }
      }

      // --- identity-meta.json ---
      try {
        const meta = await loadIdentityMeta(dataDir);
        zip.file(
          "entity-core/identity-meta.json",
          JSON.stringify(meta, null, 2),
        );
      } catch {
        // May not exist yet
      }

      // --- Memories ---
      const granularities = [
        "daily",
        "weekly",
        "monthly",
        "yearly",
        "significant",
      ] as const;
      for (const granularity of granularities) {
        const memories = await store.listMemories(granularity);
        const folder = zip.folder(`entity-core/memories/${granularity}`)!;
        for (const memory of memories) {
          // Reconstruct filename
          let filename: string;
          if (granularity === "daily" && memory.sourceInstance) {
            filename = `${memory.date}_${memory.sourceInstance}.md`;
          } else {
            filename = `${memory.date}.md`;
          }
          folder.file(filename, memory.content);
          memoryEntries++;
        }
      }

      // --- Knowledge Graph ---
      await graphStore.initialize();
      const graphFolder = zip.folder("entity-core/knowledge-graph")!;

      // Copy the sqlite database
      try {
        const dbBytes = await Deno.readFile(join(dataDir, "graph.db"));
        graphFolder.file("graph.sqlite", dbBytes);
      } catch {
        // graph.db may not exist yet
      }

      // Export nodes and edges as JSON (without embedding blobs)
      const nodes = graphStore.listNodes({
        includeDeleted: false,
        limit: 999999,
      });
      graphNodes = nodes.length;
      const edges = listAllEdges(graphStore);
      graphEdges = edges.length;

      graphFolder.file(
        "graph-export.json",
        JSON.stringify(
          {
            nodes: nodes.map((n) => ({
              id: n.id,
              type: n.type,
              label: n.label,
              description: n.description,
              properties: n.properties,
              source_instance: n.sourceInstance,
              confidence: n.confidence,
              source_memory_id: n.sourceMemoryId,
              created_at: n.createdAt,
              updated_at: n.updatedAt,
              first_learned_at: n.firstLearnedAt,
              last_confirmed_at: n.lastConfirmedAt,
              version: n.version,
            })),
            edges: edges.map((e) => ({
              id: e.id,
              from_id: e.from_id,
              to_id: e.to_id,
              type: e.type,
              custom_type: e.custom_type,
              properties: e.properties,
              weight: e.weight,
              evidence: e.evidence,
              occurred_at: e.occurred_at,
              valid_until: e.valid_until,
              created_at: e.created_at,
              updated_at: e.updated_at,
              instance_id: e.instance_id,
              deleted: e.deleted,
            })),
          },
          null,
          2,
        ),
      );

      // --- Manifest ---
      const manifest = {
        schema_version: 1,
        exported_at: new Date().toISOString(),
        parts: {
          entity_core: {
            identity: true,
            memories: true,
            knowledge_graph: true,
          },
        },
        counts: {
          identity_files: identityFiles,
          memory_entries: memoryEntries,
          graph_nodes: graphNodes,
          graph_edges: graphEdges,
        },
      };

      zip.file("manifest.json", JSON.stringify(manifest, null, 2));

      const zipBlob = await zip.generateAsync({ type: "uint8array" });
      const base64 = uint8ArrayToBase64(zipBlob);

      return {
        success: true,
        data: base64,
        manifest,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  };
}

/**
 * List all edges from the graph store (bypassing the limit in listEdges).
 */
function listAllEdges(graphStore: GraphStore) {
  const db = (graphStore as unknown as {
    db: {
      prepare: (
        sql: string,
      ) => { all: <T>(...params: unknown[]) => T[]; finalize: () => void };
    };
  }).db;
  const stmt = db.prepare(
    "SELECT * FROM graph_edges WHERE deleted = 0 ORDER BY updated_at DESC",
  );
  const rows = stmt.all<{
    id: string;
    from_id: string;
    to_id: string;
    type: string;
    custom_type: string | null;
    properties: string;
    weight: number;
    evidence: string;
    occurred_at: string | null;
    valid_until: string | null;
    created_at: string;
    updated_at: string;
    instance_id: string;
    deleted: number;
  }>();
  stmt.finalize();
  return rows;
}
