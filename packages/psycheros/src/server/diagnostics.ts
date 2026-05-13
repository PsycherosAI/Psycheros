/**
 * Diagnostics Aggregation
 *
 * Collects health and stats from all subsystems into a single snapshot.
 * Used by admin routes to power the diagnostics dashboard.
 *
 * @module
 */

import type { RouteContext } from "./routes.ts";
import { getVecVersion, isVectorModuleAvailable } from "../db/vector.ts";
import { getBroadcaster } from "./broadcaster.ts";
import { IS_STAGING, VERSION, VERSION_BASE, VERSION_SUFFIX } from "../version.ts";
import entityCoreDenoJson from "../../../entity-core/deno.json" with { type: "json" };

/** Complete system diagnostics snapshot. */
export interface DiagnosticsSnapshot {
  timestamp: string;
  uptime: number;

  versions: {
    psycheros: string;
    psycherosBase: string;
    psycherosSuffix: string;
    isStaging: boolean;
    entityCore: string;
  };

  database: {
    conversations: number;
    messages: number;
    memorySummaries: number;
    lorebooks: number;
    lorebookEntries: number;
    dbSizeBytes: number | null;
  };

  vector: {
    available: boolean;
    version: string | null;
    memoryChunks: number;
    vecMemoryChunks: number;
    messageEmbeddings: number;
    vecMessages: number;
    memorySyncOk: boolean;
    messageSyncOk: boolean;
  };

  rag: {
    enabled: boolean;
    indexedFiles: number;
    indexedChunks: number;
  };

  memory: {
    enabled: boolean;
    dailySummaries: number;
    weeklySummaries: number;
    monthlySummaries: number;
    yearlySummaries: number;
    summarizedChats: number;
  };

  mcp: {
    enabled: boolean;
    connected: boolean;
    alive: boolean;
    lastPingSuccess: string | null;
    lastPingAttempt: string | null;
    lastSync: string | null;
    pendingIdentity: number;
  };

  sse: {
    connectedClients: number;
  };

  knowledgeGraph: {
    stats: {
      totalNodes: number;
      totalEdges: number;
      nodesByType: Record<string, number>;
      edgesByType: Record<string, number>;
    } | null;
    vectorSearchAvailable: boolean;
    writeToolsEnabled: boolean;
  };
}

// Server start time (set once from server.ts)
let serverStartTime: Date | null = null;

// Snapshot cache (5-second TTL)
let cachedSnapshot: DiagnosticsSnapshot | null = null;
let cacheTimestamp = 0;
const CACHE_TTL_MS = 5000;

/**
 * Record the server start time for uptime calculation.
 * Call once from server.ts during startup.
 */
export function setServerStartTime(time: Date): void {
  serverStartTime = time;
}

/**
 * Read the server start time. Returns null if not yet set.
 */
export function getServerStartTime(): Date | null {
  return serverStartTime;
}

/**
 * Helper to safely run a COUNT query.
 */
function safeCount(
  db: ReturnType<RouteContext["db"]["getRawDb"]>,
  sql: string,
): number {
  try {
    const row = db.prepare(sql).get() as { count: number } | undefined;
    return row?.count ?? 0;
  } catch {
    return 0;
  }
}

/**
 * Collect a diagnostics snapshot from all subsystems.
 * Results are cached for 5 seconds to avoid hammering SQLite on rapid refreshes.
 */
export async function collectDiagnostics(
  ctx: RouteContext,
): Promise<DiagnosticsSnapshot> {
  const now = Date.now();
  if (cachedSnapshot && (now - cacheTimestamp) < CACHE_TTL_MS) {
    return cachedSnapshot;
  }

  const db = ctx.db.getRawDb();
  const uptime = serverStartTime
    ? Math.floor((now - serverStartTime.getTime()) / 1000)
    : 0;

  // Database counts
  const database: DiagnosticsSnapshot["database"] = {
    conversations: safeCount(db, "SELECT COUNT(*) as count FROM conversations"),
    messages: safeCount(db, "SELECT COUNT(*) as count FROM messages"),
    memorySummaries: safeCount(
      db,
      "SELECT COUNT(*) as count FROM memory_summaries",
    ),
    lorebooks: safeCount(db, "SELECT COUNT(*) as count FROM lorebooks"),
    lorebookEntries: safeCount(
      db,
      "SELECT COUNT(*) as count FROM lorebook_entries",
    ),
    dbSizeBytes: null,
  };

  // DB file size
  try {
    const dbPath = `${ctx.projectRoot}/.psycheros/psycheros.db`;
    const stat = await Deno.stat(dbPath);
    database.dbSizeBytes = stat.size;
  } catch {
    // Can't read file size — leave null
  }

  // Vector system
  const vecAvailable = isVectorModuleAvailable();
  const vecVersion = getVecVersion(db);
  const memoryChunks = safeCount(
    db,
    "SELECT COUNT(*) as count FROM memory_chunks",
  );
  const messageEmbeddings = safeCount(
    db,
    "SELECT COUNT(*) as count FROM message_embeddings",
  );
  let vecMemoryChunks = 0;
  let vecMessages = 0;
  if (vecAvailable) {
    vecMemoryChunks = safeCount(
      db,
      "SELECT COUNT(*) as count FROM vec_memory_chunks",
    );
    vecMessages = safeCount(db, "SELECT COUNT(*) as count FROM vec_messages");
  }

  const vector: DiagnosticsSnapshot["vector"] = {
    available: vecAvailable,
    version: vecVersion,
    memoryChunks,
    vecMemoryChunks,
    messageEmbeddings,
    vecMessages,
    memorySyncOk: !vecAvailable || memoryChunks === vecMemoryChunks,
    messageSyncOk: !vecAvailable || messageEmbeddings === vecMessages,
  };

  // RAG
  const rag: DiagnosticsSnapshot["rag"] = {
    enabled: ctx.ragConfig?.enabled ?? false,
    indexedFiles: safeCount(
      db,
      "SELECT COUNT(*) as count FROM indexed_memories",
    ),
    indexedChunks: memoryChunks,
  };

  // Memory consolidation
  const memory: DiagnosticsSnapshot["memory"] = {
    enabled: ctx.memoryEnabled ?? false,
    dailySummaries: safeCount(
      db,
      "SELECT COUNT(*) as count FROM memory_summaries WHERE granularity = 'daily'",
    ),
    weeklySummaries: safeCount(
      db,
      "SELECT COUNT(*) as count FROM memory_summaries WHERE granularity = 'weekly'",
    ),
    monthlySummaries: safeCount(
      db,
      "SELECT COUNT(*) as count FROM memory_summaries WHERE granularity = 'monthly'",
    ),
    yearlySummaries: safeCount(
      db,
      "SELECT COUNT(*) as count FROM memory_summaries WHERE granularity = 'yearly'",
    ),
    summarizedChats: safeCount(
      db,
      "SELECT COUNT(*) as count FROM summarized_chats",
    ),
  };

  // MCP
  const mcpEnabled = !!ctx.mcpClient;
  const pingHealth = mcpEnabled ? ctx.mcpClient?.getPingHealth() : null;
  const mcp: DiagnosticsSnapshot["mcp"] = {
    enabled: mcpEnabled,
    connected: ctx.mcpClient?.isConnected() ?? false,
    alive: ctx.mcpClient?.isAlive() ?? false,
    lastPingSuccess: pingHealth?.lastPingSuccess ?? null,
    lastPingAttempt: pingHealth?.lastPingAttempt ?? null,
    lastSync: mcpEnabled
      // deno-lint-ignore no-explicit-any
      ? ((ctx.mcpClient as any)?.cache?.lastSync as string | null) ?? null
      : null,
    pendingIdentity: 0,
  };
  if (mcpEnabled && ctx.mcpClient) {
    try {
      const pending = ctx.mcpClient.getPendingCount();
      mcp.pendingIdentity = pending.identity;
    } catch {
      // Leave as 0
    }
  }

  // SSE
  const sse: DiagnosticsSnapshot["sse"] = {
    connectedClients: getBroadcaster().clientCount,
  };

  // Knowledge graph (only if MCP connected — avoids timeout on disconnected)
  let graphStats: DiagnosticsSnapshot["knowledgeGraph"]["stats"] = null;
  let graphVecAvailable = false;
  if (mcp.connected && ctx.mcpClient) {
    try {
      const stats = await ctx.mcpClient.getGraphStats();
      if (stats) {
        graphStats = {
          totalNodes: stats.totalNodes,
          totalEdges: stats.totalEdges,
          nodesByType: stats.nodesByType,
          edgesByType: stats.edgesByType ?? {},
        };
        graphVecAvailable = stats.vectorSearchAvailable ?? false;
      }
    } catch {
      // Leave as null
    }
  }

  // Graph write tools are no longer exposed — entity-core handles graph automatically
  const graphWriteToolsEnabled = false;

  const versions: DiagnosticsSnapshot["versions"] = {
    psycheros: VERSION,
    psycherosBase: VERSION_BASE,
    psycherosSuffix: VERSION_SUFFIX,
    isStaging: IS_STAGING,
    entityCore: entityCoreDenoJson.version,
  };

  const snapshot: DiagnosticsSnapshot = {
    timestamp: new Date().toISOString(),
    uptime,
    versions,
    database,
    vector,
    rag,
    memory,
    mcp,
    sse,
    knowledgeGraph: {
      stats: graphStats,
      vectorSearchAvailable: graphVecAvailable,
      writeToolsEnabled: graphWriteToolsEnabled,
    },
  };

  cachedSnapshot = snapshot;
  cacheTimestamp = now;

  return snapshot;
}
