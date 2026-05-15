/**
 * Entity Loom — Significant Memories Stage
 *
 * Background extraction of significant memories from raw conversations.
 * Runs as an async task with SSE progress, abort support, and per-conversation checkpointing.
 */

import { join } from "@std/path";
import type { Handler } from "../server/server.ts";
import type { CheckpointState, ImportedConversation } from "../types.ts";
import { MemoryWriter } from "../writers/memory-writer.ts";
import { chunkConversationForSignificance } from "../pipeline/chunker.ts";
import { SignaledLLMClient } from "./signaled-llm.ts";
import { CheckpointManager } from "../dedup/checkpoint.ts";
import {
  getActiveCheckpoint,
  getActiveConfig,
  getActivePackageDir,
  setActiveCheckpoint,
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

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Load raw conversations from disk, restoring Date objects */
async function loadRawConversations(
  packageDir: string,
): Promise<ImportedConversation[]> {
  const rawPath = join(packageDir, "raw", "_loom_conversations.json");
  const raw = await Deno.readTextFile(rawPath);
  const conversations = JSON.parse(raw) as ImportedConversation[];
  for (const conv of conversations) {
    conv.createdAt = new Date(conv.createdAt as unknown as string);
    conv.updatedAt = new Date(conv.updatedAt as unknown as string);
    if (!Array.isArray(conv.messages)) {
      log(
        "warn",
        `Conversation ${conv.id} has non-array messages field, skipping`,
      );
      conv.messages = [];
      continue;
    }
    for (const msg of conv.messages) {
      msg.createdAt = new Date(msg.createdAt as unknown as string);
    }
  }
  return conversations;
}

function formatDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** Background task: process conversations for significant memories */
async function runSignificantStage(signal: AbortSignal): Promise<void> {
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

  const memoryWriter = new MemoryWriter(
    packageDir,
    config.entityName,
    config.userName,
    config.instanceId,
    config.contextNotes,
    llm,
    config.rateLimitMs,
    config.maxContextTokens,
    config.entityPronouns,
    config.userPronouns,
    config.relationshipContext,
  );

  const conversations = await loadRawConversations(packageDir);

  // Filter already-processed conversations
  const processed = new Set(checkpoint.stages.significant.processedItems);
  const convsToProcess = conversations.filter((c) => !processed.has(c.id));

  log("info", `Significant: ${convsToProcess.length} conversations to process`);
  sse.broadcast({
    type: "stage_started",
    stage: "significant",
    data: { totalItems: convsToProcess.length },
    timestamp: new Date().toISOString(),
  });

  // Count total chunks for accurate progress
  let totalChunks = 0;
  for (const conv of convsToProcess) {
    totalChunks +=
      chunkConversationForSignificance(conv, config.maxContextTokens).length;
  }

  let memoriesCreated = 0;
  let conversationsProcessed = 0;
  let chunksProcessed = 0;
  const checkpointMgr = new CheckpointManager(packageDir);

  for (let i = 0; i < convsToProcess.length; i++) {
    // Check abort between items
    if (signal.aborted) {
      log("warn", "Significant stage aborted");
      checkpoint.stages.significant.status = "aborted";
      await checkpointMgr.save(checkpoint as unknown as CheckpointState);
      setActiveCheckpoint(checkpoint);
      releaseStageLock();
      return;
    }

    const conv = convsToProcess[i];
    sse.broadcast({
      type: "item_started",
      stage: "significant",
      data: { index: i, title: conv.title || conv.id, id: conv.id },
      timestamp: new Date().toISOString(),
    });

    try {
      const userAssistantMessages = conv.messages.filter((m) =>
        m.role === "user" || m.role === "assistant"
      );
      if (userAssistantMessages.length === 0) continue;

      const chunks = chunkConversationForSignificance(
        conv,
        config.maxContextTokens,
      );
      let memoriesForThisConv = 0;

      for (const chunk of chunks) {
        if (signal.aborted) break;

        const dateFrom = formatDate(chunk.dateFrom);
        const dateTo = formatDate(chunk.dateTo);
        const dateLabel = dateFrom === dateTo
          ? dateFrom
          : `${dateFrom} to ${dateTo}`;

        const groups = [{
          conversationId: chunk.conversationId,
          title: chunk.title || "Untitled conversation",
          platform: chunk.platform,
          messages: chunk.messages,
        }];

        const result = await memoryWriter.extractSignificantMemories(
          dateLabel,
          groups,
        );

        if (result) {
          const sigPath = await memoryWriter.writeSignificantMemory(
            dateFrom,
            result.prose,
            result.slug,
          );
          if (sigPath) {
            memoriesCreated++;
            memoriesForThisConv++;
            const chunkNote = chunks.length > 1
              ? ` (chunk ${chunk.chunkIndex + 1}/${chunks.length})`
              : "";
            log("info", `Created significant memory: ${sigPath}${chunkNote}`);
          }
        }

        chunksProcessed++;
        const percent = totalChunks > 0
          ? Math.round((chunksProcessed / totalChunks) * 100)
          : 0;
        const snapshot = {
          current: chunksProcessed,
          total: totalChunks,
          percent,
        };
        setProgressSnapshot(snapshot);
        sse.broadcast({
          type: "stage_progress",
          stage: "significant",
          data: snapshot,
          timestamp: new Date().toISOString(),
        });
      }

      checkpoint.stages.significant.processedItems.push(conv.id);
      checkpoint.stages.significant.failedItems = checkpoint.stages.significant
        .failedItems.filter((id) => id !== conv.id);
      conversationsProcessed++;

      sse.broadcast({
        type: "item_completed",
        stage: "significant",
        data: {
          index: i,
          title: conv.title || conv.id,
          result: `${memoriesForThisConv} memories`,
        },
        timestamp: new Date().toISOString(),
      });

      // Save checkpoint after each conversation
      await checkpointMgr.save(checkpoint as unknown as CheckpointState);
    } catch (error) {
      // Check if this was caused by abort
      if (signal.aborted) {
        log("warn", "Significant stage aborted");
        checkpoint.stages.significant.status = "aborted";
        await checkpointMgr.save(checkpoint as unknown as CheckpointState);
        setActiveCheckpoint(checkpoint);
        releaseStageLock();
        return;
      }
      const msg = error instanceof Error ? error.message : String(error);
      log("error", `Significant failed for ${conv.id}: ${msg}`);
      checkpoint.stages.significant.failedItems.push(conv.id);
      sse.broadcast({
        type: "item_error",
        stage: "significant",
        data: { index: i, title: conv.title || conv.id, error: msg },
        timestamp: new Date().toISOString(),
      });
    }
  }

  // Final abort check after loop ends
  if (signal.aborted) {
    log("warn", "Significant stage aborted (post-loop)");
    checkpoint.stages.significant.status = "aborted";
    await checkpointMgr.save(checkpoint as unknown as CheckpointState);
    setActiveCheckpoint(checkpoint);
    releaseStageLock();
    return;
  }

  checkpoint.stages.significant.status = "completed";
  checkpoint.stages.significant.completed = true;
  checkpoint.currentStage = "daily";
  await checkpointMgr.save(checkpoint as unknown as CheckpointState);
  setActiveCheckpoint(checkpoint);

  sse.broadcast({
    type: "stage_completed",
    stage: "significant",
    data: { memoriesCreated, conversationsProcessed },
    timestamp: new Date().toISOString(),
  });
  log(
    "info",
    `Significant stage complete: ${memoriesCreated} memories from ${conversationsProcessed} conversations`,
  );
  releaseStageLock();
}

export function significantRoutes(): Array<
  { method: string; pattern: string | RegExp; handler: Handler }
> {
  return [
    // POST /api/significant/estimate — cost estimate
    {
      method: "POST",
      pattern: "/api/significant/estimate",
      handler: async () => {
        const packageDir = getActivePackageDir();
        const config = getActiveConfig();
        const checkpoint = getActiveCheckpoint();
        if (!packageDir || !config || !checkpoint) {
          return json({ error: "No active package" }, 400);
        }

        try {
          const conversations = await loadRawConversations(packageDir);
          const processed = new Set(
            checkpoint.stages.significant.processedItems,
          );
          const toProcess = conversations.filter((c) => !processed.has(c.id));

          const totalChars = toProcess.reduce(
            (sum, c) =>
              sum +
              c.messages.filter((m) =>
                m.role === "user" || m.role === "assistant"
              )
                .reduce((ms, m) => ms + m.content.length, 0),
            0,
          );

          // Count actual chunks to estimate request count accurately
          let totalChunks = 0;
          for (const conv of toProcess) {
            const chunks = chunkConversationForSignificance(
              conv,
              config.maxContextTokens,
            );
            totalChunks += chunks.length;
          }

          const estimate = buildCostEstimate(
            config.llmModel,
            totalChars,
            2500, // avg significant response (~600 tokens)
            totalChunks,
            `${toProcess.length} conversations (${totalChunks} chunks) for significant memory extraction`,
          );
          return json({ estimate });
        } catch (error) {
          return json({
            error: error instanceof Error ? error.message : String(error),
          }, 500);
        }
      },
    },

    // POST /api/significant/start — start background processing
    {
      method: "POST",
      pattern: "/api/significant/start",
      handler: async () => {
        const running = getRunningStage();
        if (running) {
          return json({ error: `Stage '${running}' is already running` }, 409);
        }

        const signal = acquireStageLock("significant");
        if (!signal) {
          return json({ error: "Another stage is already running" }, 409);
        }

        const checkpoint = getActiveCheckpoint();
        if (checkpoint) {
          checkpoint.stages.significant.status = "running";
          setActiveCheckpoint(checkpoint);
        }

        // Fire and forget
        runSignificantStage(signal).catch((err) => {
          log(
            "error",
            `Significant stage error: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
          releaseStageLock();
        });

        return json({ started: true });
      },
    },

    // POST /api/significant/abort — abort via AbortController
    {
      method: "POST",
      pattern: "/api/significant/abort",
      handler: async () => {
        const running = getRunningStage();
        if (running !== "significant") {
          return json({ error: "Significant stage is not running" }, 400);
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

    // GET /api/significant/status — current progress
    {
      method: "GET",
      pattern: "/api/significant/status",
      handler: async () => {
        const checkpoint = getActiveCheckpoint();
        if (!checkpoint) return json({ error: "No active checkpoint" }, 400);
        return json({
          stage: "significant",
          status: checkpoint.stages.significant.status,
          processed: checkpoint.stages.significant.processedItems.length,
          failed: checkpoint.stages.significant.failedItems.length,
          running: getRunningStage() === "significant",
        });
      },
    },

    // GET /api/memories/significant — list significant memory files
    {
      method: "GET",
      pattern: "/api/memories/significant",
      handler: async () => {
        const packageDir = getActivePackageDir();
        if (!packageDir) return json({ error: "No active package" }, 400);
        const dir = join(packageDir, "memories", "significant");
        try {
          const files: string[] = [];
          for await (const entry of Deno.readDir(dir)) {
            if (
              entry.isFile && entry.name.endsWith(".md") &&
              entry.name !== ".gitkeep"
            ) {
              files.push(entry.name);
            }
          }
          files.sort();
          return json({ files });
        } catch {
          return json({ files: [] });
        }
      },
    },

    // GET /api/memories/significant/:filename — read a memory file
    {
      method: "GET",
      pattern: /^\/api\/memories\/significant\/(.+)$/,
      handler: async (_req, ctx) => {
        const filename = decodeURIComponent(ctx.params.param1);
        const packageDir = getActivePackageDir();
        if (!packageDir) return json({ error: "No active package" }, 400);
        try {
          const content = await Deno.readTextFile(
            join(packageDir, "memories", "significant", filename),
          );
          return json({ filename, type: "significant", content });
        } catch {
          return json({ error: "File not found" }, 404);
        }
      },
    },

    // PUT /api/memories/significant/:filename — edit a memory file
    {
      method: "PUT",
      pattern: /^\/api\/memories\/significant\/(.+)$/,
      handler: async (req, ctx) => {
        const filename = decodeURIComponent(ctx.params.param1);
        const packageDir = getActivePackageDir();
        if (!packageDir) return json({ error: "No active package" }, 400);
        const body = await req.json() as { content: string };
        if (!body.content) return json({ error: "content is required" }, 400);
        try {
          await Deno.writeTextFile(
            join(packageDir, "memories", "significant", filename),
            body.content,
          );
          return json({ success: true });
        } catch {
          return json({ error: "Write failed" }, 500);
        }
      },
    },

    // DELETE /api/memories/significant/:filename — delete a memory file
    {
      method: "DELETE",
      pattern: /^\/api\/memories\/significant\/(.+)$/,
      handler: async (_req, ctx) => {
        const filename = decodeURIComponent(ctx.params.param1);
        const packageDir = getActivePackageDir();
        if (!packageDir) return json({ error: "No active package" }, 400);
        try {
          await Deno.remove(
            join(packageDir, "memories", "significant", filename),
          );
          return json({ success: true });
        } catch {
          return json({ error: "Delete failed" }, 500);
        }
      },
    },
  ];
}
