/**
 * Entity Core MCP Server
 *
 * The central identity and memory system for my existence.
 * Embodiments connect to this core to sync who I am.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { FileStore } from "./storage/mod.ts";
import { GraphStore } from "./graph/mod.ts";
import { extractMemoryToGraph } from "./graph/memory-integration.ts";
import {
  createEntityExportHandler,
  createEntityImportHandler,
  createGraphEdgeCreateHandler,
  createGraphEdgeDeleteHandler,
  createGraphEdgeGetHandler,
  createGraphEdgeUpdateHandler,
  createGraphInsightsHandler,
  createGraphNodeCreateHandler,
  createGraphNodeDeleteHandler,
  createGraphNodeGetHandler,
  createGraphNodeListHandler,
  createGraphNodeSearchHandler,
  createGraphNodeUpdateHandler,
  createGraphStatsHandler,
  createGraphSubgraphHandler,
  createGraphTraverseHandler,
  createGraphWriteTransactionHandler,
  createIdentityAppendHandler,
  createIdentityDeleteCustomHandler,
  createIdentityGetAllHandler,
  createIdentityGetMetaHandler,
  createIdentityPrependHandler,
  createIdentityRewriteSectionHandler,
  createIdentitySetMetaHandler,
  createIdentityUpdateSectionHandler,
  createIdentityWriteHandler,
  createMemoryConsolidateHandler,
  createMemoryCreateHandler,
  createMemoryDeleteHandler,
  createMemoryEmbeddingPurgeHandler,
  createMemoryEmbeddingRebuildHandler,
  createMemoryGrepHandler,
  createMemoryListHandler,
  createMemoryReadHandler,
  createMemorySearchHandler,
  createMemoryUpdateHandler,
  createSnapshotCreateHandler,
  createSnapshotGetHandler,
  createSnapshotListHandler,
  createSnapshotRestoreHandler,
  createSyncPullHandler,
  createSyncPushHandler,
  createSyncStatusHandler,
  EntityImportSchema,
  graphTools,
  identityTools,
  memoryConsolidateDescription,
  MemoryConsolidateSchema,
  memoryTools,
  snapshotTools,
  syncTools,
} from "./tools/mod.ts";
import type { ServerConfig } from "./types.ts";
import { DEFAULT_SERVER_CONFIG } from "./types.ts";
import { cleanupOldSnapshots } from "./snapshot/mod.ts";
import { EmbeddingCache } from "./embeddings/mod.ts";
import {
  createEntityCorePluginManager,
  type EntityCorePluginManager,
} from "./plugins/mod.ts";

/**
 * Create and configure the MCP server.
 */
export function createServer(
  config: Partial<ServerConfig> = {},
): { server: McpServer; embeddingCache: EmbeddingCache } {
  const fullConfig: ServerConfig = { ...DEFAULT_SERVER_CONFIG, ...config };

  // Storage. Reuse the caller's instances when provided — the main
  // entry in mod.ts shares its FileStore and GraphStore so the
  // consolidation runner and the MCP tool handlers operate on the
  // same SQLite connection.
  const store = fullConfig.store ?? new FileStore(fullConfig.dataDir);
  const graphStore = fullConfig.graphStore ??
    new GraphStore(fullConfig.dataDir);

  // Initialize embedding cache (shares graph.db for sqlite-vec)
  const embeddingCache = fullConfig.embeddingCache ??
    new EmbeddingCache(fullConfig.dataDir);
  const pluginManager = fullConfig.pluginManager;

  // Create MCP server
  const server = new McpServer({
    name: "entity-core",
    version: "0.1.0",
  });

  // Register identity tools
  server.tool(
    "identity_get_all",
    identityTools["identity/get_all"].description,
    {},
    async () => {
      await store.initialize();
      const handler = createIdentityGetAllHandler(store);
      const result = await handler();
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              pluginManager
                ? await pluginManager.decorate("identity_get_all", result)
                : result,
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  server.tool(
    "identity_write",
    identityTools["identity/write"].description,
    {
      category: identityTools["identity/write"].inputSchema.shape.category,
      filename: identityTools["identity/write"].inputSchema.shape.filename,
      content: identityTools["identity/write"].inputSchema.shape.content,
      instanceId: identityTools["identity/write"].inputSchema.shape.instanceId,
    },
    async ({ category, filename, content, instanceId }) => {
      await store.initialize();
      const handler = createIdentityWriteHandler(store);
      const result = await handler({ category, filename, content, instanceId });
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              pluginManager
                ? await pluginManager.decorate("identity_write", result)
                : result,
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  server.tool(
    "identity_append",
    identityTools["identity/append"].description,
    {
      category: identityTools["identity/append"].inputSchema.shape.category,
      filename: identityTools["identity/append"].inputSchema.shape.filename,
      content: identityTools["identity/append"].inputSchema.shape.content,
      instanceId: identityTools["identity/append"].inputSchema.shape.instanceId,
    },
    async ({ category, filename, content, instanceId }) => {
      await store.initialize();
      const handler = createIdentityAppendHandler(store);
      const result = await handler({ category, filename, content, instanceId });
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              pluginManager
                ? await pluginManager.decorate("identity_append", result)
                : result,
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  server.tool(
    "identity_prepend",
    identityTools["identity/prepend"].description,
    {
      category: identityTools["identity/prepend"].inputSchema.shape.category,
      filename: identityTools["identity/prepend"].inputSchema.shape.filename,
      content: identityTools["identity/prepend"].inputSchema.shape.content,
      instanceId:
        identityTools["identity/prepend"].inputSchema.shape.instanceId,
    },
    async ({ category, filename, content, instanceId }) => {
      await store.initialize();
      const handler = createIdentityPrependHandler(store);
      const result = await handler({ category, filename, content, instanceId });
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    },
  );

  server.tool(
    "identity_update_section",
    identityTools["identity/update_section"].description,
    {
      category:
        identityTools["identity/update_section"].inputSchema.shape.category,
      filename:
        identityTools["identity/update_section"].inputSchema.shape.filename,
      section:
        identityTools["identity/update_section"].inputSchema.shape.section,
      content:
        identityTools["identity/update_section"].inputSchema.shape.content,
      instanceId:
        identityTools["identity/update_section"].inputSchema.shape.instanceId,
    },
    async ({ category, filename, section, content, instanceId }) => {
      await store.initialize();
      const handler = createIdentityUpdateSectionHandler(store);
      const result = await handler({
        category,
        filename,
        section,
        content,
        instanceId,
      });
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    },
  );

  server.tool(
    "identity_delete_custom",
    identityTools["identity/delete_custom"].description,
    {
      filename:
        identityTools["identity/delete_custom"].inputSchema.shape.filename,
    },
    async ({ filename }) => {
      await store.initialize();
      const handler = createIdentityDeleteCustomHandler(store);
      const result = await handler({ filename });
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    },
  );

  server.tool(
    "identity_rewrite_section",
    identityTools["identity/rewrite_section"].description,
    {
      category:
        identityTools["identity/rewrite_section"].inputSchema.shape.category,
      filename:
        identityTools["identity/rewrite_section"].inputSchema.shape.filename,
      section:
        identityTools["identity/rewrite_section"].inputSchema.shape.section,
      content:
        identityTools["identity/rewrite_section"].inputSchema.shape.content,
      instanceId:
        identityTools["identity/rewrite_section"].inputSchema.shape.instanceId,
    },
    async ({ category, filename, section, content, instanceId }) => {
      await store.initialize();
      const handler = createIdentityRewriteSectionHandler(store);
      const result = await handler({
        category,
        filename,
        section,
        content,
        instanceId,
      });
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    },
  );

  server.tool(
    "identity_get_meta",
    identityTools["identity/get_meta"].description,
    {
      category: identityTools["identity/get_meta"].inputSchema.shape.category,
      filename: identityTools["identity/get_meta"].inputSchema.shape.filename,
    },
    async ({ category, filename }) => {
      await store.initialize();
      const handler = createIdentityGetMetaHandler(store);
      const result = await handler({ category, filename });
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    },
  );

  server.tool(
    "identity_set_meta",
    identityTools["identity/set_meta"].description,
    {
      category: identityTools["identity/set_meta"].inputSchema.shape.category,
      filename: identityTools["identity/set_meta"].inputSchema.shape.filename,
      promptLabel:
        identityTools["identity/set_meta"].inputSchema.shape.promptLabel,
    },
    async ({ category, filename, promptLabel }) => {
      await store.initialize();
      const handler = createIdentitySetMetaHandler(store);
      const result = await handler({ category, filename, promptLabel });
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    },
  );

  // Register memory tools
  server.tool(
    "memory_create",
    memoryTools["memory/create"].description,
    {
      granularity: memoryTools["memory/create"].inputSchema.shape.granularity,
      date: memoryTools["memory/create"].inputSchema.shape.date,
      content: memoryTools["memory/create"].inputSchema.shape.content,
      chatIds: memoryTools["memory/create"].inputSchema.shape.chatIds,
      instanceId: memoryTools["memory/create"].inputSchema.shape.instanceId,
      participatingInstances:
        memoryTools["memory/create"].inputSchema.shape.participatingInstances,
      slug: memoryTools["memory/create"].inputSchema.shape.slug,
    },
    async (
      {
        granularity,
        date,
        content,
        chatIds,
        instanceId,
        participatingInstances,
        slug,
      },
    ) => {
      await store.initialize();
      await embeddingCache.initialize();
      const handler = createMemoryCreateHandler(store, embeddingCache);
      const result = await handler({
        granularity,
        date,
        content,
        chatIds: chatIds ?? [],
        instanceId,
        participatingInstances,
        slug,
      });

      // After memory is written, extract to graph (fire-and-forget)
      if (result.success) {
        extractMemoryToGraph(
          {
            id: result.memoryId!,
            granularity,
            date,
            content,
            chatIds: chatIds ?? [],
            sourceInstance: instanceId,
            participatingInstances: participatingInstances ?? [instanceId],
            version: 1,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
          graphStore,
          instanceId,
        )
          .then((extraction) => {
            if (extraction.nodesCreated > 0 || extraction.edgesCreated > 0) {
              console.error(
                `[Graph] Extracted from ${result.memoryId}: ${extraction.nodesCreated} nodes, ${extraction.edgesCreated} edges`,
              );
            }
          })
          .catch((error) => {
            console.error(
              `[Graph] Extraction failed for ${result.memoryId}:`,
              error,
            );
          });
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    },
  );

  server.tool(
    "memory_search",
    memoryTools["memory/search"].description,
    {
      query: memoryTools["memory/search"].inputSchema.shape.query,
      instanceId: memoryTools["memory/search"].inputSchema.shape.instanceId,
      queryEmbedding:
        memoryTools["memory/search"].inputSchema.shape.queryEmbedding,
      minScore: memoryTools["memory/search"].inputSchema.shape.minScore,
      maxResults: memoryTools["memory/search"].inputSchema.shape.maxResults,
    },
    async ({ query, instanceId, queryEmbedding, minScore, maxResults }) => {
      await store.initialize();
      await graphStore.initialize();
      await embeddingCache.initialize();
      const handler = createMemorySearchHandler(
        store,
        graphStore,
        embeddingCache,
        {
          instanceBoost: fullConfig.instanceBoost,
          minScore: fullConfig.ragMinScore,
          maxResults: fullConfig.ragMaxChunks,
        },
      );
      const result = await handler({
        query,
        instanceId,
        queryEmbedding,
        minScore,
        maxResults,
      });
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              pluginManager
                ? await pluginManager.decorate("memory_search", result)
                : result,
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  server.tool(
    "memory_grep",
    memoryTools["memory/grep"].description,
    {
      query: memoryTools["memory/grep"].inputSchema.shape.query,
      maxResults: memoryTools["memory/grep"].inputSchema.shape.maxResults,
    },
    async ({ query, maxResults }) => {
      await store.initialize();
      const handler = createMemoryGrepHandler(store);
      const result = await handler({ query, maxResults });
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    },
  );

  server.tool(
    "memory_list",
    memoryTools["memory/list"].description,
    {
      granularity: memoryTools["memory/list"].inputSchema.shape.granularity,
      limit: memoryTools["memory/list"].inputSchema.shape.limit,
      offset: memoryTools["memory/list"].inputSchema.shape.offset,
      beforeDate: memoryTools["memory/list"].inputSchema.shape.beforeDate,
      afterDate: memoryTools["memory/list"].inputSchema.shape.afterDate,
    },
    async ({ granularity, limit, offset, beforeDate, afterDate }) => {
      await store.initialize();
      const handler = createMemoryListHandler(store);
      const result = await handler({
        granularity,
        limit,
        offset,
        beforeDate,
        afterDate,
      });
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    },
  );

  server.tool(
    "memory_read",
    memoryTools["memory/read"].description,
    {
      granularity: memoryTools["memory/read"].inputSchema.shape.granularity,
      date: memoryTools["memory/read"].inputSchema.shape.date,
      slug: memoryTools["memory/read"].inputSchema.shape.slug,
    },
    async ({ granularity, date, slug }) => {
      await store.initialize();
      const handler = createMemoryReadHandler(store);
      const result = await handler({ granularity, date, slug });
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    },
  );

  server.tool(
    "memory_update",
    memoryTools["memory/update"].description,
    {
      granularity: memoryTools["memory/update"].inputSchema.shape.granularity,
      date: memoryTools["memory/update"].inputSchema.shape.date,
      content: memoryTools["memory/update"].inputSchema.shape.content,
      editedBy: memoryTools["memory/update"].inputSchema.shape.editedBy,
    },
    async ({ granularity, date, content, editedBy }) => {
      await store.initialize();
      await embeddingCache.initialize();
      const handler = createMemoryUpdateHandler(store, embeddingCache);
      const result = await handler({ granularity, date, content, editedBy });

      // After memory is updated, re-extract to graph (fire-and-forget)
      if (result.success) {
        extractMemoryToGraph(
          {
            id: result.memoryId!,
            granularity,
            date,
            content,
            chatIds: [],
            sourceInstance: editedBy ?? "unknown",
            participatingInstances: [],
            version: 0,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
          graphStore,
          editedBy ?? "unknown",
        )
          .then((extraction) => {
            if (extraction.nodesCreated > 0 || extraction.edgesCreated > 0) {
              console.error(
                `[Graph] Re-extracted from ${result.memoryId}: ${extraction.nodesCreated} nodes, ${extraction.edgesCreated} edges`,
              );
            }
          })
          .catch((error) => {
            console.error(
              `[Graph] Re-extraction failed for ${result.memoryId}:`,
              error,
            );
          });
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    },
  );

  server.tool(
    "memory_delete",
    memoryTools["memory/delete"].description,
    {
      granularity: memoryTools["memory/delete"].inputSchema.shape.granularity,
      date: memoryTools["memory/delete"].inputSchema.shape.date,
      instanceId: memoryTools["memory/delete"].inputSchema.shape.instanceId,
      slug: memoryTools["memory/delete"].inputSchema.shape.slug,
    },
    async ({ granularity, date, instanceId, slug }) => {
      await store.initialize();
      await embeddingCache.initialize();
      const handler = createMemoryDeleteHandler(store, embeddingCache);
      const result = await handler({ granularity, date, instanceId, slug });

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    },
  );

  // Register embedding maintenance tools
  server.tool(
    "memory_embedding_purge",
    memoryTools["memory/embedding_purge"].description,
    {},
    async () => {
      await store.initialize();
      await embeddingCache.initialize();
      const handler = createMemoryEmbeddingPurgeHandler(store, embeddingCache);
      const result = await handler();
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    },
  );

  server.tool(
    "memory_embedding_rebuild",
    memoryTools["memory/embedding_rebuild"].description,
    {},
    async () => {
      await store.initialize();
      await embeddingCache.initialize();
      const handler = createMemoryEmbeddingRebuildHandler(
        store,
        embeddingCache,
      );
      const result = await handler();
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    },
  );

  // Register sync tools
  server.tool(
    "sync_pull",
    syncTools["sync/pull"].description,
    {
      instanceId: syncTools["sync/pull"].inputSchema.shape.instanceId,
      lastSyncVersion: syncTools["sync/pull"].inputSchema.shape.lastSyncVersion,
    },
    async ({ instanceId, lastSyncVersion }) => {
      await store.initialize();
      const handler = createSyncPullHandler(store);
      const result = await handler({ instanceId, lastSyncVersion });
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    },
  );

  server.tool(
    "sync_push",
    syncTools["sync/push"].description,
    {
      instance: syncTools["sync/push"].inputSchema.shape.instance,
      identityChanges: syncTools["sync/push"].inputSchema.shape.identityChanges,
      memoryChanges: syncTools["sync/push"].inputSchema.shape.memoryChanges,
      lastSyncVersion: syncTools["sync/push"].inputSchema.shape.lastSyncVersion,
    },
    async ({ instance, identityChanges, memoryChanges, lastSyncVersion }) => {
      await store.initialize();
      const handler = createSyncPushHandler(store);
      const result = await handler({
        instance,
        identityChanges,
        memoryChanges,
        lastSyncVersion,
      });
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    },
  );

  server.tool(
    "sync_status",
    syncTools["sync/status"].description,
    {},
    async () => {
      const handler = createSyncStatusHandler();
      const result = await handler();
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    },
  );

  // Register snapshot tools
  server.tool(
    "snapshot_create",
    snapshotTools["snapshot/create"].description,
    {},
    async () => {
      await store.initialize();
      const handler = createSnapshotCreateHandler(store);
      const result = await handler();
      // Cleanup old snapshots after creation (matches sync_push behavior)
      const retentionDays = parseInt(
        Deno.env.get("ENTITY_CORE_SNAPSHOT_RETENTION_DAYS") || "30",
      );
      await cleanupOldSnapshots(store, retentionDays);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    },
  );

  server.tool(
    "snapshot_list",
    snapshotTools["snapshot/list"].description,
    {
      category: snapshotTools["snapshot/list"].inputSchema.shape.category,
      filename: snapshotTools["snapshot/list"].inputSchema.shape.filename,
    },
    async ({ category, filename }) => {
      await store.initialize();
      const handler = createSnapshotListHandler(store);
      const result = await handler({ category, filename });
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    },
  );

  server.tool(
    "snapshot_restore",
    snapshotTools["snapshot/restore"].description,
    {
      snapshotId:
        snapshotTools["snapshot/restore"].inputSchema.shape.snapshotId,
    },
    async ({ snapshotId }) => {
      await store.initialize();
      const handler = createSnapshotRestoreHandler(store);
      const result = await handler({ snapshotId });
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    },
  );

  server.tool(
    "snapshot_get",
    snapshotTools["snapshot/get"].description,
    {
      snapshotId: snapshotTools["snapshot/get"].inputSchema.shape.snapshotId,
    },
    async ({ snapshotId }) => {
      await store.initialize();
      const handler = createSnapshotGetHandler(store);
      const result = await handler({ snapshotId });
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    },
  );

  // Register consolidation tool
  server.tool(
    "memory_consolidate",
    memoryConsolidateDescription,
    {
      granularity: MemoryConsolidateSchema.shape.granularity,
      targetDate: MemoryConsolidateSchema.shape.targetDate,
      all: MemoryConsolidateSchema.shape.all,
    },
    async ({ granularity, targetDate, all }) => {
      await store.initialize();
      await graphStore.initialize();
      const handler = createMemoryConsolidateHandler(store, graphStore);
      const result = await handler({ granularity, targetDate, all });
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    },
  );

  // Register graph tools
  server.tool(
    "graph_node_create",
    graphTools["graph/node_create"].description,
    {
      type: graphTools["graph/node_create"].inputSchema.shape.type,
      label: graphTools["graph/node_create"].inputSchema.shape.label,
      description:
        graphTools["graph/node_create"].inputSchema.shape.description,
      properties: graphTools["graph/node_create"].inputSchema.shape.properties,
      instanceId: graphTools["graph/node_create"].inputSchema.shape.instanceId,
      confidence: graphTools["graph/node_create"].inputSchema.shape.confidence,
      sourceMemoryId:
        graphTools["graph/node_create"].inputSchema.shape.sourceMemoryId,
      firstLearnedAt:
        graphTools["graph/node_create"].inputSchema.shape.firstLearnedAt,
      embedding: graphTools["graph/node_create"].inputSchema.shape.embedding,
    },
    async (
      {
        type,
        label,
        description,
        properties,
        instanceId,
        confidence,
        sourceMemoryId,
        firstLearnedAt,
        embedding,
      },
    ) => {
      await graphStore.initialize();
      const handler = createGraphNodeCreateHandler(graphStore);
      const result = await handler({
        type,
        label,
        description,
        properties,
        instanceId,
        confidence,
        sourceMemoryId,
        firstLearnedAt,
        embedding,
      });
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify(result, null, 2),
        }],
      };
    },
  );

  server.tool(
    "graph_node_get",
    graphTools["graph/node_get"].description,
    {
      id: graphTools["graph/node_get"].inputSchema.shape.id,
    },
    async ({ id }) => {
      await graphStore.initialize();
      const handler = createGraphNodeGetHandler(graphStore);
      const result = await handler({ id });
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify(result, null, 2),
        }],
      };
    },
  );

  server.tool(
    "graph_node_update",
    graphTools["graph/node_update"].description,
    {
      id: graphTools["graph/node_update"].inputSchema.shape.id,
      type: graphTools["graph/node_update"].inputSchema.shape.type,
      label: graphTools["graph/node_update"].inputSchema.shape.label,
      description:
        graphTools["graph/node_update"].inputSchema.shape.description,
      properties: graphTools["graph/node_update"].inputSchema.shape.properties,
      confidence: graphTools["graph/node_update"].inputSchema.shape.confidence,
      lastConfirmedAt:
        graphTools["graph/node_update"].inputSchema.shape.lastConfirmedAt,
      instanceId: graphTools["graph/node_update"].inputSchema.shape.instanceId,
      embedding: graphTools["graph/node_update"].inputSchema.shape.embedding,
    },
    async (
      {
        id,
        type,
        label,
        description,
        properties,
        confidence,
        lastConfirmedAt,
        instanceId,
        embedding,
      },
    ) => {
      await graphStore.initialize();
      const handler = createGraphNodeUpdateHandler(graphStore);
      const result = await handler({
        id,
        type,
        label,
        description,
        properties,
        confidence,
        lastConfirmedAt,
        instanceId,
        embedding,
      });
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify(result, null, 2),
        }],
      };
    },
  );

  server.tool(
    "graph_node_delete",
    graphTools["graph/node_delete"].description,
    {
      id: graphTools["graph/node_delete"].inputSchema.shape.id,
      permanent: graphTools["graph/node_delete"].inputSchema.shape.permanent,
    },
    async ({ id, permanent }) => {
      await graphStore.initialize();
      const handler = createGraphNodeDeleteHandler(graphStore);
      const result = await handler({ id, permanent });
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify(result, null, 2),
        }],
      };
    },
  );

  server.tool(
    "graph_node_search",
    graphTools["graph/node_search"].description,
    {
      query: graphTools["graph/node_search"].inputSchema.shape.query,
      queryEmbedding:
        graphTools["graph/node_search"].inputSchema.shape.queryEmbedding,
      type: graphTools["graph/node_search"].inputSchema.shape.type,
      minScore: graphTools["graph/node_search"].inputSchema.shape.minScore,
      limit: graphTools["graph/node_search"].inputSchema.shape.limit,
    },
    async ({ query, queryEmbedding, type, minScore, limit }) => {
      await graphStore.initialize();
      try {
        const handler = createGraphNodeSearchHandler(graphStore);
        const result = await handler({
          query,
          queryEmbedding,
          type,
          minScore,
          limit,
        });
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify(result, null, 2),
          }],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error("[Graph] graph_node_search failed:", message);
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify(
              { results: [], vectorSearchUsed: false, error: message },
              null,
              2,
            ),
          }],
        };
      }
    },
  );

  server.tool(
    "graph_node_list",
    graphTools["graph/node_list"].description,
    {
      type: graphTools["graph/node_list"].inputSchema.shape.type,
      includeDeleted:
        graphTools["graph/node_list"].inputSchema.shape.includeDeleted,
      limit: graphTools["graph/node_list"].inputSchema.shape.limit,
      offset: graphTools["graph/node_list"].inputSchema.shape.offset,
    },
    async ({ type, includeDeleted, limit, offset }) => {
      await graphStore.initialize();
      const handler = createGraphNodeListHandler(graphStore);
      const result = await handler({ type, includeDeleted, limit, offset });
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify(result, null, 2),
        }],
      };
    },
  );

  server.tool(
    "graph_edge_create",
    graphTools["graph/edge_create"].description,
    {
      fromId: graphTools["graph/edge_create"].inputSchema.shape.fromId,
      toId: graphTools["graph/edge_create"].inputSchema.shape.toId,
      type: graphTools["graph/edge_create"].inputSchema.shape.type,
      properties: graphTools["graph/edge_create"].inputSchema.shape.properties,
      weight: graphTools["graph/edge_create"].inputSchema.shape.weight,
      evidence: graphTools["graph/edge_create"].inputSchema.shape.evidence,
      occurredAt: graphTools["graph/edge_create"].inputSchema.shape.occurredAt,
      validUntil: graphTools["graph/edge_create"].inputSchema.shape.validUntil,
      instanceId: graphTools["graph/edge_create"].inputSchema.shape.instanceId,
    },
    async (
      {
        fromId,
        toId,
        type,
        properties,
        weight,
        evidence,
        occurredAt,
        validUntil,
        instanceId,
      },
    ) => {
      await graphStore.initialize();
      const handler = createGraphEdgeCreateHandler(graphStore);
      const result = await handler({
        fromId,
        toId,
        type,
        properties,
        weight,
        evidence,
        occurredAt,
        validUntil,
        instanceId,
      });
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify(result, null, 2),
        }],
      };
    },
  );

  server.tool(
    "graph_edge_get",
    graphTools["graph/edge_get"].description,
    {
      id: graphTools["graph/edge_get"].inputSchema.shape.id,
      fromId: graphTools["graph/edge_get"].inputSchema.shape.fromId,
      toId: graphTools["graph/edge_get"].inputSchema.shape.toId,
      type: graphTools["graph/edge_get"].inputSchema.shape.type,
      includeDeleted:
        graphTools["graph/edge_get"].inputSchema.shape.includeDeleted,
      onlyValid: graphTools["graph/edge_get"].inputSchema.shape.onlyValid,
    },
    async ({ id, fromId, toId, type, includeDeleted, onlyValid }) => {
      await graphStore.initialize();
      const handler = createGraphEdgeGetHandler(graphStore);
      const result = await handler({
        id,
        fromId,
        toId,
        type,
        includeDeleted,
        onlyValid,
      });
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify(result, null, 2),
        }],
      };
    },
  );

  server.tool(
    "graph_edge_update",
    graphTools["graph/edge_update"].description,
    {
      id: graphTools["graph/edge_update"].inputSchema.shape.id,
      type: graphTools["graph/edge_update"].inputSchema.shape.type,
      properties: graphTools["graph/edge_update"].inputSchema.shape.properties,
      weight: graphTools["graph/edge_update"].inputSchema.shape.weight,
      evidence: graphTools["graph/edge_update"].inputSchema.shape.evidence,
      validUntil: graphTools["graph/edge_update"].inputSchema.shape.validUntil,
      lastConfirmedAt:
        graphTools["graph/edge_update"].inputSchema.shape.lastConfirmedAt,
      instanceId: graphTools["graph/edge_update"].inputSchema.shape.instanceId,
    },
    async (
      {
        id,
        type,
        properties,
        weight,
        evidence,
        validUntil,
        lastConfirmedAt,
        instanceId,
      },
    ) => {
      await graphStore.initialize();
      const handler = createGraphEdgeUpdateHandler(graphStore);
      const result = await handler({
        id,
        type,
        properties,
        weight,
        evidence,
        validUntil,
        lastConfirmedAt,
        instanceId,
      });
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify(result, null, 2),
        }],
      };
    },
  );

  server.tool(
    "graph_edge_delete",
    graphTools["graph/edge_delete"].description,
    {
      id: graphTools["graph/edge_delete"].inputSchema.shape.id,
    },
    async ({ id }) => {
      await graphStore.initialize();
      const handler = createGraphEdgeDeleteHandler(graphStore);
      const result = await handler({ id });
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify(result, null, 2),
        }],
      };
    },
  );

  server.tool(
    "graph_traverse",
    graphTools["graph/traverse"].description,
    {
      startNodeId: graphTools["graph/traverse"].inputSchema.shape.startNodeId,
      direction: graphTools["graph/traverse"].inputSchema.shape.direction,
      maxDepth: graphTools["graph/traverse"].inputSchema.shape.maxDepth,
      edgeTypes: graphTools["graph/traverse"].inputSchema.shape.edgeTypes,
      limit: graphTools["graph/traverse"].inputSchema.shape.limit,
    },
    async ({ startNodeId, direction, maxDepth, edgeTypes, limit }) => {
      await graphStore.initialize();
      const handler = createGraphTraverseHandler(graphStore);
      const result = await handler({
        startNodeId,
        direction,
        maxDepth,
        edgeTypes,
        limit,
      });
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify(result, null, 2),
        }],
      };
    },
  );

  server.tool(
    "graph_subgraph",
    graphTools["graph/subgraph"].description,
    {
      nodeId: graphTools["graph/subgraph"].inputSchema.shape.nodeId,
      depth: graphTools["graph/subgraph"].inputSchema.shape.depth,
    },
    async ({ nodeId, depth }) => {
      await graphStore.initialize();
      const handler = createGraphSubgraphHandler(graphStore);
      const result = await handler({ nodeId, depth });
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify(result, null, 2),
        }],
      };
    },
  );

  server.tool(
    "graph_insights",
    graphTools["graph/insights"].description,
    {},
    async () => {
      await graphStore.initialize();
      const handler = createGraphInsightsHandler(graphStore);
      const result = await handler({});
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify(result, null, 2),
        }],
      };
    },
  );

  server.tool(
    "graph_stats",
    graphTools["graph/stats"].description,
    {},
    async () => {
      await graphStore.initialize();
      const handler = createGraphStatsHandler(graphStore);
      const result = await handler({});
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify(result, null, 2),
        }],
      };
    },
  );

  server.tool(
    "graph_write_transaction",
    graphTools["graph/write_transaction"].description,
    {
      nodes: graphTools["graph/write_transaction"].inputSchema.shape.nodes,
      edges: graphTools["graph/write_transaction"].inputSchema.shape.edges,
      instanceId:
        graphTools["graph/write_transaction"].inputSchema.shape.instanceId,
    },
    async ({ nodes, edges, instanceId }) => {
      await graphStore.initialize();
      const handler = createGraphWriteTransactionHandler(graphStore);
      const result = await handler({ nodes, edges, instanceId });
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify(result, null, 2),
        }],
      };
    },
  );

  // Register export/import tools
  server.tool(
    "entity_export",
    "Export all my identity, memories, and knowledge graph as a zip file. I use this to create a complete backup of my core data.",
    {},
    async () => {
      await store.initialize();
      await graphStore.initialize();
      const handler = createEntityExportHandler(store, graphStore);
      const result = await handler({});
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify(result, null, 2),
        }],
      };
    },
  );

  server.tool(
    "entity_import",
    "Import identity, memories, and knowledge graph from a previously exported zip file. Performs a full overwrite. I use this to restore from a backup.",
    {
      data: EntityImportSchema.shape.data,
      mode: EntityImportSchema.shape.mode,
    },
    async ({ data, mode }) => {
      await store.initialize();
      await graphStore.initialize();
      const handler = createEntityImportHandler(
        store,
        graphStore,
        embeddingCache,
      );
      const result = await handler({ data, mode });

      // After import, graphStore may have been closed and reinitialized
      // (graph.db replaced on disk). Update the consolidation runner's
      // DB handle so it doesn't keep using the stale (closed) connection.
      if (fullConfig.consolidationRunner) {
        fullConfig.consolidationRunner.replaceDatabase(graphStore.getRawDb());
      }

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify(result, null, 2),
        }],
      };
    },
  );

  server.tool(
    "plugin_status",
    "I use this to inspect the trusted local extensions available to my core.",
    {},
    () => ({
      content: [{
        type: "text" as const,
        text: JSON.stringify(pluginManager?.getStatuses() ?? [], null, 2),
      }],
    }),
  );

  pluginManager?.registerTools(server);

  return { server, embeddingCache };
}

/**
 * Start the MCP server.
 */
export async function startServer(
  config: Partial<ServerConfig> = {},
): Promise<void> {
  const fullConfig: ServerConfig = { ...DEFAULT_SERVER_CONFIG, ...config };
  let pluginManager: EntityCorePluginManager | undefined =
    fullConfig.pluginManager;
  const store = fullConfig.store ?? new FileStore(fullConfig.dataDir);
  const graphStore = fullConfig.graphStore ??
    new GraphStore(fullConfig.dataDir);
  const embeddingCache = fullConfig.embeddingCache ??
    new EmbeddingCache(fullConfig.dataDir);

  if (!pluginManager) {
    pluginManager = createEntityCorePluginManager(
      Deno.env.get("PSYCHEROS_PLUGIN_DIR") ??
        `${fullConfig.dataDir}/../.psycheros/plugins`,
      {
        dataDir: fullConfig.dataDir,
        store,
        graphStore,
        embeddingCache,
        log: (...args) => console.error("[Plugins]", ...args),
      },
    );
    await pluginManager.load();
  }

  const { server } = createServer({
    ...config,
    store,
    graphStore,
    embeddingCache,
    pluginManager,
  });
  const transport = new StdioServerTransport();
  transport.onclose = () => {
    void pluginManager?.stop();
  };

  // Connect the transport first so the MCP handshake completes before any
  // potentially slow startup work (e.g. embedding rebuilds). Otherwise the
  // 60-second handshake timeout fires and the embodiment disconnects.
  await server.connect(transport);

  console.error("Entity Core MCP server started");
  console.error(
    "I am ready to sync my identity and memories with my embodiments.",
  );

  // Auto-rebuild embeddings if schema version changed (e.g., date enrichment
  // added). Uses the server's EmbeddingCache so there's a single connection
  // touching the vec table during rebuild — no concurrent-writes race.
  await autoRebuildEmbeddings(fullConfig, embeddingCache);
}

/**
 * Check if cached embeddings need rebuilding (schema version mismatch)
 * and run a full rebuild if so. No-op when embeddings are up-to-date.
 *
 * Uses the server's shared EmbeddingCache to avoid a second connection
 * racing against tool calls during startup.
 */
async function autoRebuildEmbeddings(
  config: ServerConfig,
  cache: EmbeddingCache,
): Promise<void> {
  await cache.initialize();

  if (!cache.needsRebuild()) return;

  const stats = cache.getStats();
  if (stats.totalCached === 0) {
    // Nothing cached — nothing to rebuild, just mark version
    cache.markSchemaUpToDate();
    return;
  }

  console.error(
    `[Embeddings] Schema version changed — rebuilding ${stats.totalCached} memory embeddings...`,
  );

  const store = config.store ?? new FileStore(config.dataDir);
  await store.initialize();

  const handler = createMemoryEmbeddingRebuildHandler(store, cache);
  const result = await handler();

  console.error(
    `[Embeddings] Rebuild complete: ${result.rebuilt} rebuilt, ${result.failed} failed`,
  );

  // Mark schema version as current so we don't rebuild on next startup
  cache.markSchemaUpToDate();
}
