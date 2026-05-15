/**
 * Entity Loom — Graph Stage
 *
 * Background knowledge graph population from memory files.
 * Migrates graph viewer endpoints from graph/server.ts.
 */

import { basename, join } from "@std/path";
import type { Handler } from "../server/server.ts";
import type { CheckpointState } from "../types.ts";
import { Database } from "@db/sqlite";
import { zipSync } from "fflate";
import { GraphWriter } from "../writers/graph-writer.ts";
import { GraphConsolidator } from "../writers/graph-consolidator.ts";
import { SignaledLLMClient } from "./signaled-llm.ts";
import { CheckpointManager } from "../dedup/checkpoint.ts";
import {
  getActiveCheckpoint,
  getActiveConfig,
  getActivePackageDir,
  setActiveCheckpoint,
  setFinalized,
} from "./setup-stage.ts";
import {
  abortRunningStage,
  acquireStageLock,
  getRunningStage,
  releaseStageLock,
  setProgressSnapshot,
} from "../server/stage-lock.ts";
import { sse } from "../server/sse.ts";
import { log } from "../server/logger.ts";
import { buildCostEstimate } from "../server/cost-estimator.ts";
import { DBWriter } from "../writers/db-writer.ts";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Count .md files in a directory */
async function countMemoryFiles(dirPath: string): Promise<number> {
  let count = 0;
  try {
    for await (const entry of Deno.readDir(dirPath)) {
      if (
        entry.isFile && entry.name.endsWith(".md") && entry.name !== ".gitkeep"
      ) count++;
    }
  } catch {
    // Directory doesn't exist
  }
  return count;
}

/** Read file content */
async function readFileChars(dirPath: string): Promise<number> {
  let total = 0;
  try {
    for await (const entry of Deno.readDir(dirPath)) {
      if (
        entry.isFile && entry.name.endsWith(".md") && entry.name !== ".gitkeep"
      ) {
        const content = await Deno.readTextFile(join(dirPath, entry.name));
        total += content.length;
      }
    }
  } catch {
    // Directory doesn't exist
  }
  return total;
}

/** Background task: populate knowledge graph */
async function runGraphStage(signal: AbortSignal): Promise<void> {
  const packageDir = getActivePackageDir();
  const config = getActiveConfig();
  const checkpoint = getActiveCheckpoint();
  if (!packageDir || !config || !checkpoint) {
    throw new Error("No active package");
  }

  const llm = new SignaledLLMClient(
    {
      apiKey: config.llmApiKey,
      baseUrl: config.llmBaseUrl,
      model: config.llmModel,
      requestTimeoutMs: config.requestTimeoutMs,
    },
    signal,
  );

  const graphDbPath = join(packageDir, "graph.db");
  const graphWriter = new GraphWriter(
    graphDbPath,
    llm,
    config.rateLimitMs,
    config.entityName,
    config.userName,
  );
  graphWriter.init();

  const memoriesDir = join(packageDir, "memories");

  // Collect memory files, separated by type
  interface MemoryEntry {
    path: string;
    dir: string;
    name: string;
  }
  const dailyFiles: MemoryEntry[] = [];
  const significantFiles: MemoryEntry[] = [];

  for (const subdir of ["daily", "significant"]) {
    const dir = join(memoriesDir, subdir);
    try {
      for await (const entry of Deno.readDir(dir)) {
        if (
          entry.isFile && entry.name.endsWith(".md") &&
          entry.name !== ".gitkeep"
        ) {
          const fullPath = join(dir, entry.name);
          if (!checkpoint.stages.graph.processedItems.includes(fullPath)) {
            const memEntry: MemoryEntry = {
              path: fullPath,
              dir: subdir,
              name: entry.name,
            };
            if (subdir === "daily") dailyFiles.push(memEntry);
            else significantFiles.push(memEntry);
          }
        }
      }
    } catch {
      // Directory doesn't exist
    }
  }

  // Sort daily files by name (date-sorted) for chronological batching
  dailyFiles.sort((a, b) => a.name.localeCompare(b.name));
  significantFiles.sort((a, b) => a.name.localeCompare(b.name));

  // Create batches: daily files in groups of 14 (~2 weeks), significant files individually
  const BATCH_SIZE = 14;
  interface Batch {
    files: MemoryEntry[];
    label: string;
    isBatch: boolean;
  }
  const batches: Batch[] = [];

  for (let i = 0; i < dailyFiles.length; i += BATCH_SIZE) {
    const slice = dailyFiles.slice(i, i + BATCH_SIZE);
    batches.push({
      files: slice,
      label: slice.length === 1
        ? slice[0].name
        : `${slice[0].name} +${slice.length - 1}`,
      isBatch: slice.length > 1,
    });
  }

  for (const file of significantFiles) {
    batches.push({ files: [file], label: file.name, isBatch: false });
  }

  const totalItems = dailyFiles.length + significantFiles.length;
  log(
    "info",
    `Graph: ${totalItems} memory files in ${batches.length} batches (${dailyFiles.length} daily, ${significantFiles.length} significant)`,
  );
  sse.broadcast({
    type: "stage_started",
    stage: "graph",
    data: { totalItems, batches: batches.length },
    timestamp: new Date().toISOString(),
  });

  let totalNodes = 0;
  let totalEdges = 0;
  let processedCount = 0;
  const checkpointMgr = new CheckpointManager(packageDir);

  for (let i = 0; i < batches.length; i++) {
    if (signal.aborted) {
      log("warn", "Graph stage aborted");
      checkpoint.stages.graph.status = "aborted";
      await checkpointMgr.save(checkpoint as unknown as CheckpointState);
      setActiveCheckpoint(checkpoint);
      releaseStageLock();
      graphWriter.close();
      return;
    }

    const batch = batches[i];
    sse.broadcast({
      type: "item_started",
      stage: "graph",
      data: { index: i, title: batch.label, id: batch.label },
      timestamp: new Date().toISOString(),
    });

    try {
      if (batch.isBatch) {
        // Batch processing: read all files and send in one LLM call
        const memories = await Promise.all(
          batch.files.map(async (f) => ({
            path: f.path,
            content: await Deno.readTextFile(f.path),
          })),
        );
        const result = await graphWriter.processBatch(
          memories,
          config.instanceId,
        );

        totalNodes += result.nodesCreated;
        totalEdges += result.edgesCreated;
        processedCount += batch.files.length;

        if (result.nodesCreated > 0 || result.edgesCreated > 0) {
          for (const pf of result.perFile) {
            checkpoint.stages.graph.processedItems.push(pf.path);
          }
        }

        sse.broadcast({
          type: "item_completed",
          stage: "graph",
          data: {
            index: i,
            title: batch.label,
            result:
              `+${result.nodesCreated}n +${result.edgesCreated}e (${batch.files.length} files)`,
          },
          timestamp: new Date().toISOString(),
        });
      } else {
        // Single file processing (significant memories)
        const content = await Deno.readTextFile(batch.files[0].path);
        const result = await graphWriter.processMemory(
          batch.files[0].path,
          content,
          config.instanceId,
        );

        totalNodes += result.nodesCreated;
        totalEdges += result.edgesCreated;
        processedCount++;

        if (result.nodesCreated > 0 || result.edgesCreated > 0) {
          checkpoint.stages.graph.processedItems.push(batch.files[0].path);
        }

        sse.broadcast({
          type: "item_completed",
          stage: "graph",
          data: {
            index: i,
            title: batch.label,
            result: `+${result.nodesCreated}n +${result.edgesCreated}e`,
          },
          timestamp: new Date().toISOString(),
        });
      }

      const snapshot = {
        current: processedCount,
        total: totalItems,
        percent: Math.round((processedCount / totalItems) * 100),
      };
      setProgressSnapshot(snapshot);
      sse.broadcast({
        type: "stage_progress",
        stage: "graph",
        data: snapshot,
        timestamp: new Date().toISOString(),
      });

      await checkpointMgr.save(checkpoint as unknown as CheckpointState);
    } catch (error) {
      if (signal.aborted) {
        log("warn", "Graph stage aborted");
        checkpoint.stages.graph.status = "aborted";
        await checkpointMgr.save(checkpoint as unknown as CheckpointState);
        setActiveCheckpoint(checkpoint);
        releaseStageLock();
        graphWriter.close();
        return;
      }
      const msg = error instanceof Error ? error.message : String(error);
      log("error", `Graph failed for ${batch.label}: ${msg}`);
      sse.broadcast({
        type: "item_error",
        stage: "graph",
        data: { index: i, title: batch.label, error: msg },
        timestamp: new Date().toISOString(),
      });
    }
  }

  graphWriter.close();

  if (signal.aborted) {
    log("warn", "Graph stage aborted (post-loop)");
    checkpoint.stages.graph.status = "aborted";
    await checkpointMgr.save(checkpoint as unknown as CheckpointState);
    setActiveCheckpoint(checkpoint);
    releaseStageLock();
    return;
  }

  // Post-extraction consolidation
  if (totalNodes > 0 || totalEdges > 0) {
    try {
      const consolidator = new GraphConsolidator(graphDbPath);
      const { nodesRemoved, edgesRemoved, nodesMerged } = consolidator
        .consolidate((msg) => log("info", msg));
      log(
        "info",
        `Graph consolidation: removed ${nodesRemoved} nodes, ${edgesRemoved} edges, merged ${nodesMerged} nodes`,
      );
    } catch (error) {
      log(
        "error",
        `Graph consolidation failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  checkpoint.stages.graph.status = "completed";
  checkpoint.stages.graph.completed = true;
  await checkpointMgr.save(checkpoint as unknown as CheckpointState);
  setActiveCheckpoint(checkpoint);

  sse.broadcast({
    type: "stage_completed",
    stage: "graph",
    data: { nodesCreated: totalNodes, edgesCreated: totalEdges },
    timestamp: new Date().toISOString(),
  });
  log("info", `Graph stage complete: ${totalNodes} nodes, ${totalEdges} edges`);
  releaseStageLock();
}

export function graphRoutes(): Array<
  { method: string; pattern: string | RegExp; handler: Handler }
> {
  return [
    // POST /api/graph/estimate
    {
      method: "POST",
      pattern: "/api/graph/estimate",
      handler: async () => {
        const packageDir = getActivePackageDir();
        const config = getActiveConfig();
        const checkpoint = getActiveCheckpoint();
        if (!packageDir || !config || !checkpoint) {
          return json({ error: "No active package" }, 400);
        }

        const memoriesDir = join(packageDir, "memories");
        const dailyChars = await readFileChars(join(memoriesDir, "daily"));
        const significantChars = await readFileChars(
          join(memoriesDir, "significant"),
        );
        const dailyCount = await countMemoryFiles(join(memoriesDir, "daily"));
        const sigCount = await countMemoryFiles(
          join(memoriesDir, "significant"),
        );

        const processed = new Set(checkpoint.stages.graph.processedItems);

        // Rough estimate: batch daily files in groups of 14, significant individually
        const processedCount = processed.size;
        const unprocessedDaily = Math.max(
          0,
          dailyCount -
            [...processed].filter((p) => p.includes("/daily/")).length,
        );
        const unprocessedSig = Math.max(
          0,
          sigCount -
            [...processed].filter((p) => p.includes("/significant/")).length,
        );
        const batchSize = 14;
        const dailyBatches = Math.ceil(unprocessedDaily / batchSize);
        const totalRequests = dailyBatches + unprocessedSig;
        const avgChars = (dailyChars + significantChars) /
          Math.max(1, dailyCount + sigCount);
        const totalChars = (unprocessedDaily + unprocessedSig) * avgChars;

        const estimate = buildCostEstimate(
          config.llmModel,
          totalChars,
          2000, // graph extraction tends to be larger
          totalRequests,
          `${
            unprocessedDaily + unprocessedSig
          } memory files in ~${totalRequests} batched requests`,
        );
        return json({
          estimate,
          dailyFiles: dailyCount,
          significantFiles: sigCount,
          processed: processedCount,
        });
      },
    },

    // POST /api/graph/start
    {
      method: "POST",
      pattern: "/api/graph/start",
      handler: async () => {
        const running = getRunningStage();
        if (running) {
          return json({ error: `Stage '${running}' is already running` }, 409);
        }

        const signal = acquireStageLock("graph");
        if (!signal) {
          return json({ error: "Another stage is already running" }, 409);
        }

        const checkpoint = getActiveCheckpoint();
        if (checkpoint) {
          checkpoint.stages.graph.status = "running";
          setActiveCheckpoint(checkpoint);
        }

        runGraphStage(signal).catch((err) => {
          log(
            "error",
            `Graph stage error: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
          releaseStageLock();
        });

        return json({ started: true });
      },
    },

    // POST /api/graph/abort
    {
      method: "POST",
      pattern: "/api/graph/abort",
      handler: async () => {
        const running = getRunningStage();
        if (running !== "graph") {
          return json({ error: "Graph stage is not running" }, 400);
        }
        abortRunningStage();
        sse.broadcast({
          type: "abort",
          data: { reason: "User aborted" },
          timestamp: new Date().toISOString(),
        });
        return json({ aborted: true });
      },
    },

    // POST /api/graph/skip
    {
      method: "POST",
      pattern: "/api/graph/skip",
      handler: async () => {
        const packageDir = getActivePackageDir();
        const checkpoint = getActiveCheckpoint();
        if (!packageDir || !checkpoint) {
          return json({ error: "No active package" }, 400);
        }

        checkpoint.stages.graph.status = "completed";
        checkpoint.stages.graph.completed = true;

        const checkpointMgr = new CheckpointManager(packageDir);
        await checkpointMgr.save(checkpoint as unknown as CheckpointState);
        setActiveCheckpoint(checkpoint);

        log("info", "Graph stage skipped by user");
        sse.broadcast({
          type: "stage_completed",
          stage: "graph",
          data: { skipped: true },
          timestamp: new Date().toISOString(),
        });
        return json({ skipped: true });
      },
    },

    // GET /api/graph/status
    {
      method: "GET",
      pattern: "/api/graph/status",
      handler: async () => {
        const checkpoint = getActiveCheckpoint();
        if (!checkpoint) return json({ error: "No active checkpoint" }, 400);
        return json({
          stage: "graph",
          status: checkpoint.stages.graph.status,
          processed: checkpoint.stages.graph.processedItems.length,
          running: getRunningStage() === "graph",
        });
      },
    },

    // ─── Graph Viewer API (migrated from graph/server.ts) ────────

    // GET /api/graph — return all nodes and edges
    {
      method: "GET",
      pattern: "/api/graph",
      handler: async () => {
        const packageDir = getActivePackageDir();
        if (!packageDir) return json({ error: "No active package" }, 400);
        const graphDbPath = join(packageDir, "graph.db");

        try {
          const db = new Database(graphDbPath, { readonly: true });

          const nodes = db.prepare(
            "SELECT id, type, label, description, confidence, source_instance, created_at, updated_at, first_learned_at, last_confirmed_at, version FROM graph_nodes WHERE deleted = 0",
          ).all() as Array<Record<string, unknown>>;

          const edges = db.prepare(
            "SELECT id, from_id as fromId, to_id as toId, type, evidence, weight, created_at, updated_at, occurred_at, last_confirmed_at, version FROM graph_edges WHERE deleted = 0",
          ).all() as Array<Record<string, unknown>>;

          db.close();

          const mappedNodes = nodes.map((n) => ({
            id: n.id,
            type: n.type,
            label: n.label,
            description: n.description,
            confidence: n.confidence,
            sourceInstance: n.source_instance,
            createdAt: n.created_at,
            updatedAt: n.updated_at,
            firstLearnedAt: n.first_learned_at,
            lastConfirmedAt: n.last_confirmed_at,
            version: n.version,
          }));

          const mappedEdges = edges.map((e) => ({
            id: e.id,
            fromId: e.fromId,
            toId: e.toId,
            type: e.type,
            evidence: e.evidence,
            weight: e.weight,
            createdAt: e.created_at,
            updatedAt: e.updated_at,
            occurredAt: e.occurred_at,
            lastConfirmedAt: e.last_confirmed_at,
            version: e.version,
          }));

          return json({
            nodes: mappedNodes,
            edges: mappedEdges,
            stats: {
              totalNodes: mappedNodes.length,
              totalEdges: mappedEdges.length,
              nodeTypes: [...new Set(mappedNodes.map((n) => n.type))].sort(),
              edgeTypes: [...new Set(mappedEdges.map((e) => e.type))].sort(),
            },
          });
        } catch {
          return json(
            { error: "graph.db not found — run graph stage first" },
            404,
          );
        }
      },
    },

    // DELETE /api/graph/nodes/:id
    {
      method: "DELETE",
      pattern: /^\/api\/graph\/nodes\/(.+)$/,
      handler: async (_req, ctx) => {
        const packageDir = getActivePackageDir();
        if (!packageDir) return json({ error: "No active package" }, 400);
        const nodeId = decodeURIComponent(ctx.params.param1);
        const graphDbPath = join(packageDir, "graph.db");
        try {
          const db = new Database(graphDbPath);
          db.prepare(
            "UPDATE graph_edges SET deleted = 1, updated_at = ? WHERE (from_id = ? OR to_id = ?) AND deleted = 0",
          )
            .run(new Date().toISOString(), nodeId, nodeId);
          const changes = db.prepare(
            "UPDATE graph_nodes SET deleted = 1, updated_at = ? WHERE id = ? AND deleted = 0",
          )
            .run(new Date().toISOString(), nodeId);
          db.close();
          if (changes === 0) {
            return json({ success: false, error: "Node not found" }, 404);
          }
          return json({ success: true });
        } catch (err) {
          return json({ success: false, error: String(err) }, 500);
        }
      },
    },

    // PUT /api/graph/nodes/:id
    {
      method: "PUT",
      pattern: /^\/api\/graph\/nodes\/(.+)$/,
      handler: async (req, ctx) => {
        const packageDir = getActivePackageDir();
        if (!packageDir) return json({ error: "No active package" }, 400);
        const nodeId = decodeURIComponent(ctx.params.param1);
        const graphDbPath = join(packageDir, "graph.db");
        try {
          const body = await req.json() as {
            label?: string;
            description?: string;
            type?: string;
          };
          const db = new Database(graphDbPath);
          const existing = db.prepare(
            "SELECT id FROM graph_nodes WHERE id = ? AND deleted = 0",
          ).get(nodeId);
          if (!existing) {
            db.close();
            return json({ success: false, error: "Node not found" }, 404);
          }
          if (body.label !== undefined) {
            db.prepare(
              "UPDATE graph_nodes SET label = ?, updated_at = ?, version = version + 1 WHERE id = ?",
            ).run(body.label, new Date().toISOString(), nodeId);
          }
          if (body.description !== undefined) {
            db.prepare(
              "UPDATE graph_nodes SET description = ?, updated_at = ?, version = version + 1 WHERE id = ?",
            ).run(body.description || null, new Date().toISOString(), nodeId);
          }
          if (body.type !== undefined) {
            db.prepare(
              "UPDATE graph_nodes SET type = ?, updated_at = ?, version = version + 1 WHERE id = ?",
            ).run(body.type, new Date().toISOString(), nodeId);
          }
          db.close();
          return json({ success: true });
        } catch (err) {
          return json({ success: false, error: String(err) }, 500);
        }
      },
    },

    // POST /api/graph/nodes
    {
      method: "POST",
      pattern: "/api/graph/nodes",
      handler: async (req) => {
        const packageDir = getActivePackageDir();
        if (!packageDir) return json({ error: "No active package" }, 400);
        const graphDbPath = join(packageDir, "graph.db");
        try {
          const body = await req.json() as {
            type: string;
            label: string;
            description?: string;
          };
          if (!body.type || !body.label) {
            return json({
              success: false,
              error: "type and label are required",
            }, 400);
          }
          const db = new Database(graphDbPath);
          const id = `manual-${body.type}-${crypto.randomUUID().slice(0, 8)}`;
          const now = new Date().toISOString();
          db.prepare(
            `INSERT INTO graph_nodes (id, type, label, description, source_instance, confidence, created_at, updated_at, first_learned_at, version)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
          ).run(
            id,
            body.type,
            body.label,
            body.description || null,
            "entity-loom-graph-preview",
            0.8,
            now,
            now,
            now,
          );
          db.close();
          return json({ success: true, id });
        } catch (err) {
          return json({ success: false, error: String(err) }, 500);
        }
      },
    },

    // DELETE /api/graph/edges/:id
    {
      method: "DELETE",
      pattern: /^\/api\/graph\/edges\/(.+)$/,
      handler: async (_req, ctx) => {
        const packageDir = getActivePackageDir();
        if (!packageDir) return json({ error: "No active package" }, 400);
        const edgeId = decodeURIComponent(ctx.params.param1);
        const graphDbPath = join(packageDir, "graph.db");
        try {
          const db = new Database(graphDbPath);
          const changes = db.prepare(
            "UPDATE graph_edges SET deleted = 1, updated_at = ? WHERE id = ? AND deleted = 0",
          )
            .run(new Date().toISOString(), edgeId);
          db.close();
          if (changes === 0) {
            return json({ success: false, error: "Edge not found" }, 404);
          }
          return json({ success: true });
        } catch (err) {
          return json({ success: false, error: String(err) }, 500);
        }
      },
    },

    // PUT /api/graph/edges/:id
    {
      method: "PUT",
      pattern: /^\/api\/graph\/edges\/(.+)$/,
      handler: async (req, ctx) => {
        const packageDir = getActivePackageDir();
        if (!packageDir) return json({ error: "No active package" }, 400);
        const edgeId = decodeURIComponent(ctx.params.param1);
        const graphDbPath = join(packageDir, "graph.db");
        try {
          const body = await req.json() as { type?: string };
          const db = new Database(graphDbPath);
          const existing = db.prepare(
            "SELECT id FROM graph_edges WHERE id = ? AND deleted = 0",
          ).get(edgeId);
          if (!existing) {
            db.close();
            return json({ success: false, error: "Edge not found" }, 404);
          }
          if (body.type !== undefined) {
            db.prepare(
              "UPDATE graph_edges SET type = ?, updated_at = ?, version = version + 1 WHERE id = ?",
            ).run(body.type, new Date().toISOString(), edgeId);
          }
          db.close();
          return json({ success: true });
        } catch (err) {
          return json({ success: false, error: String(err) }, 500);
        }
      },
    },

    // POST /api/graph/edges
    {
      method: "POST",
      pattern: "/api/graph/edges",
      handler: async (req) => {
        const packageDir = getActivePackageDir();
        if (!packageDir) return json({ error: "No active package" }, 400);
        const graphDbPath = join(packageDir, "graph.db");
        try {
          const body = await req.json() as {
            fromId: string;
            toId: string;
            type: string;
            evidence?: string;
          };
          if (!body.fromId || !body.toId || !body.type) {
            return json({
              success: false,
              error: "fromId, toId, and type are required",
            }, 400);
          }
          if (body.fromId === body.toId) {
            return json({
              success: false,
              error: "Cannot connect a node to itself",
            }, 400);
          }
          const db = new Database(graphDbPath);
          const fromNode = db.prepare(
            "SELECT id FROM graph_nodes WHERE id = ? AND deleted = 0",
          ).get(body.fromId);
          const toNode = db.prepare(
            "SELECT id FROM graph_nodes WHERE id = ? AND deleted = 0",
          ).get(body.toId);
          if (!fromNode || !toNode) {
            db.close();
            return json({
              success: false,
              error: "One or both nodes not found",
            }, 404);
          }
          const id = `manual-edge-${crypto.randomUUID().slice(0, 8)}`;
          const now = new Date().toISOString();
          db.prepare(
            `INSERT INTO graph_edges (id, from_id, to_id, type, evidence, weight, created_at, updated_at, version)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`,
          ).run(
            id,
            body.fromId,
            body.toId,
            body.type,
            body.evidence || null,
            0.7,
            now,
            now,
          );
          db.close();
          return json({ success: true, id });
        } catch (err) {
          return json({ success: false, error: String(err) }, 500);
        }
      },
    },

    // POST /api/finalize — strip platform column from DB for Psycheros compatibility
    {
      method: "POST",
      pattern: "/api/finalize",
      handler: async () => {
        const packageDir = getActivePackageDir();
        if (!packageDir) return json({ error: "No active package" }, 400);

        const dbPath = join(packageDir, "chats.db");
        try {
          const db = new DBWriter(dbPath);
          db.init();
          db.stripPlatformColumn();
          db.close();
          setFinalized(true);
          log("info", "Finalized: stripped platform column from chats.db");
          sse.broadcast({
            type: "log",
            data: {
              level: "info",
              message:
                "Package finalized — chats.db is now Psycheros-compatible",
            },
            timestamp: new Date().toISOString(),
          });
          return json({
            success: true,
            message:
              "Platform column stripped. chats.db is now Psycheros-compatible.",
          });
        } catch (error) {
          const message = error instanceof Error
            ? error.message
            : String(error);
          log("error", `Finalize failed: ${message}`);
          return json({ error: message }, 500);
        }
      },
    },

    // GET /api/download — stream package as zip file
    {
      method: "GET",
      pattern: "/api/download",
      handler: async (req) => {
        const packageDir = getActivePackageDir();
        if (!packageDir) return json({ error: "No active package" }, 400);

        const config = getActiveConfig();
        const entityName = config?.entityName || basename(packageDir);
        const prefix = `${entityName}-import/`;

        // Optional tag suffix for renaming chats.db inside the ZIP
        const url = new URL(req.url);
        const tagSuffix = url.searchParams.get("tags") || "";

        try {
          const files = await collectFiles(packageDir, prefix);

          // Rename chats.db to {tagSuffix}chats.db if tags provided
          if (tagSuffix) {
            const chatsKey = `${prefix}chats.db`;
            if (files[chatsKey]) {
              const taggedKey = `${prefix}${tagSuffix}chats.db`;
              files[taggedKey] = files[chatsKey];
              delete files[chatsKey];
            }
          }

          const zipped = zipSync(files);
          return new Response(ReadableStream.from([new Uint8Array(zipped)]), {
            headers: {
              "Content-Type": "application/octet-stream",
              "Content-Disposition":
                `attachment; filename="${entityName}-import.zip"`,
            },
          });
        } catch (error) {
          const message = error instanceof Error
            ? error.message
            : String(error);
          log("error", `Download failed: ${message}`);
          return json({ error: message }, 500);
        }
      },
    },
  ];
}

/** Collect all files in a directory recursively into a flat map of {zipPath: data} */
async function collectFiles(
  dirPath: string,
  prefix: string,
): Promise<Record<string, Uint8Array>> {
  const EXCLUDED_FILES = new Set([
    "staging.db",
    "staging.db-journal",
    "staging.db-wal",
  ]);
  const files: Record<string, Uint8Array> = {};

  async function walk(
    currentDir: string,
    currentPrefix: string,
  ): Promise<void> {
    for await (const entry of Deno.readDir(currentDir)) {
      const fullPath = join(currentDir, entry.name);
      const zippedPath = currentPrefix + entry.name;

      if (entry.isDirectory) {
        await walk(fullPath, zippedPath + "/");
      } else if (entry.isFile) {
        if (EXCLUDED_FILES.has(entry.name)) continue;
        files[zippedPath] = await Deno.readFile(fullPath);
      }
    }
  }

  await walk(dirPath, prefix);
  return files;
}
