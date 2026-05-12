/**
 * Entity Loom — Daily Memories Stage
 *
 * Background daily memory generation from chats.db.
 * Supports time window filtering (week/month/all).
 */

import { join } from "@std/path";
import type { Handler } from "../server/server.ts";
import type { CheckpointState } from "../types.ts";
import { DBWriter } from "../writers/db-writer.ts";
import { MemoryWriter } from "../writers/memory-writer.ts";
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

/** Get dates from chats.db, optionally filtered by time window */
function getDatesFromDb(
  dbPath: string,
  window?: "all" | "week" | "month",
  dateFrom?: string,
  dateTo?: string,
): string[] {
  const db = new DBWriter(dbPath);
  let dates: string[];

  if (dateFrom || dateTo) {
    let query =
      "SELECT DISTINCT DATE(created_at) as date FROM messages WHERE 1=1";
    const params: string[] = [];
    if (dateFrom) {
      query += " AND DATE(created_at) >= ?";
      params.push(dateFrom);
    }
    if (dateTo) {
      query += " AND DATE(created_at) <= ?";
      params.push(dateTo);
    }
    query += " ORDER BY date";
    dates = db.query(query, params).map((row) => row.date as string);
  } else if (window === "week") {
    const oneWeekAgo = new Date();
    oneWeekAgo.setDate(oneWeekAgo.getDate() - 7);
    const from = oneWeekAgo.toISOString().slice(0, 10);
    dates = db.query(
      "SELECT DISTINCT DATE(created_at) as date FROM messages WHERE DATE(created_at) >= ? ORDER BY date",
      [from],
    ).map((row) => row.date as string);
  } else if (window === "month") {
    const oneMonthAgo = new Date();
    oneMonthAgo.setMonth(oneMonthAgo.getMonth() - 1);
    const from = oneMonthAgo.toISOString().slice(0, 10);
    dates = db.query(
      "SELECT DISTINCT DATE(created_at) as date FROM messages WHERE DATE(created_at) >= ? ORDER BY date",
      [from],
    ).map((row) => row.date as string);
  } else {
    dates = db.query(
      "SELECT DISTINCT DATE(created_at) as date FROM messages ORDER BY date",
    ).map((row) => row.date as string);
  }

  db.close();
  return dates;
}

/** Background task: generate daily memories */
async function runDailyStage(
  signal: AbortSignal,
  window?: string,
): Promise<void> {
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

  const dbPath = join(packageDir, "chats.db");
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

  const dates = getDatesFromDb(
    dbPath,
    window as "all" | "week" | "month" | undefined,
  );
  const processed = new Set(checkpoint.stages.daily.processedItems);
  const datesToProcess = dates.filter((d) => !processed.has(d));

  log("info", `Daily: ${datesToProcess.length} dates to process`);
  sse.broadcast({
    type: "stage_started",
    stage: "daily",
    data: { totalItems: datesToProcess.length },
    timestamp: new Date().toISOString(),
  });

  let memoriesCreated = 0;
  const db = new DBWriter(dbPath);
  const checkpointMgr = new CheckpointManager(packageDir);

  for (let i = 0; i < datesToProcess.length; i++) {
    if (signal.aborted) {
      log("warn", "Daily stage aborted");
      checkpoint.stages.daily.status = "aborted";
      await checkpointMgr.save(checkpoint as unknown as CheckpointState);
      setActiveCheckpoint(checkpoint);
      releaseStageLock();
      return;
    }

    const date = datesToProcess[i];
    sse.broadcast({
      type: "item_started",
      stage: "daily",
      data: { index: i, title: date, id: date },
      timestamp: new Date().toISOString(),
    });

    try {
      if (await memoryWriter.dailyMemoryExists(date)) {
        checkpoint.stages.daily.processedItems.push(date);
        continue;
      }

      const messages = db.getMessagesByDate(date);
      if (messages.length === 0) continue;

      const conversationMap = new Map<
        string,
        Array<{ role: string; content: string }>
      >();
      const conversationTitles = new Map<string, string>();
      const conversationPlatforms = new Map<string, string | null>();

      for (const msg of messages) {
        const existing = conversationMap.get(msg.conversationId) || [];
        existing.push({ role: msg.role, content: msg.content });
        conversationMap.set(msg.conversationId, existing);
        if (!conversationTitles.has(msg.conversationId)) {
          const title = db.getConversationTitle(msg.conversationId);
          conversationTitles.set(msg.conversationId, title || undefined!);
          conversationPlatforms.set(
            msg.conversationId,
            db.getConversationPlatform(msg.conversationId),
          );
        }
      }

      const groups = Array.from(conversationMap.entries()).map((
        [convId, msgs],
      ) => ({
        conversationId: convId,
        title: conversationTitles.get(convId),
        platform: conversationPlatforms.get(convId) || undefined,
        messages: msgs,
      }));

      const result = await memoryWriter.generateDailyMemory(date, groups);
      if (result) {
        const filePath = await memoryWriter.writeDailyMemory(
          date,
          result.content,
        );
        db.recordMemorySummary(
          date,
          "daily",
          memoryWriter.getDailyMemoryPath(date),
          result.chatIds,
        );
        memoriesCreated++;
        log("info", `Created daily memory: ${filePath}`);
      }

      checkpoint.stages.daily.processedItems.push(date);
      checkpoint.stages.daily.failedItems = checkpoint.stages.daily.failedItems
        .filter((d) => d !== date);

      sse.broadcast({
        type: "item_completed",
        stage: "daily",
        data: { index: i, title: date, result: "ok" },
        timestamp: new Date().toISOString(),
      });
      sse.broadcast({
        type: "stage_progress",
        stage: "daily",
        data: {
          current: i + 1,
          total: datesToProcess.length,
          percent: Math.round(((i + 1) / datesToProcess.length) * 100),
        },
        timestamp: new Date().toISOString(),
      });

      await checkpointMgr.save(checkpoint as unknown as CheckpointState);
    } catch (error) {
      if (signal.aborted) {
        log("warn", "Daily stage aborted");
        checkpoint.stages.daily.status = "aborted";
        await checkpointMgr.save(checkpoint as unknown as CheckpointState);
        setActiveCheckpoint(checkpoint);
        releaseStageLock();
        db.close();
        return;
      }
      const msg = error instanceof Error ? error.message : String(error);
      log("error", `Daily failed for ${date}: ${msg}`);
      checkpoint.stages.daily.failedItems.push(date);
      sse.broadcast({
        type: "item_error",
        stage: "daily",
        data: { index: i, title: date, error: msg },
        timestamp: new Date().toISOString(),
      });
    }
  }

  db.close();

  if (signal.aborted) {
    log("warn", "Daily stage aborted (post-loop)");
    checkpoint.stages.daily.status = "aborted";
    await checkpointMgr.save(checkpoint as unknown as CheckpointState);
    setActiveCheckpoint(checkpoint);
    releaseStageLock();
    return;
  }

  checkpoint.stages.daily.status = "completed";
  checkpoint.stages.daily.completed = true;
  checkpoint.currentStage = "graph";
  await checkpointMgr.save(checkpoint as unknown as CheckpointState);
  setActiveCheckpoint(checkpoint);

  sse.broadcast({
    type: "stage_completed",
    stage: "daily",
    data: { memoriesCreated },
    timestamp: new Date().toISOString(),
  });
  log("info", `Daily stage complete: ${memoriesCreated} memories`);
  releaseStageLock();
}

export function dailyRoutes(): Array<
  { method: string; pattern: string | RegExp; handler: Handler }
> {
  return [
    // POST /api/daily/estimate
    {
      method: "POST",
      pattern: "/api/daily/estimate",
      handler: async (req) => {
        const packageDir = getActivePackageDir();
        const config = getActiveConfig();
        const checkpoint = getActiveCheckpoint();
        if (!packageDir || !config || !checkpoint) {
          return json({ error: "No active package" }, 400);
        }

        try {
          const body = await req.json() as {
            window?: string;
            dateFrom?: string;
            dateTo?: string;
          };
          const dbPath = join(packageDir, "chats.db");
          const dates = getDatesFromDb(
            dbPath,
            body.window as "all" | "week" | "month" | undefined,
            body.dateFrom,
            body.dateTo,
          );
          const processed = new Set(checkpoint.stages.daily.processedItems);
          const toProcess = dates.filter((d) => !processed.has(d));

          // Count actual message chars per date for accurate estimate
          const db = new DBWriter(dbPath);
          let totalChars = 0;
          for (const date of toProcess) {
            const msgs = db.getMessagesByDate(date);
            totalChars += msgs.reduce((sum, m) => sum + m.content.length, 0);
          }
          db.close();

          const estimate = buildCostEstimate(
            config.llmModel,
            totalChars,
            2000, // avg daily response (~500 tokens)
            toProcess.length,
            `${toProcess.length} dates for daily memory generation`,
          );
          return json({ estimate });
        } catch (error) {
          return json({
            error: error instanceof Error ? error.message : String(error),
          }, 500);
        }
      },
    },

    // POST /api/daily/start
    {
      method: "POST",
      pattern: "/api/daily/start",
      handler: async (req) => {
        const running = getRunningStage();
        if (running) {
          return json({ error: `Stage '${running}' is already running` }, 409);
        }

        const body = await req.json() as { window?: string };
        const signal = acquireStageLock("daily");
        if (!signal) {
          return json({ error: "Another stage is already running" }, 409);
        }

        const checkpoint = getActiveCheckpoint();
        if (checkpoint) {
          checkpoint.stages.daily.status = "running";
          setActiveCheckpoint(checkpoint);
        }

        runDailyStage(signal, body.window).catch((err) => {
          log(
            "error",
            `Daily stage error: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
          releaseStageLock();
        });

        return json({ started: true });
      },
    },

    // POST /api/daily/abort
    {
      method: "POST",
      pattern: "/api/daily/abort",
      handler: async () => {
        const running = getRunningStage();
        if (running !== "daily") {
          return json({ error: "Daily stage is not running" }, 400);
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

    // GET /api/daily/status
    {
      method: "GET",
      pattern: "/api/daily/status",
      handler: async () => {
        const checkpoint = getActiveCheckpoint();
        if (!checkpoint) return json({ error: "No active checkpoint" }, 400);
        return json({
          stage: "daily",
          status: checkpoint.stages.daily.status,
          processed: checkpoint.stages.daily.processedItems.length,
          failed: checkpoint.stages.daily.failedItems.length,
          running: getRunningStage() === "daily",
        });
      },
    },

    // GET /api/memories/daily — list daily memory files
    {
      method: "GET",
      pattern: "/api/memories/daily",
      handler: async () => {
        const packageDir = getActivePackageDir();
        if (!packageDir) return json({ error: "No active package" }, 400);
        const dir = join(packageDir, "memories", "daily");
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

    // GET /api/memories/daily/:filename
    {
      method: "GET",
      pattern: /^\/api\/memories\/daily\/(.+)$/,
      handler: async (_req, ctx) => {
        const filename = decodeURIComponent(ctx.params.param1);
        const packageDir = getActivePackageDir();
        if (!packageDir) return json({ error: "No active package" }, 400);
        try {
          const content = await Deno.readTextFile(
            join(packageDir, "memories", "daily", filename),
          );
          return json({ filename, type: "daily", content });
        } catch {
          return json({ error: "File not found" }, 404);
        }
      },
    },

    // PUT /api/memories/daily/:filename
    {
      method: "PUT",
      pattern: /^\/api\/memories\/daily\/(.+)$/,
      handler: async (req, ctx) => {
        const filename = decodeURIComponent(ctx.params.param1);
        const packageDir = getActivePackageDir();
        if (!packageDir) return json({ error: "No active package" }, 400);
        const body = await req.json() as { content: string };
        if (!body.content) return json({ error: "content is required" }, 400);
        try {
          await Deno.writeTextFile(
            join(packageDir, "memories", "daily", filename),
            body.content,
          );
          return json({ success: true });
        } catch {
          return json({ error: "Write failed" }, 500);
        }
      },
    },

    // DELETE /api/memories/daily/:filename
    {
      method: "DELETE",
      pattern: /^\/api\/memories\/daily\/(.+)$/,
      handler: async (_req, ctx) => {
        const filename = decodeURIComponent(ctx.params.param1);
        const packageDir = getActivePackageDir();
        if (!packageDir) return json({ error: "No active package" }, 400);
        try {
          await Deno.remove(join(packageDir, "memories", "daily", filename));
          return json({ success: true });
        } catch {
          return json({ error: "Delete failed" }, 500);
        }
      },
    },
  ];
}
