/**
 * Route Handlers
 *
 * HTTP route handlers for the Psycheros server. Handles serving the web UI,
 * API endpoints for conversation management, and SSE streaming for
 * chat responses.
 *
 * @module
 */

import type { SSEEvent, TurnMetrics } from "../types.ts";
import type { DBClient } from "../db/mod.ts";
import type {
  LLMClient,
  LLMConnectionProfile,
  LLMProfileSettings,
  LLMSettings,
} from "../llm/mod.ts";
import type { WebSearchSettings } from "../llm/mod.ts";
import type {
  ButtplugSettings,
  DiscordGatewayConfig,
  DiscordSettings,
  HomeSettings,
  LovenseSettings,
} from "../llm/mod.ts";
import { dispatchDeviceControl } from "../tools/control-device.ts";
import type {
  EntityCoreLLMSettings,
  ImageGenConfig,
  ImageGenSettings,
} from "../llm/mod.ts";
import {
  createDefaultProfile,
  getDefaultDiscordSettings,
  getDefaultImageGenSettings,
  getDefaultWebSearchSettings,
  maskDiscordSettings,
  maskImageGenSettings,
  maskProfileSettings,
  maskWebSearchSettings,
} from "../llm/mod.ts";
import { getActiveProfile } from "../llm/settings.ts";
import {
  loadMemorySettings,
  saveMemorySettings,
} from "../memory/memory-settings.ts";
import { join } from "@std/path";
import { captionImageDual } from "../tools/describe-image.ts";
import {
  getMediaType as getImageMediaType,
  uint8ToBase64,
} from "../tools/generate-image.ts";
import type { ToolRegistry } from "../tools/mod.ts";
import type { ToolsSettings } from "../tools/mod.ts";
import {
  AVAILABLE_TOOLS,
  loadCustomTools,
  TOOL_CATEGORIES,
} from "../tools/mod.ts";
import type { RAGConfig } from "../rag/mod.ts";
import type { ConversationRAG } from "../rag/conversation.ts";
import type { MCPClient } from "../mcp-client/mod.ts";
import { IdentityFileManager } from "../tools/identity-helpers.ts";
import type { LorebookManager } from "../lorebook/mod.ts";
import type { VaultManager } from "../vault/mod.ts";
import {
  EntityTurn,
  type EntityYield,
  generateAndSetTitle,
} from "../entity/mod.ts";
import { createSSEEncoder, createSSEResponse } from "./sse.ts";
import {
  type EntityCoreOverviewData,
  escapeHtml,
  type GeneralSettings,
  type MetricsMap,
  renderAppShell,
  renderButtplugSettings,
  renderChatView,
  renderConnectionsDiscordSettings,
  renderConnectionsSettings,
  renderConsolidationComplete,
  renderConsolidationRunning,
  renderConsolidationTab,
  renderConversationItem,
  renderConversationList,
  renderCorePromptsSettings,
  // renderECConsolidationComplete, // removed — consolidation runs automatically on startup
  // renderECConsolidationRunning,
  renderECEmbeddingPurgeComplete,
  renderECEmbeddingPurgeRunning,
  renderECEmbeddingRebuildComplete,
  renderECEmbeddingRebuildRunning,
  renderEntityCoreGraph,
  renderEntityCoreHub,
  renderEntityCoreLLM,
  renderEntityCoreMaintenance,
  renderEntityCoreOverview,
  renderEntityCoreSnapshotPreview,
  renderEntityCoreSnapshots,
  renderEntryEditor,
  renderFileEditor,
  renderFileList,
  renderGeneralSettings,
  renderHomeSettings,
  renderImageGenSlotSettings,
  renderInstructionsTab,
  renderLLMProfileEdit,
  renderLLMProfileHub,
  renderLorebookDetailView,
  renderLorebooksView,
  renderLovenseSettings,
  renderMemoriesView,
  renderMemoryEditor,
  renderMemoryList,
  renderMemorySearchResults,
  renderMessages,
  renderSASettings,
  renderSaveError,
  renderSaveSuccess,
  renderSettingsHub,
  renderSnapshotPreview,
  renderSnapshotsView,
  renderToolsSettings,
  renderVisionAnchorsTab,
  renderVisionGalleryTab,
  renderVisionGeneratorsTab,
  renderVisionSettings,
} from "./templates.ts";
import {
  deleteConversation,
  deleteConversations,
  updateConversationTitle,
  updateMessageContent,
} from "./state-changes.ts";
import { generateUIUpdates, renderAsOobSwaps } from "./ui-updates.ts";
import { MAX_SSE_MESSAGE_SIZE, SSE_TRUNCATION_SUFFIX } from "../constants.ts";
import { getBroadcaster } from "./broadcaster.ts";
import {
  deleteSubscription as deletePushSubscription,
  loadOrGenerateKeys,
  saveSubscription,
} from "../push/mod.ts";
import { renderMarkdown } from "./markdown.ts";
import {
  FLAVOR_LABEL,
  IS_PRERELEASE,
  IS_STAGING,
  VERSION,
  VERSION_BASE,
  VERSION_SUFFIX,
} from "../version.ts";
import { getServerStartTime } from "./diagnostics.ts";
import entityCoreDenoJson from "../../../entity-core/deno.json" with {
  type: "json",
};

/**
 * Context passed to route handlers containing dependencies.
 */
export interface RouteContext {
  /** Database client for persistence */
  db: DBClient;
  /** LLM client for chat completions */
  llm: LLMClient;
  /** Tool registry getter for tool execution */
  tools: () => ToolRegistry;
  /**
   * Source root — used for serving static web/ assets, source-relative
   * reads, templates, etc.
   */
  projectRoot: string;
  /**
   * Data root — where user-mutable runtime state lives (.psycheros/,
   * identity/, .snapshots/, memories/, custom-tools/, backgrounds/).
   * Equal to projectRoot when PSYCHEROS_DATA_DIR is unset.
   */
  dataRoot: string;
  /** Pulse engine for autonomous entity prompts */
  pulseEngine?: import("../pulse/mod.ts").PulseEngine;
  /** Durable scheduler — schedules and job_runs. */
  scheduler?: import("../scheduler/mod.ts").Scheduler;
  /** Optional chat RAG for searching conversation history */
  chatRAG?: ConversationRAG;
  /** RAG configuration */
  ragConfig?: Partial<RAGConfig>;
  /** Whether memory summarization is enabled */
  memoryEnabled?: boolean;
  /** Optional MCP client for syncing with entity-core */
  mcpClient?: MCPClient;
  /** Optional lorebook manager for world info */
  lorebookManager?: LorebookManager;
  /** Optional vault manager for document storage */
  vaultManager?: VaultManager;
  /** Get current LLM settings (derived from active profile) */
  getLLMSettings: () => LLMSettings;
  /** Update LLM settings and hot-reload */
  updateLLMSettings: (settings: LLMSettings) => Promise<void>;
  /** Get current LLM profile settings (all profiles + active ID) */
  getLLMProfileSettings: () => import("../llm/mod.ts").LLMProfileSettings;
  /** Update LLM profile settings and hot-reload */
  updateLLMProfileSettings: (
    settings: import("../llm/mod.ts").LLMProfileSettings,
  ) => Promise<void>;
  /** Get the currently active LLM connection profile */
  getActiveLLMProfile: () =>
    | import("../llm/mod.ts").LLMConnectionProfile
    | null;
  /** Set the active LLM profile by ID */
  setActiveProfile: (profileId: string) => Promise<void>;
  /** Get current web search settings */
  getWebSearchSettings: () => WebSearchSettings;
  /** Update web search settings and hot-reload tool registry */
  updateWebSearchSettings: (settings: WebSearchSettings) => Promise<void>;
  /** Get current Discord settings */
  getDiscordSettings: () => DiscordSettings;
  /** Update Discord settings and hot-reload tool registry */
  updateDiscordSettings: (settings: DiscordSettings) => Promise<void>;
  /** Get current Discord gateway configuration */
  getDiscordGatewayConfig: () => DiscordGatewayConfig;
  /** Update Discord gateway configuration */
  updateDiscordGatewayConfig: (config: DiscordGatewayConfig) => Promise<void>;
  /** Get the Discord gateway client (for status checks) */
  getDiscordGateway: () =>
    | import("../discord/gateway.ts").DiscordGatewayClient
    | null;
  /** Get the Discord conversation mapper (for DM queue) */
  getDiscordConversationMapper: () =>
    | import("../discord/conversation-map.ts").ConversationMapper
    | null;
  /** Restart the Discord gateway connection */
  restartDiscordGateway: () => Promise<void>;
  /** Get current Home settings */
  getHomeSettings: () => HomeSettings;
  /** Update Home settings and hot-reload tool registry */
  updateHomeSettings: (settings: HomeSettings) => Promise<void>;
  /** Get current Lovense settings */
  getLovenseSettings: () => LovenseSettings;
  /** Update Lovense settings and hot-reload tool registry */
  updateLovenseSettings: (settings: LovenseSettings) => Promise<void>;
  /** Get current Buttplug settings */
  getButtplugSettings: () => ButtplugSettings;
  /** Update Buttplug settings and hot-reload tool registry */
  updateButtplugSettings: (settings: ButtplugSettings) => Promise<void>;
  /** Get current image gen settings */
  getImageGenSettings: () => ImageGenSettings;
  /** Update image gen settings and hot-reload tool registry */
  updateImageGenSettings: (settings: ImageGenSettings) => Promise<void>;
  /** Get current tools settings */
  getToolSettings: () => ToolsSettings;
  /** Update tools settings and hot-reload tool registry */
  updateToolSettings: (settings: ToolsSettings) => Promise<void>;
  /** Get current entity-core LLM settings */
  getEntityCoreLLMSettings: () => EntityCoreLLMSettings;
  /** Update entity-core LLM settings and restart MCP client */
  updateEntityCoreLLMSettings: (
    settings: EntityCoreLLMSettings,
  ) => Promise<void>;
  /** Get the device status cache for the SA system */
  getDeviceStatusCache: () => import("./device-cache.ts").DeviceStatusCache;
  /** Custom tools loaded from custom-tools/ directory */
  customTools: Record<string, import("../tools/types.ts").Tool>;
}

/**
 * MIME type mapping for static file serving.
 */
const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".eot": "application/vnd.ms-fontobject",
};

/**
 * Allowed image MIME types for background uploads.
 */
const ALLOWED_IMAGE_TYPES = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
];

/**
 * Maximum file size for background uploads (5MB).
 */
const MAX_BACKGROUND_SIZE = 5 * 1024 * 1024;

/**
 * Get MIME type for a file path.
 *
 * @param path - File path
 * @returns MIME type string
 */
function getMimeType(path: string): string {
  const ext = path.substring(path.lastIndexOf(".")).toLowerCase();
  return MIME_TYPES[ext] || "application/octet-stream";
}

/**
 * Determine if the client expects an HTML response.
 *
 * Checks in order:
 * 1. HX-Request header (HTMX clients)
 * 2. Accept header preferring text/html
 *
 * This allows non-HTMX clients to explicitly request HTML via Accept header.
 *
 * @param request - The HTTP request
 * @returns true if HTML response is preferred
 */
function prefersHtml(request: Request): boolean {
  // HTMX always sends this header
  if (request.headers.get("HX-Request") === "true") {
    return true;
  }

  // Check Accept header for HTML preference
  const accept = request.headers.get("Accept") || "";
  // Simple check: if text/html appears before application/json, prefer HTML
  const htmlIndex = accept.indexOf("text/html");
  const jsonIndex = accept.indexOf("application/json");

  if (htmlIndex !== -1 && (jsonIndex === -1 || htmlIndex < jsonIndex)) {
    return true;
  }

  return false;
}

/**
 * Normalize a file path by resolving "..", ".", and collapsing multiple slashes.
 *
 * This is critical for preventing path traversal attacks.
 *
 * @param path - The path to normalize
 * @returns The normalized path
 */
function normalizePath(path: string): string {
  // Split path into segments
  const segments = path.split("/");
  const result: string[] = [];

  for (const segment of segments) {
    if (segment === "..") {
      // Go up one directory (but don't go above root)
      if (result.length > 0 && result[result.length - 1] !== "") {
        result.pop();
      }
    } else if (segment !== "." && segment !== "") {
      // Skip "." and empty segments (from "//")
      result.push(segment);
    }
  }

  // Reconstruct the path, preserving leading slash for absolute paths
  const normalized = (path.startsWith("/") ? "/" : "") + result.join("/");
  return normalized || "/";
}

/**
 * Handle GET / - Serve the web UI
 *
 * Renders the app shell using server-side templates.
 *
 * @param _ctx - Route context (unused, kept for consistency)
 * @returns HTTP Response with the app shell HTML
 */
export function handleIndex(_ctx: RouteContext): Response {
  const html = renderAppShell();
  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
    },
  });
}

/**
 * Handle GET /api/conversations - List conversations
 *
 * Returns all conversations as JSON, ordered by most recently updated.
 * For HTML partial, use /fragments/conv-list instead.
 *
 * @param ctx - Route context
 * @returns HTTP Response with JSON array of conversations
 */
export function handleListConversations(ctx: RouteContext): Response {
  const conversations = ctx.db.listWebConversations();

  return new Response(JSON.stringify(conversations), {
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

/**
 * Handle POST /api/conversations - Create new conversation
 *
 * Creates a new conversation with an optional title from the request body.
 * Returns HTML when HX-Request header is present, JSON otherwise.
 *
 * @param ctx - Route context
 * @param request - HTTP Request (body may contain { title?: string })
 * @returns HTTP Response with the created conversation
 */
export async function handleCreateConversation(
  ctx: RouteContext,
  request: Request,
): Promise<Response> {
  let title: string | undefined;

  // Try to parse body for optional title
  try {
    const body = await request.json();
    if (body && typeof body.title === "string") {
      title = body.title;
    }
  } catch {
    // No body or invalid JSON - that's fine, title is optional
  }

  const conversation = ctx.db.createConversation(title);

  // Return HTML for HTMX requests or clients preferring HTML
  if (prefersHtml(request)) {
    const html = renderConversationItem(conversation, true);
    return new Response(html, {
      status: 201,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Access-Control-Allow-Origin": "*",
      },
    });
  }

  return new Response(JSON.stringify(conversation), {
    status: 201,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

/**
 * Handle GET /c/:id - Get conversation page
 *
 * Always returns the full app shell. The frontend JavaScript
 * detects the URL and loads the conversation content via the
 * fragment endpoint.
 *
 * @param ctx - Route context
 * @param conversationId - The conversation ID
 * @returns HTTP Response with full app shell HTML
 */
export function handleConversationView(
  ctx: RouteContext,
  conversationId: string,
): Response {
  // Check if conversation exists
  const conversation = ctx.db.getConversation(conversationId);
  if (!conversation) {
    return new Response("Conversation not found", {
      status: 404,
      headers: { "Content-Type": "text/plain" },
    });
  }

  // Always return the full app shell
  // Frontend JS will load the conversation content via /fragments/chat/:id
  const html = renderAppShell();
  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
    },
  });
}

// =============================================================================
// Fragment Routes (HTML partials for HTMX)
// =============================================================================

/**
 * Handle GET /fragments/chat/:id - Get chat view fragment
 *
 * Returns just the chat HTML partial (messages + input area).
 * Used by HTMX for in-app navigation and by JS for initial load.
 * Includes an out-of-band swap for the header title.
 *
 * @param ctx - Route context
 * @param conversationId - The conversation ID
 * @returns HTTP Response with chat HTML fragment
 */
export async function handleChatFragment(
  ctx: RouteContext,
  conversationId: string,
): Promise<Response> {
  // Check if conversation exists
  const conversation = ctx.db.getConversation(conversationId);
  if (!conversation) {
    return new Response("Conversation not found", {
      status: 404,
      headers: { "Content-Type": "text/plain" },
    });
  }

  const { messages, hasMore } = ctx.db.getMessagesPaginated(conversationId, {
    limit: 50,
  });

  // Build metrics map for assistant messages
  const metricsMap: MetricsMap = new Map();
  for (const msg of messages) {
    if (msg.role === "assistant") {
      const metrics = ctx.db.getMetricsByMessageId(msg.id);
      if (metrics) {
        metricsMap.set(msg.id, metrics);
      }
    }
  }

  const displayNames = await loadGeneralSettings(ctx.dataRoot);
  const chatHtml = renderChatView(messages, metricsMap, displayNames, hasMore);

  // Generate OOB swaps for header title using unified helper
  const uiUpdates = generateUIUpdates(["header-title"], ctx.db, conversationId);
  const oobHtml = renderAsOobSwaps(uiUpdates);

  return new Response(chatHtml + oobHtml, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
    },
  });
}

/**
 * Handle GET /api/conversations/:id/messages/paginated - Paginated messages
 *
 * Query params:
 *   before   - ISO timestamp; fetch messages older than this (exclusive)
 *   beforeId - Message ID tiebreaker for duplicate timestamps
 *   limit    - number of messages (default 50, max 100)
 *
 * Returns JSON: { html: string, hasMore: boolean, oldestCreatedAt: string | null, oldestId: string | null }
 */
export async function handleMessagesPaginated(
  ctx: RouteContext,
  conversationId: string,
  before?: string,
  beforeId?: string,
  limit?: number,
): Promise<Response> {
  const conversation = ctx.db.getConversation(conversationId);
  if (!conversation) {
    return new Response("Not found", { status: 404 });
  }

  const clampedLimit = Math.min(Math.max(limit ?? 50, 1), 100);
  const result = ctx.db.getMessagesPaginated(conversationId, {
    before,
    beforeId,
    limit: clampedLimit,
  });

  // Build metrics map for assistant messages in this batch
  const metricsMap: MetricsMap = new Map();
  for (const msg of result.messages) {
    if (msg.role === "assistant") {
      const metrics = ctx.db.getMetricsByMessageId(msg.id);
      if (metrics) metricsMap.set(msg.id, metrics);
    }
  }

  const displayNames = await loadGeneralSettings(ctx.dataRoot);
  const html = renderMessages(result.messages, metricsMap, displayNames);

  // Get the timestamp and id of the oldest message in this batch for the next cursor
  const oldestCreatedAt = result.messages.length > 0
    ? result.messages[0].createdAt.toISOString()
    : null;
  const oldestId = result.messages.length > 0 ? result.messages[0].id : null;

  return new Response(
    JSON.stringify({
      html,
      hasMore: result.hasMore,
      oldestCreatedAt,
      oldestId,
    }),
    {
      headers: { "Content-Type": "application/json" },
    },
  );
}

/**
 * Handle GET /fragments/conv-list - Get conversation list fragment
 *
 * Returns just the conversation list HTML partial.
 * Used by HTMX for sidebar updates.
 *
 * @param ctx - Route context
 * @returns HTTP Response with conversation list HTML fragment
 */
export function handleConversationListFragment(ctx: RouteContext): Response {
  const conversations = ctx.db.listWebConversations();

  // Build set of conversation IDs that have active pulses
  const allPulses = ctx.db.listPulses({ enabled: true });
  const pulseConversationIds = new Set<string>();
  for (const pulse of allPulses) {
    if (pulse.conversationId) {
      pulseConversationIds.add(pulse.conversationId);
    }
  }

  const html = renderConversationList(conversations, pulseConversationIds);

  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
    },
  });
}

/**
 * Handle GET /api/conversations/:id/messages - Get messages
 *
 * Returns all messages for a specific conversation.
 *
 * @param ctx - Route context
 * @param conversationId - The conversation ID
 * @returns HTTP Response with JSON array of messages
 */
export function handleGetMessages(
  ctx: RouteContext,
  conversationId: string,
): Response {
  // Check if conversation exists
  const conversation = ctx.db.getConversation(conversationId);
  if (!conversation) {
    return new Response(
      JSON.stringify({ error: "Conversation not found" }),
      {
        status: 404,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      },
    );
  }

  const messages = ctx.db.getMessages(conversationId);

  return new Response(JSON.stringify(messages), {
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

/**
 * Handle GET /api/conversations/:id/context - Get context snapshots
 *
 * Returns all persisted context snapshots for a conversation,
 * or just the latest if latest=true.
 *
 * @param ctx - Route context
 * @param conversationId - The conversation ID
 * @param latest - If true, return only the most recent snapshot
 * @returns HTTP Response with snapshot data
 */
export function handleGetContextSnapshots(
  ctx: RouteContext,
  conversationId: string,
  latest: boolean,
): Response {
  if (latest) {
    const snapshot = ctx.db.getLatestContextSnapshot(conversationId);
    if (!snapshot) {
      return new Response(null, {
        status: 204,
        headers: { "Access-Control-Allow-Origin": "*" },
      });
    }
    return new Response(JSON.stringify(snapshot), {
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    });
  }

  const snapshots = ctx.db.getContextSnapshots(conversationId);
  return new Response(JSON.stringify(snapshots), {
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

/**
 * Handle PUT /api/messages/:id - Update message content
 *
 * Updates a message's content, regenerates embedding, and returns updated HTML.
 *
 * @param ctx - Route context
 * @param messageId - The message ID
 * @param request - HTTP Request with body { content: string, conversationId: string }
 * @returns HTTP Response with updated message HTML for HTMX swap
 */
export async function handleUpdateMessage(
  ctx: RouteContext,
  messageId: string,
  request: Request,
): Promise<Response> {
  // Parse request body
  let content: string;
  let conversationId: string;
  try {
    const body = await request.json();
    if (!body.content || typeof body.content !== "string") {
      throw new Error("Missing or invalid content");
    }
    if (!body.conversationId || typeof body.conversationId !== "string") {
      throw new Error("Missing or invalid conversationId");
    }
    content = body.content;
    conversationId = body.conversationId;
  } catch (error) {
    console.error("[Routes] handleUpdateMessage parse error:", error);
    return new Response(
      JSON.stringify({ error: "Invalid request body" }),
      {
        status: 400,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      },
    );
  }

  // Perform the state change
  const result = updateMessageContent(
    ctx.db,
    conversationId,
    messageId,
    content,
  );

  if (!result.success) {
    return new Response(
      JSON.stringify({ error: result.error }),
      {
        status: result.error?.includes("not found") ? 404 : 400,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      },
    );
  }

  // Get the updated message
  const messages = ctx.db.getMessages(conversationId);
  const updatedMsg = messages.find((m) => m.id === messageId);

  if (!updatedMsg) {
    return new Response(
      JSON.stringify({ error: "Updated message not found" }),
      {
        status: 404,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      },
    );
  }

  // Regenerate embedding in RAG (non-blocking)
  if (
    ctx.chatRAG &&
    (updatedMsg.role === "user" || updatedMsg.role === "assistant")
  ) {
    ctx.chatRAG.updateMessageEmbedding(
      messageId,
      conversationId,
      updatedMsg.role,
      updatedMsg.content,
    ).catch((error) => {
      console.error(
        `[Routes] Failed to update embedding for message ${messageId}:`,
        error instanceof Error ? error.message : String(error),
      );
    });
  }

  // Get metrics for assistant messages
  let metrics: TurnMetrics | undefined = undefined;
  if (updatedMsg.role === "assistant") {
    const dbMetrics = ctx.db.getMetricsByMessageId(messageId);
    metrics = dbMetrics ?? undefined;
  }

  // Render updated message HTML for HTMX swap
  const { renderMessage } = await import("./templates.ts");
  const displayNames = await loadGeneralSettings(ctx.dataRoot);
  const html = renderMessage(updatedMsg, metrics, displayNames);

  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

/**
 * Handle PATCH /api/conversations/:id/title - Update conversation title
 *
 * Updates the title and returns OOB swaps for reactive UI updates.
 * Uses the unified state change pattern.
 *
 * @param ctx - Route context
 * @param conversationId - The conversation ID
 * @param request - HTTP Request with body { title: string }
 * @returns HTTP Response with OOB swap HTML for HTMX, or JSON for non-HTMX
 */
export async function handleUpdateTitle(
  ctx: RouteContext,
  conversationId: string,
  request: Request,
): Promise<Response> {
  // Parse request body
  let title: string;
  try {
    const body = await request.json();
    if (!body.title || typeof body.title !== "string") {
      throw new Error("Missing or invalid title");
    }
    title = body.title;
  } catch (error) {
    console.error("[Routes] handleUpdateTitle parse error:", error);
    return new Response(
      JSON.stringify({ error: "Invalid request body" }),
      {
        status: 400,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      },
    );
  }

  // Use the unified state change function
  const result = updateConversationTitle(ctx.db, conversationId, title);

  if (!result.success) {
    return new Response(
      JSON.stringify({ error: result.error }),
      {
        status: result.error?.includes("not found") ? 404 : 400,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      },
    );
  }

  // For HTMX requests or clients preferring HTML, return OOB swaps
  if (prefersHtml(request)) {
    const uiUpdates = generateUIUpdates(
      result.affectedRegions,
      ctx.db,
      conversationId,
    );
    const oobHtml = renderAsOobSwaps(uiUpdates);

    return new Response(oobHtml, {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Access-Control-Allow-Origin": "*",
      },
    });
  }

  // For regular requests, return JSON
  return new Response(
    JSON.stringify({ success: true, title: result.data?.title }),
    {
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    },
  );
}

/**
 * Handle DELETE /api/conversations/:id - Delete a single conversation
 *
 * Deletes the conversation and broadcasts UI update via SSE.
 *
 * @param ctx - Route context
 * @param conversationId - The conversation ID to delete
 * @param _request - HTTP Request (unused)
 * @returns HTTP Response with JSON result
 */
export function handleDeleteConversation(
  ctx: RouteContext,
  conversationId: string,
  _request: Request,
): Response {
  const result = deleteConversation(ctx.db, conversationId);

  if (!result.success) {
    return new Response(
      JSON.stringify({ error: result.error }),
      {
        status: result.error?.includes("not found") ? 404 : 400,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      },
    );
  }

  // Broadcast UI update via SSE to all clients
  const uiUpdates = generateUIUpdates(result.affectedRegions, ctx.db);
  getBroadcaster().broadcastUpdates(uiUpdates, null); // null = broadcast to all

  return new Response(
    JSON.stringify({ success: true, deletedId: result.data?.deletedId }),
    {
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    },
  );
}

/**
 * Handle POST /api/conversations/:id/clear-context
 *
 * Inserts a system divider message marking the context boundary.
 * Does NOT delete messages — they remain visible as scrollable history.
 */
export async function handleClearConversationContext(
  ctx: RouteContext,
  conversationId: string,
): Promise<Response> {
  try {
    const conv = ctx.db.getConversation(conversationId);
    if (!conv) {
      return new Response(JSON.stringify({ error: "Conversation not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }

    const timestamp = new Date().toLocaleString();
    const content =
      `Context cleared at ${timestamp}. Messages above this line are not in the entity's context window.`;
    ctx.db.insertSystemMessage(conversationId, content);

    return new Response(JSON.stringify({ success: true }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("[Routes] handleClearConversationContext error:", error);
    return new Response(JSON.stringify({ error: "Failed to clear context" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}

/**
 * Handle DELETE /api/conversations - Delete multiple conversations
 *
 * Expects body: { ids: string[] }
 * Deletes the conversations and broadcasts UI update via SSE.
 *
 * @param ctx - Route context
 * @param request - HTTP Request with body { ids: string[] }
 * @returns HTTP Response with JSON result
 */
export async function handleBatchDeleteConversations(
  ctx: RouteContext,
  request: Request,
): Promise<Response> {
  // Parse request body
  let ids: string[];
  try {
    const body = await request.json();
    if (!body.ids || !Array.isArray(body.ids)) {
      throw new Error("Missing or invalid ids array");
    }
    ids = body.ids.filter((id: unknown) => typeof id === "string");
  } catch (error) {
    console.error(
      "[Routes] handleBatchDeleteConversations parse error:",
      error,
    );
    return new Response(
      JSON.stringify({ error: "Invalid request body" }),
      {
        status: 400,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      },
    );
  }

  const result = deleteConversations(ctx.db, ids);

  if (!result.success) {
    return new Response(
      JSON.stringify({ error: result.error }),
      {
        status: 400,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      },
    );
  }

  // Broadcast UI update via SSE to all clients
  const uiUpdates = generateUIUpdates(result.affectedRegions, ctx.db);
  getBroadcaster().broadcastUpdates(uiUpdates, null); // null = broadcast to all

  return new Response(
    JSON.stringify({
      success: true,
      deletedCount: result.data?.deletedCount,
      deletedIds: result.data?.deletedIds,
    }),
    {
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    },
  );
}

/**
 * Chat request body schema.
 */
interface ChatRequestBody {
  conversationId: string;
  message: string;
  attachmentId?: string;
  deviceType?: "desktop" | "mobile";
}

/**
 * Chat retry request body schema.
 * Re-attempts the last failed turn without re-persisting the user message.
 */
interface RetryChatRequestBody {
  conversationId: string;
}

/**
 * Handle POST /api/chat - Send message and stream response via SSE
 *
 * This is the main endpoint for chat interactions. It:
 * 1. Validates the request body
 * 2. Creates or uses an EntityTurn
 * 3. Processes the message
 * 4. Converts StreamChunks to SSEEvents
 * 5. Streams the response back to the client
 *
 * @param ctx - Route context
 * @param request - HTTP Request with body { conversationId: string, message: string }
 * @returns HTTP Response with SSE stream
 */
export async function handleChat(
  ctx: RouteContext,
  request: Request,
): Promise<Response> {
  // Parse and validate request body
  let body: ChatRequestBody;
  try {
    body = await request.json();
    if (!body.conversationId || typeof body.conversationId !== "string") {
      throw new Error("Missing or invalid conversationId");
    }
    if (!body.message || typeof body.message !== "string") {
      throw new Error("Missing or invalid message");
    }
  } catch (error) {
    console.error("[Routes] handleChat parse error:", error);
    return new Response(
      JSON.stringify({ error: "Invalid request body" }),
      {
        status: 400,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      },
    );
  }

  // Check if conversation exists
  const conversation = ctx.db.getConversation(body.conversationId);
  if (!conversation) {
    return new Response(
      JSON.stringify({ error: "Conversation not found" }),
      {
        status: 404,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      },
    );
  }

  // Check if this is the first message (for auto-titling in parallel)
  const existingMessages = ctx.db.getMessages(body.conversationId);
  const isFirstMessage = existingMessages.length === 0 && !conversation.title;

  // Create an AbortController to handle client disconnect
  const abortController = new AbortController();
  const { signal } = abortController;

  // Create a ReadableStream that will produce SSE events
  const stream = new ReadableStream<SSEEvent>({
    async start(controller) {
      try {
        // Prefix user message with attachment reference if provided
        let userMessage = body.message;
        if (body.attachmentId) {
          // Resolve the actual filename (attachment is saved as {uuid}.{ext} but we only have the UUID)
          let attachmentFilename = body.attachmentId;
          try {
            const attachDir = `${ctx.dataRoot}/.psycheros/chat-attachments`;
            for await (const entry of Deno.readDir(attachDir)) {
              if (entry.name.startsWith(body.attachmentId)) {
                attachmentFilename = entry.name;
                break;
              }
            }
          } catch { /* dir may not exist yet */ }

          const captioningSettings = ctx.getImageGenSettings().captioning;
          if (captioningSettings?.enabled) {
            try {
              const attachmentPath =
                `${ctx.dataRoot}/.psycheros/chat-attachments/${attachmentFilename}`;
              const fileData = await Deno.readFile(attachmentPath);
              const base64 = uint8ToBase64(fileData);
              const mediaType = getImageMediaType(attachmentFilename);
              const caption = await captionImageDual(
                base64,
                mediaType,
                captioningSettings,
              );
              userMessage =
                `[USER_IMAGE: /chat-attachments/${attachmentFilename} | Caption: ${caption.long} | Short: ${caption.short}] ${body.message}`;
            } catch (captionError) {
              console.error(
                "[Chat] Auto-captioning failed, falling back to path-only:",
                captionError,
              );
              userMessage =
                `[USER_IMAGE: /chat-attachments/${attachmentFilename}] ${body.message}`;
            }
          } else {
            userMessage =
              `[USER_IMAGE: /chat-attachments/${attachmentFilename}] ${body.message}`;
          }
        }

        // Start auto-title generation in parallel (runs concurrently with main response)
        const titlePromise = isFirstMessage
          ? generateAndSetTitle(body.conversationId, userMessage, ctx.db, {
            activeProfile: ctx.getActiveLLMProfile() ?? undefined,
          })
          : null;

        // Inactivity-trigger eligibility is derived from the messages table
        // on every tick, so no in-memory cache to update here.

        // Create EntityTurn instance
        const activeProfile = ctx.getActiveLLMProfile();
        const turn = new EntityTurn(
          ctx.llm,
          ctx.db,
          ctx.tools,
          {
            projectRoot: ctx.projectRoot,
            dataRoot: ctx.dataRoot,
            chatRAG: ctx.chatRAG,
            mcpClient: ctx.mcpClient,
            lorebookManager: ctx.lorebookManager,
            vaultManager: ctx.vaultManager,
            webSearchSettings: ctx.getWebSearchSettings(),
            discordSettings: ctx.getDiscordSettings(),
            homeSettings: ctx.getHomeSettings(),
            lovenseSettings: ctx.getLovenseSettings(),
            buttplugSettings: ctx.getButtplugSettings(),
            imageGenSettings: ctx.getImageGenSettings(),
            deviceStatusCache: ctx.getDeviceStatusCache(),
            contextLength: activeProfile?.contextLength,
            maxTokens: activeProfile?.maxTokens,
          },
        );

        // Process the message and stream chunks
        for await (
          const chunk of turn.process(body.conversationId, userMessage, {
            deviceType: body.deviceType,
          })
        ) {
          if (signal.aborted) {
            console.log("Client disconnected, stopping stream");
            break;
          }
          controller.enqueue(convertToSSEEvent(chunk));
        }

        // Await title generation (it broadcasts its own updates via persistent SSE)
        if (titlePromise && !signal.aborted) {
          await titlePromise;
        }
      } catch (error) {
        // Don't log or send error events if client disconnected
        if (signal.aborted) {
          return;
        }

        // Extract structured error info for logging
        const errorCode = (error as { code?: string })?.code || "UNKNOWN";
        const statusCode = (error as { statusCode?: number })?.statusCode;
        const errorMsg = error instanceof Error ? error.message : String(error);
        console.error(
          `[Routes] Chat streaming error — code=${errorCode}` +
            (statusCode ? `, http=${statusCode}` : "") +
            `: ${errorMsg}`,
        );

        // Build a user-facing message that includes the error category
        // without leaking sensitive internal details
        let userMessage: string;
        switch (errorCode) {
          case "CONNECT_TIMEOUT":
            userMessage =
              "The AI service is unreachable or failed to respond. It may be temporarily unavailable — please try again.";
            break;
          case "STREAM_STALL_TIMEOUT":
            userMessage =
              "The AI response stalled mid-stream. The service may be overloaded — please try again.";
            break;
          case "NETWORK_ERROR":
            userMessage =
              "Could not reach the AI service. Please check your connection and try again.";
            break;
          case "MALFORMED_STREAM":
            userMessage =
              "Received corrupted data from the AI service. Please try again.";
            break;
          default:
            if (statusCode && statusCode >= 500) {
              userMessage =
                `The AI service returned an error (HTTP ${statusCode}). Please try again later.`;
            } else if (statusCode === 429) {
              userMessage =
                "Rate limited by the AI service. Please wait a moment and try again.";
            } else if (statusCode === 401 || statusCode === 403) {
              userMessage =
                "Authentication error with the AI service. Check your API key configuration.";
            } else {
              userMessage = "An error occurred while processing your message.";
            }
            break;
        }

        // Send error as a status event with descriptive message and code
        controller.enqueue({
          type: "status",
          data: JSON.stringify({ error: userMessage, errorCode }),
        });

        // Send done event
        controller.enqueue({
          type: "done",
          data: "error",
        });
      } finally {
        controller.close();
      }
    },
    cancel() {
      // Called when the client disconnects or the stream is cancelled
      abortController.abort();
    },
  });

  // Pipe through the SSE encoder and return the response
  const encodedStream = stream.pipeThrough(createSSEEncoder());
  return createSSEResponse(encodedStream);
}

/**
 * Handle POST /api/chat/retry - Retry a failed turn without re-persisting the user message
 *
 * When a turn fails (e.g. rate limit), the user message is already in the DB.
 * This endpoint re-attempts the LLM call using the already-persisted user message
 * without creating a duplicate.
 */
export async function handleChatRetry(
  ctx: RouteContext,
  request: Request,
): Promise<Response> {
  let body: RetryChatRequestBody;
  try {
    body = await request.json();
    if (!body.conversationId || typeof body.conversationId !== "string") {
      throw new Error("Missing or invalid conversationId");
    }
  } catch (error) {
    console.error("[Routes] handleChatRetry parse error:", error);
    return new Response(
      JSON.stringify({ error: "Invalid request body" }),
      {
        status: 400,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      },
    );
  }

  const conversation = ctx.db.getConversation(body.conversationId);
  if (!conversation) {
    return new Response(
      JSON.stringify({ error: "Conversation not found" }),
      {
        status: 404,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      },
    );
  }

  // Retrieve the last user message from the conversation
  const allMessages = ctx.db.getMessages(body.conversationId);
  const lastUserMessage = [...allMessages].reverse().find((m) =>
    m.role === "user"
  );

  if (!lastUserMessage) {
    return new Response(
      JSON.stringify({ error: "No user message found to retry" }),
      {
        status: 400,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      },
    );
  }

  const userMessage = lastUserMessage.content;

  const abortController = new AbortController();
  const { signal } = abortController;

  const stream = new ReadableStream<SSEEvent>({
    async start(controller) {
      try {
        const retryProfile = ctx.getActiveLLMProfile();
        const turn = new EntityTurn(
          ctx.llm,
          ctx.db,
          ctx.tools,
          {
            projectRoot: ctx.projectRoot,
            dataRoot: ctx.dataRoot,
            chatRAG: ctx.chatRAG,
            mcpClient: ctx.mcpClient,
            lorebookManager: ctx.lorebookManager,
            vaultManager: ctx.vaultManager,
            webSearchSettings: ctx.getWebSearchSettings(),
            discordSettings: ctx.getDiscordSettings(),
            homeSettings: ctx.getHomeSettings(),
            lovenseSettings: ctx.getLovenseSettings(),
            buttplugSettings: ctx.getButtplugSettings(),
            imageGenSettings: ctx.getImageGenSettings(),
            deviceStatusCache: ctx.getDeviceStatusCache(),
            contextLength: retryProfile?.contextLength,
            maxTokens: retryProfile?.maxTokens,
          },
        );

        // Process with retry mode: skip user message persistence
        for await (
          const chunk of turn.process(body.conversationId, userMessage, {
            retry: true,
          })
        ) {
          if (signal.aborted) break;
          controller.enqueue(convertToSSEEvent(chunk));
        }
      } catch (error) {
        if (signal.aborted) return;

        const errorCode = (error as { code?: string })?.code || "UNKNOWN";
        const statusCode = (error as { statusCode?: number })?.statusCode;
        const errorMsg = error instanceof Error ? error.message : String(error);
        console.error(
          `[Routes] Chat retry streaming error — code=${errorCode}` +
            (statusCode ? `, http=${statusCode}` : "") +
            `: ${errorMsg}`,
        );

        let userMessage: string;
        switch (errorCode) {
          case "CONNECT_TIMEOUT":
            userMessage =
              "The AI service is unreachable or failed to respond. It may be temporarily unavailable — please try again.";
            break;
          case "STREAM_STALL_TIMEOUT":
            userMessage =
              "The AI response stalled mid-stream. The service may be overloaded — please try again.";
            break;
          case "NETWORK_ERROR":
            userMessage =
              "Could not reach the AI service. Please check your connection and try again.";
            break;
          case "MALFORMED_STREAM":
            userMessage =
              "Received corrupted data from the AI service. Please try again.";
            break;
          default:
            if (statusCode && statusCode >= 500) {
              userMessage =
                `The AI service returned an error (HTTP ${statusCode}). Please try again later.`;
            } else if (statusCode === 429) {
              userMessage =
                "Rate limited by the AI service. Please wait a moment and try again.";
            } else if (statusCode === 401 || statusCode === 403) {
              userMessage =
                "Authentication error with the AI service. Check your API key configuration.";
            } else {
              userMessage = "An error occurred while processing your message.";
            }
            break;
        }

        controller.enqueue({
          type: "status",
          data: JSON.stringify({ error: userMessage, errorCode }),
        });
        controller.enqueue({ type: "done", data: "error" });
      } finally {
        controller.close();
      }
    },
    cancel() {
      abortController.abort();
    },
  });

  const encodedStream = stream.pipeThrough(createSSEEncoder());
  return createSSEResponse(encodedStream);
}

/**
 * Truncate a string with a descriptive suffix showing how much was cut.
 */
function truncateWithNotice(text: string, maxLength: number): string {
  const omitted = text.length - maxLength;
  return text.substring(0, maxLength) +
    `\n\n[... ${omitted.toLocaleString()} characters truncated]`;
}

/**
 * Maximum length for tool result content sent to the client via SSE.
 * The client JSON.parse()s this, so we must truncate BEFORE serialization
 * to keep the JSON valid. The LLM still gets the full result in its context.
 */
const MAX_TOOL_RESULT_CONTENT_LENGTH = 50 * 1024;

/**
 * Truncate SSE data if it exceeds the maximum size.
 * This is a last-resort safety net for non-JSON event types.
 * JSON events (tool_result, tool_call) truncate their content fields
 * BEFORE serialization in convertToSSEEvent to keep JSON valid.
 */
function truncateSSEData(data: string): string {
  if (data.length <= MAX_SSE_MESSAGE_SIZE) {
    return data;
  }

  const truncateAt = MAX_SSE_MESSAGE_SIZE - SSE_TRUNCATION_SUFFIX.length;
  return data.substring(0, truncateAt) + SSE_TRUNCATION_SUFFIX;
}

/**
 * Convert an EntityTurn yield to an SSEEvent.
 *
 * Mapping:
 * - StreamChunk 'thinking' -> SSEEvent 'thinking', data is content
 * - StreamChunk 'content' -> SSEEvent 'content', data is content
 * - StreamChunk 'tool_call' -> SSEEvent 'tool_call', data is JSON of toolCall
 * - 'tool_result' -> SSEEvent 'tool_result', data is JSON of result
 * - StreamChunk 'done' -> SSEEvent 'done', data is finishReason
 *
 * Large tool result content is truncated BEFORE JSON serialization so the
 * resulting JSON remains valid and parseable by the client. The LLM always
 * receives the full content in its context regardless of this truncation.
 *
 * @param chunk - The chunk from EntityTurn
 * @returns The corresponding SSEEvent
 */
function convertToSSEEvent(chunk: EntityYield): SSEEvent {
  switch (chunk.type) {
    case "thinking":
      return {
        type: "thinking",
        data: chunk.content,
      };

    case "content":
      return {
        type: "content",
        data: chunk.content,
      };

    case "tool_call": {
      // Truncate tool call arguments before serialization to keep JSON valid.
      // Tool arguments are typically small, but some tools accept large
      // content payloads that could exceed the SSE limit.
      const toolCall = chunk.toolCall;
      const args = toolCall.function.arguments;
      const truncatedArgs = args.length > MAX_SSE_MESSAGE_SIZE
        ? truncateWithNotice(args, MAX_SSE_MESSAGE_SIZE - 200)
        : args;
      return {
        type: "tool_call",
        data: JSON.stringify({
          ...toolCall,
          function: { ...toolCall.function, arguments: truncatedArgs },
        }),
      };
    }

    case "tool_result": {
      // Truncate tool result content BEFORE serialization.
      // The old approach (truncateSSEData on serialized JSON) produced
      // invalid JSON, causing JSON.parse to fail silently on the client
      // and tool results to disappear from the UI with no visible error.
      // The LLM still gets the full content in its agentic loop context.
      const result = chunk.result;
      const content = result.content;
      const truncatedContent = content.length > MAX_TOOL_RESULT_CONTENT_LENGTH
        ? truncateWithNotice(content, MAX_TOOL_RESULT_CONTENT_LENGTH)
        : content;
      return {
        type: "tool_result",
        data: JSON.stringify({
          toolCallId: result.toolCallId,
          content: truncatedContent,
          isError: result.isError,
          affectedRegions: result.affectedRegions,
        }),
      };
    }

    case "dom_update":
      return {
        type: "dom_update",
        data: truncateSSEData(JSON.stringify(chunk.update)),
      };

    case "status":
      return {
        type: "status",
        data: JSON.stringify(chunk.status),
      };

    case "metrics":
      return {
        type: "metrics",
        data: JSON.stringify(chunk.metrics),
      };

    case "context":
      return {
        type: "context",
        data: JSON.stringify(chunk.context),
      };

    case "done":
      return {
        type: "done",
        data: chunk.finishReason,
      };

    case "message_id":
      return {
        type: "message_id",
        data: JSON.stringify({ role: chunk.role, id: chunk.id }),
      };

    case "image_generated":
      return {
        type: "image_generated",
        data: JSON.stringify({
          imagePath: chunk.imagePath,
          prompt: chunk.prompt,
          generatorName: chunk.generatorName,
          description: chunk.description,
        }),
      };
  }
}

/**
 * Handle static file requests from the web/ directory.
 *
 * @param ctx - Route context
 * @param path - The requested file path (relative to web/)
 * @returns HTTP Response with file content or 404
 */
export async function handleStaticFile(
  ctx: RouteContext,
  path: string,
): Promise<Response> {
  // Build the full path and normalize it to resolve any ".." or "." segments
  const webRoot = `${ctx.projectRoot}/web`;

  // Normalize the path to resolve "..", ".", and "//" sequences
  // This handles URL-encoded traversal attempts since the URL is already decoded
  const normalizedPath = normalizePath(`${webRoot}${path}`);

  // Security check: ensure the resolved path is still within the web root
  // This prevents path traversal attacks like "/../../../etc/passwd"
  if (!normalizedPath.startsWith(webRoot + "/") && normalizedPath !== webRoot) {
    return new Response("Forbidden", {
      status: 403,
      headers: { "Content-Type": "text/plain" },
    });
  }

  const filePath = normalizedPath;

  try {
    const content = await Deno.readFile(filePath);
    const mimeType = getMimeType(filePath);

    return new Response(content, {
      headers: {
        "Content-Type": mimeType,
        "Cache-Control": "no-cache",
      },
    });
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return new Response("Not Found", {
        status: 404,
        headers: { "Content-Type": "text/plain" },
      });
    }
    throw error;
  }
}

/**
 * Handle health check requests.
 *
 * Returns JSON with the daemon's identity + version metadata so consumers
 * (the launcher dashboard, ops scripts) can surface the running version
 * without scraping logs. Container HEALTHCHECK only checks `r.ok` so the
 * body is free to grow as needed.
 */
export function handleHealth(): Response {
  const started = getServerStartTime();
  return new Response(
    JSON.stringify({
      status: "ok",
      name: "psycheros",
      version: VERSION,
      version_base: VERSION_BASE,
      version_suffix: VERSION_SUFFIX,
      is_staging: IS_STAGING,
      is_prerelease: IS_PRERELEASE,
      flavor: FLAVOR_LABEL,
      entity_core_version: entityCoreDenoJson.version,
      started_at: started ? started.toISOString() : null,
    }),
    {
      status: 200,
      headers: { "Content-Type": "application/json" },
    },
  );
}

/**
 * Serve the service worker with the cache name stamped to the running
 * version. The raw file in web/sw.js carries a `__VERSION__` placeholder;
 * this handler substitutes it at serve time so every released build owns
 * a distinct cache key and stale offline assets are evicted on upgrade.
 */
export async function handleServiceWorker(
  ctx: RouteContext,
): Promise<Response> {
  const swPath = `${ctx.projectRoot}/web/sw.js`;
  const raw = await Deno.readTextFile(swPath);
  // Replace `+` and `.` with `-` to produce a cache-name-safe slug
  // (`0.1.2+staging.abc1234` -> `0-1-2-staging-abc1234`).
  const safeVersion = VERSION.replace(/[+.]/g, "-");
  const body = raw.replace(/__VERSION__/g, safeVersion);
  return new Response(body, {
    headers: {
      "Content-Type": "application/javascript",
      "Cache-Control": "no-cache",
      "Service-Worker-Allowed": "/",
    },
  });
}

/**
 * Handle CORS preflight requests.
 *
 * @returns HTTP Response with CORS headers
 */
export function handleCORS(): Response {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "86400",
    },
  });
}

/**
 * SSE headers for persistent event stream connections.
 */
const SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache",
  "Connection": "keep-alive",
  "Access-Control-Allow-Origin": "*",
};

/**
 * Handle GET /api/events - Persistent SSE event stream
 *
 * Creates a persistent SSE connection that receives DOM updates from
 * background operations like auto-title generation. Unlike /api/chat,
 * this connection stays open independently of any specific request.
 *
 * @param _ctx - Route context (unused)
 * @param request - HTTP Request (may contain conversationId query param)
 * @returns HTTP Response with SSE stream
 */
export function handleEvents(_ctx: RouteContext, request: Request): Response {
  const url = new URL(request.url);
  const conversationId = url.searchParams.get("conversationId");
  const broadcaster = getBroadcaster();
  const encoder = new TextEncoder();

  let clientId: string | null = null;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      // Create a wrapper controller that encodes strings to Uint8Array
      const stringController = {
        enqueue: (str: string) => controller.enqueue(encoder.encode(str)),
        close: () => controller.close(),
        error: (e: Error) => controller.error(e),
      };

      // Register this client with the broadcaster (using string-based controller)
      clientId = broadcaster.addClient(
        stringController as unknown as ReadableStreamDefaultController<string>,
        conversationId,
      );

      // Send initial connected event
      const connectedEvent = `event: connected\ndata: ${
        JSON.stringify({
          clientId,
          conversationId,
        })
      }\n\n`;
      controller.enqueue(encoder.encode(connectedEvent));
    },
    cancel() {
      // Client disconnected - clean up
      if (clientId) {
        broadcaster.removeClient(clientId);
      }
    },
  });

  return new Response(stream, { headers: SSE_HEADERS });
}

// =============================================================================
// Settings Routes
// =============================================================================

/**
 * Valid prompt directories for file operations.
 */
const VALID_PROMPT_DIRS = ["self", "user", "relationship", "custom"];

/**
 * Security check for directory parameter.
 * Prevents path traversal attacks.
 */
function isValidDirectory(dir: string): boolean {
  return VALID_PROMPT_DIRS.includes(dir);
}

/**
 * Security check for filename parameter.
 * Only allows .md files with safe names.
 * For custom files, only allows single words (letters, numbers, underscores).
 */
function isValidFilename(filename: string, isCustom: boolean = false): boolean {
  // Must end with .md
  if (!filename.endsWith(".md")) return false;
  // No path separators
  if (filename.includes("/") || filename.includes("\\")) return false;
  // No parent directory references
  if (filename.includes("..")) return false;
  // Must be a reasonable filename
  const baseName = filename.slice(0, -3); // Remove .md
  if (isCustom) {
    // Custom files: single word only (letters, numbers, underscores - no spaces or hyphens)
    return /^[a-zA-Z0-9_]+$/.test(baseName);
  }
  // Standard files: alphanumeric, underscores, hyphens (no spaces)
  return /^[a-zA-Z0-9_-]+$/.test(baseName);
}

/**
 * Handle GET /fragments/settings - Settings hub page fragment.
 * Returns the settings hub view listing all settings categories.
 *
 * @param _ctx - Route context
 * @returns HTTP Response with settings hub HTML fragment
 */
export function handleSettingsHubFragment(_ctx: RouteContext): Response {
  const html = renderSettingsHub();
  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
    },
  });
}

/**
 * Handle GET /fragments/settings/core-prompts - Settings page fragment.
 * Returns the core prompts settings view with tabs.
 *
 * @param _ctx - Route context
 * @returns HTTP Response with settings HTML fragment
 */
export function handleSettingsFragment(_ctx: RouteContext): Response {
  const html = renderCorePromptsSettings("self");
  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
    },
  });
}

/**
 * Handle GET /fragments/settings/core-prompts/:directory - File list fragment.
 * Returns the list of files for the selected directory.
 *
 * @param ctx - Route context
 * @param directory - The prompt directory (self, user, relationship)
 * @returns HTTP Response with file list HTML fragment
 */
export async function handleSettingsFileListFragment(
  ctx: RouteContext,
  directory: string,
): Promise<Response> {
  // Validate directory
  if (!isValidDirectory(directory)) {
    return new Response("Invalid directory", {
      status: 400,
      headers: { "Content-Type": "text/plain" },
    });
  }

  try {
    // List .md files in the directory
    const dirPath = `${ctx.dataRoot}/identity/${directory}`;
    const files: string[] = [];

    for await (const entry of Deno.readDir(dirPath)) {
      if (entry.isFile && entry.name.endsWith(".md")) {
        files.push(entry.name);
      }
    }

    // Sort files alphabetically
    files.sort();

    const html = renderFileList(
      directory as "self" | "user" | "relationship" | "custom",
      files,
    );
    return new Response(html, {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
      },
    });
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      // For custom directory, create it and return empty list
      if (directory === "custom") {
        const customDir = `${ctx.dataRoot}/identity/custom`;
        await Deno.mkdir(customDir, { recursive: true });
        const html = renderFileList("custom", []);
        return new Response(html, {
          headers: {
            "Content-Type": "text/html; charset=utf-8",
          },
        });
      }
      return new Response("Directory not found", {
        status: 404,
        headers: { "Content-Type": "text/plain" },
      });
    }
    throw error;
  }
}

/**
 * Handle GET /fragments/settings/file/:directory/:filename - File editor fragment.
 * Returns the file editor with textarea for editing the file.
 *
 * @param ctx - Route context
 * @param directory - The prompt directory (self, user, relationship)
 * @param filename - The filename to edit
 * @returns HTTP Response with editor HTML fragment
 */
export async function handleSettingsFileEditorFragment(
  ctx: RouteContext,
  directory: string,
  filename: string,
): Promise<Response> {
  // Validate parameters
  if (!isValidDirectory(directory)) {
    return new Response("Invalid directory", {
      status: 400,
      headers: { "Content-Type": "text/plain" },
    });
  }

  const isCustom = directory === "custom";
  if (!isValidFilename(filename, isCustom)) {
    return new Response("Invalid filename", {
      status: 400,
      headers: { "Content-Type": "text/plain" },
    });
  }

  try {
    // Read file content
    const filePath = `${ctx.dataRoot}/identity/${directory}/${filename}`;
    const content = await Deno.readTextFile(filePath);

    // Load prompt label from entity-core
    let promptLabel: string | undefined;
    if (ctx.mcpClient) {
      try {
        const meta = await ctx.mcpClient.getIdentityMeta(
          directory as "self" | "user" | "relationship" | "custom",
        );
        const key = `${directory}/${filename}`;
        promptLabel = meta[key];
      } catch {
        // Use default (filename without .md)
      }
    }

    const html = renderFileEditor(
      directory as "self" | "user" | "relationship" | "custom",
      filename,
      content,
      promptLabel,
    );
    return new Response(html, {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
      },
    });
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return new Response("File not found", {
        status: 404,
        headers: { "Content-Type": "text/plain" },
      });
    }
    throw error;
  }
}

/**
 * Handle POST /api/settings/file/:directory/:filename - Save file changes.
 * Saves the file content and returns a status message.
 *
 * @param ctx - Route context
 * @param directory - The prompt directory (self, user, relationship)
 * @param filename - The filename to save
 * @param request - HTTP Request with form body containing content
 * @returns HTTP Response with status HTML fragment
 */
export async function handleSaveSettingsFile(
  ctx: RouteContext,
  directory: string,
  filename: string,
  request: Request,
): Promise<Response> {
  // Validate parameters
  if (!isValidDirectory(directory)) {
    return new Response(renderSaveError("Invalid directory"), {
      status: 400,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }

  const isCustom = directory === "custom";
  if (!isValidFilename(filename, isCustom)) {
    return new Response(renderSaveError("Invalid filename"), {
      status: 400,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }

  try {
    // Parse form data
    const formData = await request.formData();
    const content = formData.get("content");

    if (typeof content !== "string") {
      return new Response(renderSaveError("Missing content"), {
        status: 400,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    // Write file - MCP is source of truth when connected
    if (ctx.mcpClient) {
      // Use MCP client to write (pushes to entity-core, updates cache, writes local)
      await ctx.mcpClient.writeIdentityFile(
        directory as "self" | "user" | "relationship" | "custom",
        filename,
        content,
        ctx.dataRoot,
      );
    } else {
      // Fallback to direct file write when MCP is not enabled
      const filePath = `${ctx.dataRoot}/identity/${directory}/${filename}`;
      await Deno.writeTextFile(filePath, content);
    }

    return new Response(renderSaveSuccess(), {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
      },
    });
  } catch (error) {
    console.error("[Routes] handleSaveSettingsFile error:", error);
    return new Response(renderSaveError("Failed to save file"), {
      status: 500,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }
}

/**
 * Handle POST /api/settings/prompt-label/:directory/:filename - Save prompt label.
 * Updates the XML tag name used to wrap the file's content in the context.
 */
export async function handleSavePromptLabel(
  ctx: RouteContext,
  directory: string,
  filename: string,
  request: Request,
): Promise<Response> {
  if (!ctx.mcpClient) {
    return new Response(renderSaveError("MCP not connected"), {
      status: 500,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }

  try {
    const formData = await request.formData();
    const promptLabel = formData.get("promptLabel");

    if (typeof promptLabel !== "string" || !promptLabel.trim()) {
      return new Response(renderSaveError("Missing prompt label"), {
        status: 400,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    const trimmed = promptLabel.trim();
    if (!/^[a-zA-Z0-9_]+$/.test(trimmed)) {
      return new Response(
        renderSaveError(
          "Prompt label can only contain letters, numbers, and underscores",
        ),
        {
          status: 400,
          headers: { "Content-Type": "text/html; charset=utf-8" },
        },
      );
    }

    await ctx.mcpClient.setIdentityMeta(
      directory as "self" | "user" | "relationship" | "custom",
      filename,
      trimmed,
    );

    return new Response(renderSaveSuccess(), {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
      },
    });
  } catch (error) {
    console.error("[Routes] handleSavePromptLabel error:", error);
    return new Response(renderSaveError("Failed to save prompt label"), {
      status: 500,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }
}

/**
 * Handle POST /api/settings/custom/create - Create a new custom file.
 * Creates an empty file with the given filename.
 *
 * @param ctx - Route context
 * @param request - HTTP Request with body { filename: string }
 * @returns HTTP Response redirecting to the editor for the new file
 */
export async function handleCreateCustomFile(
  ctx: RouteContext,
  request: Request,
): Promise<Response> {
  try {
    // Parse request body
    const body = await request.json();
    const filename = body.filename;

    if (typeof filename !== "string" || !filename.trim()) {
      return new Response(
        JSON.stringify({ error: "Missing or invalid filename" }),
        {
          status: 400,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    // Ensure filename ends with .md
    const fullFilename = filename.endsWith(".md") ? filename : `${filename}.md`;

    // Validate filename (custom files: single word only)
    if (!isValidFilename(fullFilename, true)) {
      return new Response(
        JSON.stringify({
          error:
            "Invalid filename. Use only letters, numbers, and underscores (no spaces).",
        }),
        {
          status: 400,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    // Ensure custom directory exists
    const customDir = `${ctx.dataRoot}/identity/custom`;
    await Deno.mkdir(customDir, { recursive: true });

    // Create file with XML tags based on filename
    const filePath = `${customDir}/${fullFilename}`;
    const tagName = fullFilename.replace(/\.md$/, "");
    const initialContent = `<${tagName}>

</${tagName}>
`;
    await Deno.writeTextFile(filePath, initialContent);

    // If MCP is connected, sync the new file
    if (ctx.mcpClient) {
      await ctx.mcpClient.writeIdentityFile(
        "custom",
        fullFilename,
        initialContent,
        ctx.dataRoot,
      );
    }

    return new Response(
      JSON.stringify({ success: true, filename: fullFilename }),
      {
        status: 201,
        headers: { "Content-Type": "application/json" },
      },
    );
  } catch (error) {
    console.error("[Routes] handleCreateCustomFile error:", error);
    return new Response(
      JSON.stringify({ error: "Failed to create file" }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      },
    );
  }
}

/**
 * Handle POST /api/settings/identity/upload - Upload an identity file.
 * Writes through MCP so entity-core stays canonical. Overwrites if the file
 * already exists.
 */
export async function handleUploadIdentityFile(
  ctx: RouteContext,
  request: Request,
): Promise<Response> {
  try {
    const body = await request.json();
    const { directory, filename, content } = body as {
      directory?: string;
      filename?: string;
      content?: string;
    };

    if (!isValidDirectory(directory ?? "")) {
      return new Response(
        JSON.stringify({ error: "Invalid directory" }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }

    if (typeof filename !== "string" || !filename.trim()) {
      return new Response(
        JSON.stringify({ error: "Missing or invalid filename" }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }

    // Ensure filename ends with .md
    const fullFilename = filename.endsWith(".md") ? filename : `${filename}.md`;

    const isCustom = directory === "custom";
    if (!isValidFilename(fullFilename, isCustom)) {
      return new Response(
        JSON.stringify({
          error:
            "Invalid filename. Use only letters, numbers, and underscores (no spaces).",
        }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }

    if (typeof content !== "string" || !content.trim()) {
      return new Response(
        JSON.stringify({ error: "Content cannot be empty" }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }

    // Write through MCP (source of truth) or fall back to direct file write
    if (ctx.mcpClient) {
      await ctx.mcpClient.writeIdentityFile(
        directory as "self" | "user" | "relationship" | "custom",
        fullFilename,
        content,
        ctx.dataRoot,
      );
    } else {
      const dirPath = `${ctx.dataRoot}/identity/${directory}`;
      await Deno.mkdir(dirPath, { recursive: true });
      await Deno.writeTextFile(`${dirPath}/${fullFilename}`, content);
    }

    return new Response(
      JSON.stringify({ success: true, filename: fullFilename }),
      { status: 201, headers: { "Content-Type": "application/json" } },
    );
  } catch (error) {
    console.error("[Routes] handleUploadIdentityFile error:", error);
    return new Response(
      JSON.stringify({ error: "Failed to upload file" }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
}

/**
 * Handle DELETE /api/settings/file/custom/:filename - Delete a custom file.
 * Only custom files can be deleted.
 *
 * @param ctx - Route context
 * @param filename - The filename to delete
 * @returns HTTP Response with JSON result
 */
export async function handleDeleteCustomFile(
  ctx: RouteContext,
  filename: string,
): Promise<Response> {
  // Decode filename from URL
  const decodedFilename = decodeURIComponent(filename);

  // Validate filename (custom files allow spaces)
  if (!isValidFilename(decodedFilename, true)) {
    return new Response(
      JSON.stringify({ error: "Invalid filename" }),
      {
        status: 400,
        headers: { "Content-Type": "application/json" },
      },
    );
  }

  try {
    // If MCP is connected, use MCP to delete (which also handles local)
    if (ctx.mcpClient) {
      const result = await ctx.mcpClient.deleteCustomFile(
        decodedFilename,
        ctx.dataRoot,
      );
      if (result.success) {
        return new Response(
          JSON.stringify({ success: true, message: result.message }),
          {
            headers: { "Content-Type": "application/json" },
          },
        );
      }
      return new Response(
        JSON.stringify({ error: result.message || "Failed to delete file" }),
        {
          status: 500,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    // Fallback: direct file delete when MCP is not enabled
    const filePath = `${ctx.dataRoot}/identity/custom/${decodedFilename}`;
    await Deno.remove(filePath);

    return new Response(
      JSON.stringify({ success: true, message: "File deleted" }),
      {
        headers: { "Content-Type": "application/json" },
      },
    );
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return new Response(
        JSON.stringify({ error: "File not found" }),
        {
          status: 404,
          headers: { "Content-Type": "application/json" },
        },
      );
    }
    console.error("[Routes] handleDeleteCustomFile error:", error);
    return new Response(
      JSON.stringify({ error: "Failed to delete file" }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      },
    );
  }
}

// =============================================================================
// Memories Settings Routes
// =============================================================================

/**
 * Valid memory granularities for route parameters.
 */
const VALID_MEMORY_GRANULARITIES = [
  "daily",
  "weekly",
  "monthly",
  "yearly",
  "significant",
];

/**
 * Date validation regex (same as entity-core).
 */
const DATE_REGEX = /^\d{4}(-W\d{2}|(-\d{2})?(-\d{2})?)$/;

/**
 * Handle GET /fragments/settings/memories - Memories view fragment.
 */
export function handleMemoriesFragment(_ctx: RouteContext): Response {
  const html = renderMemoriesView("daily");
  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

/**
 * Handle GET /fragments/settings/memories/:granularity - Memory list fragment.
 */
export async function handleMemoriesListFragment(
  ctx: RouteContext,
  granularity: string,
  url: URL,
): Promise<Response> {
  if (!VALID_MEMORY_GRANULARITIES.includes(granularity)) {
    return new Response("Invalid granularity", {
      status: 400,
      headers: { "Content-Type": "text/plain" },
    });
  }

  const offset = parseInt(url.searchParams.get("offset") || "0");
  const beforeDate = url.searchParams.get("before") || undefined;
  const afterDate = url.searchParams.get("after") || undefined;
  const limit = 50;

  try {
    if (!ctx.mcpClient?.isConnected()) {
      const html = renderMemoryList(
        granularity as
          | "daily"
          | "weekly"
          | "monthly"
          | "yearly"
          | "significant",
        [],
      );
      return new Response(html, {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    const result = await ctx.mcpClient.listMemories(
      granularity as "daily" | "weekly" | "monthly" | "yearly" | "significant",
      limit,
      { offset, beforeDate, afterDate },
    );

    const hasMore = offset + limit < result.total;
    const html = renderMemoryList(
      granularity as "daily" | "weekly" | "monthly" | "yearly" | "significant",
      result.memories,
      { hasMore, nextOffset: offset + limit, total: result.total },
    );

    return new Response(html, {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  } catch (error) {
    console.error("[Routes] handleMemoriesListFragment error:", error);
    return new Response(renderSaveError("Failed to list memories"), {
      status: 500,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }
}

/**
 * Handle GET /fragments/settings/memories/search?q=... - Search memories.
 */
export async function handleMemoriesSearchFragment(
  ctx: RouteContext,
  url: URL,
): Promise<Response> {
  const query = url.searchParams.get("q") || "";

  if (!query.trim()) {
    return new Response(renderMemorySearchResults("", []), {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }

  if (!ctx.mcpClient?.isConnected()) {
    return new Response(
      renderMemorySearchResults(query, [], "Not connected to entity-core"),
      { headers: { "Content-Type": "text/html; charset=utf-8" } },
    );
  }

  try {
    const results = await ctx.mcpClient.searchMemories(query, {
      maxResults: 50,
    });
    const html = renderMemorySearchResults(query, results);
    return new Response(html, {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  } catch (error) {
    console.error("[Routes] handleMemoriesSearchFragment error:", error);
    return new Response(renderSaveError("Search failed"), {
      status: 500,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }
}

/**
 * Handle GET /fragments/settings/memories/:granularity/:date - Memory editor fragment.
 */
export async function handleMemoriesEditorFragment(
  ctx: RouteContext,
  granularity: string,
  date: string,
): Promise<Response> {
  if (!VALID_MEMORY_GRANULARITIES.includes(granularity)) {
    return new Response("Invalid granularity", {
      status: 400,
      headers: { "Content-Type": "text/plain" },
    });
  }

  // Significant memories use slug-based filenames (e.g., 2026-04-06_first-conversation.md)
  // Other granularities use date-based filenames, optionally with instance suffix
  // (e.g., 2026-04-06.md or 2026-04-06_psycheros.md)
  const filename = `${date}.md`;
  if (!isValidFilename(filename)) {
    return new Response("Invalid filename", {
      status: 400,
      headers: { "Content-Type": "text/plain" },
    });
  }

  // For MCP lookup, extract the date portion (before any instance suffix)
  const mcpDate = date.split("_")[0];

  if (!ctx.mcpClient?.isConnected()) {
    return new Response(
      renderSaveError("MCP not connected — cannot load memory"),
      {
        status: 503,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      },
    );
  }

  try {
    const entry = await ctx.mcpClient.readMemory(
      granularity as "daily" | "weekly" | "monthly" | "yearly" | "significant",
      mcpDate,
    );

    if (!entry) {
      return new Response(renderSaveError("Memory not found"), {
        status: 404,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    const metadata = {
      sourceInstance: entry.sourceInstance,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
      version: entry.version,
    };

    const html = renderMemoryEditor(
      granularity as "daily" | "weekly" | "monthly" | "yearly" | "significant",
      date,
      entry.content,
      metadata,
    );

    return new Response(html, {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  } catch (error) {
    console.error("[Routes] handleMemoriesEditorFragment error:", error);
    return new Response(renderSaveError("Failed to load memory"), {
      status: 500,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }
}

/**
 * Handle POST /api/memories/:granularity/:date - Save edited memory.
 */
export async function handleSaveMemory(
  ctx: RouteContext,
  granularity: string,
  date: string,
  request: Request,
): Promise<Response> {
  if (!VALID_MEMORY_GRANULARITIES.includes(granularity)) {
    return new Response(renderSaveError("Invalid granularity"), {
      status: 400,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }

  // Significant memories use slug-based filenames (e.g., 2026-04-06_first-conversation.md)
  // Other granularities use date-based filenames, optionally with instance suffix
  // (e.g., 2026-04-06.md or 2026-04-06_psycheros.md)
  const filename = `${date}.md`;
  if (!isValidFilename(filename)) {
    return new Response(renderSaveError("Invalid filename"), {
      status: 400,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }

  // Extract the date portion for MCP lookup (before any slug suffix)
  const parts = date.split("_");
  const mcpDate = parts[0];
  const slug = granularity === "significant" && parts.length > 1
    ? parts.slice(1).join("_")
    : undefined;

  if (!ctx.mcpClient?.isConnected()) {
    return new Response(
      renderSaveError("MCP not connected — cannot save memory"),
      {
        status: 503,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      },
    );
  }

  try {
    // Parse form data
    const formData = await request.formData();
    const content = formData.get("content") as string | null;

    if (!content || content.trim().length === 0) {
      return new Response(renderSaveError("Content cannot be empty"), {
        status: 400,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    await ctx.mcpClient.updateMemory(
      granularity as "daily" | "weekly" | "monthly" | "yearly" | "significant",
      mcpDate,
      content,
      slug,
    );

    return new Response(renderSaveSuccess(), {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  } catch (error) {
    console.error("[Routes] handleSaveMemory error:", error);
    return new Response(renderSaveError("Failed to save memory"), {
      status: 500,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }
}

/**
 * Convert a title to a URL-safe filename slug.
 */
function slugify(title: string): string {
  return title
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .substring(0, 50);
}

/**
 * Handle POST /api/memories/significant/create - Create a new significant memory.
 */
export async function handleCreateSignificantMemory(
  ctx: RouteContext,
  request: Request,
): Promise<Response> {
  try {
    const formData = await request.formData();
    const title = formData.get("title") as string | null;
    const date = formData.get("date") as string | null;
    const content = formData.get("content") as string | null;

    if (!date || !DATE_REGEX.test(date)) {
      return new Response(renderSaveError("Invalid date format"), {
        status: 400,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    if (!content || content.trim().length === 0) {
      return new Response(renderSaveError("Content cannot be empty"), {
        status: 400,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    // Derive slug from title, or auto-generate from first line of content
    const displayTitle = title || content.trim().split("\n")[0];
    const slug = (title && title.trim().length > 0)
      ? slugify(title)
      : slugify(content.trim().split("\n")[0].replace(/^[-*#>\s]+/, ""));

    if (!slug) {
      return new Response(
        renderSaveError("Could not generate filename from title"),
        {
          status: 400,
          headers: { "Content-Type": "text/html; charset=utf-8" },
        },
      );
    }

    if (!ctx.mcpClient?.isConnected()) {
      return new Response(
        renderSaveError("MCP not connected — cannot create significant memory"),
        {
          status: 503,
          headers: { "Content-Type": "text/html; charset=utf-8" },
        },
      );
    }

    const formattedContent = `# ${displayTitle}

${content.trim()}
`;

    await ctx.mcpClient.createMemory(
      "significant",
      date,
      formattedContent,
      [],
      slug,
    );

    // Return redirect to refresh the significant tab
    return new Response("", {
      status: 200,
      headers: {
        "HX-Redirect": "/fragments/settings/memories/significant",
        "Content-Type": "text/html; charset=utf-8",
      },
    });
  } catch (error) {
    console.error("[Routes] handleCreateSignificantMemory error:", error);
    return new Response(
      renderSaveError("Failed to create significant memory"),
      {
        status: 500,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      },
    );
  }
}

/**
 * Handle DELETE /api/memories/significant/:filename - Delete a significant memory.
 */
export async function handleDeleteSignificantMemory(
  ctx: RouteContext,
  filename: string,
): Promise<Response> {
  // Extract date and slug from the URL filename (e.g., "2026-04-06_some-slug" -> date + slug)
  const decoded = decodeURIComponent(filename);
  const parts = decoded.split("_");
  const date = parts[0];
  const slug = parts.length > 1 ? parts.slice(1).join("_") : undefined;

  if (!ctx.mcpClient?.isConnected()) {
    return new Response(
      JSON.stringify({ error: "MCP not connected — cannot delete memory" }),
      {
        status: 503,
        headers: { "Content-Type": "application/json" },
      },
    );
  }

  try {
    const deleted = await ctx.mcpClient.deleteMemory("significant", date, slug);

    if (!deleted) {
      console.warn(`[Routes] Memory not found for delete: ${decoded}`);
      return new Response(
        JSON.stringify({ error: "Memory not found" }),
        {
          status: 404,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    console.log(`[Routes] Deleted significant memory via MCP: ${decoded}`);

    return new Response(
      JSON.stringify({ success: true }),
      {
        headers: { "Content-Type": "application/json" },
      },
    );
  } catch (error) {
    console.error("[Routes] handleDeleteSignificantMemory error:", error);
    return new Response(
      JSON.stringify({ error: "Failed to delete memory" }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      },
    );
  }
}

// =============================================================================
// Memory Consolidation Routes
// =============================================================================

/**
 * Handle POST /api/memory/consolidate/:granularity - Trigger memory consolidation
 *
 * Manually triggers consolidation for testing/debugging purposes.
 * Delegates to entity-core via MCP.
 * Granularity can be "weekly", "monthly", or "yearly".
 *
 * @param ctx - Route context
 * @param granularity - The consolidation granularity
 * @returns HTTP Response with JSON result
 */
export async function handleMemoryConsolidate(
  ctx: RouteContext,
  granularity: string,
): Promise<Response> {
  // Validate granularity
  if (
    granularity !== "weekly" && granularity !== "monthly" &&
    granularity !== "yearly"
  ) {
    return new Response(
      JSON.stringify({
        error:
          `Invalid granularity: ${granularity}. Must be weekly, monthly, or yearly.`,
      }),
      {
        status: 400,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      },
    );
  }

  if (!ctx.mcpClient) {
    return new Response(
      JSON.stringify({
        error: "Consolidation requires MCP connection to entity-core",
      }),
      {
        status: 400,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      },
    );
  }

  try {
    const result = await ctx.mcpClient.consolidateMemories({
      granularity: granularity as "weekly" | "monthly" | "yearly",
    });

    return new Response(
      JSON.stringify(result),
      {
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      },
    );
  } catch (error) {
    console.error("[Routes] handleMemoryConsolidate error:", error);
    return new Response(
      JSON.stringify({ success: false, error: "Consolidation failed" }),
      {
        status: 500,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      },
    );
  }
}

// =============================================================================
// MCP Sync Routes
// =============================================================================

// In-memory guard to prevent double-runs
let consolidationRunning = false;

/**
 * Handle GET /fragments/settings/memories/consolidation - Consolidation status tab.
 * Consolidation status is now managed by entity-core. If MCP is connected, show
 * the UI with a catch-up button that delegates to entity-core.
 */
export function handleConsolidationFragment(ctx: RouteContext): Response {
  try {
    // Consolidation runs in entity-core; if MCP is available, show the UI.
    // Since we can't check entity-core's consolidation status without calling it,
    // assume all may need consolidation and let the user trigger it.
    const mcpAvailable = !!ctx.mcpClient;
    const html = renderConsolidationTab({
      weekly: mcpAvailable,
      monthly: mcpAvailable,
      yearly: mcpAvailable,
    });
    return new Response(html, {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  } catch (error) {
    console.error("[Routes] handleConsolidationFragment error:", error);
    return new Response(
      renderSaveError("Failed to check consolidation status"),
      {
        status: 500,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      },
    );
  }
}

/**
 * Handle POST /api/memories/consolidation/run - Run catch-up consolidation.
 * Delegates to entity-core via MCP.
 */
export function handleConsolidationRun(ctx: RouteContext): Response {
  if (!ctx.mcpClient) {
    return new Response(
      renderSaveError("Consolidation requires MCP connection to entity-core"),
      {
        status: 400,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      },
    );
  }

  if (consolidationRunning) {
    return new Response(renderSaveError("Consolidation is already running"), {
      status: 409,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }

  consolidationRunning = true;

  // Return the loading state immediately
  const html = renderConsolidationRunning();
  const response = new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });

  // Fire consolidation in background via MCP
  runConsolidationInBackground(ctx);

  return response;
}

/**
 * Run all consolidations in the background via MCP and broadcast results via SSE.
 */
function runConsolidationInBackground(ctx: RouteContext): void {
  const mcpClient = ctx.mcpClient;

  if (!mcpClient) {
    consolidationRunning = false;
    return;
  }

  mcpClient.consolidateMemories({ all: true })
    .then((result) => {
      const displayResults = result.consolidations.map((c) => ({
        granularity: c.granularity,
        success: c.success,
        error: c.error,
      }));

      const html = renderConsolidationComplete(displayResults);
      getBroadcaster().broadcastUpdate({
        target: "#consolidation-content",
        html,
        swap: "outerHTML",
      }, null);
    })
    .catch((error) => {
      console.error("[Routes] Background consolidation failed:", error);
      const html = renderConsolidationComplete([
        {
          granularity: "consolidation",
          success: false,
          error: error instanceof Error ? error.message : String(error),
        },
      ]);
      getBroadcaster().broadcastUpdate({
        target: "#consolidation-content",
        html,
        swap: "outerHTML",
      }, null);
    })
    .finally(() => {
      consolidationRunning = false;
    });
}

// =============================================================================
// Memory Instructions Routes
// =============================================================================

/**
 * Handle GET /fragments/settings/memories/instructions - Instructions tab.
 * Loads and displays the custom daily memory-writing instructions.
 */
export async function handleInstructionsFragment(
  ctx: RouteContext,
): Promise<Response> {
  try {
    const settings = await loadMemorySettings(ctx.dataRoot);
    const html = renderInstructionsTab(settings.dailyInstructions);
    return new Response(html, {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  } catch (error) {
    console.error("[Routes] handleInstructionsFragment error:", error);
    return new Response(
      renderSaveError("Failed to load memory instructions"),
      {
        status: 500,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      },
    );
  }
}

/**
 * Handle POST /api/memories/instructions - Save custom daily memory instructions.
 */
export async function handleSaveMemoryInstructions(
  ctx: RouteContext,
  request: Request,
): Promise<Response> {
  try {
    const formData = await request.formData();
    const dailyInstructions = formData.get("dailyInstructions");

    if (typeof dailyInstructions !== "string") {
      return new Response(renderSaveError("Missing instructions"), {
        status: 400,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    await saveMemorySettings(ctx.dataRoot, { dailyInstructions });

    return new Response(renderSaveSuccess(), {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  } catch (error) {
    console.error("[Routes] handleSaveMemoryInstructions error:", error);
    return new Response(
      renderSaveError("Failed to save memory instructions"),
      {
        status: 500,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      },
    );
  }
}

/**
 * Handle POST /api/mcp/sync - Manually trigger MCP sync
 *
 * Triggers an immediate pull + push with entity-core.
 * Useful for testing or when you need to sync immediately.
 *
 * @param ctx - Route context
 * @returns HTTP Response with JSON result
 */
export async function handleMcpSync(ctx: RouteContext): Promise<Response> {
  if (!ctx.mcpClient) {
    return new Response(
      JSON.stringify({
        success: false,
        error:
          "MCP is not enabled. Set PSYCHEROS_MCP_ENABLED=true to use entity-core sync.",
      }),
      {
        status: 400,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      },
    );
  }

  try {
    // Check if connected
    if (!ctx.mcpClient.isConnected()) {
      return new Response(
        JSON.stringify({
          success: false,
          connected: false,
          message: "MCP client is not connected to entity-core",
        }),
        {
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          },
        },
      );
    }

    // Pull latest from entity-core. Pending local writes flow through
    // the scheduler's `mcp.push-identity-change` queue automatically —
    // I report how many are still in flight so the user can see them.
    const identity = await ctx.mcpClient.pull();
    const pending = ctx.mcpClient.getPendingCount();

    const result: {
      success: boolean;
      connected: boolean;
      pulled?: {
        self: number;
        user: number;
        relationship: number;
      };
      pending: {
        identity: number;
      };
    } = {
      success: true,
      connected: true,
      pending,
    };

    if (identity) {
      result.pulled = {
        self: identity.self.length,
        user: identity.user.length,
        relationship: identity.relationship.length,
      };
    }

    return new Response(JSON.stringify(result), {
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    });
  } catch (error) {
    console.error("[Routes] handleMcpSync error:", error);
    return new Response(
      JSON.stringify({ success: false, error: "MCP sync failed" }),
      {
        status: 500,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      },
    );
  }
}

// =============================================================================
// Snapshot Routes
// =============================================================================

/**
 * Handle GET /api/snapshots - List all snapshots
 *
 * Returns snapshots grouped by category with metadata.
 *
 * @param ctx - Route context
 * @returns HTTP Response with JSON result
 */
export async function handleListSnapshots(
  ctx: RouteContext,
): Promise<Response> {
  // Snapshots are centralized in entity-core - require MCP connection
  if (!ctx.mcpClient) {
    return new Response(
      JSON.stringify({
        success: false,
        error: "Snapshots require entity-core connection. Please enable MCP.",
      }),
      {
        status: 503,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      },
    );
  }

  const result = await ctx.mcpClient.listSnapshots();

  if (!result.success) {
    return new Response(
      JSON.stringify({ success: false, error: result.error }),
      {
        status: 500,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      },
    );
  }

  return new Response(JSON.stringify(result), {
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

/**
 * Handle GET /api/snapshots/:id - Get snapshot content
 *
 * @param ctx - Route context
 * @param snapshotId - The snapshot ID (category/filename_timestamp)
 * @returns HTTP Response with JSON result
 */
export async function handleGetSnapshot(
  ctx: RouteContext,
  snapshotId: string,
): Promise<Response> {
  // Snapshots are centralized in entity-core - require MCP connection
  if (!ctx.mcpClient) {
    return new Response(
      JSON.stringify({
        success: false,
        error: "Snapshots require entity-core connection. Please enable MCP.",
      }),
      {
        status: 503,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      },
    );
  }

  const decodedId = decodeURIComponent(snapshotId);
  const result = await ctx.mcpClient.getSnapshotContent(decodedId);

  if (!result.success) {
    return new Response(
      JSON.stringify({ success: false, error: result.error }),
      {
        status: 404,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      },
    );
  }

  return new Response(JSON.stringify(result), {
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

/**
 * Handle POST /api/snapshots/:id/restore - Restore snapshot
 *
 * @param ctx - Route context
 * @param snapshotId - The snapshot ID to restore
 * @returns HTTP Response with JSON result
 */
export async function handleRestoreSnapshot(
  ctx: RouteContext,
  snapshotId: string,
): Promise<Response> {
  // Decode URL-encoded snapshot ID (e.g., custom%2Fmy_facets -> custom/my_facets)
  const decodedId = decodeURIComponent(snapshotId);

  // Local snapshot: ID is a filesystem path
  if (decodedId.startsWith("/")) {
    const manager = new IdentityFileManager(
      ctx.mcpClient ?? null,
      ctx.dataRoot,
    );
    const result = await manager.restoreFromSnapshot(decodedId);

    if (!result.success) {
      const errorHtml = `<div class="snapshot-error">Local restore failed: ${
        escapeHtml(result.message || "Unknown error")
      }</div>`;
      return new Response(errorHtml, {
        status: 500,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    // Return entity-core snapshots view after restore
    const localSnapshots = await manager.listSnapshots();
    const snapshots = localSnapshots.map((s) => ({
      id: s.path,
      category: s.category,
      filename: s.filename,
      timestamp: s.date,
      date: s.date,
      reason: "local",
      source: "local" as const,
    }));
    const html = renderEntityCoreSnapshots(snapshots);
    return new Response(html, {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }

  // Entity-core snapshot
  if (!ctx.mcpClient) {
    return new Response(
      `<div class="snapshot-error">Snapshots require entity-core connection. Please enable MCP.</div>`,
      {
        status: 503,
        headers: {
          "Content-Type": "text/html; charset=utf-8",
        },
      },
    );
  }

  const result = await ctx.mcpClient.restoreSnapshot(decodedId);

  if (!result.success) {
    const errorHtml = `<div class="snapshot-error">Restore failed: ${
      escapeHtml(result.error || "Unknown error")
    }</div>`;
    return new Response(errorHtml, {
      status: 500,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
      },
    });
  }

  // Sync restored file to local disk so Core Prompts UI shows updated content.
  // pull() (called inside restoreSnapshot) updates the in-memory cache, but the
  // Core Prompts UI reads identity files from disk at projectRoot/identity/.
  const idMatch = decodedId.match(/^(.+)\/(.+)_\d{4}-\d{2}-\d{2}T[\d-]+Z$/);
  if (idMatch) {
    const [, cat, filenamePart] = idMatch;
    const fname = `${filenamePart}.md`;
    const identity = await ctx.mcpClient.loadIdentity();
    const files = identity
      ?.[cat as "self" | "user" | "relationship" | "custom"];
    const restored = files?.find((f: { filename: string }) =>
      f.filename === fname
    );
    if (restored) {
      try {
        const localPath = `${ctx.dataRoot}/identity/${cat}/${fname}`;
        await Deno.mkdir(`${ctx.dataRoot}/identity/${cat}`, {
          recursive: true,
        });
        await Deno.writeTextFile(localPath, restored.content);
      } catch (error) {
        console.error(
          "[Snapshot] Failed to sync restored file to local disk:",
          error,
        );
      }
    }
  }

  // Fetch updated list and return HTML
  const listResult = await ctx.mcpClient.listSnapshots();
  const html = renderSnapshotsView(listResult.snapshots || []);
  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
    },
  });
}

/**
 * Handle POST /api/snapshots/create - Create manual snapshot
 *
 * @param ctx - Route context
 * @returns HTTP Response with JSON result
 */
export async function handleCreateSnapshot(
  ctx: RouteContext,
): Promise<Response> {
  // Snapshots are centralized in entity-core - require MCP connection
  if (!ctx.mcpClient) {
    return new Response(
      JSON.stringify({
        success: false,
        error: "Snapshots require entity-core connection. Please enable MCP.",
      }),
      {
        status: 503,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      },
    );
  }

  const result = await ctx.mcpClient.createSnapshot();

  if (!result.success) {
    const html =
      `<div class="snapshot-error">Failed to create snapshot: ${result.error}</div>`;
    return new Response(html, {
      status: 500,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
      },
    });
  }

  // Fetch updated list and return HTML
  const listResult = await ctx.mcpClient.listSnapshots();
  const html = renderSnapshotsView(listResult.snapshots || []);
  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
    },
  });
}

/**
 * Handle GET /fragments/settings/snapshots - Snapshot list fragment
 *
 * @param ctx - Route context
 * @returns HTTP Response with HTML fragment
 */
export async function handleSnapshotsFragment(
  ctx: RouteContext,
): Promise<Response> {
  // Snapshots are centralized in entity-core - require MCP connection
  if (!ctx.mcpClient) {
    const html =
      `<div class="snapshot-error">Snapshots require entity-core connection. Please enable MCP.</div>`;
    return new Response(html, {
      status: 503,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
      },
    });
  }

  const result = await ctx.mcpClient.listSnapshots();
  const html = renderSnapshotsView(result.snapshots || []);
  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
    },
  });
}

/**
 * Handle GET /fragments/settings/snapshots/:id - Snapshot preview fragment
 *
 * @param ctx - Route context
 * @param snapshotId - The snapshot ID to preview
 * @returns HTTP Response with HTML fragment
 */
export async function handleSnapshotPreviewFragment(
  ctx: RouteContext,
  snapshotId: string,
): Promise<Response> {
  // Snapshots are centralized in entity-core - require MCP connection
  if (!ctx.mcpClient) {
    return new Response(
      `<div class="snapshot-error">Snapshots require entity-core connection. Please enable MCP.</div>`,
      {
        status: 503,
        headers: {
          "Content-Type": "text/html; charset=utf-8",
        },
      },
    );
  }

  // Decode URL-encoded snapshot ID (e.g., self%2Ffilename -> self/filename)
  const decodedId = decodeURIComponent(snapshotId);
  const result = await ctx.mcpClient.getSnapshotContent(decodedId);

  if (!result.success || !result.content) {
    return new Response(
      `<div class="snapshot-error">Failed to load snapshot: ${
        escapeHtml(result.error || "Unknown error")
      }</div>`,
      {
        status: 404,
        headers: {
          "Content-Type": "text/html; charset=utf-8",
        },
      },
    );
  }

  // Parse snapshot ID to get category and filename
  const match = decodedId.match(/^(.+)\/(.+)_\d{4}-\d{2}-\d{2}T[\d-]+Z$/);
  if (!match) {
    return new Response(
      `<div class="snapshot-error">Invalid snapshot ID</div>`,
      {
        status: 400,
        headers: {
          "Content-Type": "text/html; charset=utf-8",
        },
      },
    );
  }

  const [, category, filenamePart] = match;
  const filename = `${filenamePart}.md`;

  // Import SnapshotCategory from the types file - use string type
  type SnapshotCategoryType = "self" | "user" | "relationship" | "custom";

  const html = renderSnapshotPreview(
    category as SnapshotCategoryType,
    filename,
    result.content,
    decodedId,
  );

  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
    },
  });
}

// =============================================================================
// Lorebook Routes
// =============================================================================

/**
 * Handle GET /api/lorebooks - List all lorebooks
 */
export function handleListLorebooks(ctx: RouteContext): Response {
  if (!ctx.lorebookManager) {
    return new Response(
      JSON.stringify({ error: "Lorebook system not available" }),
      {
        status: 503,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      },
    );
  }

  const lorebooks = ctx.lorebookManager.listLorebooks();
  return new Response(JSON.stringify(lorebooks), {
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

/**
 * Handle POST /api/lorebooks - Create a new lorebook
 */
export async function handleCreateLorebook(
  ctx: RouteContext,
  request: Request,
): Promise<Response> {
  if (!ctx.lorebookManager) {
    return new Response(
      JSON.stringify({ error: "Lorebook system not available" }),
      {
        status: 503,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      },
    );
  }

  try {
    const contentType = request.headers.get("content-type") || "";
    let name: string;
    let description: string | undefined;

    if (contentType.includes("application/x-www-form-urlencoded")) {
      const formData = await request.formData();
      name = formData.get("name") as string;
      description = formData.get("description") as string || undefined;
    } else {
      const body = await request.json();
      name = body.name;
      description = body.description;
    }

    if (!name || typeof name !== "string") {
      return new Response(
        JSON.stringify({ error: "Missing or invalid name" }),
        {
          status: 400,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          },
        },
      );
    }

    ctx.lorebookManager.createLorebook({
      name,
      description,
      enabled: true,
    });

    // Return updated list for HTMX
    const lorebooks = ctx.lorebookManager.listLorebooks();
    const html = renderLorebooksView(lorebooks);
    return new Response(html, {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  } catch (error) {
    console.error("[Routes] handleCreateLorebook error:", error);
    return new Response(
      JSON.stringify({ error: "Failed to create lorebook" }),
      {
        status: 500,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      },
    );
  }
}

/**
 * Handle GET /api/lorebooks/:id - Get a lorebook with entries
 */
export function handleGetLorebook(
  ctx: RouteContext,
  lorebookId: string,
): Response {
  if (!ctx.lorebookManager) {
    return new Response(
      JSON.stringify({ error: "Lorebook system not available" }),
      {
        status: 503,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      },
    );
  }

  const lorebook = ctx.lorebookManager.getLorebook(lorebookId);
  if (!lorebook) {
    return new Response(
      JSON.stringify({ error: "Lorebook not found" }),
      {
        status: 404,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      },
    );
  }

  const entries = ctx.lorebookManager.listEntries(lorebookId);

  return new Response(JSON.stringify({ ...lorebook, entries }), {
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

/**
 * Handle PUT /api/lorebooks/:id - Update a lorebook
 */
export async function handleUpdateLorebook(
  ctx: RouteContext,
  lorebookId: string,
  request: Request,
): Promise<Response> {
  if (!ctx.lorebookManager) {
    return new Response(
      JSON.stringify({ error: "Lorebook system not available" }),
      {
        status: 503,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      },
    );
  }

  try {
    const contentType = request.headers.get("content-type") || "";
    let body: Record<string, unknown>;

    if (contentType.includes("application/x-www-form-urlencoded")) {
      const formData = await request.formData();
      body = { name: formData.get("name") as string };
      const desc = formData.get("description") as string | null;
      if (desc !== null) body.description = desc;
    } else {
      body = await request.json();
    }

    const lorebook = ctx.lorebookManager.updateLorebook(lorebookId, body);

    if (!lorebook) {
      return new Response(
        JSON.stringify({ error: "Lorebook not found" }),
        {
          status: 404,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          },
        },
      );
    }

    // If form-encoded (HTMX), return the updated list view
    if (contentType.includes("application/x-www-form-urlencoded")) {
      const lorebooks = ctx.lorebookManager.listLorebooks();
      const html = renderLorebooksView(lorebooks);
      return new Response(html, {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    return new Response(JSON.stringify(lorebook), {
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    });
  } catch (error) {
    console.error("[Routes] handleUpdateLorebook error:", error);
    return new Response(
      JSON.stringify({ error: "Failed to update lorebook" }),
      {
        status: 500,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      },
    );
  }
}

/**
 * Handle DELETE /api/lorebooks/:id - Delete a lorebook
 */
export function handleDeleteLorebook(
  ctx: RouteContext,
  lorebookId: string,
): Response {
  if (!ctx.lorebookManager) {
    return new Response(
      JSON.stringify({ error: "Lorebook system not available" }),
      {
        status: 503,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      },
    );
  }

  const deleted = ctx.lorebookManager.deleteLorebook(lorebookId);
  if (!deleted) {
    return new Response(
      JSON.stringify({ error: "Lorebook not found" }),
      {
        status: 404,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      },
    );
  }

  // Return updated list for HTMX
  const lorebooks = ctx.lorebookManager.listLorebooks();
  const html = renderLorebooksView(lorebooks);
  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

/**
 * Handle GET /api/lorebooks/:id/entries - List entries for a lorebook
 */
export function handleListLorebookEntries(
  ctx: RouteContext,
  lorebookId: string,
): Response {
  if (!ctx.lorebookManager) {
    return new Response(
      JSON.stringify({ error: "Lorebook system not available" }),
      {
        status: 503,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      },
    );
  }

  const entries = ctx.lorebookManager.listEntries(lorebookId);
  return new Response(JSON.stringify(entries), {
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

/**
 * Handle POST /api/lorebooks/:id/entries - Create an entry
 */
export async function handleCreateLorebookEntry(
  ctx: RouteContext,
  lorebookId: string,
  request: Request,
): Promise<Response> {
  if (!ctx.lorebookManager) {
    return new Response(
      JSON.stringify({ error: "Lorebook system not available" }),
      {
        status: 503,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      },
    );
  }

  try {
    const contentType = request.headers.get("content-type") || "";
    let name: string;
    let content: string;
    let triggers: string[];
    let triggerMode: string | undefined;
    let caseSensitive: boolean = false;
    let sticky: boolean = false;
    let stickyDuration: number = 0;
    let nonRecursable: boolean = false;
    let preventRecursion: boolean = false;
    let reTriggerResetsTimer: boolean = true;
    let enabled: boolean = true;
    let priority: number = 0;
    let scanDepth: number = 5;
    let maxTokens: number = 0;

    if (contentType.includes("application/x-www-form-urlencoded")) {
      const formData = await request.formData();
      name = formData.get("name") as string;
      content = formData.get("content") as string;
      triggers = (formData.get("triggers") as string)
        .split(",")
        .map((t) => t.trim())
        .filter((t) => t.length > 0);
      triggerMode = formData.get("triggerMode") as string || undefined;
      caseSensitive = formData.has("caseSensitive");
      sticky = formData.has("sticky");
      nonRecursable = formData.has("nonRecursable");
      preventRecursion = formData.has("preventRecursion");
      reTriggerResetsTimer = formData.has("reTriggerResetsTimer");
      enabled = formData.has("enabled");
      stickyDuration = parseInt(formData.get("stickyDuration") as string) || 0;
      priority = parseInt(formData.get("priority") as string) || 0;
      scanDepth = parseInt(formData.get("scanDepth") as string) || 5;
      maxTokens = parseInt(formData.get("maxTokens") as string) || 0;
    } else {
      const body = await request.json();
      name = body.name;
      content = body.content;
      triggers = body.triggers;
      triggerMode = body.triggerMode;
      caseSensitive = body.caseSensitive ?? false;
      sticky = body.sticky ?? false;
      stickyDuration = body.stickyDuration ?? 0;
      nonRecursable = body.nonRecursable ?? false;
      preventRecursion = body.preventRecursion ?? false;
      reTriggerResetsTimer = body.reTriggerResetsTimer ?? true;
      enabled = body.enabled ?? true;
      priority = body.priority ?? 0;
      scanDepth = body.scanDepth ?? 5;
      maxTokens = body.maxTokens ?? 0;
    }

    if (!name || typeof name !== "string") {
      return new Response(
        JSON.stringify({ error: "Missing or invalid name" }),
        {
          status: 400,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          },
        },
      );
    }
    if (!content || typeof content !== "string") {
      return new Response(
        JSON.stringify({ error: "Missing or invalid content" }),
        {
          status: 400,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          },
        },
      );
    }
    if (!triggers || !Array.isArray(triggers) || triggers.length === 0) {
      return new Response(
        JSON.stringify({ error: "Missing or invalid triggers array" }),
        {
          status: 400,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          },
        },
      );
    }

    ctx.lorebookManager.createEntry(lorebookId, {
      name,
      content,
      triggers,
      triggerMode: triggerMode as
        | "substring"
        | "word"
        | "exact"
        | "regex"
        | undefined,
      caseSensitive,
      sticky,
      stickyDuration,
      nonRecursable,
      preventRecursion,
      reTriggerResetsTimer,
      enabled,
      priority,
      scanDepth,
      maxTokens,
    });

    // Return updated view for HTMX
    const lorebook = ctx.lorebookManager.getLorebook(lorebookId);
    const entries = ctx.lorebookManager.listEntries(lorebookId);
    if (!lorebook) {
      return new Response(
        JSON.stringify({ error: "Lorebook not found" }),
        { status: 404, headers: { "Content-Type": "application/json" } },
      );
    }
    const html = renderLorebookDetailView(lorebook, entries);
    return new Response(html, {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  } catch (error) {
    console.error("[Routes] handleCreateLorebookEntry error:", error);
    return new Response(
      JSON.stringify({ error: "Failed to create entry" }),
      {
        status: 500,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      },
    );
  }
}

/**
 * Handle PUT /api/lorebooks/:bookId/entries/:entryId - Update an entry
 */
export async function handleUpdateLorebookEntry(
  ctx: RouteContext,
  _lorebookId: string,
  entryId: string,
  request: Request,
): Promise<Response> {
  if (!ctx.lorebookManager) {
    return new Response(
      JSON.stringify({ error: "Lorebook system not available" }),
      {
        status: 503,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      },
    );
  }

  try {
    const contentType = request.headers.get("content-type") || "";
    let updateData: Record<string, unknown> = {};

    if (contentType.includes("application/x-www-form-urlencoded")) {
      const formData = await request.formData();
      if (formData.get("name")) updateData.name = formData.get("name");
      if (formData.get("content")) updateData.content = formData.get("content");
      if (formData.get("triggers")) {
        updateData.triggers = (formData.get("triggers") as string)
          .split(",")
          .map((t) => t.trim())
          .filter((t) => t.length > 0);
      }
      if (formData.get("triggerMode")) {
        updateData.triggerMode = formData.get("triggerMode");
      }
      updateData.caseSensitive = formData.has("caseSensitive");
      updateData.sticky = formData.has("sticky");
      updateData.nonRecursable = formData.has("nonRecursable");
      updateData.preventRecursion = formData.has("preventRecursion");
      updateData.reTriggerResetsTimer = formData.has("reTriggerResetsTimer");
      updateData.enabled = formData.has("enabled");
      if (formData.get("stickyDuration")) {
        updateData.stickyDuration = parseInt(
          formData.get("stickyDuration") as string,
        );
      }
      if (formData.get("priority")) {
        updateData.priority = parseInt(formData.get("priority") as string);
      }
      if (formData.get("scanDepth")) {
        updateData.scanDepth = parseInt(formData.get("scanDepth") as string);
      }
      if (formData.get("maxTokens")) {
        updateData.maxTokens = parseInt(formData.get("maxTokens") as string);
      }
    } else {
      const body = await request.json();
      updateData = body;
    }

    const entry = ctx.lorebookManager.updateEntry(entryId, updateData);

    if (!entry) {
      return new Response(
        JSON.stringify({ error: "Entry not found" }),
        {
          status: 404,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          },
        },
      );
    }

    // Return updated view for HTMX
    const lorebook = ctx.lorebookManager.getLorebook(entry.bookId);
    const entries = ctx.lorebookManager.listEntries(entry.bookId);
    if (!lorebook) {
      return new Response(
        JSON.stringify({ error: "Lorebook not found" }),
        { status: 404, headers: { "Content-Type": "application/json" } },
      );
    }
    const html = renderLorebookDetailView(lorebook, entries);
    return new Response(html, {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  } catch (error) {
    console.error("[Routes] handleUpdateLorebookEntry error:", error);
    return new Response(
      JSON.stringify({ error: "Failed to update entry" }),
      {
        status: 500,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      },
    );
  }
}

/**
 * Handle DELETE /api/lorebooks/:bookId/entries/:entryId - Delete an entry
 */
export function handleDeleteLorebookEntry(
  ctx: RouteContext,
  lorebookId: string,
  entryId: string,
): Response {
  if (!ctx.lorebookManager) {
    return new Response(
      JSON.stringify({ error: "Lorebook system not available" }),
      {
        status: 503,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      },
    );
  }

  const deleted = ctx.lorebookManager.deleteEntry(entryId);
  if (!deleted) {
    return new Response(
      JSON.stringify({ error: "Entry not found" }),
      {
        status: 404,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      },
    );
  }

  // Return updated view for HTMX
  const lorebook = ctx.lorebookManager.getLorebook(lorebookId);
  const entries = ctx.lorebookManager.listEntries(lorebookId);
  if (!lorebook) {
    return new Response(
      JSON.stringify({ error: "Lorebook not found" }),
      { status: 404, headers: { "Content-Type": "application/json" } },
    );
  }
  const html = renderLorebookDetailView(lorebook, entries);
  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

/**
 * Handle DELETE /api/lorebooks/state/:conversationId - Reset sticky state
 */
export function handleResetLorebookState(
  ctx: RouteContext,
  conversationId: string,
): Response {
  if (!ctx.lorebookManager) {
    return new Response(
      JSON.stringify({ error: "Lorebook system not available" }),
      {
        status: 503,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      },
    );
  }

  ctx.lorebookManager.resetState(conversationId);

  return new Response(
    JSON.stringify({ success: true }),
    {
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    },
  );
}

/**
 * Handle POST /api/lorebooks/import-sillytavern - Import a SillyTavern lorebook
 */
export async function handleImportSillyTavernLorebook(
  ctx: RouteContext,
  request: Request,
): Promise<Response> {
  if (!ctx.lorebookManager) {
    return new Response(
      JSON.stringify({ error: "Lorebook system not available" }),
      {
        status: 503,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      },
    );
  }

  try {
    const contentType = request.headers.get("content-type") || "";
    let jsonData: Record<string, unknown>;
    let fileName: string;

    if (contentType.includes("multipart/form-data")) {
      const formData = await request.formData();
      const file = formData.get("file") as File | null;
      if (!file) {
        return new Response(
          JSON.stringify({ error: "No file provided" }),
          {
            status: 400,
            headers: {
              "Content-Type": "application/json",
              "Access-Control-Allow-Origin": "*",
            },
          },
        );
      }
      fileName = file.name.replace(/\.json$/i, "") || "Imported Lorebook";
      const text = await file.text();
      jsonData = JSON.parse(text);
    } else {
      const body = await request.json();
      jsonData = body.lorebook || body;
      fileName = body.name || "Imported Lorebook";
    }

    // Validate SillyTavern format
    const stEntries = jsonData.entries;
    if (
      !stEntries || typeof stEntries !== "object" || Array.isArray(stEntries)
    ) {
      return new Response(
        JSON.stringify({
          error: "Invalid SillyTavern lorebook format: missing entries object",
        }),
        {
          status: 400,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          },
        },
      );
    }

    // Create the lorebook
    const lorebook = ctx.lorebookManager.createLorebook({
      name: fileName,
      description: "Imported from SillyTavern",
      enabled: true,
    });

    let entryCount = 0;
    const errors: string[] = [];

    for (const [_key, entry] of Object.entries(stEntries)) {
      if (!entry || typeof entry !== "object") continue;

      const e = entry as Record<string, unknown>;
      try {
        const entryKey = Array.isArray(e.key) ? e.key : [];
        const name = (typeof e.comment === "string" && e.comment.trim())
          ? e.comment.trim()
          : (entryKey.length > 0 && typeof entryKey[0] === "string")
          ? entryKey[0].trim()
          : "Untitled";

        const content = typeof e.content === "string" ? e.content : "";

        if (!content.trim()) {
          errors.push(`Skipped entry "${name}": empty content`);
          continue;
        }

        const triggers = entryKey
          .filter((k): k is string => typeof k === "string")
          .map((k) => k.trim())
          .filter((k) => k.length > 0);

        ctx.lorebookManager.createEntry(lorebook.id, {
          name,
          content,
          triggers,
          enabled: e.enabled !== false,
          priority: typeof e.insertion_order === "number"
            ? e.insertion_order
            : 10,
          preventRecursion: !!e.preventRecursion,
          scanDepth: typeof e.depth === "number"
            ? e.depth
            : typeof e.scan_depth === "number"
            ? e.scan_depth
            : 5,
          caseSensitive: !!e.caseSensitive,
          triggerMode: "substring",
          sticky: !!e.constant,
        });
        entryCount++;
      } catch (err) {
        errors.push(
          `Failed to import entry "${
            (e.comment as string) || "unknown"
          }": ${err}`,
        );
      }
    }

    // If form-encoded (HTMX), return the updated list view
    if (contentType.includes("multipart/form-data")) {
      const lorebooks = ctx.lorebookManager.listLorebooks();
      const html = renderLorebooksView(lorebooks);
      return new Response(html, {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    return new Response(
      JSON.stringify({
        success: true,
        bookId: lorebook.id,
        entryCount,
        errors,
      }),
      {
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      },
    );
  } catch (error) {
    console.error("[Routes] handleImportSillyTavernLorebook error:", error);
    return new Response(
      JSON.stringify({
        error: "Failed to import lorebook: " +
          (error instanceof Error ? error.message : String(error)),
      }),
      {
        status: 400,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      },
    );
  }
}

// =============================================================================
// Lorebook Fragment Handlers
// =============================================================================

/**
 * Handle GET /fragments/settings/lorebooks - Lorebooks list view
 */
export function handleLorebooksFragment(ctx: RouteContext): Response {
  if (!ctx.lorebookManager) {
    return new Response(
      '<div class="error">Lorebook system not available</div>',
      { headers: { "Content-Type": "text/html; charset=utf-8" } },
    );
  }

  const lorebooks = ctx.lorebookManager.listLorebooks();
  const html = renderLorebooksView(lorebooks);
  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

/**
 * Handle GET /fragments/settings/lorebooks/:id - Single lorebook view
 */
export function handleLorebookDetailFragment(
  ctx: RouteContext,
  lorebookId: string,
): Response {
  if (!ctx.lorebookManager) {
    return new Response(
      '<div class="error">Lorebook system not available</div>',
      { headers: { "Content-Type": "text/html; charset=utf-8" } },
    );
  }

  const lorebook = ctx.lorebookManager.getLorebook(lorebookId);
  if (!lorebook) {
    return new Response(
      '<div class="error">Lorebook not found</div>',
      { status: 404, headers: { "Content-Type": "text/html; charset=utf-8" } },
    );
  }

  const entries = ctx.lorebookManager.listEntries(lorebookId);
  const html = renderLorebookDetailView(lorebook, entries);
  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

/**
 * Handle GET /fragments/settings/lorebooks/:bookId/entries/:entryId/edit - Entry editor
 */
export function handleLorebookEntryEditFragment(
  ctx: RouteContext,
  _bookId: string,
  entryId: string,
): Response {
  if (!ctx.lorebookManager) {
    return new Response(
      '<div class="error">Lorebook system not available</div>',
      { headers: { "Content-Type": "text/html; charset=utf-8" } },
    );
  }

  const entry = ctx.lorebookManager.getEntry(entryId);
  if (!entry) {
    return new Response(
      '<div class="error">Entry not found</div>',
      { status: 404, headers: { "Content-Type": "text/html; charset=utf-8" } },
    );
  }

  const html = renderEntryEditor(entry);
  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

// =============================================================================
// Knowledge Graph Routes
// =============================================================================

/**
 * Handle GET /api/graph/data - Get full graph data for visualization
 *
 * @param ctx - Route context
 * @returns HTTP Response with JSON graph data
 */
export async function handleGetGraphData(ctx: RouteContext): Promise<Response> {
  if (!ctx.mcpClient) {
    return new Response(
      JSON.stringify({
        error: "Knowledge Graph requires entity-core connection",
      }),
      {
        status: 503,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      },
    );
  }

  try {
    const [nodes, edges, stats] = await Promise.all([
      ctx.mcpClient.getGraphNodes({ limit: 500 }),
      ctx.mcpClient.getGraphEdges(),
      ctx.mcpClient.getGraphStats(),
    ]);

    return new Response(
      JSON.stringify({ nodes, edges, stats }),
      {
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      },
    );
  } catch (error) {
    console.error("[Graph] Failed to get graph data:", error);
    return new Response(
      JSON.stringify({ error: "Failed to fetch graph data" }),
      {
        status: 500,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      },
    );
  }
}

/**
 * Handle POST /api/graph/nodes - Create a graph node
 *
 * @param ctx - Route context
 * @param request - HTTP request with node data
 * @returns HTTP Response with result
 */
export async function handleCreateGraphNode(
  ctx: RouteContext,
  request: Request,
): Promise<Response> {
  if (!ctx.mcpClient) {
    return new Response(
      JSON.stringify({
        success: false,
        error: "Knowledge Graph requires entity-core connection",
      }),
      {
        status: 503,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      },
    );
  }

  try {
    const body = await request.json();
    const result = await ctx.mcpClient.createGraphNode(body);
    return new Response(JSON.stringify(result), {
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    });
  } catch (error) {
    console.error("[Graph] Failed to create node:", error);
    return new Response(
      JSON.stringify({ success: false, error: "Failed to create node" }),
      {
        status: 500,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      },
    );
  }
}

/**
 * Handle POST /api/graph/edges - Create a graph edge
 *
 * @param ctx - Route context
 * @param request - HTTP request with edge data
 * @returns HTTP Response with result
 */
export async function handleCreateGraphEdge(
  ctx: RouteContext,
  request: Request,
): Promise<Response> {
  if (!ctx.mcpClient) {
    return new Response(
      JSON.stringify({
        success: false,
        error: "Knowledge Graph requires entity-core connection",
      }),
      {
        status: 503,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      },
    );
  }

  try {
    const body = await request.json();
    const result = await ctx.mcpClient.createGraphEdge(body);
    return new Response(JSON.stringify(result), {
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    });
  } catch (error) {
    console.error("[Graph] Failed to create edge:", error);
    return new Response(
      JSON.stringify({ success: false, error: "Failed to create edge" }),
      {
        status: 500,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      },
    );
  }
}

/**
 * Handle DELETE /api/graph/nodes/:id - Delete a graph node
 *
 * @param ctx - Route context
 * @param nodeId - Node ID to delete
 * @returns HTTP Response with result
 */
export async function handleDeleteGraphNode(
  ctx: RouteContext,
  nodeId: string,
): Promise<Response> {
  if (!ctx.mcpClient) {
    return new Response(
      JSON.stringify({
        success: false,
        error: "Knowledge Graph requires entity-core connection",
      }),
      {
        status: 503,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      },
    );
  }

  const result = await ctx.mcpClient.deleteGraphNode(nodeId);
  return new Response(JSON.stringify(result), {
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

/**
 * Handle DELETE /api/graph/edges/:id - Delete a graph edge
 *
 * @param ctx - Route context
 * @param edgeId - Edge ID to delete
 * @returns HTTP Response with result
 */
export async function handleDeleteGraphEdge(
  ctx: RouteContext,
  edgeId: string,
): Promise<Response> {
  if (!ctx.mcpClient) {
    return new Response(
      JSON.stringify({
        success: false,
        error: "Knowledge Graph requires entity-core connection",
      }),
      {
        status: 503,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      },
    );
  }

  const result = await ctx.mcpClient.deleteGraphEdge(edgeId);
  return new Response(JSON.stringify(result), {
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

/**
 * Handle PUT /api/graph/nodes/:id - Update a graph node
 */
export async function handleUpdateGraphNode(
  ctx: RouteContext,
  request: Request,
  nodeId: string,
): Promise<Response> {
  if (!ctx.mcpClient) {
    return new Response(
      JSON.stringify({
        success: false,
        error: "Knowledge Graph requires entity-core connection",
      }),
      {
        status: 503,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      },
    );
  }

  try {
    const body = await request.json();
    const result = await ctx.mcpClient.updateGraphNode(nodeId, body);
    return new Response(JSON.stringify(result), {
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    });
  } catch (error) {
    console.error("[Graph] Failed to update node:", error);
    return new Response(
      JSON.stringify({ success: false, error: "Failed to update node" }),
      {
        status: 500,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      },
    );
  }
}

/**
 * Handle PUT /api/graph/edges/:id - Update a graph edge
 */
export async function handleUpdateGraphEdge(
  ctx: RouteContext,
  request: Request,
  edgeId: string,
): Promise<Response> {
  if (!ctx.mcpClient) {
    return new Response(
      JSON.stringify({
        success: false,
        error: "Knowledge Graph requires entity-core connection",
      }),
      {
        status: 503,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      },
    );
  }

  try {
    const body = await request.json();
    const result = await ctx.mcpClient.updateGraphEdge(edgeId, body);
    return new Response(JSON.stringify(result), {
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    });
  } catch (error) {
    console.error("[Graph] Failed to update edge:", error);
    return new Response(
      JSON.stringify({ success: false, error: "Failed to update edge" }),
      {
        status: 500,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      },
    );
  }
}

// =============================================================================
// Background Image Upload Routes
// =============================================================================

/**
 * Handle GET /api/backgrounds - List uploaded background images
 *
 * @param ctx - Route context
 * @returns HTTP Response with JSON array of backgrounds
 */
export async function handleListBackgrounds(
  ctx: RouteContext,
): Promise<Response> {
  const backgroundsDir = `${ctx.dataRoot}/.psycheros/backgrounds`;
  const backgrounds: Array<{ filename: string; url: string }> = [];

  try {
    for await (const entry of Deno.readDir(backgroundsDir)) {
      if (entry.isFile && /\.(jpg|jpeg|png|gif|webp)$/i.test(entry.name)) {
        backgrounds.push({
          filename: entry.name,
          url: `/backgrounds/${entry.name}`,
        });
      }
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) {
      throw error;
    }
  }

  return new Response(JSON.stringify({ backgrounds }), {
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

/**
 * Handle POST /api/backgrounds - Upload a background image
 *
 * @param ctx - Route context
 * @param request - HTTP Request with multipart form data
 * @returns HTTP Response with JSON result
 */
export async function handleUploadBackground(
  ctx: RouteContext,
  request: Request,
): Promise<Response> {
  try {
    const formData = await request.formData();
    const file = formData.get("background");

    if (!file || !(file instanceof File)) {
      return new Response(
        JSON.stringify({ error: "No file provided" }),
        {
          status: 400,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          },
        },
      );
    }

    // Validate file type
    if (!ALLOWED_IMAGE_TYPES.includes(file.type)) {
      return new Response(
        JSON.stringify({
          error: "Invalid file type. Allowed: JPEG, PNG, GIF, WebP",
        }),
        {
          status: 400,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          },
        },
      );
    }

    // Validate file size
    if (file.size > MAX_BACKGROUND_SIZE) {
      return new Response(
        JSON.stringify({ error: "File too large. Maximum size: 5MB" }),
        {
          status: 400,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          },
        },
      );
    }

    // Ensure backgrounds directory exists (inside .psycheros/ for persistence across container rebuilds)
    const backgroundsDir = `${ctx.dataRoot}/.psycheros/backgrounds`;
    await Deno.mkdir(backgroundsDir, { recursive: true });

    // Generate unique filename
    const timestamp = Date.now();
    const randomSuffix = Math.random().toString(36).substring(2, 8);
    const ext = file.name.split(".").pop()?.toLowerCase() || "png";
    const filename = `bg-${timestamp}-${randomSuffix}.${ext}`;

    // Write file
    const filePath = `${backgroundsDir}/${filename}`;
    const arrayBuffer = await file.arrayBuffer();
    await Deno.writeFile(filePath, new Uint8Array(arrayBuffer));

    return new Response(
      JSON.stringify({
        success: true,
        filename,
        url: `/backgrounds/${filename}`,
      }),
      {
        status: 201,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      },
    );
  } catch (error) {
    console.error("[Routes] handleUploadBackground error:", error);
    return new Response(
      JSON.stringify({ error: "Upload failed" }),
      {
        status: 500,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      },
    );
  }
}

/**
 * Handle DELETE /api/backgrounds/:filename - Delete a background image
 *
 * @param ctx - Route context
 * @param filename - The filename to delete
 * @returns HTTP Response with JSON result
 */
export async function handleDeleteBackground(
  ctx: RouteContext,
  filename: string,
): Promise<Response> {
  // Sanitize filename - only allow safe characters
  const decodedFilename = decodeURIComponent(filename);
  if (!/^[a-zA-Z0-9_.-]+$/.test(decodedFilename)) {
    return new Response(
      JSON.stringify({ error: "Invalid filename" }),
      {
        status: 400,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      },
    );
  }

  // Only allow image files
  if (!/\.(jpg|jpeg|png|gif|webp)$/i.test(decodedFilename)) {
    return new Response(
      JSON.stringify({ error: "Invalid file type" }),
      {
        status: 400,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      },
    );
  }

  try {
    const filePath =
      `${ctx.dataRoot}/.psycheros/backgrounds/${decodedFilename}`;
    await Deno.remove(filePath);

    return new Response(
      JSON.stringify({ success: true, message: "Background deleted" }),
      {
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      },
    );
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return new Response(
        JSON.stringify({ error: "File not found" }),
        {
          status: 404,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          },
        },
      );
    }
    console.error("[Routes] handleDeleteBackground error:", error);
    return new Response(
      JSON.stringify({ error: "Delete failed" }),
      {
        status: 500,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      },
    );
  }
}

/**
 * Handle GET /backgrounds/:filename - Serve an uploaded background image.
 *
 * Files are stored in .psycheros/backgrounds/ (outside web/) for persistence
 * across Docker container rebuilds.
 *
 * @param ctx - Route context
 * @param filename - The filename to serve
 * @returns HTTP Response with file content or 404
 */
export async function handleServeBackground(
  ctx: RouteContext,
  filename: string,
): Promise<Response> {
  // Sanitize filename
  const decodedFilename = decodeURIComponent(filename);
  if (!/^[a-zA-Z0-9_.-]+$/.test(decodedFilename)) {
    return new Response("Forbidden", {
      status: 403,
      headers: { "Content-Type": "text/plain" },
    });
  }

  // Only allow image files
  if (!/\.(jpg|jpeg|png|gif|webp)$/i.test(decodedFilename)) {
    return new Response("Forbidden", {
      status: 403,
      headers: { "Content-Type": "text/plain" },
    });
  }

  const filePath = `${ctx.dataRoot}/.psycheros/backgrounds/${decodedFilename}`;

  try {
    const content = await Deno.readFile(filePath);
    const mimeType = getMimeType(filePath);

    return new Response(content, {
      headers: {
        "Content-Type": mimeType,
        "Cache-Control": "no-cache",
      },
    });
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return new Response("Not Found", {
        status: 404,
        headers: { "Content-Type": "text/plain" },
      });
    }
    throw error;
  }
}

// =============================================================================
// LLM Settings Routes
// =============================================================================

/**
 * Handle GET /api/llm-settings - Return current LLM profile settings (API keys masked).
 */
export function handleGetLLMSettings(ctx: RouteContext): Response {
  const settings = ctx.getLLMProfileSettings();
  const masked = maskProfileSettings(settings);
  return new Response(JSON.stringify(masked), {
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

/**
 * Handle POST /api/llm-settings - Save and apply LLM profile settings.
 * Accepts the full LLMProfileSettings object. Preserves existing API keys
 * when the masked value is sent back.
 */
export async function handleSaveLLMSettings(
  ctx: RouteContext,
  request: Request,
): Promise<Response> {
  try {
    const body = await request.json() as LLMProfileSettings;
    const current = ctx.getLLMProfileSettings();

    // Preserve real API keys when masked values are sent back
    for (const profile of body.profiles) {
      const existing = current.profiles.find((p) => p.id === profile.id);
      if (existing && profile.apiKey.includes("••••")) {
        profile.apiKey = existing.apiKey;
      }
    }

    await ctx.updateLLMProfileSettings(body);

    return new Response(JSON.stringify({ success: true }), {
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    });
  } catch (error) {
    console.error("[Routes] handleSaveLLMSettings error:", error);
    return new Response(
      JSON.stringify({ error: "Failed to save settings" }),
      {
        status: 500,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      },
    );
  }
}

/**
 * Handle POST /api/llm-settings/profile - Add or update a single profile.
 * This eliminates the client-side read-modify-write race condition by doing
 * the merge atomically on the server.
 */
export async function handleSaveLLMProfile(
  ctx: RouteContext,
  request: Request,
): Promise<Response> {
  try {
    const body = await request.json() as { profile: LLMConnectionProfile };
    const profile = body.profile;

    if (!profile || !profile.id || !profile.name) {
      return new Response(
        JSON.stringify({ error: "Profile must have id and name" }),
        {
          status: 400,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          },
        },
      );
    }

    const settings = ctx.getLLMProfileSettings();
    const existingIdx = settings.profiles.findIndex((p) => p.id === profile.id);

    if (existingIdx >= 0) {
      // Update existing profile — preserve real API key if masked value sent
      const existing = settings.profiles[existingIdx];
      if (profile.apiKey.includes("••••")) {
        profile.apiKey = existing.apiKey;
      }
      settings.profiles[existingIdx] = profile;
    } else {
      // New profile — add it
      settings.profiles.push(profile);
      // Auto-set as active if it's the first profile or no active profile
      if (!settings.activeProfileId || settings.profiles.length === 1) {
        settings.activeProfileId = profile.id;
      }
    }

    await ctx.updateLLMProfileSettings(settings);

    return new Response(JSON.stringify({ success: true }), {
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    });
  } catch (error) {
    console.error("[Routes] handleSaveLLMProfile error:", error);
    return new Response(
      JSON.stringify({ error: "Failed to save profile" }),
      {
        status: 500,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      },
    );
  }
}

/**
 * Handle POST /api/llm-settings/reset - Reset to env-based defaults.
 * Replaces all profiles with a single default profile from environment variables.
 */
export async function handleResetLLMSettings(
  ctx: RouteContext,
): Promise<Response> {
  try {
    const defaultProfile = createDefaultProfile();
    const settings: LLMProfileSettings = {
      profiles: [defaultProfile],
      activeProfileId: defaultProfile.id,
    };
    await ctx.updateLLMProfileSettings(settings);

    return new Response(JSON.stringify({ success: true }), {
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    });
  } catch (error) {
    console.error("[Routes] handleResetLLMSettings error:", error);
    return new Response(
      JSON.stringify({ error: "Failed to reset settings" }),
      {
        status: 500,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      },
    );
  }
}

/**
 * Determine whether a model requires `max_completion_tokens` instead of `max_tokens`.
 * OpenAI's newer models (o-series, gpt-5.x) reject `max_tokens` outright.
 */
function usesMaxCompletionTokensParam(model: string): boolean {
  const lower = model.toLowerCase();
  if (/^o[134]/.test(lower)) return true;
  if (/^gpt-5/.test(lower)) return true;
  return false;
}

/**
 * Handle POST /api/llm-settings/test - Test an LLM connection.
 * Accepts a profile object (may not be saved yet). Preserves existing API key if masked.
 */
export async function handleTestLLMConnection(
  ctx: RouteContext,
  request: Request,
): Promise<Response> {
  try {
    let baseUrl = "";
    let apiKey = "";
    let model = "";

    try {
      const body = await request.json() as
        | Partial<LLMConnectionProfile>
        | undefined;
      if (body) {
        // If testing a specific profile, use its values
        baseUrl = body.baseUrl || "";
        model = body.model || "";
        // Check if apiKey is masked — if so, look up the real key
        if (body.apiKey && body.apiKey.includes("••••")) {
          const current = ctx.getLLMProfileSettings();
          const existing = body.id
            ? current.profiles.find((p) => p.id === body.id)
            : current.profiles.find((p) => p.baseUrl === baseUrl);
          apiKey = existing?.apiKey || "";
        } else {
          apiKey = body.apiKey || "";
        }
      }
    } catch {
      // No body or invalid JSON
    }

    // Fall back to active profile if no values provided (empty form submit)
    if (!baseUrl && !apiKey && !model) {
      const active = ctx.getActiveLLMProfile();
      if (active) {
        baseUrl = active.baseUrl;
        apiKey = active.apiKey;
        model = active.model;
      }
    }

    if (!baseUrl || !apiKey) {
      return new Response(
        JSON.stringify({
          success: false,
          error: "No API key or base URL configured",
        }),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          },
        },
      );
    }

    const startTime = performance.now();

    const response = await fetch(baseUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: model || "test",
        messages: [{ role: "user", content: "Hi" }],
        ...usesMaxCompletionTokensParam(model || "test")
          ? { max_completion_tokens: 5 }
          : { max_tokens: 5 },
        stream: false,
      }),
    });

    const latency = Math.round(performance.now() - startTime);

    if (response.ok) {
      return new Response(
        JSON.stringify({ success: true, latency }),
        {
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          },
        },
      );
    } else {
      let errorMsg = `HTTP ${response.status}`;
      try {
        const errBody = await response.json();
        if (errBody.error?.message) {
          errorMsg = errBody.error.message;
        }
      } catch {
        errorMsg = `${errorMsg}: ${response.statusText}`;
      }
      return new Response(
        JSON.stringify({ success: false, error: errorMsg, latency }),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          },
        },
      );
    }
  } catch (error) {
    console.error("[Routes] handleTestLLMConnection error:", error);
    return new Response(
      JSON.stringify({ success: false, error: "Connection failed" }),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      },
    );
  }
}

/**
 * Handle POST /api/llm-settings/set-active - Set the active LLM profile.
 */
export async function handleSetActiveProfile(
  ctx: RouteContext,
  request: Request,
): Promise<Response> {
  try {
    const body = await request.json() as { profileId: string };
    if (!body.profileId) {
      return new Response(
        JSON.stringify({ error: "profileId is required" }),
        {
          status: 400,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          },
        },
      );
    }

    const settings = ctx.getLLMProfileSettings();
    const exists = settings.profiles.some((p) => p.id === body.profileId);
    if (!exists) {
      return new Response(
        JSON.stringify({ error: "Profile not found" }),
        {
          status: 404,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          },
        },
      );
    }

    await ctx.setActiveProfile(body.profileId);

    return new Response(JSON.stringify({ success: true }), {
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    });
  } catch (error) {
    console.error("[Routes] handleSetActiveProfile error:", error);
    return new Response(
      JSON.stringify({ error: "Failed to set active profile" }),
      {
        status: 500,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      },
    );
  }
}

/**
 * Handle GET /fragments/settings/llm - LLM settings hub (profile cards).
 */
export function handleLLMSettingsFragment(ctx: RouteContext): Response {
  const settings = ctx.getLLMProfileSettings();
  const html = renderLLMProfileHub(settings);
  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
    },
  });
}

/**
 * Handle GET /fragments/settings/llm/new - New profile form.
 * Handle GET /fragments/settings/llm/:id - Edit existing profile form.
 */
export function handleLLMProfileEditFragment(
  ctx: RouteContext,
  profileId?: string,
): Response {
  const settings = ctx.getLLMProfileSettings();
  const profile = profileId
    ? settings.profiles.find((p) => p.id === profileId)
    : undefined;
  const isNew = !profile;
  const html = renderLLMProfileEdit(
    profile || undefined,
    isNew,
    settings.activeProfileId,
  );
  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
    },
  });
}

// =============================================================================
// Web Search Settings API Routes
// =============================================================================

/**
 * Handle GET /api/web-search-settings - Return current web search settings (API keys masked).
 */
export function handleGetWebSearchSettings(ctx: RouteContext): Response {
  const settings = maskWebSearchSettings(ctx.getWebSearchSettings());
  return new Response(JSON.stringify(settings), {
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

/**
 * Handle POST /api/web-search-settings - Save and apply web search settings.
 * If an API key field contains the masked value, it keeps the existing key.
 */
export async function handleSaveWebSearchSettings(
  ctx: RouteContext,
  request: Request,
): Promise<Response> {
  try {
    const body = await request.json() as Partial<WebSearchSettings>;
    const current = ctx.getWebSearchSettings();

    const updated: WebSearchSettings = {
      provider: body.provider === "disabled"
        ? "disabled"
        : (body.provider ?? current.provider),
      tavilyApiKey: (body.tavilyApiKey && !body.tavilyApiKey.includes("••••"))
        ? body.tavilyApiKey
        : current.tavilyApiKey,
      braveApiKey: (body.braveApiKey && !body.braveApiKey.includes("••••"))
        ? body.braveApiKey
        : current.braveApiKey,
    };

    await ctx.updateWebSearchSettings(updated);

    return new Response(JSON.stringify({ success: true }), {
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    });
  } catch (error) {
    console.error("[Routes] handleSaveWebSearchSettings error:", error);
    return new Response(
      JSON.stringify({ error: "Failed to save settings" }),
      {
        status: 500,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      },
    );
  }
}

/**
 * Handle POST /api/web-search-settings/reset - Reset to env-based defaults.
 */
export async function handleResetWebSearchSettings(
  ctx: RouteContext,
): Promise<Response> {
  try {
    const defaults = getDefaultWebSearchSettings();
    await ctx.updateWebSearchSettings(defaults);

    return new Response(JSON.stringify({ success: true }), {
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    });
  } catch (error) {
    console.error("[Routes] handleResetWebSearchSettings error:", error);
    return new Response(
      JSON.stringify({ error: "Failed to reset settings" }),
      {
        status: 500,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      },
    );
  }
}

// =============================================================================
// Discord Settings API Routes
// =============================================================================

/**
 * Handle GET /api/discord-settings - Get current Discord settings (masked).
 */
export function handleGetDiscordSettings(ctx: RouteContext): Response {
  const settings = maskDiscordSettings(ctx.getDiscordSettings());
  return new Response(JSON.stringify(settings), {
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

/**
 * Handle POST /api/discord-settings - Save and apply Discord settings.
 * If the bot token field contains the masked value, it keeps the existing token.
 */
export async function handleSaveDiscordSettings(
  ctx: RouteContext,
  request: Request,
): Promise<Response> {
  try {
    const body = await request.json() as Partial<DiscordSettings>;
    const current = ctx.getDiscordSettings();

    const updated: DiscordSettings = {
      enabled: body.enabled ?? current.enabled,
      botToken: (body.botToken && !body.botToken.includes("••••"))
        ? body.botToken
        : current.botToken,
      defaultChannelId: body.defaultChannelId ?? current.defaultChannelId,
      gatewayEnabled: body.gatewayEnabled ?? current.gatewayEnabled,
      globalInstructions: body.globalInstructions ?? current.globalInstructions,
      showHubInSidebar: body.showHubInSidebar ?? current.showHubInSidebar ??
        true,
    };

    await ctx.updateDiscordSettings(updated);

    return new Response(JSON.stringify({ success: true }), {
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    });
  } catch (error) {
    console.error("[Routes] handleSaveDiscordSettings error:", error);
    return new Response(
      JSON.stringify({ error: "Failed to save settings" }),
      {
        status: 500,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      },
    );
  }
}

/**
 * Handle POST /api/discord-settings/reset - Reset to env-based defaults.
 */
export async function handleResetDiscordSettings(
  ctx: RouteContext,
): Promise<Response> {
  try {
    const defaults = getDefaultDiscordSettings();
    await ctx.updateDiscordSettings(defaults);

    return new Response(JSON.stringify({ success: true }), {
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    });
  } catch (error) {
    console.error("[Routes] handleResetDiscordSettings error:", error);
    return new Response(
      JSON.stringify({ error: "Failed to reset settings" }),
      {
        status: 500,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      },
    );
  }
}

/**
 * Handle GET /fragments/settings/connections - External connections hub fragment.
 */
export function handleConnectionsSettingsFragment(ctx: RouteContext): Response {
  const html = renderConnectionsSettings(
    maskDiscordSettings(ctx.getDiscordSettings()),
    ctx.getHomeSettings(),
    maskWebSearchSettings(ctx.getWebSearchSettings()),
    ctx.getLovenseSettings(),
    ctx.getButtplugSettings(),
  );
  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
    },
  });
}

/**
 * Handle GET /fragments/settings/connections/discord - Discord settings fragment.
 */
export function handleConnectionsDiscordFragment(ctx: RouteContext): Response {
  const gatewayConfig = ctx.getDiscordGatewayConfig();
  const mapper = ctx.getDiscordConversationMapper();
  const whitelist = mapper?.getDmWhitelist() ?? [];
  const gcWithWhitelist = gatewayConfig
    ? { ...gatewayConfig, dmWhitelist: whitelist }
    : gatewayConfig;
  const html = renderConnectionsDiscordSettings(
    maskDiscordSettings(ctx.getDiscordSettings()),
    gcWithWhitelist,
  );
  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
    },
  });
}

/**
 * Handle GET /fragments/settings/connections/home - Home automation settings fragment.
 */
export function handleConnectionsHomeFragment(ctx: RouteContext): Response {
  const html = renderHomeSettings(ctx.getHomeSettings());
  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
    },
  });
}

/**
 * Handle GET /fragments/settings/connections/lovense - Lovense settings fragment.
 */
export function handleConnectionsLovenseFragment(ctx: RouteContext): Response {
  const html = renderLovenseSettings(ctx.getLovenseSettings());
  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
    },
  });
}

// =============================================================================
// Home Settings API Routes
// =============================================================================

/**
 * Handle GET /api/home-settings - Return current home settings.
 */
export function handleGetHomeSettings(ctx: RouteContext): Response {
  const settings = ctx.getHomeSettings();
  return new Response(JSON.stringify(settings), {
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

/**
 * Handle POST /api/home-settings - Save home settings.
 */
export async function handleSaveHomeSettings(
  ctx: RouteContext,
  request: Request,
): Promise<Response> {
  try {
    const body = await request.json() as Partial<HomeSettings>;

    if (!body.devices || !Array.isArray(body.devices)) {
      return new Response(
        JSON.stringify({
          error: "Invalid settings: 'devices' array is required",
        }),
        {
          status: 400,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          },
        },
      );
    }

    const updated: HomeSettings = { devices: body.devices };
    await ctx.updateHomeSettings(updated);

    return new Response(JSON.stringify({ success: true }), {
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    });
  } catch (_error) {
    return new Response(
      JSON.stringify({ error: "Failed to save settings" }),
      {
        status: 500,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      },
    );
  }
}

/**
 * Handle POST /api/home-device/control - Direct user control of a home device.
 *
 * Bypasses the entity/LLM loop entirely — this is the manual safety override.
 * Works on any configured device regardless of enabled state.
 */
export async function handleControlHomeDevice(
  ctx: RouteContext,
  request: Request,
): Promise<Response> {
  try {
    const body = await request.json() as { name?: string; action?: string };

    if (
      typeof body.name !== "string" || body.name.trim().length === 0 ||
      typeof body.action !== "string" ||
      !["on", "off", "status"].includes(body.action)
    ) {
      return new Response(
        JSON.stringify({
          error:
            "Invalid request: 'name' (string) and 'action' (on|off|status) are required",
        }),
        {
          status: 400,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          },
        },
      );
    }

    const settings = ctx.getHomeSettings();
    const device = (settings.devices || []).find(
      (d) => d.name.toLowerCase() === body.name!.trim().toLowerCase(),
    );

    if (!device) {
      return new Response(
        JSON.stringify({ error: `Device "${body.name}" not found` }),
        {
          status: 404,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          },
        },
      );
    }

    const action = body.action as "on" | "off" | "status";
    const result = await dispatchDeviceControl(device, action);

    return new Response(
      JSON.stringify({
        success: result.success,
        message: result.message,
        powerState: result.success && action !== "status"
          ? action === "on" ? "on" : "off"
          : undefined,
      }),
      {
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      },
    );
  } catch (_error) {
    return new Response(
      JSON.stringify({ error: "Failed to control device" }),
      {
        status: 500,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      },
    );
  }
}

// =============================================================================
// Lovense Settings API Routes
// =============================================================================

/**
 * Handle GET /api/lovense-settings - Return current Lovense settings.
 */
export function handleGetLovenseSettings(ctx: RouteContext): Response {
  const settings = ctx.getLovenseSettings();
  return new Response(JSON.stringify(settings), {
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

/**
 * Handle POST /api/lovense-settings - Save Lovense settings.
 */
export async function handleSaveLovenseSettings(
  ctx: RouteContext,
  request: Request,
): Promise<Response> {
  try {
    const body = await request.json() as Partial<
      import("../llm/lovense-settings.ts").LovenseSettings
    >;

    if (typeof body.enabled !== "boolean") {
      return new Response(
        JSON.stringify({
          error: "Invalid settings: 'enabled' must be a boolean",
        }),
        {
          status: 400,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          },
        },
      );
    }

    const updated: import("../llm/lovense-settings.ts").LovenseSettings = {
      enabled: body.enabled,
      connection: {
        domain: body.connection?.domain ?? "",
        port: body.connection?.port ?? 34568,
        secure: body.connection?.secure ?? true,
      },
      customInstructions: typeof body.customInstructions === "string"
        ? body.customInstructions
        : "",
    };

    await ctx.updateLovenseSettings(updated);

    return new Response(JSON.stringify({ success: true }), {
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    });
  } catch (_error) {
    return new Response(
      JSON.stringify({ error: "Failed to save settings" }),
      {
        status: 500,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      },
    );
  }
}

/**
 * Handle POST /api/lovense-settings/test - Test connection to Lovense Connect.
 * Runs server-side to avoid browser TLS restrictions on self-signed certs.
 */
export async function handleTestLovenseConnection(
  _ctx: RouteContext,
  request: Request,
): Promise<Response> {
  try {
    const body = await request.json() as {
      domain: string;
      port: number;
      secure: boolean;
    };
    const domain = body.domain?.trim();
    const port = body.port ?? 34568;
    const secure = body.secure ?? true;

    if (!domain) {
      return new Response(
        JSON.stringify({ error: "No bridge address configured" }),
        {
          status: 400,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          },
        },
      );
    }

    const baseUrl = `${secure ? "https" : "http"}://${domain}:${port}`;

    const resp = await fetch(`${baseUrl}/command`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command: "GetToys" }),
      signal: AbortSignal.timeout(8000),
    });

    if (!resp.ok) {
      return new Response(
        JSON.stringify({ error: `HTTP ${resp.status}: ${resp.statusText}` }),
        {
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          },
        },
      );
    }

    const data = await resp.json() as {
      code: number;
      data?: { toys: string };
    };

    if (data.code !== 200 || !data.data?.toys) {
      return new Response(
        JSON.stringify({ error: `API returned code ${data.code}` }),
        {
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          },
        },
      );
    }

    const toysMap = JSON.parse(data.data.toys) as Record<
      string,
      {
        id: string;
        status: string;
        name: string;
        battery: number;
        nickName: string;
      }
    >;

    const toys = Object.values(toysMap).map((t) => ({
      id: t.id,
      name: t.name,
      nickname: t.nickName || "",
      battery: t.battery,
      connected: t.status === "1",
    }));

    return new Response(
      JSON.stringify({ success: true, toys }),
      {
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      },
    );
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return new Response(
      JSON.stringify({ error: `Connection failed: ${msg}` }),
      {
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      },
    );
  }
}

/**
 * Handle GET /api/lovense-status - Quick connection check for header icon.
 * Returns whether a toy is connected and basic info about it.
 */
export async function handleLovenseStatus(
  ctx: RouteContext,
): Promise<Response> {
  const settings = ctx.getLovenseSettings();

  if (!settings.enabled || !settings.connection.domain) {
    return new Response(
      JSON.stringify({ connected: false }),
      {
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      },
    );
  }

  try {
    const { domain, port, secure } = settings.connection;
    const baseUrl = `${secure ? "https" : "http"}://${domain}:${port}`;

    const resp = await fetch(`${baseUrl}/command`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command: "GetToys" }),
      signal: AbortSignal.timeout(3000),
    });

    if (!resp.ok) {
      return new Response(
        JSON.stringify({ connected: false }),
        {
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          },
        },
      );
    }

    const data = await resp.json() as {
      code: number;
      data?: { toys: string };
    };

    if (data.code !== 200 || !data.data?.toys) {
      return new Response(
        JSON.stringify({ connected: false }),
        {
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          },
        },
      );
    }

    const toysMap = JSON.parse(data.data.toys) as Record<
      string,
      {
        id: string;
        status: string;
        name: string;
        battery: number;
        nickName: string;
      }
    >;

    const connected = Object.values(toysMap).find((t) => t.status === "1");
    if (!connected) {
      return new Response(
        JSON.stringify({ connected: false }),
        {
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          },
        },
      );
    }

    return new Response(
      JSON.stringify({
        connected: true,
        toy: {
          name: connected.name,
          battery: connected.battery,
          nickname: connected.nickName || "",
        },
      }),
      {
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      },
    );
  } catch {
    return new Response(
      JSON.stringify({ connected: false }),
      {
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      },
    );
  }
}

// =============================================================================
// Buttplug Settings API Routes
// =============================================================================

/**
 * Handle GET /api/buttplug-settings - Return current Buttplug settings.
 */
export function handleGetButtplugSettings(ctx: RouteContext): Response {
  const settings = ctx.getButtplugSettings();
  return new Response(JSON.stringify(settings), {
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

/**
 * Handle POST /api/buttplug-settings - Save Buttplug settings.
 */
export async function handleSaveButtplugSettings(
  ctx: RouteContext,
  request: Request,
): Promise<Response> {
  try {
    const body = await request.json() as Partial<
      import("../llm/buttplug-settings.ts").ButtplugSettings
    >;

    if (typeof body.enabled !== "boolean") {
      return new Response(
        JSON.stringify({
          error: "Invalid settings: 'enabled' must be a boolean",
        }),
        {
          status: 400,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          },
        },
      );
    }

    const updated: import("../llm/buttplug-settings.ts").ButtplugSettings = {
      enabled: body.enabled,
      websocketUrl: typeof body.websocketUrl === "string"
        ? body.websocketUrl.trim()
        : "ws://127.0.0.1:12345",
      customInstructions: typeof body.customInstructions === "string"
        ? body.customInstructions
        : "",
    };

    await ctx.updateButtplugSettings(updated);

    return new Response(JSON.stringify({ success: true }), {
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    });
  } catch (_error) {
    return new Response(
      JSON.stringify({ error: "Failed to save settings" }),
      {
        status: 500,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      },
    );
  }
}

/**
 * Handle POST /api/buttplug-settings/test - Test connection to Buttplug server.
 * Connects to the WebSocket, starts scanning, and returns discovered devices.
 */
export async function handleTestButtplugConnection(
  _ctx: RouteContext,
  request: Request,
): Promise<Response> {
  try {
    const body = await request.json() as { websocketUrl: string };
    const websocketUrl = body.websocketUrl?.trim() || "ws://127.0.0.1:12345";

    // Dynamically import to avoid requiring the library if not installed
    const { ButtplugClient } = await import("@zendrex/buttplug.js");

    const client = new ButtplugClient(websocketUrl);
    try {
      await client.connect();
      await client.startScanning();
      // Wait for device discovery
      await new Promise((r) => setTimeout(r, 3000));

      const devices = client.devices;
      const deviceList = devices.map((d) => {
        const label = d.displayName || d.name;
        const caps: string[] = [];
        for (
          const type of [
            "Vibrate",
            "Rotate",
            "Position",
            "Oscillate",
            "Constrict",
          ] as const
        ) {
          if (d.canOutput(type)) caps.push(type);
        }
        return {
          index: d.index,
          name: label,
          capabilities: caps,
        };
      });

      return new Response(
        JSON.stringify({ success: true, devices: deviceList }),
        {
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          },
        },
      );
    } finally {
      try {
        await client.disconnect();
      } catch { /* ignore */ }
      client.dispose();
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return new Response(
      JSON.stringify({ error: `Connection failed: ${msg}` }),
      {
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      },
    );
  }
}

/**
 * Handle GET /api/buttplug-status - Quick connection check.
 * Returns whether devices are connected.
 */
export async function handleButtplugStatus(
  ctx: RouteContext,
): Promise<Response> {
  const settings = ctx.getButtplugSettings();

  if (!settings.enabled) {
    return new Response(
      JSON.stringify({ connected: false }),
      {
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      },
    );
  }

  try {
    const { ButtplugClient } = await import("@zendrex/buttplug.js");
    const client = new ButtplugClient(
      settings.websocketUrl || "ws://127.0.0.1:12345",
    );
    try {
      await client.connect();
      await client.startScanning();
      await new Promise((r) => setTimeout(r, 2000));

      const devices = client.devices;
      const connected = devices.length > 0;

      return new Response(
        JSON.stringify({
          connected,
          deviceCount: devices.length,
          devices: devices.slice(0, 5).map((d) => ({
            name: d.displayName || d.name,
            index: d.index,
          })),
        }),
        {
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          },
        },
      );
    } finally {
      try {
        await client.disconnect();
      } catch { /* ignore */ }
      client.dispose();
    }
  } catch {
    return new Response(
      JSON.stringify({ connected: false }),
      {
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      },
    );
  }
}

/**
 * Handle GET /fragments/settings/connections/buttplug - Buttplug settings fragment.
 */
export function handleConnectionsButtplugFragment(ctx: RouteContext): Response {
  const html = renderButtplugSettings(ctx.getButtplugSettings());
  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
    },
  });
}

// =============================================================================
// Image Gen Settings API Routes
// =============================================================================

/**
 * Handle GET /api/image-gen-settings - Return masked image gen settings.
 */
export function handleGetImageGenSettings(ctx: RouteContext): Response {
  const settings = maskImageGenSettings(ctx.getImageGenSettings());
  return new Response(JSON.stringify(settings), {
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

/**
 * Handle POST /api/image-gen-settings - Save image gen settings.
 */
export async function handleSaveImageGenSettings(
  ctx: RouteContext,
  request: Request,
): Promise<Response> {
  try {
    const body = await request.json() as Partial<ImageGenSettings>;

    // If only captioning is provided (no generators), merge into existing settings
    // to avoid overwriting actual API keys with masked versions
    if (!body.generators && body.captioning) {
      const current = ctx.getImageGenSettings();
      const captioning = body.captioning;

      // Preserve real API keys if masked values were sent from the UI
      if (captioning.gemini?.apiKey?.includes("••••")) {
        captioning.gemini.apiKey = current.captioning?.gemini?.apiKey ||
          captioning.gemini.apiKey;
      }
      if (captioning.openrouter?.apiKey?.includes("••••")) {
        captioning.openrouter.apiKey = current.captioning?.openrouter?.apiKey ||
          captioning.openrouter.apiKey;
      }

      current.captioning = captioning;
      await ctx.updateImageGenSettings(current as ImageGenSettings);
      return new Response(JSON.stringify({ success: true }), {
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      });
    }

    if (!body.generators || !Array.isArray(body.generators)) {
      return new Response(
        JSON.stringify({
          error: "Invalid settings: 'generators' array is required",
        }),
        {
          status: 400,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          },
        },
      );
    }

    await ctx.updateImageGenSettings(body as ImageGenSettings);
    return new Response(JSON.stringify({ success: true }), {
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    });
  } catch (error) {
    console.error("[Routes] Failed to save image gen settings:", error);
    return new Response(
      JSON.stringify({ error: "Failed to save image gen settings" }),
      {
        status: 500,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      },
    );
  }
}

/**
 * Handle POST /api/image-gen-settings/slot - Save a single generator slot.
 * Server-side merge that preserves real API keys when masked values are sent.
 */
export async function handleSaveImageGenSlot(
  ctx: RouteContext,
  request: Request,
): Promise<Response> {
  try {
    const body = await request.json() as { generator: ImageGenConfig };
    const generator = body.generator;

    if (!generator || !generator.id) {
      return new Response(
        JSON.stringify({ error: "Generator must have an id" }),
        {
          status: 400,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          },
        },
      );
    }

    const settings = ctx.getImageGenSettings();
    const existingIdx = settings.generators.findIndex((g) =>
      g.id === generator.id
    );

    if (existingIdx >= 0) {
      // Update existing — preserve real API keys if masked values sent
      const existing = settings.generators[existingIdx];
      if (generator.settings.openrouter?.apiKey?.includes("••••")) {
        generator.settings.openrouter.apiKey =
          existing.settings.openrouter?.apiKey ||
          generator.settings.openrouter.apiKey;
      }
      if (generator.settings.gemini?.apiKey?.includes("••••")) {
        generator.settings.gemini.apiKey = existing.settings.gemini?.apiKey ||
          generator.settings.gemini.apiKey;
      }
      if (generator.settings.comfyui) {
        generator.settings.comfyui = existing.settings.comfyui ||
          generator.settings.comfyui;
      }
      if (generator.settings.native) {
        generator.settings.native = existing.settings.native ||
          generator.settings.native;
      }
      settings.generators[existingIdx] = generator;
    } else {
      // New generator — add it
      settings.generators.push(generator);
    }

    await ctx.updateImageGenSettings(settings);
    return new Response(JSON.stringify({ success: true }), {
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    });
  } catch (error) {
    console.error("[Routes] Failed to save image gen slot:", error);
    return new Response(
      JSON.stringify({ error: "Failed to save image gen slot" }),
      {
        status: 500,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      },
    );
  }
}

/**
 * Handle POST /api/image-gen-settings/reset - Reset to defaults.
 */
export function handleResetImageGenSettings(ctx: RouteContext): Response {
  const defaults = getDefaultImageGenSettings();
  ctx.updateImageGenSettings(defaults);
  return new Response(JSON.stringify({ success: true }), {
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

/**
 * Handle POST /api/image-gen-settings/delete - Delete a single generator slot.
 * Server-side operation to avoid clobbering other generators' API keys.
 */
export async function handleDeleteImageGenSlot(
  ctx: RouteContext,
  request: Request,
): Promise<Response> {
  try {
    const body = await request.json() as { id: string };
    if (!body.id) {
      return new Response(
        JSON.stringify({ error: "Generator id is required" }),
        {
          status: 400,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          },
        },
      );
    }

    const settings = ctx.getImageGenSettings();
    settings.generators = settings.generators.filter((g) => g.id !== body.id);
    await ctx.updateImageGenSettings(settings);

    return new Response(JSON.stringify({ success: true }), {
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    });
  } catch (error) {
    console.error("[Routes] Failed to delete image gen slot:", error);
    return new Response(
      JSON.stringify({ error: "Failed to delete image gen slot" }),
      {
        status: 500,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      },
    );
  }
}

// =============================================================================
// Anchor Images API Routes
// =============================================================================

/**
 * Handle GET /api/anchor-images - List all anchor images.
 */
export function handleListAnchorImages(ctx: RouteContext): Response {
  const rows = ctx.db.getRawDb()
    .prepare("SELECT * FROM anchor_images ORDER BY created_at DESC")
    .all<
      {
        id: string;
        label: string;
        description: string;
        filename: string;
        file_size: number;
        created_at: string;
      }
    >();
  return new Response(JSON.stringify(rows), {
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

/**
 * Handle POST /api/anchor-images - Upload a new anchor image.
 */
export async function handleUploadAnchorImage(
  ctx: RouteContext,
  request: Request,
): Promise<Response> {
  try {
    const formData = await request.formData();
    const file = formData.get("file") as File | null;
    const label = formData.get("label") as string || "Unnamed Anchor";
    const description = formData.get("description") as string || "";

    if (!file) {
      return new Response(
        JSON.stringify({ error: "No file provided" }),
        {
          status: 400,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          },
        },
      );
    }

    const id = crypto.randomUUID();
    const ext = file.name.split(".").pop() || "png";
    const filename = `${id}.${ext}`;
    const anchorsDir = `${ctx.dataRoot}/.psycheros/anchors`;
    await Deno.mkdir(anchorsDir, { recursive: true });

    const bytes = new Uint8Array(await file.arrayBuffer());
    await Deno.writeFile(`${anchorsDir}/${filename}`, bytes);

    ctx.db.getRawDb().prepare(
      "INSERT INTO anchor_images (id, label, description, filename, file_size, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(
      id,
      label,
      description,
      filename,
      bytes.length,
      new Date().toISOString(),
    );

    return new Response(
      JSON.stringify({
        id,
        label,
        description,
        filename,
        file_size: bytes.length,
      }),
      {
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      },
    );
  } catch (error) {
    console.error("[Routes] Failed to upload anchor image:", error);
    return new Response(
      JSON.stringify({ error: "Failed to upload anchor image" }),
      {
        status: 500,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      },
    );
  }
}

/**
 * Handle PATCH /api/anchor-images/:id - Update anchor image label/description.
 */
export async function handleUpdateAnchorImage(
  ctx: RouteContext,
  id: string,
  request: Request,
): Promise<Response> {
  try {
    const body = await request.json() as {
      label?: string;
      description?: string;
    };
    const row = ctx.db.getRawDb().prepare(
      "SELECT id FROM anchor_images WHERE id = ?",
    ).get<{ id: string }>(id);
    if (!row) {
      return new Response(
        JSON.stringify({ error: "Anchor image not found" }),
        {
          status: 404,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          },
        },
      );
    }

    if (body.label !== undefined) {
      ctx.db.getRawDb().prepare(
        "UPDATE anchor_images SET label = ? WHERE id = ?",
      ).run(body.label, id);
    }
    if (body.description !== undefined) {
      ctx.db.getRawDb().prepare(
        "UPDATE anchor_images SET description = ? WHERE id = ?",
      ).run(body.description, id);
    }

    return new Response(JSON.stringify({ success: true }), {
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    });
  } catch (error) {
    console.error("[Routes] Failed to update anchor image:", error);
    return new Response(
      JSON.stringify({ error: "Failed to update anchor image" }),
      {
        status: 500,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      },
    );
  }
}

/**
 * Handle DELETE /api/anchor-images/:id - Delete anchor image.
 */
export function handleDeleteAnchorImage(
  ctx: RouteContext,
  id: string,
): Response {
  try {
    const row = ctx.db.getRawDb().prepare(
      "SELECT filename FROM anchor_images WHERE id = ?",
    ).get<{ filename: string }>(id);
    if (!row) {
      return new Response(
        JSON.stringify({ error: "Anchor image not found" }),
        {
          status: 404,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          },
        },
      );
    }

    // Delete the file
    try {
      Deno.removeSync(`${ctx.dataRoot}/.psycheros/anchors/${row.filename}`);
    } catch {
      // File may already be deleted
    }

    ctx.db.getRawDb().prepare("DELETE FROM anchor_images WHERE id = ?").run(id);
    return new Response(JSON.stringify({ success: true }), {
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    });
  } catch (error) {
    console.error("[Routes] Failed to delete anchor image:", error);
    return new Response(
      JSON.stringify({ error: "Failed to delete anchor image" }),
      {
        status: 500,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      },
    );
  }
}

// =============================================================================
// Image File Serving
// =============================================================================

/**
 * Serve files from .psycheros/generated-images/, .psycheros/anchors/, and .psycheros/chat-attachments/.
 */
export async function handleServeImageFile(
  ctx: RouteContext,
  path: string,
): Promise<Response> {
  // Map URL paths to filesystem directories
  let dirName: string;
  if (path.startsWith("/generated-images/")) {
    dirName = "generated-images";
  } else if (path.startsWith("/anchors/")) {
    dirName = "anchors";
  } else if (path.startsWith("/chat-attachments/")) {
    dirName = "chat-attachments";
  } else {
    return new Response("Not found", { status: 404 });
  }

  const filename = path.slice(`/${dirName}/`.length);
  // Prevent path traversal
  if (
    filename.includes("..") || filename.includes("/") || filename.includes("\\")
  ) {
    return new Response("Forbidden", { status: 403 });
  }

  const filePath = `${ctx.dataRoot}/.psycheros/${dirName}/${filename}`;
  try {
    const data = await Deno.readFile(filePath);
    const ext = filename.split(".").pop()?.toLowerCase();
    const mediaType = ext === "jpg" || ext === "jpeg"
      ? "image/jpeg"
      : ext === "webp"
      ? "image/webp"
      : ext === "gif"
      ? "image/gif"
      : "image/png";

    return new Response(data, {
      headers: {
        "Content-Type": mediaType,
        "Cache-Control": "public, max-age=31536000, immutable",
        "Access-Control-Allow-Origin": "*",
      },
    });
  } catch {
    return new Response("Not found", { status: 404 });
  }
}

// =============================================================================
// Chat Attachments API Routes
// =============================================================================

/**
 * Handle POST /api/chat-attachments - Upload a chat attachment image.
 */
export async function handleUploadChatAttachment(
  ctx: RouteContext,
  request: Request,
): Promise<Response> {
  try {
    const formData = await request.formData();
    const file = formData.get("file") as File | null;

    if (!file) {
      return new Response(
        JSON.stringify({ error: "No file provided" }),
        {
          status: 400,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          },
        },
      );
    }

    const id = crypto.randomUUID();
    const ext = file.name.split(".").pop() || "png";
    const filename = `${id}.${ext}`;
    const attachmentsDir = `${ctx.dataRoot}/.psycheros/chat-attachments`;
    await Deno.mkdir(attachmentsDir, { recursive: true });

    const bytes = new Uint8Array(await file.arrayBuffer());
    await Deno.writeFile(`${attachmentsDir}/${filename}`, bytes);

    return new Response(
      JSON.stringify({ id, filename, url: `/chat-attachments/${filename}` }),
      {
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      },
    );
  } catch (error) {
    console.error("[Routes] Failed to upload chat attachment:", error);
    return new Response(
      JSON.stringify({ error: "Failed to upload chat attachment" }),
      {
        status: 500,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      },
    );
  }
}

// =============================================================================
// Image Gen Fragment Routes
// =============================================================================

/**
 * Handle GET /fragments/settings/vision - Vision settings fragment (hub with tabs).
 */
export function handleVisionSettingsFragment(ctx: RouteContext): Response {
  const settings = maskImageGenSettings(ctx.getImageGenSettings());
  const html = renderVisionSettings(settings);
  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

/**
 * Handle GET /fragments/settings/vision/generators - Generators tab content.
 */
export function handleVisionGeneratorsFragment(ctx: RouteContext): Response {
  const settings = maskImageGenSettings(ctx.getImageGenSettings());
  const html = renderVisionGeneratorsTab(settings);
  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

/**
 * Handle GET /fragments/settings/vision/anchors - Anchors tab content.
 */
export function handleVisionAnchorsFragment(ctx: RouteContext): Response {
  const anchors = ctx.db.getRawDb()
    .prepare("SELECT * FROM anchor_images ORDER BY created_at DESC")
    .all<
      {
        id: string;
        label: string;
        description: string;
        filename: string;
        file_size: number;
        created_at: string;
      }
    >();
  const html = renderVisionAnchorsTab(anchors);
  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

/**
 * Handle GET /fragments/settings/vision/gallery - Gallery tab content.
 * Renders gallery server-side to avoid HTMX script-in-swap issues.
 */
export async function handleVisionGalleryFragment(
  ctx: RouteContext,
): Promise<Response> {
  let result: GalleryResult;
  try {
    result = await scanGalleryImages(ctx, 0, 24);
  } catch (error) {
    console.error("[Routes] Failed to scan gallery images:", error);
    result = {
      totalSize: 0,
      generatedCount: 0,
      userCount: 0,
      total: 0,
      offset: 0,
      limit: 24,
      hasMore: false,
      images: [],
    };
  }
  const html = renderVisionGalleryTab(result);
  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

/**
 * Handle GET /fragments/settings/vision/image-gen/:id - Image gen slot settings.
 */
export function handleVisionImageGenSlotFragment(
  ctx: RouteContext,
  id: string,
): Response {
  const settings = ctx.getImageGenSettings();
  const generator = settings.generators.find((g) => g.id === id);
  const html = renderImageGenSlotSettings(generator, id);
  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

// =============================================================================
// Tools Settings API Routes
// =============================================================================

/**
 * Handle GET /api/tools-settings - Return current tools settings with all tool metadata.
 */
export function handleGetToolsSettings(ctx: RouteContext): Response {
  const settings = ctx.getToolSettings();
  const overrides = settings.toolOverrides;

  // Build tool entries from built-in catalog
  const allTools: Record<
    string,
    {
      name: string;
      description: string;
      category: string;
      parameters?: Record<string, unknown>;
    }
  > = {};

  for (const [name, tool] of Object.entries(AVAILABLE_TOOLS)) {
    const cat = TOOL_CATEGORIES.find((c) => c.toolNames.includes(name));
    allTools[name] = {
      name,
      description: tool.definition.function.description,
      category: cat?.id ?? "other",
      parameters: tool.definition.function.parameters as
        | Record<string, unknown>
        | undefined,
    };
  }

  // Add custom tools
  for (const [name, tool] of Object.entries(ctx.customTools)) {
    allTools[name] = {
      name,
      description: tool.definition.function.description,
      category: "custom",
      parameters: tool.definition.function.parameters as
        | Record<string, unknown>
        | undefined,
    };
  }

  return new Response(
    JSON.stringify({
      toolOverrides: overrides,
      categories: TOOL_CATEGORIES,
      tools: allTools,
      customToolNames: Object.keys(ctx.customTools),
    }),
    {
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    },
  );
}

/**
 * Handle POST /api/tools-settings - Save and apply tools settings.
 */
export async function handleSaveToolsSettings(
  ctx: RouteContext,
  request: Request,
): Promise<Response> {
  try {
    const body = await request.json() as Partial<ToolsSettings>;

    if (!body.toolOverrides || typeof body.toolOverrides !== "object") {
      return new Response(
        JSON.stringify({
          error: "toolOverrides is required and must be an object",
        }),
        {
          status: 400,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          },
        },
      );
    }

    const updated: ToolsSettings = {
      toolOverrides: body.toolOverrides,
    };

    await ctx.updateToolSettings(updated);

    return new Response(JSON.stringify({ success: true }), {
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    });
  } catch (error) {
    console.error("[Routes] handleSaveToolsSettings error:", error);
    return new Response(
      JSON.stringify({ error: "Failed to save settings" }),
      {
        status: 500,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      },
    );
  }
}

/**
 * Handle GET /fragments/settings/tools - Tools settings UI fragment.
 */
export function handleToolsSettingsFragment(ctx: RouteContext): Response {
  const settings = ctx.getToolSettings();
  const html = renderToolsSettings(settings, AVAILABLE_TOOLS, ctx.customTools);
  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
    },
  });
}

/**
 * Handle POST /api/custom-tools/upload - Upload a custom tool .js file.
 */
export async function handleUploadCustomTool(
  ctx: RouteContext,
  request: Request,
): Promise<Response> {
  try {
    const formData = await request.formData();
    const file = formData.get("tool");

    if (!file || !(file instanceof File)) {
      return jsonResp({ success: false, error: "No file provided" }, 400);
    }

    if (!file.name.endsWith(".js")) {
      return jsonResp(
        { success: false, error: "Only .js files are accepted" },
        400,
      );
    }

    if (file.size > 100 * 1024) {
      return jsonResp(
        { success: false, error: "File too large (max 100KB)" },
        400,
      );
    }

    const customDir = `${ctx.dataRoot}/custom-tools`;
    try {
      await Deno.mkdir(customDir, { recursive: true });
    } catch {
      // directory may already exist
    }

    const destPath = `${customDir}/${file.name}`;
    const bytes = new Uint8Array(await file.arrayBuffer());
    await Deno.writeFile(destPath, bytes);

    // Reload custom tools to pick up the new file
    const newTools = await loadCustomTools(ctx.dataRoot);
    ctx.customTools = newTools;

    // Detect the tool name from the newly loaded tools
    const toolName = Object.keys(newTools).length > 0
      ? Object.keys(newTools)[Object.keys(newTools).length - 1]
      : file.name;

    return jsonResp({ success: true, toolName });
  } catch (error) {
    console.error("[Routes] handleUploadCustomTool error:", error);
    const msg = error instanceof Error ? error.message : "Upload failed";
    return jsonResp({ success: false, error: msg }, 500);
  }
}

// =============================================================================
// Situational Awareness Settings API Routes
// =============================================================================

interface SASettings {
  enabled: boolean;
}

const SA_SETTINGS_PATH = ".psycheros/sa-settings.json";

async function loadSASettings(dataRoot: string): Promise<SASettings> {
  try {
    const text = await Deno.readTextFile(`${dataRoot}/${SA_SETTINGS_PATH}`);
    const saved = JSON.parse(text) as Partial<SASettings>;
    return { enabled: saved.enabled !== false };
  } catch {
    return { enabled: true };
  }
}

/**
 * Handle GET /api/sa-settings - Return current SA settings as JSON.
 */
export async function handleGetSASettings(
  ctx: RouteContext,
): Promise<Response> {
  const settings = await loadSASettings(ctx.dataRoot);
  return new Response(JSON.stringify(settings), {
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

/**
 * Handle POST /api/sa-settings - Save SA settings.
 */
export async function handleSaveSASettings(
  ctx: RouteContext,
  request: Request,
): Promise<Response> {
  try {
    const body = await request.json() as Partial<SASettings>;
    const current = await loadSASettings(ctx.dataRoot);

    const updated: SASettings = {
      enabled: body.enabled !== undefined ? body.enabled : current.enabled,
    };

    const settingsDir = `${ctx.dataRoot}/.psycheros`;
    await Deno.mkdir(settingsDir, { recursive: true });
    await Deno.writeTextFile(
      `${settingsDir}/sa-settings.json`,
      JSON.stringify(updated, null, 2) + "\n",
    );

    return new Response(JSON.stringify({ success: true }), {
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    });
  } catch (error) {
    console.error("[Routes] Failed to save SA settings:", error);
    return new Response(
      JSON.stringify({ error: "Failed to save settings" }),
      {
        status: 500,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      },
    );
  }
}

/**
 * Handle GET /fragments/settings/sa - Render the Situational Awareness settings page.
 */
export async function handleSASettingsFragment(
  ctx: RouteContext,
): Promise<Response> {
  const settings = await loadSASettings(ctx.dataRoot);
  const html = renderSASettings(settings);
  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
    },
  });
}

function jsonResp(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// =============================================================================
// General Settings API Routes
// =============================================================================

const GENERAL_SETTINGS_PATH = ".psycheros/general-settings.json";

async function loadGeneralSettings(
  dataRoot: string,
): Promise<GeneralSettings> {
  try {
    const text = await Deno.readTextFile(
      `${dataRoot}/${GENERAL_SETTINGS_PATH}`,
    );
    const saved = JSON.parse(text) as Partial<GeneralSettings>;
    return {
      entityName: saved.entityName || "Assistant",
      userName: saved.userName || "You",
      timezone: saved.timezone ?? "",
    };
  } catch {
    return { entityName: "Assistant", userName: "You", timezone: "" };
  }
}

/**
 * Handle GET /api/general-settings - Return current general settings as JSON.
 */
export async function handleGetGeneralSettings(
  ctx: RouteContext,
): Promise<Response> {
  const settings = await loadGeneralSettings(ctx.dataRoot);
  return new Response(JSON.stringify(settings), {
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

/**
 * Handle POST /api/general-settings - Save general settings.
 */
export async function handleSaveGeneralSettings(
  ctx: RouteContext,
  request: Request,
): Promise<Response> {
  try {
    const body = await request.json() as Partial<GeneralSettings>;
    const current = await loadGeneralSettings(ctx.dataRoot);

    const updated: GeneralSettings = {
      entityName: body.entityName || current.entityName,
      userName: body.userName || current.userName,
      timezone: body.timezone !== undefined ? body.timezone : current.timezone,
    };

    const settingsDir = `${ctx.dataRoot}/.psycheros`;
    await Deno.mkdir(settingsDir, { recursive: true });
    await Deno.writeTextFile(
      `${settingsDir}/general-settings.json`,
      JSON.stringify(updated, null, 2) + "\n",
    );

    // Propagate timezone to env var so server-side formatters pick it up
    if (updated.timezone) {
      Deno.env.set("PSYCHEROS_DISPLAY_TZ", updated.timezone);
    } else {
      Deno.env.delete("PSYCHEROS_DISPLAY_TZ");
    }

    return new Response(JSON.stringify({ success: true }), {
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    });
  } catch (error) {
    console.error("[Routes] handleSaveGeneralSettings error:", error);
    return new Response(
      JSON.stringify({ error: "Failed to save settings" }),
      {
        status: 500,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      },
    );
  }
}

/**
 * Handle GET /fragments/settings/general - Render the General Settings page.
 */
export async function handleGeneralSettingsFragment(
  ctx: RouteContext,
): Promise<Response> {
  const settings = await loadGeneralSettings(ctx.dataRoot);
  const html = renderGeneralSettings(settings);
  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
    },
  });
}

// =============================================================================
// Appearance Settings API Routes
// =============================================================================

const APPEARANCE_SETTINGS_PATH = ".psycheros/appearance-settings.json";

interface AppearanceSettings {
  preset: string | null;
  customAccent: string | null;
  bgImage: string | null;
  bgBlur: number;
  bgOverlayOpacity: number;
  glassEnabled: boolean;
}

const DEFAULT_APPEARANCE_SETTINGS: AppearanceSettings = {
  preset: "violet",
  customAccent: null,
  bgImage: null,
  bgBlur: 0,
  bgOverlayOpacity: 0,
  glassEnabled: false,
};

async function loadAppearanceSettings(
  dataRoot: string,
): Promise<AppearanceSettings> {
  try {
    const text = await Deno.readTextFile(
      `${dataRoot}/${APPEARANCE_SETTINGS_PATH}`,
    );
    const saved = JSON.parse(text) as Partial<AppearanceSettings>;
    return { ...DEFAULT_APPEARANCE_SETTINGS, ...saved };
  } catch {
    return { ...DEFAULT_APPEARANCE_SETTINGS };
  }
}

/**
 * Handle GET /api/appearance-settings - Return current appearance settings as JSON.
 */
export async function handleGetAppearanceSettings(
  ctx: RouteContext,
): Promise<Response> {
  const settings = await loadAppearanceSettings(ctx.dataRoot);
  return new Response(JSON.stringify(settings), {
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

/**
 * Handle POST /api/appearance-settings - Save appearance settings.
 */
export async function handleSaveAppearanceSettings(
  ctx: RouteContext,
  request: Request,
): Promise<Response> {
  try {
    const body = await request.json() as Partial<AppearanceSettings>;
    const current = await loadAppearanceSettings(ctx.dataRoot);

    const updated: AppearanceSettings = {
      preset: body.preset !== undefined ? body.preset : current.preset,
      customAccent: body.customAccent !== undefined
        ? body.customAccent
        : current.customAccent,
      bgImage: body.bgImage !== undefined ? body.bgImage : current.bgImage,
      bgBlur: body.bgBlur !== undefined ? body.bgBlur : current.bgBlur,
      bgOverlayOpacity: body.bgOverlayOpacity !== undefined
        ? body.bgOverlayOpacity
        : current.bgOverlayOpacity,
      glassEnabled: body.glassEnabled !== undefined
        ? body.glassEnabled
        : current.glassEnabled,
    };

    const settingsDir = `${ctx.dataRoot}/.psycheros`;
    await Deno.mkdir(settingsDir, { recursive: true });
    await Deno.writeTextFile(
      `${settingsDir}/appearance-settings.json`,
      JSON.stringify(updated, null, 2) + "\n",
    );

    return new Response(JSON.stringify({ success: true }), {
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    });
  } catch (error) {
    console.error("[Routes] handleSaveAppearanceSettings error:", error);
    return new Response(
      JSON.stringify({ error: "Failed to save appearance settings" }),
      {
        status: 500,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      },
    );
  }
}

// =============================================================================
// Vault API Routes
// =============================================================================

/** JSON response helper */
function vaultJson(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

/** HTML fragment response helper */
function vaultHtml(content: string): Response {
  return new Response(content, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

/**
 * Handle GET /api/vault - List vault documents.
 */
export function handleListVault(ctx: RouteContext): Response {
  if (!ctx.vaultManager) {
    return vaultJson({ error: "Vault not available" }, 503);
  }

  const docs = ctx.vaultManager.listDocuments();
  return vaultJson({ documents: docs });
}

/**
 * Handle POST /api/vault - Upload a vault document.
 */
export async function handleUploadVault(
  ctx: RouteContext,
  request: Request,
): Promise<Response> {
  if (!ctx.vaultManager) {
    return vaultJson({ error: "Vault not available" }, 503);
  }

  const isHtmx = request.headers.get("HX-Request") === "true";

  try {
    const formData = await request.formData();
    const file = formData.get("document");

    if (!file || !(file instanceof File)) {
      return isHtmx
        ? vaultHtml(renderVaultView(ctx, "No file provided", "error"))
        : vaultJson({ error: "No file provided" }, 400);
    }

    const _title = formData.get("title") as string || file.name;
    const scope = (formData.get("scope") as "global" | "chat") || "global";
    const conversationId = formData.get("conversation_id") as
      | string
      | undefined;

    const doc = await ctx.vaultManager.createFromUpload(file, {
      scope,
      conversationId,
      title: typeof _title === "string" ? _title : undefined,
    });

    if (isHtmx) {
      return vaultHtml(renderVaultView(ctx));
    }

    return vaultJson({ success: true, document: doc }, 201);
  } catch (error) {
    console.error("[Routes] handleUploadVault error:", error);
    const msg = error instanceof Error ? error.message : "Upload failed";
    return isHtmx
      ? vaultHtml(renderVaultView(ctx, msg, "error"))
      : vaultJson({ error: msg }, 500);
  }
}

/**
 * Handle GET /api/vault/:id - Get vault document metadata.
 */
export function handleGetVault(ctx: RouteContext, id: string): Response {
  if (!ctx.vaultManager) {
    return vaultJson({ error: "Vault not available" }, 503);
  }

  const doc = ctx.vaultManager.getDocument(id);
  if (!doc) return vaultJson({ error: "Document not found" }, 404);
  return vaultJson(doc);
}

/**
 * Handle PUT /api/vault/:id - Update vault document metadata.
 * Accepts both JSON (API) and form-encoded (HTMX) payloads.
 */
export async function handleUpdateVault(
  ctx: RouteContext,
  id: string,
  request: Request,
): Promise<Response> {
  if (!ctx.vaultManager) {
    return vaultJson({ error: "Vault not available" }, 503);
  }

  const isHtmx = request.headers.get("HX-Request") === "true";

  try {
    const updates: { title?: string; content?: string } = {};

    if (isHtmx) {
      const formData = await request.formData();
      const title = formData.get("title") as string;
      const content = formData.get("content") as string;
      if (title) updates.title = title;
      if (content !== null) updates.content = content;
    } else {
      const body = await request.json() as Record<string, unknown>;
      if (body.title) updates.title = String(body.title);
      if (body.content !== undefined) updates.content = String(body.content);
    }

    const doc = await ctx.vaultManager.updateDocument(id, updates);
    if (!doc) {
      return isHtmx
        ? new Response(renderSaveError("Document not found"), {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        })
        : vaultJson({ error: "Document not found" }, 404);
    }

    if (isHtmx) {
      const viewContent = updates.content !== undefined
        ? `<div id="vault-view-mode" hx-swap-oob="innerHTML"><div class="assistant-text">${
          renderMarkdown(updates.content)
        }</div></div>`
        : "";
      return new Response(renderSaveSuccess() + viewContent, {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }
    return vaultJson(doc);
  } catch (error) {
    console.error("[Routes] handleUpdateVault error:", error);
    const msg = error instanceof Error ? error.message : "Update failed";
    return isHtmx
      ? new Response(renderSaveError(msg), {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      })
      : vaultJson({ error: msg }, 500);
  }
}

/**
 * Handle DELETE /api/vault/:id - Delete a vault document.
 */
export function handleDeleteVault(
  ctx: RouteContext,
  id: string,
  request: Request,
): Response {
  if (!ctx.vaultManager) {
    return vaultJson({ error: "Vault not available" }, 503);
  }

  const success = ctx.vaultManager.deleteDocument(id);
  if (!success) return vaultJson({ error: "Document not found" }, 404);

  const isHtmx = request.headers.get("HX-Request") === "true";
  if (isHtmx) {
    return vaultHtml(renderVaultView(ctx, "Document deleted", "success"));
  }
  return vaultJson({ success: true });
}

/**
 * Handle POST /api/vault/search - Search vault documents.
 */
export async function handleSearchVault(
  ctx: RouteContext,
  request: Request,
): Promise<Response> {
  if (!ctx.vaultManager) {
    return vaultJson({ error: "Vault not available" }, 503);
  }

  try {
    const body = await request.json() as {
      query: string;
      conversation_id?: string;
      max_results?: number;
    };

    if (!body.query) {
      return vaultJson({ error: "Query is required" }, 400);
    }

    const results = await ctx.vaultManager.search(body.query, {
      conversationId: body.conversation_id,
      maxChunks: body.max_results ?? 5,
    });

    return vaultJson({ results });
  } catch (error) {
    console.error("[Routes] handleSearchVault error:", error);
    return vaultJson({ error: "Search failed" }, 500);
  }
}

/**
 * Handle GET /fragments/settings/vault - Vault management view.
 */
export function handleVaultFragment(ctx: RouteContext): Response {
  return vaultHtml(renderVaultView(ctx));
}

/**
 * Handle GET /fragments/settings/vault/:id - Vault document detail view.
 */
export async function handleVaultDetailFragment(
  ctx: RouteContext,
  id: string,
): Promise<Response> {
  return vaultHtml(await renderVaultDetailView(ctx, id));
}

// =============================================================================
// Vault View Templates (inline to avoid large template.ts changes)
// =============================================================================

function renderVaultView(
  ctx: RouteContext,
  statusMsg?: string,
  statusType?: "success" | "error",
): string {
  const docs = ctx.vaultManager?.listDocuments() ?? [];

  const statusHtml = statusMsg
    ? `<div class="settings-status visible ${statusType}">${
      escapeHtml(statusMsg)
    }</div>`
    : "";

  const docCards = docs.length === 0
    ? `<div class="vault-empty">No documents in the Data Vault. Upload a file or the entity can create documents using vault.</div>`
    : docs.map((d) => {
      const sourceLabel = d.source === "entity" ? "entity" : "upload";
      const sizeKB = (d.fileSize / 1024).toFixed(1);
      const date = new Date(d.updatedAt).toLocaleDateString([], {
        timeZone: Deno.env.get("PSYCHEROS_DISPLAY_TZ") || Deno.env.get("TZ") ||
          undefined,
      });

      return `<div class="vault-card" hx-target="#chat" hx-swap="innerHTML">
        <div class="vault-card-header">
          <span class="vault-card-title">${escapeHtml(d.title)}</span>
          <div class="vault-card-meta">
            <span class="vault-type-badge">${d.fileType.toUpperCase()}</span>
            <span class="vault-source-badge">${sourceLabel}</span>
          </div>
        </div>
        <div class="vault-card-body">
          <span>${d.chunkCount} chunks</span>
          <span>${sizeKB} KB</span>
          <span>${date}</span>
        </div>
        <div class="vault-card-actions">
          <a class="btn btn--sm" hx-get="/fragments/settings/vault/${d.id}">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
            View/Edit
          </a>
          <button class="btn btn--sm btn--danger"
            hx-delete="/api/vault/${d.id}"
            hx-confirm="Delete this document?"
            hx-target="#chat"
            hx-swap="innerHTML"
            hx-on::after-request="if(event.detail.successful) htmx.ajax('GET','/fragments/settings/vault',{target:'#chat',swap:'innerHTML'})"
            onclick="event.stopPropagation()">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
            Delete
          </button>
        </div>
      </div>`;
    }).join("\n");

  return `<div class="settings-view">
  <div class="settings-header">
    <div class="settings-header-row">
      <a class="settings-back-btn"
        hx-get="/fragments/settings"
        hx-target="#chat"
        hx-swap="innerHTML">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="15 18 9 12 15 6"/>
        </svg>
        <span>Settings</span>
      </a>
      <div>
        <h1 class="settings-title">Data Vault</h1>
        <p class="settings-desc">Store and search documents for context-aware responses</p>
      </div>
    </div>
  </div>
  <div class="settings-content" id="settings-content">
    ${statusHtml}
    <div class="vault-upload">
      <form hx-post="/api/vault" hx-encoding="multipart/form-data" hx-target="#chat" hx-swap="innerHTML">
        <div class="form-row">
          <div class="form-group" style="flex:0 0 auto;">
            <label>Document</label>
            <label class="btn btn--sm" style="position:relative;overflow:hidden;cursor:pointer;">
              Choose File
              <input type="file" id="vault-file-input" name="document" accept=".md,.txt,.pdf,.docx,.xlsx" required style="position:absolute;inset:0;opacity:0;cursor:pointer;" />
            </label>
          </div>
          <div class="form-group">
            <label>Title (optional)</label>
            <input type="text" name="title" placeholder="Auto-detected from filename" />
          </div>
          <div class="form-group" style="flex:0;align-items:flex-end">
            <button type="submit" class="btn btn--primary">Upload</button>
          </div>
        </div>
      </form>
    </div>
    <div class="vault-list">
      ${docCards}
    </div>
  </div>
</div>`;
}

async function renderVaultDetailView(
  ctx: RouteContext,
  id: string,
): Promise<string> {
  const doc = ctx.vaultManager?.getDocument(id);

  if (!doc) {
    return `<div class="settings-view">
      <div class="settings-header">
        <div class="settings-header-row">
          <a class="settings-back-btn"
            hx-get="/fragments/settings/vault"
            hx-target="#chat"
            hx-swap="innerHTML">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polyline points="15 18 9 12 15 6"/>
            </svg>
            <span>Vault</span>
          </a>
        </div>
      </div>
      <div class="settings-content">
        <div class="settings-empty">Document not found.</div>
      </div>
    </div>`;
  }

  const isEditable = doc.source === "entity";
  let contentText = "";
  let loadError = "";
  try {
    if (isEditable || doc.fileType === "md" || doc.fileType === "txt") {
      contentText = Deno.readTextFileSync(doc.filePath);
    } else {
      // For binary formats, extract text via processor
      const { extractText } = await import("../vault/processor.ts");
      contentText = await extractText(doc.filePath, doc.fileType);
    }
  } catch (err) {
    console.error(`[Vault] Failed to load content for "${doc.title}":`, err);
    loadError =
      "Could not load file content. The file may not exist or may be corrupted.";
  }

  const renderedContent = contentText ? renderMarkdown(contentText) : "";
  const canView = doc.fileType === "md" || doc.fileType === "txt" || isEditable;
  const showLoadError = loadError
    ? `<div class="settings-status visible error" style="margin-bottom:var(--sp-3)">${
      escapeHtml(loadError)
    }</div>`
    : "";

  return `<div class="settings-view">
  <div class="settings-header">
    <div class="settings-header-row">
      <a class="settings-back-btn"
        hx-get="/fragments/settings/vault"
        hx-target="#chat"
        hx-swap="innerHTML">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="15 18 9 12 15 6"/>
        </svg>
        <span>Vault</span>
      </a>
      <div>
        <h1 class="settings-title">${escapeHtml(doc.title)}</h1>
        <p class="settings-desc">
          ${doc.fileType.toUpperCase()} | ${doc.chunkCount} chunks | ${
    (doc.fileSize / 1024).toFixed(1)
  } KB | ${doc.source}
        </p>
      </div>
    </div>
  </div>
  <div class="settings-content">
    ${showLoadError}
    <div class="settings-editor">
      <div class="settings-editor-header">
        <span class="settings-editor-filename">${
    escapeHtml(doc.filename)
  }</span>
        ${
    canView
      ? `
        <div class="vault-view-toggle" style="margin-left:auto;display:flex;gap:var(--sp-1)">
          <button type="button" class="btn btn--sm vault-toggle-btn vault-toggle-btn--active" onclick="this.classList.add('vault-toggle-btn--active');this.nextElementSibling.classList.remove('vault-toggle-btn--active');document.getElementById('vault-view-mode').style.display='';document.getElementById('vault-edit-mode').style.display='none'">View</button>
          <button type="button" class="btn btn--sm vault-toggle-btn" onclick="this.classList.add('vault-toggle-btn--active');this.previousElementSibling.classList.remove('vault-toggle-btn--active');document.getElementById('vault-edit-mode').style.display='';document.getElementById('vault-view-mode').style.display='none'">Edit</button>
        </div>`
      : ""
  }
      </div>
      <div id="vault-view-mode" class="vault-view-content" style="${
    canView ? "" : "display:none"
  }">
        ${
    contentText
      ? `<div class="assistant-text">${renderedContent}</div>`
      : '<div class="vault-empty">No content to display.</div>'
  }
      </div>
      <div id="vault-edit-mode" class="vault-edit-content" style="display:none">
        <form hx-put="/api/vault/${doc.id}" hx-target="#vault-editor-status" hx-swap="innerHTML">
          <div class="form-group" style="margin-bottom:var(--sp-3)">
            <label>Title</label>
            <input type="text" name="title" value="${escapeHtml(doc.title)}" />
          </div>
          <div class="form-group">
            <label>Content</label>
            <textarea name="content" class="settings-textarea" rows="20">${
    escapeHtml(contentText)
  }</textarea>
          </div>
          <div class="settings-editor-actions">
            <button type="submit" class="btn btn--primary">Save Changes</button>
            <a class="btn btn--ghost" hx-get="/fragments/settings/vault" hx-target="#chat" hx-swap="innerHTML">Cancel</a>
          </div>
          <div id="vault-editor-status" class="settings-editor-status"></div>
        </form>
      </div>
    </div>
  </div>
</div>`;
}

// =============================================================================
// Push Notification Routes
// =============================================================================

/**
 * POST /api/push/subscribe - Store a push subscription.
 * Expects JSON body: { endpoint: string, keys: { p256dh: string, auth: string } }
 */
export async function handlePushSubscribe(
  ctx: RouteContext,
  request: Request,
): Promise<Response> {
  try {
    const body = await request.json() as {
      endpoint?: string;
      keys?: { p256dh: string; auth: string };
    };

    if (!body.endpoint || !body.keys?.p256dh || !body.keys?.auth) {
      return new Response(
        JSON.stringify({
          error:
            "Invalid subscription: endpoint and keys (p256dh, auth) are required",
        }),
        {
          status: 400,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          },
        },
      );
    }

    const db = ctx.db.getRawDb();
    const keysJson = JSON.stringify(body.keys);
    saveSubscription(db, body.endpoint, keysJson);

    console.log(
      `[Push] Subscription stored: ${body.endpoint.substring(0, 60)}...`,
    );

    // Return VAPID public key so client can verify
    const vapidKeys = await loadOrGenerateKeys(ctx.dataRoot);

    return new Response(
      JSON.stringify({ success: true, publicKey: vapidKeys.publicKey }),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      },
    );
  } catch (error) {
    console.error(
      "[Push] Subscribe error:",
      error instanceof Error ? error.message : String(error),
    );
    return new Response(
      JSON.stringify({ error: "Failed to store subscription" }),
      {
        status: 500,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      },
    );
  }
}

/**
 * POST /api/push/unsubscribe - Remove a push subscription.
 * Expects JSON body: { endpoint: string }
 */
export async function handlePushUnsubscribe(
  ctx: RouteContext,
  request: Request,
): Promise<Response> {
  try {
    const body = await request.json() as { endpoint?: string };

    if (!body.endpoint) {
      return new Response(
        JSON.stringify({ error: "endpoint is required" }),
        {
          status: 400,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          },
        },
      );
    }

    const db = ctx.db.getRawDb();
    deletePushSubscription(db, body.endpoint);

    console.log(
      `[Push] Subscription removed: ${body.endpoint.substring(0, 60)}...`,
    );

    return new Response(
      JSON.stringify({ success: true }),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      },
    );
  } catch (error) {
    console.error(
      "[Push] Unsubscribe error:",
      error instanceof Error ? error.message : String(error),
    );
    return new Response(
      JSON.stringify({ error: "Failed to remove subscription" }),
      {
        status: 500,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      },
    );
  }
}

/**
 * GET /api/push/vapid-key - Return the VAPID public key.
 * The client needs this to call pushManager.subscribe().
 */
export async function handlePushVapidKey(
  ctx: RouteContext,
): Promise<Response> {
  try {
    const vapidKeys = await loadOrGenerateKeys(ctx.dataRoot);
    return new Response(
      JSON.stringify({ publicKey: vapidKeys.publicKey }),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      },
    );
  } catch (error) {
    console.error(
      "[Push] VAPID key error:",
      error instanceof Error ? error.message : String(error),
    );
    return new Response(
      JSON.stringify({ error: "Failed to get VAPID key" }),
      {
        status: 500,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      },
    );
  }
}

// =============================================================================
// Entity Core Routes
// =============================================================================

/**
 * Handle GET /fragments/settings/entity-core — Entity Core hub with tab navigation.
 */
export function handleEntityCoreFragment(_ctx: RouteContext): Response {
  const html = renderEntityCoreHub();
  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

/**
 * Handle GET /fragments/settings/entity-core/overview — Overview tab.
 */
export async function handleEntityCoreOverview(
  ctx: RouteContext,
): Promise<Response> {
  const connected = ctx.mcpClient?.isAlive() ?? false;

  let stats = null;
  let pendingIdentity = 0;
  let lastSyncTime = null;
  let extraction = null;

  if (connected && ctx.mcpClient) {
    [stats, extraction] = await Promise.all([
      ctx.mcpClient.getGraphStats(),
      ctx.mcpClient.getExtractionHealth(),
    ]);
    const pending = ctx.mcpClient.getPendingCount();
    pendingIdentity = pending.identity;
    lastSyncTime = ctx.mcpClient.getLastSyncTime();
  }

  const data: EntityCoreOverviewData = {
    connected,
    stats,
    pendingIdentity,
    lastSyncTime,
    extraction,
  };

  const html = renderEntityCoreOverview(data);
  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

/**
 * Handle GET /fragments/settings/entity-core/llm — LLM settings tab.
 */
export function handleEntityCoreLLM(ctx: RouteContext): Response {
  const settings = ctx.getEntityCoreLLMSettings();
  const activeProfile = ctx.getActiveLLMProfile();

  const data: import("./templates.ts").EntityCoreLLMData = {
    settings,
    resolved: {
      model: settings.model || activeProfile?.model || "",
      temperature: settings.temperature ?? 0.3,
      maxTokens: settings.maxTokens ?? 8000,
      profileName: activeProfile?.name || null,
    },
  };

  const html = renderEntityCoreLLM(data);
  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

/**
 * Handle GET /fragments/settings/entity-core/graph — Knowledge Graph tab.
 */
export async function handleEntityCoreGraph(
  ctx: RouteContext,
): Promise<Response> {
  if (!ctx.mcpClient) {
    return new Response(
      `<div class="error">Knowledge Graph requires entity-core connection.</div>`,
      {
        status: 503,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      },
    );
  }

  const stats = await ctx.mcpClient.getGraphStats();
  const html = renderEntityCoreGraph(stats);
  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

/**
 * Handle GET /fragments/settings/entity-core/maintenance — Maintenance tab.
 */
export function handleEntityCoreMaintenance(ctx: RouteContext): Response {
  const mcpAvailable = !!ctx.mcpClient;
  const html = renderEntityCoreMaintenance(mcpAvailable);
  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

/**
 * Handle GET /fragments/settings/entity-core/snapshots — Snapshots tab.
 */
export async function handleEntityCoreSnapshots(
  ctx: RouteContext,
): Promise<Response> {
  let snapshots: Array<{
    id: string;
    category: string;
    filename: string;
    timestamp: string;
    date: string;
    reason: string;
    source?: string;
  }> = [];

  // Try entity-core snapshots first
  if (ctx.mcpClient) {
    const result = await ctx.mcpClient.listSnapshots();
    snapshots = result.snapshots ?? [];
  }

  // Fall back to local snapshots if entity-core has none
  if (snapshots.length === 0) {
    const manager = new IdentityFileManager(
      ctx.mcpClient ?? null,
      ctx.dataRoot,
    );
    const localSnapshots = await manager.listSnapshots();
    snapshots = localSnapshots.map((s) => ({
      id: s.path, // Use filesystem path as ID for local snapshots
      category: s.category,
      filename: s.filename,
      timestamp: s.date, // Only have date, not full timestamp
      date: s.date,
      reason: "local",
      source: "local",
    }));
  }

  const html = renderEntityCoreSnapshots(snapshots);
  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

/**
 * Handle GET /fragments/entity-core/snapshots/:id — Snapshot preview.
 */
export async function handleEntityCoreSnapshotPreview(
  ctx: RouteContext,
  snapshotId: string,
): Promise<Response> {
  const decodedId = decodeURIComponent(snapshotId);

  // Local snapshot: ID is a filesystem path
  if (decodedId.startsWith("/")) {
    try {
      const content = await Deno.readTextFile(decodedId);

      // Parse metadata from snapshot header
      const lines = content.split("\n");
      let category = "self";
      let filename = "unknown";
      for (const line of lines.slice(0, 10)) {
        const catMatch = line.match(/^# Snapshot: (.+)\/(.+)$/);
        if (catMatch) {
          category = catMatch[1];
          filename = catMatch[2];
        }
      }

      const html = renderEntityCoreSnapshotPreview(
        category,
        filename,
        content,
        snapshotId,
      );
      return new Response(html, {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    } catch {
      return new Response(
        `<div class="error">Local snapshot not found.</div>`,
        {
          status: 404,
          headers: { "Content-Type": "text/html; charset=utf-8" },
        },
      );
    }
  }

  // Entity-core snapshot
  if (!ctx.mcpClient) {
    return new Response(
      `<div class="error">Snapshots require entity-core connection.</div>`,
      {
        status: 503,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      },
    );
  }

  const result = await ctx.mcpClient.getSnapshotContent(decodedId);
  if (!result.success || !result.content) {
    return new Response(
      `<div class="error">${
        escapeHtml(result.error || "Snapshot not found")
      }</div>`,
      {
        status: 404,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      },
    );
  }

  // Parse metadata from snapshot header
  const lines = result.content.split("\n");
  let category = "self";
  let filename = "unknown";
  for (const line of lines.slice(0, 10)) {
    const catMatch = line.match(/^# Snapshot: (.+)\/(.+)$/);
    if (catMatch) {
      category = catMatch[1];
      filename = catMatch[2];
    }
  }

  const html = renderEntityCoreSnapshotPreview(
    category,
    filename,
    result.content,
    snapshotId,
  );
  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

// NOTE: Memory Consolidation removed from UI — it now runs automatically on
// startup. Route handler preserved below in case manual triggering is ever
// needed again.
//
// /**
//  * Handle POST /api/entity-core/consolidation/run — Run consolidation from Entity Core context.
//  */
// let ecConsolidationRunning = false;
//
// export function handleEntityCoreConsolidationRun(ctx: RouteContext): Response {
//   if (!ctx.mcpClient) {
//     return new Response(
//       renderSaveError("Consolidation requires MCP connection to entity-core"),
//       {
//         status: 400,
//         headers: { "Content-Type": "text/html; charset=utf-8" },
//       },
//     );
//   }
//
//   if (ecConsolidationRunning) {
//     return new Response(renderSaveError("Consolidation is already running"), {
//       status: 409,
//       headers: { "Content-Type": "text/html; charset=utf-8" },
//     });
//   }
//
//   ecConsolidationRunning = true;
//
//   const html = renderECConsolidationRunning();
//   const response = new Response(html, {
//     headers: { "Content-Type": "text/html; charset=utf-8" },
//   });
//
//   // Fire consolidation in background
//   const mcpClient = ctx.mcpClient;
//   mcpClient.consolidateMemories({ all: true })
//     .then((result) => {
//       const displayResults = result.consolidations.map((c) => ({
//         granularity: c.granularity,
//         success: c.success,
//         error: c.error,
//       }));
//
//       const html = renderECConsolidationComplete(displayResults);
//       getBroadcaster().broadcastUpdate({
//         target: "#ec-consolidation-content",
//         html,
//         swap: "outerHTML",
//       }, null);
//     })
//     .catch((error) => {
//       console.error("[Routes] EC consolidation failed:", error);
//       const html = renderECConsolidationComplete([
//         {
//           granularity: "consolidation",
//           success: false,
//           error: error instanceof Error ? error.message : String(error),
//         },
//       ]);
//       getBroadcaster().broadcastUpdate({
//         target: "#ec-consolidation-content",
//         html,
//         swap: "outerHTML",
//       }, null);
//     })
//     .finally(() => {
//       ecConsolidationRunning = false;
//     });
//
//   return response;
// }

let ecPurgeRunning = false;

export function handleEntityCoreEmbeddingPurge(ctx: RouteContext): Response {
  if (!ctx.mcpClient) {
    return new Response(
      renderSaveError("Purge requires MCP connection to entity-core"),
      {
        status: 400,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      },
    );
  }

  if (ecPurgeRunning) {
    return new Response(renderSaveError("Purge is already running"), {
      status: 409,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }

  ecPurgeRunning = true;

  const html = renderECEmbeddingPurgeRunning();
  const response = new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });

  const mcpClient = ctx.mcpClient;
  mcpClient.purgeEmbeddings()
    .then((result) => {
      const html = renderECEmbeddingPurgeComplete({
        purged: result.purged,
        remaining: result.remaining,
        message: result.message,
      });
      getBroadcaster().broadcastUpdate({
        target: "#ec-purge-content",
        html,
        swap: "outerHTML",
      }, null);
    })
    .catch((error) => {
      console.error("[Routes] EC embedding purge failed:", error);
      const html = renderECEmbeddingPurgeComplete({
        purged: 0,
        remaining: 0,
        message: error instanceof Error ? error.message : String(error),
      });
      getBroadcaster().broadcastUpdate({
        target: "#ec-purge-content",
        html,
        swap: "outerHTML",
      }, null);
    })
    .finally(() => {
      ecPurgeRunning = false;
    });

  return response;
}

let ecRebuildRunning = false;

export function handleEntityCoreEmbeddingRebuild(ctx: RouteContext): Response {
  if (!ctx.mcpClient) {
    return new Response(
      renderSaveError("Rebuild requires MCP connection to entity-core"),
      {
        status: 400,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      },
    );
  }

  if (ecRebuildRunning) {
    return new Response(renderSaveError("Rebuild is already running"), {
      status: 409,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }

  ecRebuildRunning = true;

  const html = renderECEmbeddingRebuildRunning();
  const response = new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });

  const mcpClient = ctx.mcpClient;
  mcpClient.rebuildEmbeddings()
    .then((result) => {
      const html = renderECEmbeddingRebuildComplete({
        rebuilt: result.rebuilt,
        failed: result.failed,
        total: result.total,
        message: result.message,
      });
      getBroadcaster().broadcastUpdate({
        target: "#ec-rebuild-content",
        html,
        swap: "outerHTML",
      }, null);
    })
    .catch((error) => {
      console.error("[Routes] EC embedding rebuild failed:", error);
      const html = renderECEmbeddingRebuildComplete({
        rebuilt: 0,
        failed: 0,
        total: 0,
        message: error instanceof Error ? error.message : String(error),
      });
      getBroadcaster().broadcastUpdate({
        target: "#ec-rebuild-content",
        html,
        swap: "outerHTML",
      }, null);
    })
    .finally(() => {
      ecRebuildRunning = false;
    });

  return response;
}

/**
 * Handle POST /api/entity-core/sync — Manual sync (pull then push).
 */
export async function handleEntityCoreSync(
  ctx: RouteContext,
): Promise<Response> {
  if (!ctx.mcpClient) {
    return new Response(
      JSON.stringify({ success: false, error: "MCP not connected" }),
      {
        headers: { "Content-Type": "application/json" },
      },
    );
  }

  try {
    // Pull canonical identity; pending pushes ride the scheduler queue.
    await ctx.mcpClient.pull();
    return new Response(JSON.stringify({ success: true }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    return new Response(
      JSON.stringify({
        success: false,
        error: error instanceof Error ? error.message : String(error),
      }),
      {
        headers: { "Content-Type": "application/json" },
      },
    );
  }
}

/**
 * Handle POST /api/entity-core/actions/embed-memories — Run embed-existing-memories script.
 */
export async function handleEmbedMemories(
  _ctx: RouteContext,
  body: Record<string, unknown>,
): Promise<Response> {
  const dryRun = body.dryRun === true;
  const verbose = body.verbose === true;

  const entityCoreRoot = Deno.env.get("PSYCHEROS_ENTITY_CORE_PATH") ||
    join(_ctx.projectRoot, "..", "entity-core");

  const profileSettings = _ctx.getLLMProfileSettings();
  const activeProfile = getActiveProfile(profileSettings);

  const args = [
    "run",
    "-A",
    `${entityCoreRoot}/scripts/embed-existing-memories.ts`,
  ];
  if (dryRun) args.push("--dry-run");
  if (verbose) args.push("--verbose");

  try {
    const cmd = new Deno.Command("deno", {
      args,
      env: {
        ...Deno.env.toObject(),
        ENTITY_CORE_DATA_DIR: Deno.env.get("PSYCHEROS_ENTITY_CORE_DATA_DIR") ||
          `${entityCoreRoot}/data`,
        ENTITY_CORE_LLM_API_KEY: Deno.env.get("ENTITY_CORE_LLM_API_KEY") ||
          activeProfile?.apiKey || Deno.env.get("ZAI_API_KEY") || "",
        ENTITY_CORE_LLM_BASE_URL: Deno.env.get("ENTITY_CORE_LLM_BASE_URL") ||
          activeProfile?.baseUrl || Deno.env.get("ZAI_BASE_URL") || "",
        ENTITY_CORE_LLM_MODEL: Deno.env.get("ENTITY_CORE_LLM_MODEL") ||
          activeProfile?.model || Deno.env.get("ZAI_MODEL") || "",
        ZAI_API_KEY: Deno.env.get("ZAI_API_KEY") || "",
        ZAI_BASE_URL: Deno.env.get("ZAI_BASE_URL") || "",
        ZAI_MODEL: Deno.env.get("ZAI_MODEL") || "",
      },
      stdout: "piped",
      stderr: "piped",
    });

    const process = cmd.spawn();
    const [stdout, stderr] = await Promise.all([
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
    ]);
    const status = await process.status;

    const output = stdout + (stderr ? `\n--- stderr ---\n${stderr}` : "");
    const success = status.success;

    return new Response(
      JSON.stringify({ success, exitCode: status.code, output }),
      {
        headers: { "Content-Type": "application/json" },
      },
    );
  } catch (error) {
    return new Response(
      JSON.stringify({
        success: false,
        exitCode: -1,
        output: `Failed to spawn script: ${
          error instanceof Error ? error.message : String(error)
        }`,
      }),
      { headers: { "Content-Type": "application/json" } },
    );
  }
}

// =============================================================================
// Gallery API Routes
// =============================================================================

export interface GalleryImage {
  filename: string;
  path: string;
  category: "generated" | "user";
  size: number;
  url: string;
  createdAt: string;
  prompt?: string;
  generator?: string;
  description?: string;
}

export interface GalleryResult {
  totalSize: number;
  generatedCount: number;
  userCount: number;
  total: number;
  offset: number;
  limit: number;
  hasMore: boolean;
  images: GalleryImage[];
}

/**
 * Scan generated-images and chat-attachments directories, cross-referencing
 * with messages table for metadata (prompt, generator, date).
 */
async function scanGalleryImages(
  ctx: RouteContext,
  offset: number,
  limit: number,
): Promise<GalleryResult> {
  const genDir = `${ctx.dataRoot}/.psycheros/generated-images`;
  const attDir = `${ctx.dataRoot}/.psycheros/chat-attachments`;

  const allImages: GalleryImage[] = [];

  // Scan generated-images directory
  try {
    for await (const entry of Deno.readDir(genDir)) {
      if (!entry.isFile) continue;
      const ext = entry.name.split(".").pop()?.toLowerCase();
      if (!["png", "jpg", "jpeg", "webp", "gif"].includes(ext || "")) continue;

      const filePath = `${genDir}/${entry.name}`;
      let stat: Deno.FileInfo;
      try {
        stat = await Deno.stat(filePath);
      } catch {
        continue;
      }

      // Query messages for metadata
      const row = ctx.db.getRawDb()
        .prepare(
          "SELECT content, created_at FROM messages WHERE content LIKE ? ORDER BY created_at ASC LIMIT 1",
        )
        .get<{ content: string; created_at: string }>(
          `%/generated-images/${entry.name}%`,
        );

      let prompt: string | undefined;
      let generator: string | undefined;
      let description: string | undefined;
      let createdAt = stat.birthtime?.toISOString() ||
        stat.mtime?.toISOString() || "";

      if (row) {
        createdAt = row.created_at;
        // Parse [IMAGE:{...}] metadata
        const match = row.content.match(/\[IMAGE:\s*(\{.*?\})\]/);
        if (match) {
          try {
            const meta = JSON.parse(match[1]);
            prompt = typeof meta.prompt === "string" ? meta.prompt : undefined;
            generator = typeof meta.generator === "string"
              ? meta.generator
              : undefined;
            description = typeof meta.description === "string"
              ? meta.description
              : undefined;
          } catch {
            // Ignore malformed JSON
          }
        }
      }

      allImages.push({
        filename: entry.name,
        path: `/generated-images/${entry.name}`,
        category: "generated",
        size: stat.size,
        url: `/generated-images/${entry.name}`,
        createdAt,
        prompt,
        generator,
        description,
      });
    }
  } catch {
    // Directory doesn't exist yet
  }

  // Scan chat-attachments directory
  try {
    for await (const entry of Deno.readDir(attDir)) {
      if (!entry.isFile) continue;
      const ext = entry.name.split(".").pop()?.toLowerCase();
      if (!["png", "jpg", "jpeg", "webp", "gif"].includes(ext || "")) continue;

      const filePath = `${attDir}/${entry.name}`;
      let stat: Deno.FileInfo;
      try {
        stat = await Deno.stat(filePath);
      } catch {
        continue;
      }

      // Query messages for earliest date
      const row = ctx.db.getRawDb()
        .prepare(
          "SELECT created_at FROM messages WHERE content LIKE ? ORDER BY created_at ASC LIMIT 1",
        )
        .get<{ created_at: string }>(`%/chat-attachments/${entry.name}%`);

      const createdAt = row?.created_at || stat.birthtime?.toISOString() ||
        stat.mtime?.toISOString() || "";

      allImages.push({
        filename: entry.name,
        path: `/chat-attachments/${entry.name}`,
        category: "user",
        size: stat.size,
        url: `/chat-attachments/${entry.name}`,
        createdAt,
      });
    }
  } catch {
    // Directory doesn't exist yet
  }

  // Sort by date descending (most recent first)
  allImages.sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  // Compute stats
  const totalSize = allImages.reduce((sum, img) => sum + img.size, 0);
  const generatedCount =
    allImages.filter((img) => img.category === "generated").length;
  const userCount = allImages.filter((img) => img.category === "user").length;

  // Paginate
  const paginated = allImages.slice(offset, offset + limit);
  const hasMore = offset + limit < allImages.length;

  return {
    totalSize,
    generatedCount,
    userCount,
    total: allImages.length,
    offset,
    limit,
    hasMore,
    images: paginated,
  };
}

/**
 * Handle GET /api/gallery/images - List images with pagination (JSON API).
 */
export async function handleGalleryImages(
  ctx: RouteContext,
  request: Request,
): Promise<Response> {
  const url = new URL(request.url);
  const offset = parseInt(url.searchParams.get("offset") || "0");
  const limit = Math.min(parseInt(url.searchParams.get("limit") || "24"), 96);

  try {
    const result = await scanGalleryImages(ctx, offset, limit);
    return new Response(JSON.stringify(result), {
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    });
  } catch (error) {
    console.error("[Routes] Failed to list gallery images:", error);
    return new Response(
      JSON.stringify({ error: "Failed to list gallery images" }),
      {
        status: 500,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      },
    );
  }
}

/**
 * Handle GET /api/entity-core-llm-settings — Get entity-core LLM settings.
 * Returns both the saved overrides and the resolved values (after applying active profile defaults).
 */
export function handleGetEntityCoreLLMSettings(ctx: RouteContext): Response {
  const settings = ctx.getEntityCoreLLMSettings();
  const activeProfile = ctx.getActiveLLMProfile();

  const resolved = {
    model: settings.model || activeProfile?.model || "",
    temperature: settings.temperature ?? 0.3,
    maxTokens: settings.maxTokens ?? 8000,
    profileName: activeProfile?.name || null,
  };

  return new Response(
    JSON.stringify({ settings, resolved }),
    {
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    },
  );
}

/**
 * Handle POST /api/entity-core-llm-settings — Save entity-core LLM settings and restart MCP.
 */
export async function handleSaveEntityCoreLLMSettings(
  ctx: RouteContext,
  request: Request,
): Promise<Response> {
  try {
    const body = await request.json() as Partial<EntityCoreLLMSettings>;

    const updated: EntityCoreLLMSettings = {};

    if (body.model !== undefined && body.model !== "") {
      updated.model = body.model;
    }

    if (body.temperature !== undefined && body.temperature !== null) {
      updated.temperature = typeof body.temperature === "string"
        ? parseFloat(body.temperature)
        : body.temperature;
    }

    if (body.maxTokens !== undefined && body.maxTokens !== null) {
      updated.maxTokens = typeof body.maxTokens === "string"
        ? parseInt(body.maxTokens, 10)
        : body.maxTokens;
    }

    await ctx.updateEntityCoreLLMSettings(updated);

    const activeProfile = ctx.getActiveLLMProfile();
    const resolved = {
      model: updated.model || activeProfile?.model || "",
      temperature: updated.temperature ?? 0.3,
      maxTokens: updated.maxTokens ?? 8000,
      profileName: activeProfile?.name || null,
    };

    return new Response(
      JSON.stringify({ success: true, settings: updated, resolved }),
      {
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      },
    );
  } catch (error) {
    console.error("[Routes] Failed to save entity-core LLM settings:", error);
    return new Response(
      JSON.stringify({ error: "Failed to save entity-core LLM settings" }),
      {
        status: 500,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      },
    );
  }
}

// =============================================================================
// Discord Gateway API Routes
// =============================================================================

export function handleGetDiscordStatus(ctx: RouteContext): Response {
  const gateway = ctx.getDiscordGateway();
  const settings = ctx.getDiscordSettings();
  const guilds = [...(gateway?.getGuilds().entries() ?? [])];
  const channels = [...(gateway?.getChannels().entries() ?? [])];

  // Group text channels (type 0) by guild
  const channelsByGuild = new Map<
    string,
    Array<{ id: string; name: string }>
  >();
  for (const [, ch] of channels) {
    if (ch.type === 0 && ch.guild_id) {
      const list = channelsByGuild.get(ch.guild_id) ?? [];
      list.push({ id: ch.id, name: ch.name });
      channelsByGuild.set(ch.guild_id, list);
    }
  }

  return new Response(
    JSON.stringify({
      connected: gateway?.isConnected() ?? false,
      enabled: settings.enabled,
      gatewayEnabled: settings.gatewayEnabled,
      showHubInSidebar: settings.showHubInSidebar !== false,
      botUserId: gateway?.getBotUserId() ?? null,
      botUsername: gateway?.getBotUsername() ?? null,
      guildCount: guilds.length,
      guilds: guilds.map(([id, g]) => ({
        id,
        name: g.name,
        memberCount: g.member_count,
        channels: channelsByGuild.get(id) ?? [],
      })),
    }),
    {
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    },
  );
}

export function handleGetDiscordGatewayConfig(ctx: RouteContext): Response {
  return new Response(
    JSON.stringify(ctx.getDiscordGatewayConfig()),
    {
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    },
  );
}

export async function handleSaveDiscordGatewayConfig(
  ctx: RouteContext,
  request: Request,
): Promise<Response> {
  try {
    const config = await request.json() as DiscordGatewayConfig;
    await ctx.updateDiscordGatewayConfig(config);
    return new Response(
      JSON.stringify({ success: true }),
      {
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      },
    );
  } catch (_error) {
    return new Response(
      JSON.stringify({ error: "Failed to save gateway config" }),
      {
        status: 400,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      },
    );
  }
}

export async function handleRestartDiscordGateway(
  ctx: RouteContext,
): Promise<Response> {
  try {
    await ctx.restartDiscordGateway();
    return new Response(
      JSON.stringify({ success: true }),
      {
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      },
    );
  } catch (_error) {
    return new Response(
      JSON.stringify({ error: "Failed to restart gateway" }),
      {
        status: 500,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      },
    );
  }
}

export function handleGetDiscordConversations(ctx: RouteContext): Response {
  const conversations = ctx.db.listConversationsBySource("discord");
  return new Response(
    JSON.stringify(conversations),
    {
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    },
  );
}

export function handleGetDmWhitelist(ctx: RouteContext): Response {
  const mapper = ctx.getDiscordConversationMapper();
  if (!mapper) {
    return new Response(
      JSON.stringify({ entries: [] }),
      {
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      },
    );
  }
  const entries = mapper.getDmWhitelist();
  return new Response(
    JSON.stringify({ entries }),
    {
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    },
  );
}

export async function handleAddDmWhitelistEntry(
  ctx: RouteContext,
  request: Request,
): Promise<Response> {
  const mapper = ctx.getDiscordConversationMapper();
  const body = await request.json() as {
    userId: string;
    username: string;
    notes?: string;
  };
  if (!body.userId || !body.username) {
    return new Response(
      JSON.stringify({
        success: false,
        error: "userId and username are required",
      }),
      {
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      },
    );
  }
  if (mapper) {
    mapper.addDmWhitelistEntry(body.userId, body.username, body.notes || "");
  }
  return new Response(
    JSON.stringify({ success: true }),
    {
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    },
  );
}

export async function handleRemoveDmWhitelistEntry(
  ctx: RouteContext,
  userId: string,
): Promise<Response> {
  const mapper = ctx.getDiscordConversationMapper();
  if (mapper) mapper.removeDmWhitelistEntry(userId);
  return new Response(
    JSON.stringify({ success: true }),
    {
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    },
  );
}

export async function handleUpdateDmWhitelistNotes(
  ctx: RouteContext,
  userId: string,
  request: Request,
): Promise<Response> {
  const mapper = ctx.getDiscordConversationMapper();
  const body = await request.json() as { username: string; notes: string };
  if (!body.username) {
    return new Response(
      JSON.stringify({ success: false, error: "username is required" }),
      {
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      },
    );
  }
  if (mapper) {
    mapper.updateDmWhitelistEntry(userId, body.username, body.notes || "");
  }
  return new Response(
    JSON.stringify({ success: true }),
    {
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    },
  );
}
