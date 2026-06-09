/**
 * Entity Loop
 *
 * The main orchestration module that handles a single conversation turn.
 * Manages the full agentic loop: LLM call -> tool execution -> continue.
 *
 * ## Error Handling Strategy
 *
 * This module uses a "best-effort persistence" strategy:
 *
 * 1. **User message persistence** - CRITICAL. If this fails, the turn is aborted
 *    because we cannot proceed without the foundation message. Throws an error.
 *
 * 2. **Assistant message persistence** - IMPORTANT but non-fatal. If this fails,
 *    the content has already been streamed to the client. We log the error and
 *    continue so the user sees the response. Data may be lost on server restart.
 *
 * 3. **Tool result persistence** - IMPORTANT but non-fatal. Tool results have
 *    already been yielded to the client and added to the LLM context. We log
 *    the error and continue. The LLM will still see and process the results.
 *
 * This strategy prioritizes user experience (not breaking mid-stream) over
 * data integrity, with the assumption that DB failures are rare and transient.
 */

import type { ChatMessage, LLMClient, StreamChunk } from "../llm/mod.ts";
import type { WebSearchSettings } from "../llm/web-search-settings.ts";
import type { DiscordSettings } from "../llm/discord-settings.ts";
import type { HomeSettings } from "../llm/home-settings.ts";
import type { ImageGenSettings } from "../llm/image-gen-settings.ts";
import { LLMError } from "../llm/mod.ts";
import type { DBClient } from "../db/mod.ts";
import type { ToolContext, ToolRegistry } from "../tools/mod.ts";
import type {
  LLMContextSnapshot,
  Message,
  ToolCall,
  ToolDefinition,
  ToolResult,
  TurnMetrics,
  UIUpdate,
} from "../types.ts";
import type { ConversationRAG } from "../rag/conversation.ts";
import type { MCPClient } from "../mcp-client/mod.ts";
import type { LorebookManager } from "../lorebook/mod.ts";
import type { VaultManager } from "../vault/mod.ts";
import {
  buildSystemMessage,
  loadBaseInstructions,
  loadCustomContent,
  loadRelationshipContent,
  loadSelfContent,
  loadUserContent,
} from "./context.ts";
import { applyContextBudget, type BudgetResult } from "./token-budget.ts";
import { buildGraphContext, formatChatHistoryForContext } from "../rag/mod.ts";
import { generateUIUpdates } from "../server/ui-updates.ts";
import { acquireLock } from "../utils/conversation-lock.ts";
import { createCollector, finalize, setFinishReason } from "../metrics/mod.ts";
import { getWearableDataCache } from "../wearable/cache.ts";
import { formatWearableData } from "./sa-formatters.ts";

/**
 * Escape special XML characters in a string.
 */
function escapeXml(str: string): string {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Format the connected devices section for the SA block.
 * Returns undefined if there are no devices to report.
 */
function formatConnectedDevices(
  snapshot: import("../server/device-cache.ts").DeviceCacheSnapshot,
  lovenseSettings?: import("../llm/lovense-settings.ts").LovenseSettings,
  buttplugSettings?: import("../llm/buttplug-settings.ts").ButtplugSettings,
): string | undefined {
  const parts: string[] = [];

  // Intimacy devices (Lovense + Intiface)
  const intimacyParts: string[] = [];

  if (snapshot.lovense.connected && snapshot.lovense.toys.length > 0) {
    const devices = snapshot.lovense.toys
      .map((t) => {
        const label = t.nickname || t.name;
        return `      <device name="${
          escapeXml(label)
        }" battery="${t.battery}" />`;
      })
      .join("\n");
    intimacyParts.push(`    <lovense count="${snapshot.lovense.toys.length}">`);
    intimacyParts.push(devices);
    intimacyParts.push("    </lovense>");
  }

  if (snapshot.intiface.connected && snapshot.intiface.devices.length > 0) {
    const devices = snapshot.intiface.devices
      .map((d) => `      <device name="${escapeXml(d.name)}" />`)
      .join("\n");
    intimacyParts.push(
      `    <intiface count="${snapshot.intiface.devices.length}">`,
    );
    intimacyParts.push(devices);
    intimacyParts.push("    </intiface>");
  }

  if (intimacyParts.length > 0) {
    parts.push("  <intimacy>");
    parts.push(intimacyParts.join("\n"));
    parts.push("  </intimacy>");
  }

  // Home devices
  if (snapshot.homeDevices.length > 0) {
    const devices = snapshot.homeDevices
      .map((d) =>
        `    <device name="${escapeXml(d.name)}" type="${escapeXml(d.type)}" />`
      )
      .join("\n");
    parts.push("  <home>");
    parts.push(devices);
    parts.push("  </home>");
  }

  if (parts.length === 0) return undefined;

  let result = `  <connected_devices>\n${
    parts.join("\n")
  }\n  </connected_devices>`;

  // Inject custom instructions only when matching devices are connected
  if (
    snapshot.lovense.connected && snapshot.lovense.toys.length > 0 &&
    lovenseSettings?.customInstructions?.trim()
  ) {
    result += `\n  <lovense_preferences>${
      escapeXml(lovenseSettings.customInstructions.trim())
    }</lovense_preferences>`;
  }
  if (
    snapshot.intiface.connected && snapshot.intiface.devices.length > 0 &&
    buttplugSettings?.customInstructions?.trim()
  ) {
    result += `\n  <toy_preferences>${
      escapeXml(buttplugSettings.customInstructions.trim())
    }</toy_preferences>`;
  }

  return result;
}

/**
/**
 * Format a timestamp for message content.
 * Uses PSYCHEROS_DISPLAY_TZ for user-facing timezone, falls back to TZ, defaults to UTC.
 * Format: <t>YYYY-MM-DD HH:MM</t>
 *
 * XML tags are used so the LLM treats timestamps as structural
 * metadata rather than content to reproduce.
 */
export function formatMessageTimestamp(date: Date): string {
  const timeZone = Deno.env.get("PSYCHEROS_DISPLAY_TZ") || Deno.env.get("TZ") ||
    "UTC";
  const weekday = date.toLocaleDateString("en-US", {
    timeZone,
    weekday: "short",
  });
  const year = date.toLocaleDateString("en-US", { timeZone, year: "numeric" });
  const month = date.toLocaleDateString("en-US", {
    timeZone,
    month: "2-digit",
  });
  const day = date.toLocaleDateString("en-US", { timeZone, day: "2-digit" });
  const time = date.toLocaleTimeString("en-US", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  return `<t>${weekday} ${year}-${month}-${day} ${time}</t>`;
}

/**
 * Options for EntityTurn.process() that modify behavior for specific callers
 * (e.g., Pulse system).
 */
export interface ProcessOptions {
  /** If this turn was triggered by a Pulse, the Pulse's ID */
  pulseId?: string;
  /** If this turn was triggered by a Pulse, the Pulse's display name */
  pulseName?: string;
  /** When true, skip user message persistence (it's already in the DB from the failed turn) */
  retry?: boolean;
  /** When true, skip user message persistence (individual messages already persisted, e.g. lurk mode) */
  skipUserPersist?: boolean;
  /** Device type of the user for this turn (from frontend detection) */
  deviceType?: "desktop" | "mobile";
  /** When true, sticky lorebook entries are not decremented.
   *  Set automatically for Pulse turns so automated messages
   *  don't consume sticky duration earned by real user conversation. */
  skipStickyDecrement?: boolean;
  /** Source type for this turn */
  sourceType?: "web" | "discord" | "pulse";
  /** Discord channel metadata (when sourceType is "discord") */
  discordContext?: {
    channelId: string;
    channelName: string;
    serverId: string | null;
    serverName: string | null;
    channelMode: string;
    isDM: boolean;
    senderUsername: string;
    senderUserId: string;
    activeTier?: import("../llm/discord-settings.ts").ActiveTier;
  };
}

/**
 * Configuration for the entity turn processor.
 */
export interface EntityConfig {
  /**
   * Source root — where psycheros source lives. Used for reading
   * templates and source-relative assets.
   */
  projectRoot: string;
  /**
   * Data root — where the entity's persistent state lives (identity,
   * snapshots, .psycheros settings, memories, custom tools).
   * Equal to projectRoot when PSYCHEROS_DATA_DIR is unset.
   */
  dataRoot: string;
  /** Maximum tool iterations before stopping (prevents infinite loops) */
  maxToolIterations?: number;
  /** Optional chat RAG for searching conversation history */
  chatRAG?: ConversationRAG;
  /** Optional MCP client for syncing with entity-core */
  mcpClient?: MCPClient;
  /** Optional lorebook manager for world info/triggered content */
  lorebookManager?: LorebookManager;
  /** Optional vault manager for document storage and eager RAG */
  vaultManager?: VaultManager;
  /** Optional web search settings */
  webSearchSettings?: WebSearchSettings;
  /** Optional Discord settings */
  discordSettings?: DiscordSettings;
  /** Optional Discord gateway config (for server/channel modes, allowed tools) */
  discordGatewayConfig?:
    import("../llm/discord-settings.ts").DiscordGatewayConfig;
  /** Discord turn context (set when processing a Discord turn) */
  discordContext?: ProcessOptions["discordContext"];
  /** Optional Home automation settings */
  homeSettings?: HomeSettings;
  /** Optional image generation settings */
  imageGenSettings?: ImageGenSettings;
  /** Optional Lovense device control settings */
  lovenseSettings?: import("../llm/lovense-settings.ts").LovenseSettings;
  /** Optional Buttplug device control settings */
  buttplugSettings?: import("../llm/buttplug-settings.ts").ButtplugSettings;
  /** Optional BLE device bridge settings */
  bleSettings?: import("../llm/ble-settings.ts").BLESettings;
  /** Device status cache for connected devices SA signal */
  deviceStatusCache?: import("../server/device-cache.ts").DeviceStatusCache;
  /** Model context window size in tokens (from active LLM profile) */
  contextLength?: number;
  /** Maximum tokens reserved for the response (from active LLM profile) */
  maxTokens?: number;
}

/**
 * Default maximum tool iterations.
 * Set high enough to allow complex multi-tool workflows (identity + memory +
 * graph + RAG chains) while still catching genuine runaway loops.
 */
const DEFAULT_MAX_TOOL_ITERATIONS = 25;

/**
 * Number of conversation turns (user+assistant pairs) to keep longform image
 * descriptions in context before fading to shorthand. After this many turns,
 * the entity can use the look_closer tool to retrieve the full description.
 */
const IMAGE_DESCRIPTION_FADE_TURNS = 5;

/**
 * Extended yield type that includes tool results, UI updates, and metrics.
 */
export type EntityYield =
  | StreamChunk
  | { type: "tool_result"; result: ToolResult }
  | { type: "dom_update"; update: UIUpdate }
  | {
    type: "status";
    status: {
      message?: string;
      error?: string;
      retry?: { attempt: number; maxAttempts: number };
    };
  }
  | { type: "metrics"; metrics: TurnMetrics }
  | { type: "context"; context: LLMContextSnapshot }
  | { type: "message_id"; role: "user" | "assistant"; id: string }
  | {
    type: "image_generated";
    imagePath: string;
    prompt: string;
    generatorName: string;
    description?: string;
  };

/**
 * Represents a single turn in the conversation.
 * Handles the full cycle: LLM call -> tool execution -> continue until done.
 */
/**
 * Fade an image marker's longform description to its shortform.
 * Operates on raw message content (not HTML-rendered).
 *
 * For [IMAGE:{...}] markers: replaces "description" with "shortDescription" if available.
 * For [USER_IMAGE:... | Caption: ... | Short: ...]: replaces Caption with Short.
 */
function fadeImageMarker(content: string): string {
  // Fade [IMAGE:{...}] markers — replace long description with short
  // Use a greedy match up to }] to handle JSON with complex string values
  content = content.replace(
    /\[IMAGE:(\{.*\})\]/g,
    (_match, jsonStr) => {
      try {
        const img = JSON.parse(jsonStr);
        if (img.shortDescription && img.description) {
          img.description = img.shortDescription;
        }
        return `[IMAGE:${JSON.stringify(img)}]`;
      } catch {
        return _match;
      }
    },
  );

  // Fade [USER_IMAGE:... | Caption: ... | Short: ...] markers
  content = content.replace(
    /\[USER_IMAGE:\s*(\S+)\s*\|\s*Caption:\s*(.*?)\s*\|\s*Short:\s*(.*?)\]/g,
    (_match, path, _caption, short) => {
      return `[USER_IMAGE: ${path} | Short: ${short}]`;
    },
  );

  return content;
}

/**
 * Tool names whose arguments are verbose and should be faded in context.
 * These tools have their key info (image path, prompt) captured in the
 * tool result content or IMAGE markers, so the full arguments are redundant.
 */
const FADE_ARGUMENT_TOOLS = new Set([
  "generate_image",
  "describe_image",
  "look_closer",
]);

/**
 * Fade verbose tool call arguments to reduce token usage in context.
 * For image-related tools, replaces the arguments JSON with a minimal
 * version that preserves structure but removes verbose fields (long prompts,
 * detailed descriptions). The LLM only needs the tool_call_id to match
 * results; the arguments are redundant with tool result content.
 */
function fadeToolCallArguments(toolCalls: ToolCall[]): ToolCall[] {
  return toolCalls.map((tc) => {
    const name = tc.function.name;
    if (!FADE_ARGUMENT_TOOLS.has(name)) return tc;

    try {
      const args = JSON.parse(tc.function.arguments) as Record<string, unknown>;
      // Keep only structural fields, truncate verbose string fields
      const faded: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(args)) {
        if (typeof value === "string" && value.length > 50) {
          faded[key] = value.slice(0, 50) + "... [truncated]";
        } else {
          faded[key] = value;
        }
      }
      return {
        ...tc,
        function: {
          ...tc.function,
          arguments: JSON.stringify(faded),
        },
      };
    } catch {
      // If we can't parse the arguments, leave them as-is
      return tc;
    }
  });
}

export class EntityTurn {
  private readonly maxToolIterations: number;
  private lastBudgetResult?: BudgetResult;

  constructor(
    private llm: LLMClient,
    private db: DBClient,
    private tools: () => ToolRegistry,
    private config: EntityConfig,
  ) {
    this.maxToolIterations = config.maxToolIterations ??
      DEFAULT_MAX_TOOL_ITERATIONS;
  }

  /**
   * Process a user message and yield stream chunks.
   *
   * This handles the full agentic loop:
   * 1. Load identity files and build context
   * 2. Get conversation history from DB
   * 3. Stream LLM response
   * 4. If tool calls, execute them and continue
   * 5. Persist all messages to DB
   *
   * @param conversationId - The conversation ID to use
   * @param userMessage - The user's message text
   * @param options - Optional process options (e.g., Pulse metadata)
   * @yields Stream chunks and tool results as they occur
   */
  async *process(
    conversationId: string,
    userMessage: string,
    options?: ProcessOptions,
  ): AsyncGenerator<EntityYield, void, unknown> {
    // Ensure conversation exists - if not, create one and use its ID
    let conversation = this.db.getConversation(conversationId);
    if (!conversation) {
      conversation = this.db.createConversation();
      // Use the newly created conversation's ID for all subsequent operations
      conversationId = conversation.id;
      console.warn(
        `EntityTurn: Requested conversation not found. Created new conversation ${conversationId}.`,
      );
    }

    // Load self files, user files, relationship files, and custom files, build system message
    // Use MCP client if available, otherwise fall back to local files
    const selfContent = await loadSelfContent(
      this.config.dataRoot,
      this.config.mcpClient,
    );
    const userContent = await loadUserContent(
      this.config.dataRoot,
      this.config.mcpClient,
    );
    const relationshipContent = await loadRelationshipContent(
      this.config.dataRoot,
      this.config.mcpClient,
    );
    const customContent = await loadCustomContent(
      this.config.dataRoot,
      this.config.mcpClient,
    );

    // Retrieve relevant memories via MCP search
    let memoriesContent: string | undefined;
    if (this.config.mcpClient) {
      console.debug(
        "[Memory] Searching memories for query:",
        userMessage.substring(0, 50),
      );
      try {
        const results = await this.config.mcpClient.searchMemories(userMessage);
        if (results.length > 0) {
          memoriesContent = results.map((r, i) =>
            `[${i + 1}] (${r.granularity}/${r.date}, ${
              Math.round(r.score * 100)
            }% relevant)\n${r.excerpt}`
          ).join("\n\n");
          memoriesContent = `\n\n---\nRelevant Memories:\n\n${memoriesContent}`;
          console.debug(
            "[Memory] Found",
            results.length,
            "memories (",
            memoriesContent.length,
            "chars)",
          );
        }
      } catch (error) {
        console.error(
          "EntityTurn: Memory search failed:",
          error instanceof Error ? error.message : String(error),
        );
      }
    }

    // Retrieve relevant chat history using Chat RAG if available
    let chatHistoryContent: string | undefined;
    if (this.config.chatRAG) {
      console.debug(
        "[ChatRAG] Searching chat history for:",
        userMessage.substring(0, 50),
      );
      try {
        const chatMessages = await this.config.chatRAG.searchTiered({
          query: userMessage,
          conversationId: conversationId,
          limit: 5,
          minScore: 0.3,
          currentThreshold: 0.5,
        });
        console.debug(
          "[ChatRAG] Found",
          chatMessages.length,
          "relevant messages",
        );
        chatHistoryContent = formatChatHistoryForContext(chatMessages);
        if (chatHistoryContent) {
          console.debug(
            "[ChatRAG] Injected chat history into context (",
            chatHistoryContent.length,
            "chars)",
          );
        }
      } catch (error) {
        // Non-fatal: log and continue without chat history
        console.error(
          "EntityTurn: Chat RAG search failed:",
          error instanceof Error ? error.message : String(error),
        );
      }
    }

    // Evaluate lorebook triggers if manager is available
    let lorebookContent: string | undefined;
    if (this.config.lorebookManager) {
      try {
        // Get conversation history for lorebook evaluation (before adding current user message)
        const history = this.db.getMessages(conversationId);
        const historyForLorebook = history.map((msg) => ({
          role: msg.role,
          content: msg.content,
        }));

        const result = this.config.lorebookManager.evaluate(
          userMessage,
          historyForLorebook,
          conversationId,
          { skipStickyDecrement: options?.skipStickyDecrement },
        );

        if (result.context) {
          lorebookContent = result.context;
          console.debug(
            "[Lorebook] Triggered",
            result.entries.length,
            "entries (",
            result.totalTokens,
            "tokens)",
          );
        }
      } catch (error) {
        // Non-fatal: log and continue without lorebook content
        console.error(
          "EntityTurn: Lorebook evaluation failed:",
          error instanceof Error ? error.message : String(error),
        );
      }
    }

    // Retrieve relevant knowledge graph context if MCP client is available
    let graphContent: string | undefined;
    if (this.config.mcpClient) {
      console.debug(
        "[Graph] Searching knowledge graph for:",
        userMessage.substring(0, 50),
      );
      try {
        const graphResult = await buildGraphContext(
          userMessage,
          this.config.mcpClient,
          {
            maxNodes: 8,
            minScore: 0.3,
            includeRelated: true,
            traversalDepth: 1,
          },
        );
        if (graphResult.context) {
          graphContent = graphResult.context;
          console.debug(
            "[Graph] Found",
            graphResult.nodeCount,
            "nodes and",
            graphResult.edgeCount,
            "edges (",
            graphContent.length,
            "chars)",
          );
        }
      } catch (error) {
        // Non-fatal: log and continue without graph context
        console.error(
          "EntityTurn: Graph context retrieval failed:",
          error instanceof Error ? error.message : String(error),
        );
      }
    }

    const baseInstructions = await loadBaseInstructions(
      this.config.dataRoot,
      this.config.mcpClient,
      conversationId,
    );

    // Build image generation context from enabled generators
    let imageGenContent: string | undefined;
    if (this.config.imageGenSettings?.generators.some((g) => g.enabled)) {
      const enabled = this.config.imageGenSettings.generators.filter((g) =>
        g.enabled
      );
      imageGenContent = enabled.map((g) =>
        `- "${g.name}" (ID: ${g.id}): ${g.description} [${g.provider}${
          g.nsfw ? ", NSFW-capable" : ", SFW only"
        }]`
      ).join("\n");

      // Include available anchor images so the entity knows what IDs to use
      const anchors = this.db.getRawDb()
        .prepare(
          "SELECT id, label, description FROM anchor_images ORDER BY created_at DESC",
        )
        .all<{ id: string; label: string; description: string }>();
      if (anchors.length > 0) {
        imageGenContent +=
          "\n\nAvailable anchor images (use IDs in anchor_ids parameter):\n" +
          anchors.map((a) =>
            `- "${a.label}" (ID: ${a.id}): ${a.description || "no description"}`
          ).join("\n");
      }

      imageGenContent +=
        "\n\nTo generate an image, I use the generate_image tool with the appropriate generator_id. I can include anchor_images by ID as style references, and a user_image_path if the user provided an image with their message.";
    }

    // Search vault for relevant documents if manager is available
    let vaultContent: string | undefined;
    if (this.config.vaultManager) {
      console.debug("[Vault] Searching for:", userMessage.substring(0, 50));
      try {
        const vaultResults = await this.config.vaultManager.search(
          userMessage,
          {
            conversationId,
            maxChunks: 5,
            minScore: 0.3,
          },
        );
        if (vaultResults.length > 0) {
          const { formatVaultContext } = await import("../vault/retriever.ts");
          vaultContent = formatVaultContext(vaultResults);
          console.debug(
            "[Vault] Found",
            vaultResults.length,
            "chunks (",
            vaultContent!.length,
            "chars)",
          );
        }
      } catch (error) {
        console.error(
          "EntityTurn: Vault search failed:",
          error instanceof Error ? error.message : String(error),
        );
      }
    }

    // Build situational awareness block
    let saContent: string | undefined;
    const lastInteraction = this.db.getLatestUserInteraction();

    // Get connected devices snapshot from cache (zero latency)
    const snapshot = this.config.deviceStatusCache
      ? this.config.deviceStatusCache.getSnapshot()
      : undefined;
    const deviceSection = snapshot
      ? formatConnectedDevices(
        snapshot,
        this.config.lovenseSettings,
        this.config.buttplugSettings,
      )
      : undefined;

    if (
      lastInteraction || options?.deviceType || conversation || deviceSection
    ) {
      const parts: string[] = ["<situational_awareness>"];
      parts.push(
        `  <current_time>${formatMessageTimestamp(new Date())}</current_time>`,
      );
      if (conversation) {
        const title = conversation.title
          ? escapeXml(conversation.title)
          : "Untitled";
        parts.push(
          `  <current_conversation id="${conversation.id}" title="${title}" />`,
        );
      }
      if (lastInteraction) {
        const date = new Date(lastInteraction.createdAt);
        const formatted = formatMessageTimestamp(date);
        const title = lastInteraction.title
          ? escapeXml(lastInteraction.title)
          : "Untitled";
        parts.push("  <last_user_message>");
        parts.push(`    <timestamp>${formatted}</timestamp>`);
        parts.push(
          `    <conversation id="${lastInteraction.conversationId}" title="${title}" />`,
        );
        parts.push("  </last_user_message>");
      }
      if (options?.deviceType) {
        parts.push(`  <user_device>${options.deviceType}</user_device>`);
      }
      if (deviceSection) {
        parts.push(deviceSection);
      }
      // Wearable data (sensor streams from connected devices)
      if (snapshot) {
        const wearableSection = formatWearableData(
          snapshot,
          this.config.bleSettings,
          getWearableDataCache(),
        );
        if (wearableSection) {
          parts.push(wearableSection);
        }
      }
      parts.push("</situational_awareness>");
      saContent = parts.join("\n");
    }

    // Build Discord channel context block
    let discordChannelContent: string | undefined;
    if (this.config.discordContext) {
      const ctx = this.config.discordContext;
      const parts: string[] = ["My current Discord context:"];
      if (ctx.isDM) {
        parts.push(
          `\nThis is a direct message conversation with ${ctx.senderUsername} (${ctx.senderUserId}).`,
        );
        const wlEntry = this.config.discordGatewayConfig?.dmWhitelist.find(
          (e) => e.userId === ctx.senderUserId,
        );
        if (wlEntry?.notes?.trim()) {
          parts.push(`User notes: ${wlEntry.notes}`);
        }
      } else {
        parts.push(
          `\nI am in the server "${
            ctx.serverName || ctx.serverId
          }" in the channel "#${ctx.channelName}".`,
        );
        parts.push(`Channel mode: ${ctx.channelMode}.`);
      }
      // Add global instructions if present
      if (this.config.discordSettings?.globalInstructions?.trim()) {
        parts.push(
          `\nMy instructions for Discord:\n${this.config.discordSettings.globalInstructions}`,
        );
      }
      // Add per-channel instructions if present
      if (this.config.discordGatewayConfig) {
        for (const server of this.config.discordGatewayConfig.servers) {
          const channel = server.channels.find((c) =>
            c.channelId === ctx.channelId
          );
          if (channel?.instructions?.trim()) {
            parts.push(
              `\nChannel-specific rules for #${ctx.channelName}:\n${channel.instructions}`,
            );
            break;
          }
        }
      }
      if (ctx.isDM) {
        parts.push(
          `\nThis is a direct message — a one-to-one conversation. I should engage naturally, but like any conversation, it has rhythms. If we've said what there is to say, I can let the exchange wind down by not responding — the other person will understand. If I simply don't call act_in_discord, no message is sent, and that's a natural end, not an error.`,
        );
      }

      discordChannelContent = parts.join("\n");

      // Add tier-specific instructions for active mode
      if (ctx.channelMode === "active" && ctx.activeTier) {
        if (ctx.activeTier === "slow") {
          parts.push(
            `\nThis is an active channel with low activity. I've been shown a message (or small group of messages). I should respond naturally if I have something to contribute. If nothing warrants a response, I can simply output nothing — no message will be sent.`,
          );
        } else {
          parts.push(
            `\nThis is an active channel with ${ctx.activeTier} activity. I've been shown a digest of recent messages from this channel. I should only respond if I have something meaningful to add to the conversation. If the discussion doesn't need my input, I should output nothing — this is a natural pass and no message will be sent.`,
          );
        }
      }

      // Add Discord action tool instructions
      parts.push(`
Discord interaction:
- User messages are piped in from a Discord channel. Each line shows: **author** (<@authorId>) (time) [msg:messageId]: content
- I use the act_in_discord tool to send messages and reactions. Every message I want to appear in Discord must go through this tool — any text I output without calling it stays internal and is not sent to Discord.
- I batch all my actions into a single tool call. The 'actions' array can hold as many actions as I need — I should not make multiple calls when one will do.
- Each action can include 'content' (to reply), 'emoji' (one or more, to react), or both on the same 'message_id'.
- To reply to a specific message, I include 'content' and 'message_id' — my message threads under it. To send a plain channel message, I omit 'message_id'.
- To react to a message, I include 'emoji' (one or more emoji, e.g. 👍 or ["🔥","💀"]) and 'message_id'.
- I can combine reply and react in one action: { message_id, content, emoji } replies to and reacts to the same message.
- If I have nothing to add, I simply don't call the tool. No message is sent. This is a natural pass.
- I reserve @mentions (<@userId>) for when I genuinely need to draw someone's attention. Using @mentions for every reply is redundant when message threading already makes the connection clear.`);
      discordChannelContent = parts.join("\n");
    }

    const systemMessage = buildSystemMessage(
      baseInstructions,
      selfContent,
      userContent,
      relationshipContent,
      customContent,
      memoriesContent,
      chatHistoryContent,
      lorebookContent,
      graphContent,
      vaultContent,
      imageGenContent,
      saContent,
      discordChannelContent,
    );

    // Get conversation history from DB
    const history = this.db.getMessages(conversationId);

    // For Pulse messages, prefix the content so the entity perceives it as system-initiated
    const displayContent = options?.pulseId && options?.pulseName
      ? `[System — Pulse "${options.pulseName}"] ${userMessage}`
      : userMessage;
    let userMessageId: string | undefined;

    const shouldPersist = !options?.retry && !options?.skipUserPersist;

    // Acquire per-conversation lock to prevent concurrent writes from
    // corrupting message role alternation (e.g. send_discord_dm from
    // another turn writing while this turn is mid-stream).
    const releaseLock = await acquireLock(conversationId);
    try {
      if (shouldPersist) {
        // Persist the user message
        // Note: This must succeed before we proceed, as it's the foundation of the turn
        // Store the message ID for chat RAG indexing
        try {
          // Generate ID upfront so we can use it for chat RAG indexing
          userMessageId = crypto.randomUUID();
          this.db.addMessage(conversationId, {
            role: "user",
            content: displayContent,
            pulseId: options?.pulseId,
            pulseName: options?.pulseName,
          }, userMessageId);

          // Yield user message ID so the frontend can attach edit capability
          yield { type: "message_id", role: "user", id: userMessageId };

          // Index the user message for chat RAG (non-blocking, non-fatal)
          // Skip for Discord and other non-web source turns
          if (
            this.config.chatRAG && userMessageId && !this.config.discordContext
          ) {
            this.config.chatRAG.indexMessage(
              userMessageId,
              conversationId,
              "user",
              displayContent,
            ).catch((error) => {
              console.warn("[ChatRAG] Failed to index user message:", error);
            });
          }
        } catch (error) {
          // User message persistence is critical - rethrow with context
          const message = error instanceof Error
            ? error.message
            : String(error);
          throw new Error(`Failed to persist user message: ${message}`);
        }
      } else {
        // User message not persisted — either retry, skip, or force-append only.
        const lastUserMsg = [...history].reverse().find((m) =>
          m.role === "user"
        );
        userMessageId = lastUserMsg?.id;
        if (options?.retry) {
          console.log(
            "[EntityTurn] Retry mode: skipping user message persistence",
          );
        }
      }

      // Get tool definitions (needed for context budget estimation)
      const toolDefinitions = this.tools().getDefinitions();

      // Build the messages array for the LLM
      const messages = this.buildMessages(
        systemMessage,
        history,
        displayContent,
        shouldPersist,
        toolDefinitions,
      );

      // Create and yield context snapshot for debugging
      const contextSnapshot: LLMContextSnapshot = {
        timestamp: new Date().toISOString(),
        conversationId,
        userMessage: displayContent,
        systemMessage,
        baseInstructions,
        selfContent,
        userContent,
        relationshipContent,
        customContent,
        memoriesContent,
        chatHistoryContent,
        lorebookContent,
        graphContent,
        vaultContent,
        situationalAwarenessContent: saContent,
        messages: messages.slice(1).map((msg) => ({
          role: msg.role,
          content: msg.content,
          toolCalls: msg.tool_calls,
          toolCallId: msg.tool_call_id,
        })),
        toolDefinitions,
        metrics: {
          systemMessageLength: systemMessage.length,
          totalMessages: messages.length,
          estimatedTokens: this.lastBudgetResult?.estimatedTotalTokens ??
            Math.ceil(systemMessage.length / 4) +
              messages.reduce(
                (acc, m) => acc + Math.ceil((m.content?.length || 0) / 4),
                0,
              ),
          contextLength: this.config.contextLength,
          budgetAvailable: this.lastBudgetResult?.availableBudget,
          messagesTruncated: this.lastBudgetResult?.messagesRemoved,
        },
      };

      // Persist context snapshot to database for the Context Inspector
      const turnIndexStmt = this.db.getRawDb()
        .prepare(
          "SELECT COUNT(*) as count FROM messages WHERE conversation_id = ? AND role = 'user'",
        );
      let turnIndex: number;
      try {
        const turnIndexResult = turnIndexStmt.get<{ count: number }>(
          conversationId,
        );
        turnIndex = turnIndexResult?.count ?? 1;
      } finally {
        turnIndexStmt.finalize();
      }

      this.db.addContextSnapshot({
        conversationId,
        turnIndex,
        iteration: 1,
        timestamp: contextSnapshot.timestamp,
        userMessage,
        systemMessage,
        baseInstructionsContent: baseInstructions,
        selfContent,
        userContent,
        relationshipContent,
        customContent,
        memoriesContent,
        chatHistoryContent,
        lorebookContent,
        graphContent,
        vaultContent,
        situationalAwarenessContent: saContent,
        messagesJson: JSON.stringify(contextSnapshot.messages),
        toolDefinitionsJson: JSON.stringify(toolDefinitions),
        metricsJson: JSON.stringify(contextSnapshot.metrics),
      });

      yield { type: "context", context: contextSnapshot };

      // Track current iteration for tool loop protection
      let iteration = 0;

      // Retry configuration for transient upstream errors (e.g. Z.ai "network_error").
      // Z.ai's failure already takes ~30s, so we use a short fixed delay between retries
      // rather than exponential backoff — the API already "waited" for us.
      const MAX_LLM_ATTEMPTS = 3;
      const RETRY_DELAY_MS = 3000;
      const EXPECTED_FINISH_REASONS = new Set(["stop", "tool_calls", "length"]);

      // Main agentic loop
      while (iteration < this.maxToolIterations) {
        iteration++;

        let assistantContent = "";
        let assistantReasoning = "";
        const toolCalls: ToolCall[] = [];
        let streamError: Error | null = null;
        let finishReason = "stop";
        let metricsCollector = createCollector(conversationId);

        for (let attempt = 1; attempt <= MAX_LLM_ATTEMPTS; attempt++) {
          // Reset accumulators for each attempt
          assistantContent = "";
          assistantReasoning = "";
          toolCalls.length = 0;
          streamError = null;
          finishReason = "stop";
          metricsCollector = createCollector(conversationId);

          // Stream LLM response with error handling.
          // Done events are held back until after the retry decision — yielding
          // a done event from a failed attempt would cause the frontend to
          // finalize the message before the retry even starts.
          try {
            for await (
              const chunk of this.llm.chatStream(messages, toolDefinitions, {
                metricsCollector,
              })
            ) {
              switch (chunk.type) {
                case "thinking":
                  assistantReasoning += chunk.content;
                  yield chunk;
                  break;
                case "content":
                  assistantContent += chunk.content;
                  yield chunk;
                  break;
                case "tool_call":
                  toolCalls.push(chunk.toolCall);
                  yield chunk;
                  break;
                case "done":
                  // Capture but don't yield — we'll yield after retry decision
                  finishReason = chunk.finishReason;
                  setFinishReason(metricsCollector, chunk.finishReason);
                  break;
              }
            }
          } catch (error) {
            // Capture the error but continue to persist what we have
            streamError = error instanceof Error
              ? error
              : new Error(String(error));
            const errorCode = (error as { code?: string })?.code || "UNKNOWN";
            const statusCode = (error as { statusCode?: number })?.statusCode;
            console.error(
              `[EntityTurn] LLM stream error — code=${errorCode}` +
                (statusCode ? `, http=${statusCode}` : "") +
                `: ${streamError.message}`,
            );
            finishReason = "error";
          }

          const hasContentThisAttempt = assistantContent ||
            toolCalls.length > 0 || assistantReasoning;

          // Check if this is a retryable failure: unexpected finish_reason with no content
          const isRetryableFinish =
            !EXPECTED_FINISH_REASONS.has(finishReason) &&
            !hasContentThisAttempt && !streamError;

          if (isRetryableFinish && attempt < MAX_LLM_ATTEMPTS) {
            console.warn(
              `[EntityTurn] Retryable failure — finish_reason="${finishReason}", ` +
                `attempt ${attempt}/${MAX_LLM_ATTEMPTS}, retrying in ${RETRY_DELAY_MS}ms`,
            );
            yield {
              type: "status",
              status: {
                message:
                  `Upstream connection lost — retrying (${attempt}/${MAX_LLM_ATTEMPTS})`,
                retry: { attempt, maxAttempts: MAX_LLM_ATTEMPTS },
              },
            };
            await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
            continue;
          }

          // Either succeeded or non-retryable — break out of retry loop
          break;
        }

        // Now that the retry loop is settled, yield the done event to the frontend
        yield { type: "done", finishReason };

        // Generate message ID upfront so we can link metrics to it
        const hasContent = assistantContent || toolCalls.length > 0 ||
          assistantReasoning;
        const messageId = hasContent ? crypto.randomUUID() : undefined;

        // Persist the assistant message FIRST (metrics reference it via FK)
        // This ensures we don't lose content that was already streamed
        if (hasContent) {
          try {
            this.db.addMessage(conversationId, {
              role: "assistant",
              content: assistantContent,
              reasoningContent: assistantReasoning || undefined,
              toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
            }, messageId);

            // Index the assistant message for chat RAG (non-blocking, non-fatal)
            // Skip for Discord and other non-web source turns
            if (
              this.config.chatRAG && messageId && assistantContent &&
              !this.config.discordContext
            ) {
              this.config.chatRAG.indexMessage(
                messageId,
                conversationId,
                "assistant",
                assistantContent,
              ).catch((error) => {
                console.warn(
                  "[ChatRAG] Failed to index assistant message:",
                  error,
                );
              });
            }
          } catch (dbError) {
            // Non-fatal: content already streamed to client (see Error Handling Strategy)
            console.error(
              "EntityTurn: Failed to persist assistant message:",
              dbError instanceof Error ? dbError.message : String(dbError),
            );
          }
        }

        // Finalize and persist metrics (non-fatal), linked to message if present
        // Must happen AFTER message insert due to FK constraint
        const metrics = finalize(metricsCollector, { finishReason, messageId });
        this.db.addTurnMetrics(metrics);
        yield { type: "metrics", metrics };

        // If there was a stream error, re-throw it after persisting
        if (streamError) {
          throw streamError;
        }

        // Detect upstream error finish reasons after all retry attempts exhausted
        if (!EXPECTED_FINISH_REASONS.has(finishReason) && !hasContent) {
          throw new LLMError(
            `LLM stream failed with finish_reason="${finishReason}" after ${MAX_LLM_ATTEMPTS} attempts — ` +
              "the upstream API may be experiencing an outage",
            "NETWORK_ERROR",
          );
        }

        // If no tool calls, we're done — yield assistant message ID for edit capability
        if (toolCalls.length === 0) {
          if (messageId) {
            yield { type: "message_id", role: "assistant", id: messageId };
          }
          return;
        }

        // Build tool execution context
        const toolContext: Omit<ToolContext, "toolCallId"> = {
          conversationId,
          db: this.db,
          config: this.config,
        };

        // Execute all tool calls with context
        const toolResults = await this.tools().executeAll(
          toolCalls,
          toolContext,
        );

        // Persist tool results and add to messages for next iteration
        // Track UI regions that need updating (from tool results, not metadata)
        const affectedUIRegions = new Set<string>();

        for (const result of toolResults) {
          // Yield the tool result
          yield { type: "tool_result", result };

          // Detect [IMAGE:...] markers in tool results for inline image display
          const imageMatch = result.content.match(/\[IMAGE:(\{.*\})\]/);
          if (imageMatch) {
            try {
              const img = JSON.parse(imageMatch[1]);
              yield {
                type: "image_generated",
                imagePath: img.path,
                prompt: img.prompt,
                generatorName: img.generator,
                description: img.description,
              };
              // Append image marker to persisted content so it survives page reload
              if (messageId) {
                const imgMarker = `\n\n[IMAGE:${imageMatch[1]}]`;
                assistantContent += imgMarker;
                this.db.getRawDb().prepare(
                  "UPDATE messages SET content = ? WHERE id = ?",
                ).run(assistantContent, messageId);
                console.log(
                  `[ImageGen] Persisted image marker to message ${messageId}: ${img.path}`,
                );
              }
            } catch {
              // Invalid JSON in marker — skip
            }
          }

          // Collect affected UI regions from the result
          // (State change functions return these, making the pattern unified)
          if (result.affectedRegions) {
            for (const region of result.affectedRegions) {
              affectedUIRegions.add(region);
            }
          }

          // Persist to DB with error handling
          try {
            // Strip [IMAGE:{...}] markers — they're UI-only, stored in the
            // assistant message content instead
            const persistedContent = result.content.replace(
              /\[IMAGE:\{.*?\}\]/g,
              "",
            );
            this.db.addMessage(conversationId, {
              role: "tool",
              content: persistedContent,
              toolCallId: result.toolCallId,
            });
          } catch (dbError) {
            // Non-fatal: result already yielded and in LLM context (see Error Handling Strategy)
            console.error(
              "EntityTurn: Failed to persist tool result:",
              dbError instanceof Error ? dbError.message : String(dbError),
            );
          }
        }

        // Generate and yield UI updates for affected regions
        if (affectedUIRegions.size > 0) {
          const uiUpdates = generateUIUpdates(
            Array.from(affectedUIRegions),
            this.db,
            conversationId,
          );
          for (const update of uiUpdates) {
            yield { type: "dom_update", update };
          }
        }

        // Add assistant message with tool calls to the messages array
        const assistantTimestamp = formatMessageTimestamp(new Date());
        // Strip any <t>...</t> tags the LLM echoed to prevent accumulation
        const cleanAssistantContent = (assistantContent || "")
          .replace(/<t>[^<]*<\/t>\s*/g, "")
          // Strip [IMAGE:{...}] markers — UI-only, not part of entity's text
          .replace(/\[IMAGE:\{.*?\}\]/g, "");
        const assistantMsg: ChatMessage = {
          role: "assistant",
          content: `${assistantTimestamp} ${cleanAssistantContent}`,
          tool_calls: toolCalls,
        };
        messages.push(assistantMsg);

        // Add tool results to messages for next LLM call
        for (const result of toolResults) {
          const toolTimestamp = formatMessageTimestamp(new Date());
          // Strip [IMAGE:{...}] markers and [short:...] metadata from tool results
          const cleanResult = result.content
            .replace(/\[IMAGE:\{.*?\}\]/g, "")
            .replace(/\[short:.+?\]/g, "");
          const toolMsg: ChatMessage = {
            role: "tool",
            content: `${toolTimestamp} ${cleanResult}`,
            tool_call_id: result.toolCallId,
          };
          messages.push(toolMsg);
        }

        // Continue the loop to let the LLM process tool results
      }

      // If we hit max iterations, yield a warning content chunk and done
      // This ensures the caller knows why processing stopped
      const warningMessage =
        `\n\n[System: Stopped after ${this.maxToolIterations} tool iterations to prevent infinite loop.]`;

      yield { type: "content", content: warningMessage };

      // Persist this system-generated message so the context is clear
      const maxIterMsgId = crypto.randomUUID();
      this.db.addMessage(conversationId, {
        role: "assistant",
        content: warningMessage,
      }, maxIterMsgId);

      // Yield message ID for the warning message so the frontend can attach edit capability
      yield { type: "message_id", role: "assistant", id: maxIterMsgId };

      console.warn(
        `EntityTurn: Hit max tool iterations (${this.maxToolIterations}). ` +
          "Stopping to prevent infinite loop.",
      );

      yield { type: "done", finishReason: "max_iterations" };
    } finally {
      releaseLock();
    }
  }

  /**
   * Build a map of message ID -> faded content for image descriptions.
   *
   * For messages containing [IMAGE:...] or [USER_IMAGE:...] markers with both
   * long and short descriptions, replaces the longform with the shortform
   * after IMAGE_DESCRIPTION_FADE_TURNS conversation turns have passed.
   * Also fades look_closer tool results after the same threshold.
   */
  private buildFadeMap(history: Message[]): Map<string, string> {
    const fadeMap = new Map<string, string>();
    // Count conversation turns (user or assistant messages, excluding tool messages)
    let turnCount = 0;
    // Track which image markers are at which turn index
    // Map: messageIndex -> turnIndex when the image appeared
    const imageTurns = new Map<number, number>();
    // Track which look_closer results are at which turn index
    const lookCloserTurns = new Map<number, number>();
    // Track generate_image and describe_image tool results for fading
    const imageDescToolTurns = new Map<number, number>();

    // First pass: identify image markers and look_closer results with their turn positions
    for (let i = 0; i < history.length; i++) {
      const msg = history[i];
      if (msg.role === "user" || msg.role === "assistant") {
        turnCount++;
        if (
          /\[IMAGE:\{/.test(msg.content) || /\[USER_IMAGE:/.test(msg.content)
        ) {
          imageTurns.set(i, turnCount);
        }
      }
      if (msg.role === "tool" && msg.content.startsWith("[look_closer]")) {
        lookCloserTurns.set(i, turnCount);
      }
      if (
        msg.role === "tool" &&
        (msg.content.startsWith("[image_generated]") ||
          msg.content.startsWith("[describe_image]"))
      ) {
        imageDescToolTurns.set(i, turnCount);
      }
    }

    // Second pass: fade descriptions that are past the threshold
    const currentTurn = turnCount;

    // Fade [IMAGE:...] markers
    for (const [msgIdx, imgTurn] of imageTurns) {
      if (currentTurn - imgTurn > IMAGE_DESCRIPTION_FADE_TURNS) {
        const msg = history[msgIdx];
        const faded = fadeImageMarker(msg.content);
        if (faded !== msg.content) {
          fadeMap.set(msg.id, faded);
        }
      }
    }

    // Fade look_closer results
    for (const [msgIdx, resultTurn] of lookCloserTurns) {
      if (currentTurn - resultTurn > IMAGE_DESCRIPTION_FADE_TURNS) {
        const msg = history[msgIdx];
        // Extract the image path from "[look_closer] /path/to/img.png: description..."
        const pathMatch = msg.content.match(/^\[look_closer]\s+(\S+?):/);
        if (pathMatch) {
          fadeMap.set(
            msg.id,
            `[look_closer] ${
              pathMatch[1]
            }: [description faded — use look_closer again for details]`,
          );
        }
      }
    }

    // Fade generate_image and describe_image tool results
    for (const [msgIdx, resultTurn] of imageDescToolTurns) {
      if (currentTurn - resultTurn > IMAGE_DESCRIPTION_FADE_TURNS) {
        const msg = history[msgIdx];
        const prefixMatch = msg.content.match(
          /^\[(image_generated|describe_image)\]\s*/,
        );
        const shortMatch = msg.content.match(/\[short:(.+?)\]/);
        if (prefixMatch && shortMatch) {
          fadeMap.set(msg.id, `${prefixMatch[0]}${shortMatch[1]}`);
        }
      }
    }

    return fadeMap;
  }

  /**
   * Build the messages array for the LLM request.
   * Each message includes a timestamp prefix for temporal awareness.
   *
   * @param systemMessage - The system message with Psycheros identity content
   * @param history - Previous messages from the database
   * @param userMessage - The new user message
   * @param appendUserMessage - Whether to append the user message at the end (false on retry)
   * @returns Array of ChatMessage for the LLM
   */
  private buildMessages(
    systemMessage: string,
    history: Message[],
    userMessage: string,
    appendUserMessage: boolean = true,
    toolDefinitions?: ToolDefinition[],
  ): ChatMessage[] {
    const messages: ChatMessage[] = [];

    // Add system message (no timestamp - has its own in content)
    messages.push({
      role: "system",
      content: systemMessage,
    });

    // Add history with timestamps (convert from DB format to LLM format)
    const fadeMap = this.buildFadeMap(history);
    for (const msg of history) {
      // Skip system messages in history — LLM APIs only allow system role at position 0
      if (msg.role === "system") continue;

      const timestamp = formatMessageTimestamp(msg.createdAt);
      // Strip any <t>...</t> tags the LLM may have echoed in its output
      // to prevent timestamp accumulation across turns
      let cleanContent = msg.content.replace(/<t>[^<]*<\/t>\s*/g, "");
      // Strip [IMAGE:{...}] markers from assistant messages — UI-only
      cleanContent = cleanContent.replace(/\[IMAGE:\{.*?\}\]/g, "");
      // Strip [short:...] metadata from tool results — hidden from the LLM
      if (msg.role === "tool") {
        cleanContent = cleanContent.replace(/\[short:.+?\]/g, "");
      }
      // Apply image description fading
      const faded = fadeMap.get(msg.id);
      if (faded) {
        cleanContent = faded;
      }
      const chatMsg: ChatMessage = {
        role: msg.role,
        content: `${timestamp} ${cleanContent}`,
      };

      // Add tool call ID if present (for tool role messages)
      if (msg.toolCallId) {
        chatMsg.tool_call_id = msg.toolCallId;
      }

      // Add tool calls if present (for assistant messages)
      // Fade verbose arguments for image tools to reduce token usage
      if (msg.toolCalls && msg.toolCalls.length > 0) {
        chatMsg.tool_calls = fadeToolCallArguments(msg.toolCalls);
      }

      messages.push(chatMsg);
    }

    // Add the new user message with timestamp (skip on retry — it's already in history)
    if (appendUserMessage) {
      const now = formatMessageTimestamp(new Date());
      messages.push({
        role: "user",
        content: `${now} ${userMessage}`,
      });
    }

    // Apply context window budget if configured
    if (this.config.contextLength && this.config.maxTokens && toolDefinitions) {
      const result = applyContextBudget(
        messages,
        toolDefinitions,
        this.config.contextLength,
        this.config.maxTokens,
      );
      this.lastBudgetResult = result;
      if (result.truncated) {
        console.log(
          `[Context] Truncated ${result.messagesRemoved} oldest messages — ` +
            `~${result.estimatedTotalTokens}/${result.contextLength} tokens ` +
            `(system: ~${result.systemMessageTokens}, tools: ~${result.toolTokens}, history: ~${result.historyTokens})`,
        );
      }
      return result.messages;
    }

    return messages;
  }
}
