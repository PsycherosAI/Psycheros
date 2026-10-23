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

import type {
  ChatContent,
  ChatImageUrlPart,
  ChatMessage,
  LLMClient,
  StreamChunk,
} from "../llm/mod.ts";
import { runAgentLoopEvents } from "./turn-core.ts";
import type { WebSearchSettings } from "../llm/web-search-settings.ts";
import type { DiscordSettings } from "../llm/discord-settings.ts";
import type { HomeSettings } from "../llm/home-settings.ts";
import type { ImageGenSettings } from "../llm/image-gen-settings.ts";
import { buildImageGenContent } from "./image-gen-context.ts";
import { LLMError } from "../llm/mod.ts";
import type { DBClient } from "../db/mod.ts";
import type { ToolContext, ToolRegistry } from "../tools/mod.ts";
import type {
  LLMContextSnapshot,
  Message,
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
  buildDynamicBlock,
  buildSituationalAwareness,
  buildStableCore,
  formatMessageTimestamp,
} from "./turn-context.ts";
export { formatMessageTimestamp } from "./turn-context.ts";
import {
  loadBaseInstructions,
  loadCustomContent,
  loadRelationshipContent,
  loadSelfContent,
  loadUserContent,
} from "./context.ts";
import { loadMemorySettings } from "../memory/memory-settings.ts";
import {
  buildHeldSkillsBlock,
  buildSkillsIndexBlock,
  listSkills,
  loadSkill,
} from "../skills/mod.ts";
import { applyContextBudget, type BudgetResult } from "./token-budget.ts";
import { buildGraphContext, formatChatHistoryForContext } from "../rag/mod.ts";
import { generateUIUpdates } from "../server/ui-updates.ts";
import { acquireLock } from "../utils/conversation-lock.ts";
import { createCollector, finalize, setFinishReason } from "../metrics/mod.ts";
import type { PluginManager } from "../plugins/mod.ts";
import type { FluxManager } from "../../../entity-flux/src/mod.ts";

/**
 * Escape special XML characters in a string.
 */
function renderChatContentForSnapshot(content: ChatContent): string {
  if (typeof content === "string") return content;
  return content.map((part) => {
    if (part.type === "text") return part.text;
    return "[transient vision image]";
  }).join("\n");
}

function estimateChatContentChars(content: ChatContent): number {
  if (typeof content === "string") return content.length;
  return content.reduce((sum, part) => {
    if (part.type === "text") return sum + part.text.length;
    return sum + 1200;
  }, 0);
}

/**
 * Format the connected devices section for the SA block.
 * Returns undefined if there are no devices to report.
 */
/**
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
  /** Transient images I send to the LLM for this turn without saving them in chat history */
  visionImages?: ChatImageUrlPart[];
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
  /**
   * Voice mode flag. When true:
   * - messagePrefix is prepended to persisted user/assistant messages
   * - Any parrot-emitted leading messagePrefix in LLM output is stripped
   *   before persist (snowball prevention, same pattern as <t> tags)
   *
   * Note: voiceMode does NOT imply disableTools — tools are enabled for
   * voice turns. Pass disableTools: true explicitly to suppress tool
   * definitions for a specific turn.
   */
  voiceMode?: boolean;
  /**
   * Appended to the end of the system message. Used by voice mode to add
   * the VOICE CHAT MODE note + per-profile custom instructions.
   */
  systemPromptSuffix?: string;
  /**
   * Prepended to user and assistant message content when persisting.
   * Voice mode uses "[Voice Chat] " so humans (and the entity, in history)
   * can see which turns were voice vs text.
   */
  messagePrefix?: string;
  /**
   * Skip tool definitions and tool_call handling. The LLM gets no tool
   * list and any tool_call chunks it emits anyway are ignored. Voice mode
   * sets this until tool support for voice is designed.
   */
  disableTools?: boolean;
  /**
   * Self-initiated turn — the subconscious escalated something. When true:
   * - Skip user-message persistence (no user message at all)
   * - Use `contextQuery` for RAG retrieval instead of `userMessage`
   * - Build messages array without a trailing user message
   * - Add a self-initiation directive to the system message
   * Full context (identity, RAG, SA, plugins) is still built.
   */
  selfInitiated?: boolean;
  /** RAG search query when selfInitiated (replaces userMessage as retrieval trigger). */
  contextQuery?: string;
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
  /** Context placement style from the LLM profile: "regular" (dynamic
   * block in the leading system message — default) or "cache-friendly"
   * (stable core leads; the dynamic block rides as a trailing system
   * message after the user message, maximizing prefix reuse). */
  contextStyle?: "regular" | "cache-friendly";
  /** Maximum tokens reserved for the response (from active LLM profile) */
  maxTokens?: number;
  /**
   * Whether I carry my reasoning_content back to the next inference call
   * within one entity turn (between tool-call iterations). Resolved from
   * the active profile's `persistentReasoningIntraTurn` tri-state. When
   * undefined, treated as false (preserves existing behavior for voice
   * and pulse paths that don't set it).
   */
  persistentReasoningIntraTurn?: boolean;
  /**
   * How many of my prior entity turns I attach reasoning_content from when
   * building context for a new user message. 0 or undefined disables.
   * Counted in user-visible turns, not DB rows.
   */
  persistentReasoningInterTurns?: number;
  /** Trusted local plugins that can contribute prompt-time context */
  pluginManager?: PluginManager;
  /**
   * Optional entity-flux nervous-system manager. Feeds the tool-execution
   * context (the modulation tools — pay_attention, mindfulness,
   * tune_attention — read it at execution time). NEVER touches the
   * situational-awareness block: flux state reaches conversations only
   * through the Flux session's briefings, never SA (SA injection would
   * leak the undercurrent into every classic conversation while flux
   * runs).
   */
  fluxManager?: FluxManager;
  /**
   * One-line MODE flag for classic turns: when
   * flux is enabled in settings, the entity is told whether its
   * subconscious is active, paused, or off RIGHT NOW — so it cannot
   * hallucinate a running nervous system from memory when the State is
   * off ("Entity Flux is off, I operate on standard turns…"). This is a
   * mode descriptor, not flux content — the SA-content rule stands.
   * Undefined when flux is disabled (baseline Psycheros: no block).
   */
  /** Static text or a live getter (flux state changes after config
   *  construction — the server reads it at turn time). */
  fluxModeNote?: string | (() => string | undefined);
  /**
   * Configured user name from GeneralSettings. Passed through to plugin
   * prompt-hook context for personalization (e.g. calendar-caldav / google-suite
   * "{userName}'s calendar" template substitution). Optional — turn sources
   * that don't have it leave hooks to fall back to a generic label.
   */
  userName?: string;
}

/**
 * Default maximum tool iterations.
 * Set high enough to allow complex multi-tool workflows (identity + memory +
 * graph + RAG chains) while still catching genuine runaway loops.
 */
const DEFAULT_MAX_TOOL_ITERATIONS = 25;

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
    toolCallId: string;
  }
  | {
    type: "thinking_corrected";
    thinking?: string;
    content: string;
  };

/**
 * Represents a single turn in the conversation.
 * Handles the full cycle: LLM call -> tool execution -> continue until done.
 */
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

    // Self-heal orphaned tool calls left by an interrupted turn (user Stop
    // or stream death between persisting an assistant tool_calls message and
    // its tool result). Without a result row, every later turn shows the
    // model a call that never answered, and guidance-free models re-issue
    // it — the "stuck in a loop" signature. Cap each dangling call with a
    // synthetic tool result; this turn's context (built below) already
    // includes the healed rows.
    this.healOrphanedToolCalls(conversationId);

    // When self-initiated (subconscious escalation), use contextQuery for
    // RAG retrieval instead of userMessage. The entity has no user message
    // — it's waking from its own awareness, not responding to input.
    const ragQuery = options?.selfInitiated && options?.contextQuery
      ? options.contextQuery
      : userMessage;

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
        ragQuery.substring(0, 50),
      );
      try {
        const memSettings = await loadMemorySettings(this.config.dataRoot);
        const results = await this.config.mcpClient.searchMemories(
          userMessage,
          {
            maxResults: memSettings.ragMaxChunks,
          },
        );
        if (results.length > 0) {
          memoriesContent = results.map((r, i) =>
            `[${i + 1}] (${r.granularity}/${r.date}, ${
              Math.round(r.score * 100)
            }% relevant)\n${r.excerpt}`
          ).join("\n\n");
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
        ragQuery.substring(0, 50),
      );
      try {
        const chatMessages = await this.config.chatRAG.searchTiered({
          query: ragQuery,
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
          ragQuery,
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
        ragQuery.substring(0, 50),
      );
      try {
        const graphResult = await buildGraphContext(
          ragQuery,
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

    // Build image generation context from enabled generators — the
    // shared builder; the Flux session composes the same block into its
    // late dynamic block (classic parity, one source of truth).
    const imageGenContent = buildImageGenContent(
      this.config.imageGenSettings,
      this.db.getRawDb(),
    );

    // Search vault for relevant documents if manager is available
    let vaultContent: string | undefined;
    if (this.config.vaultManager) {
      console.debug("[Vault] Searching for:", ragQuery.substring(0, 50));
      try {
        const vaultResults = await this.config.vaultManager.search(
          ragQuery,
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

    // Live State (the kit's SA builder — environmental fact only)
    const saContent = buildSituationalAwareness({
      lastInteraction: this.db.getLatestUserInteraction(),
      conversation,
      deviceType: options?.deviceType,
      deviceStatusCache: this.config.deviceStatusCache,
      lovenseSettings: this.config.lovenseSettings,
      buttplugSettings: this.config.buttplugSettings,
      bleSettings: this.config.bleSettings,
    });

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

    const pluginContentResult = await this.config.pluginManager
      ?.buildPromptContent({
        conversationId,
        sourceType: options?.sourceType ?? (options?.pulseId ? "pulse" : "web"),
        userMessage: ragQuery,
        sections: {
          memories: memoriesContent,
          chatHistory: chatHistoryContent,
          lorebook: lorebookContent,
          graph: graphContent,
          vault: vaultContent,
          situationalAwareness: saContent,
          discord: discordChannelContent,
        },
        mcpClient: this.config.mcpClient,
        userName: this.config.userName,
      }, this.computePluginContextBudget());
    const pluginContent = pluginContentResult?.content;
    const pluginHooks = pluginContentResult?.hooks;

    // Skills index — only advertised when the skill tool is actually enabled,
    // and re-scanned per request so Settings edits apply next turn. The index
    // rides with the skill tool's description (appended to the request's tool
    // definitions below), not in the system message.
    let skillsIndexContent: string | undefined;
    if (
      this.tools().getDefinitions().some((d) => d.function.name === "skill")
    ) {
      const skills = await listSkills(this.config.dataRoot);
      if (skills.length > 0) {
        skillsIndexContent = buildSkillsIndexBlock(skills);
      }
    }
    let heldSkillsContent = await this.buildHeldSkillsContent(conversationId);

    const stableCoreText = buildStableCore({
      baseInstructions,
      selfContent,
      userContent,
      relationshipContent,
      customContent,
      imageGenContent,
    });
    /** Dynamic halves for the current held state; the mode parts are
     *  fixed per turn. Returns [stable, dynamic]. */
    const composeContext = (held: string | undefined): [string, string] => {
      const modeParts: string[] = [];
      if (discordChannelContent?.trim()) modeParts.push(discordChannelContent);
      const fluxNote = typeof this.config.fluxModeNote === "function"
        ? this.config.fluxModeNote()
        : this.config.fluxModeNote;
      if (fluxNote) {
        modeParts.push(`<flux_mode>${fluxNote}</flux_mode>`);
      }
      if (options?.systemPromptSuffix) {
        modeParts.push(options.systemPromptSuffix);
      }
      if (options?.selfInitiated) {
        modeParts.push(
          "I am speaking from my own awareness. My subconscious escalated something to my attention — I can see it in my sensory state above. This is not a response to a user message. If I have something I want to say to my user, I say it naturally. If not, I say nothing.",
        );
      }
      const dynamic = buildDynamicBlock({
        lorebookContent,
        vaultContent,
        memoriesList: memoriesContent,
        chatHistoryContent,
        graphContent,
        situationalAwarenessContent: saContent,
        heldSkillsContent: held,
        pluginContent,
        modeContent: modeParts.length > 0 ? modeParts.join("\n\n") : undefined,
      });
      return [stableCoreText, dynamic];
    };
    const joinContext = (halves: [string, string]): string =>
      halves.filter((b) => b.trim()).join("\n");
    const contextHalves = composeContext(heldSkillsContent);
    const finalSystemMessage = joinContext(contextHalves);

    // Get conversation history from DB
    const history = this.db.getMessages(conversationId);

    // For Pulse messages, prefix the content so the entity perceives it as system-initiated
    const baseContent = options?.pulseId && options?.pulseName
      ? `[System — Pulse "${options.pulseName}"] ${userMessage}`
      : userMessage;
    // Voice mode prefixes persisted messages so voice attribution is
    // visible in history. Same pattern as <t> tags: system inserts once,
    // parrot copies stripped before persist (see assistant side below).
    const displayContent = options?.messagePrefix
      ? `${options.messagePrefix}${baseContent}`
      : baseContent;
    let userMessageId: string | undefined;

    const shouldPersist = !options?.retry && !options?.skipUserPersist &&
      !options?.selfInitiated;

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
            isVoice: options?.messagePrefix === "[Voice Chat] ",
          }, userMessageId);

          // Yield user message ID so the frontend can attach edit capability
          yield { type: "message_id", role: "user", id: userMessageId };

          // Index the user message for chat RAG (non-blocking, non-fatal)
          // Skip for Discord and other non-web source turns, and for
          // workspace conversations — the scratchpad stays out of ChatRAG
          // (ephemeral principle: the Pulse summary is the only channel
          // workspace content flows back through).
          if (
            this.config.chatRAG && userMessageId &&
            !this.config.discordContext &&
            conversation?.sourceType !== "workspace"
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

      // Get tool definitions (needed for context budget estimation).
      // Voice mode now has full tool support — only the explicit
      // disableTools flag (set by callers that genuinely want a tool-less
      // turn) suppresses tool definitions.
      //
      // Passing { conversationId, db } lets each tool's `visibleIn` predicate
      // gate itself out of contexts where it doesn't apply (e.g. ask_user and
      // manage_message are workspace-only and stay out of main chat; the Flux
      // modulation tools are Flux Space-only).
      const baseToolDefinitions = options?.disableTools
        ? undefined
        : this.tools().getDefinitions({
          conversationId,
          db: this.db,
        });
      // Append the skills index to the skill tool's description so the
      // catalog loads with the tools array, where the model considers calling
      // it. Cloned, never mutated in place — the registry's canonical
      // definition (Settings UI) stays clean and nothing accumulates across
      // turns.
      const toolDefinitions = baseToolDefinitions && skillsIndexContent
        ? baseToolDefinitions.map((d) =>
          d.function.name === "skill"
            ? {
              ...d,
              function: {
                ...d.function,
                description:
                  `${d.function.description}\n\n${skillsIndexContent}`,
              },
            }
            : d
        )
        : baseToolDefinitions;

      // Build the messages array for the LLM. Cache-friendly profiles
      // split the assembly: stable core leads, dynamic block trails.
      const cacheFriendly = this.config.contextStyle === "cache-friendly";
      const messages = this.buildMessages(
        cacheFriendly ? stableCoreText : finalSystemMessage,
        history,
        displayContent,
        shouldPersist,
        toolDefinitions,
        options?.visionImages,
        cacheFriendly ? contextHalves[1] : undefined,
      );

      // Create and yield context snapshot for debugging
      const contextSnapshot: LLMContextSnapshot = {
        contextStyle: this.config.contextStyle,
        timestamp: new Date().toISOString(),
        conversationId,
        userMessage: displayContent,
        systemMessage: finalSystemMessage,
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
        heldSkillsContent,
        pluginContent,
        pluginHooks,
        messages: messages.slice(1).map((msg) => ({
          role: msg.role,
          content: renderChatContentForSnapshot(msg.content),
          toolCalls: msg.tool_calls,
          toolCallId: msg.tool_call_id,
        })),
        toolDefinitions: toolDefinitions ?? [],
        metrics: {
          systemMessageLength: finalSystemMessage.length,
          totalMessages: messages.length,
          estimatedTokens: this.lastBudgetResult?.estimatedTotalTokens ??
            Math.ceil(finalSystemMessage.length / 4) +
              messages.reduce(
                (acc, m) =>
                  acc + Math.ceil(estimateChatContentChars(m.content) / 4),
                0,
              ),
          contextLength: this.config.contextLength,
          budgetAvailable: this.lastBudgetResult?.availableBudget,
          messagesTruncated: this.lastBudgetResult?.messagesRemoved,
          pluginBudgetUsed: this.config.pluginManager?.getLastBudgetReport()
            ?.used,
          pluginBudgetMax: this.config.pluginManager?.getLastBudgetReport()
            ?.cap,
        },
      };

      // Persist context snapshot to database for the Context Inspector.
      // Skipped for workspace conversations — engaged sessions run many
      // EntityTurns per task, each writing a ~140KB snapshot of the same
      // 22k-token system message. The scratchpad has no Inspector value
      // (turns aren't user-visible conversations), so this is pure DB bloat.
      // The in-memory snapshot still yields to the live stream below.
      // persistSnapshot stays undefined for workspace conversations (skipped
      // by design) — held-skills changes mid-turn call it if present.
      let persistSnapshot: (() => void) | undefined;
      if (conversation?.sourceType !== "workspace") {
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

        // Reads contextSnapshot's CURRENT fields, so mid-turn held-skills
        // mutations (see the tool loop) persist on re-call.
        persistSnapshot = () => {
          this.db.addContextSnapshot({
            conversationId,
            turnIndex,
            iteration: 1,
            timestamp: contextSnapshot.timestamp,
            userMessage,
            systemMessage: contextSnapshot.systemMessage,
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
            heldSkillsContent: contextSnapshot.heldSkillsContent,
            messagesJson: JSON.stringify(contextSnapshot.messages ?? []),
            // toolDefinitions is undefined when disableTools/voiceMode is set.
            // JSON.stringify(undefined) returns undefined (not a string), which
            // SQLite rejects with "Value of unsupported type: undefined". Coerce
            // to "[]" so the column always has a valid JSON string.
            toolDefinitionsJson: JSON.stringify(toolDefinitions ?? []),
            metricsJson: JSON.stringify(contextSnapshot.metrics ?? {}),
            pluginHooksJson: JSON.stringify(pluginHooks ?? []),
          });
        };
        persistSnapshot();
      }

      yield { type: "context", context: contextSnapshot };

      // -- The agent loop (turn-core drive)
      // Retry, retryable-finish handling, misroute recovery, message
      // shaping, and iteration policy live in the shared engine both
      // surfaces drive. runAgentLoopEvents
      // streams what happens; this generator maps each event to the SSE
      // stream classic has always emitted, order for order.
      // Retry configuration for transient upstream errors. Short fixed
      // delay (no exponential backoff — the API already "waited" for us).
      // Set when a tool held/released a skill this turn — triggers the
      // live system-message splice in the tool_results handler.
      let heldSkillsDirty = false;
      const MAX_LLM_ATTEMPTS = 3;
      const RETRY_DELAY_MS = 3000;
      const EXPECTED_FINISH_REASONS = new Set(["stop", "tool_calls", "length"]);
      const VOICE_PREFIX = "[Voice Chat] ";
      let leadingPrefixBuffer = "";
      let leadingPrefixResolved = false;
      let assistantContent = "";
      let assistantReasoning = "";
      let finishReason = "stop";
      let fatalOutcome: import("./turn-core.ts").TurnCoreOutcome | null = null;
      const metricsCollector = createCollector(conversationId);

      // Tool context is built once; the core executes through it.
      const toolContext: Omit<ToolContext, "toolCallId"> = {
        conversationId,
        db: this.db,
        config: this.config,
      };

      for await (
        const ev of runAgentLoopEvents(messages, {
          client: this.llm,
          maxIterations: this.maxToolIterations,
          toolDefs: () => toolDefinitions,
          chatOptions: () => ({ metricsCollector }),
          retry: {
            maxAttempts: MAX_LLM_ATTEMPTS,
            delayMs: RETRY_DELAY_MS,
          },
          // Classic's transcript shapes: timestamped, cleaned, reasoning
          // threaded per the profile's intra-turn setting.
          shapers: {
            shapeAssistantMessage: (gen) => {
              const assistantTimestamp = formatMessageTimestamp(new Date());
              const clean = (gen.content || "")
                .replace(/<t>[^<]*<\/t>\s*/g, "")
                .replace(/\[Voice Chat\]\s*/g, "")
                .replace(/\[IMAGE:\{.*?\}\]/g, "");
              const msg: ChatMessage = {
                role: "assistant",
                content: `${assistantTimestamp} ${clean}`,
                ...(gen.toolCalls.length > 0
                  ? { tool_calls: gen.toolCalls }
                  : {}),
              };
              if (
                this.config.persistentReasoningIntraTurn && gen.thinking.trim()
              ) {
                msg.reasoning_content = gen.thinking;
              }
              return msg;
            },
            shapeToolMessage: (_call, result) => {
              const toolTimestamp = formatMessageTimestamp(new Date());
              const cleanResult = result.content
                .replace(/\[IMAGE:\{.*?\}\]/g, "")
                .replace(/\[short:.+?\]/g, "");
              return {
                role: "tool",
                content: `${toolTimestamp} ${cleanResult}`,
                tool_call_id: result.toolCallId,
              };
            },
          },
          executeTools: (calls) =>
            this.tools().executeAll(calls as never, toolContext),
        })
      ) {
        switch (ev.type) {
          case "thinking":
            yield { type: "thinking", content: ev.content };
            break;
          case "content": {
            // Voice-prefix holdback: the first 13 chars buffer until the
            // parrot check resolves, so a leading "[Voice Chat] " strips
            // before it ever streams to the browser.
            if (leadingPrefixResolved) {
              yield { type: "content", content: ev.content };
            } else {
              leadingPrefixBuffer += ev.content;
              const couldStillMatch =
                VOICE_PREFIX.startsWith(leadingPrefixBuffer) &&
                leadingPrefixBuffer.length < VOICE_PREFIX.length;
              if (couldStillMatch) break;
              leadingPrefixResolved = true;
              if (leadingPrefixBuffer.startsWith(VOICE_PREFIX)) {
                const cleaned = leadingPrefixBuffer.slice(
                  VOICE_PREFIX.length,
                );
                if (cleaned) yield { type: "content", content: cleaned };
              } else {
                yield { type: "content", content: leadingPrefixBuffer };
              }
            }
            break;
          }
          case "tool_call":
            yield { type: "tool_call", toolCall: ev.toolCall };
            break;
          case "retry":
            yield {
              type: "status",
              status: {
                message:
                  `Upstream connection lost — retrying (${ev.attempt}/${ev.maxAttempts})`,
                retry: { attempt: ev.attempt, maxAttempts: ev.maxAttempts },
              },
            };
            break;
          case "reasoning_promoted":
            // Misroute recovery succeeded — the live UI resets its
            // thinking section and renders the recovered reply.
            yield {
              type: "thinking_corrected",
              thinking: ev.thinking.trim() ? ev.thinking : undefined,
              content: ev.content,
            };
            break;
          case "generation": {
            // A settled generation, before its tool batch: persist its
            // row, finalize metrics, emit done — classic's per-generation
            // order, once per round.
            const gen = ev.gen;
            assistantContent = gen.content;
            assistantReasoning = gen.thinking;
            finishReason = gen.finishReason;
            setFinishReason(metricsCollector, gen.finishReason);
            yield { type: "done", finishReason: gen.finishReason };
            const hasContent = assistantContent ||
              gen.toolCalls.length > 0 || assistantReasoning;
            const messageId = hasContent ? crypto.randomUUID() : undefined;
            if (hasContent) {
              try {
                const prefixPattern = new RegExp(
                  "\\[Voice Chat\\]\\s*",
                  "g",
                );
                const tTagPattern = /<t>[^<]*<\/t>\s*/g;
                const cleanedAssistantContent = assistantContent
                  .replace(prefixPattern, "")
                  .replace(tTagPattern, "");
                this.db.addMessage(conversationId, {
                  role: "assistant",
                  content: cleanedAssistantContent,
                  reasoningContent: assistantReasoning || undefined,
                  toolCalls: gen.toolCalls.length > 0
                    ? gen.toolCalls
                    : undefined,
                  isVoice: options?.messagePrefix === "[Voice Chat] ",
                }, messageId);
                if (
                  this.config.chatRAG && messageId && assistantContent &&
                  !this.config.discordContext &&
                  conversation?.sourceType !== "workspace"
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
                console.error(
                  "EntityTurn: Failed to persist assistant message:",
                  dbError instanceof Error ? dbError.message : String(dbError),
                );
              }
            }
            const metrics = finalize(metricsCollector, {
              finishReason,
              messageId,
            });
            this.db.addTurnMetrics(metrics);
            yield { type: "metrics", metrics };
            // The row's id reaches the live bubble as soon as the row
            // exists — one id per generation. Classic's live UI renders
            // one bubble per generation (each done finalizes a bubble;
            // the next generation streams into a fresh element that
            // binds this id), mirroring the per-generation rows
            // persisted here. Yielding only the final generation's id
            // leaves earlier rows uneditable live; suppressing it on tool
            // turns hides the last row's edit entirely.
            if (messageId) {
              yield { type: "message_id", role: "assistant", id: messageId };
            }
            break;
          }
          case "tool_results": {
            const affectedUIRegions = new Set<string>();
            for (const result of ev.results) {
              try {
                this.db.addMessage(conversationId, {
                  role: "tool",
                  content: result.content,
                  toolCallId: result.toolCallId,
                  metadata: result.metadata as never,
                });
              } catch (dbError) {
                console.error(
                  "EntityTurn: Failed to persist tool result:",
                  dbError instanceof Error ? dbError.message : String(dbError),
                );
              }
              yield {
                type: "tool_result",
                result: result as never,
              };
              const image = (result.metadata as {
                image?: NonNullable<
                  NonNullable<Message["metadata"]>["image"]
                >;
              } | undefined)?.image;
              if (image) {
                yield {
                  type: "image_generated",
                  imagePath: image.path,
                  prompt: image.prompt,
                  generatorName: image.generatorName,
                  description: image.description,
                  toolCallId: result.toolCallId,
                };
              }
              if (result.affectedRegions) {
                for (const region of result.affectedRegions) {
                  affectedUIRegions.add(region);
                  if (region === "held-skills") {
                    heldSkillsDirty = true;
                  }
                }
              }
            }
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
            // Live held skills: a hold/release this turn splices the
            // rebuilt block into the system message NOW.
            if (heldSkillsDirty) {
              heldSkillsContent = await this.buildHeldSkillsContent(
                conversationId,
              );
              const halves = composeContext(heldSkillsContent);
              const updatedSystem = joinContext(halves);
              if (this.config.contextStyle === "cache-friendly") {
                for (let i = messages.length - 1; i >= 0; i--) {
                  if (messages[i].role === "system") {
                    messages[i].content = halves[1];
                    break;
                  }
                }
              } else {
                messages[0].content = updatedSystem;
              }
              contextSnapshot.systemMessage = updatedSystem;
              contextSnapshot.heldSkillsContent = heldSkillsContent;
              persistSnapshot?.();
              heldSkillsDirty = false;
            }
            break;
          }
          case "outcome": {
            fatalOutcome = ev.outcome;
            break;
          }
        }
      }

      // Flush a pending prefix buffer from a very short stream.
      if (!leadingPrefixResolved && leadingPrefixBuffer) {
        leadingPrefixResolved = true;
        if (leadingPrefixBuffer.startsWith(VOICE_PREFIX)) {
          const cleaned = leadingPrefixBuffer.slice(VOICE_PREFIX.length);
          if (cleaned) yield { type: "content", content: cleaned };
        } else {
          yield { type: "content", content: leadingPrefixBuffer };
        }
      }

      // Upstream failure after the rows are persisted — re-throw so the
      // caller's error strategy (SSE error event) runs with data intact.
      if (fatalOutcome?.lastError) {
        throw fatalOutcome.lastError;
      }
      // Empty, unexplained finish after every retry — surface as the
      // outage error classic has always thrown.
      if (
        !EXPECTED_FINISH_REASONS.has(finishReason) && !assistantContent &&
        !assistantReasoning
      ) {
        throw new LLMError(
          `LLM stream failed with finish_reason="${finishReason}" after ${MAX_LLM_ATTEMPTS} attempts — ` +
            "the upstream API may be experiencing an outage",
          "NETWORK_ERROR",
        );
      }

      // Budget exhaustion warning (classic parity).
      if (fatalOutcome?.exhausted) {
        const warningMessage =
          `\n\n[System: Stopped after ${this.maxToolIterations} tool iterations to prevent infinite loop.]`;
        yield { type: "content", content: warningMessage };
        const maxIterMsgId = crypto.randomUUID();
        this.db.addMessage(conversationId, {
          role: "assistant",
          content: warningMessage,
        }, maxIterMsgId);
        yield { type: "message_id", role: "assistant", id: maxIterMsgId };
        console.warn(
          `EntityTurn: Hit max tool iterations (${this.maxToolIterations}). ` +
            "Stopping to prevent infinite loop.",
        );
        yield { type: "done", finishReason: "max_iterations" };
      }
    } finally {
      releaseLock();
    }
  }

  /**
   * Cap off orphaned tool calls: for every assistant message whose
   * tool_calls lack a matching tool result row, insert a synthetic result
   * explaining the interruption. Runs once per turn start so a Stop during
   * a tool call can never wedge the conversation into a re-issue loop.
   * Uses raw SQL (not addMessage) so the created_at ordering can slot
   * between the orphaned call and the next message already in the table.
   */
  private healOrphanedToolCalls(conversationId: string): void {
    try {
      const rows = this.db.getMessages(conversationId);
      const answeredCalls = new Set(
        rows.filter((m) => m.role === "tool" && m.toolCallId)
          .map((m) => m.toolCallId as string),
      );
      for (const msg of rows) {
        if (msg.role !== "assistant" || !msg.toolCalls) continue;
        for (const call of msg.toolCalls) {
          if (answeredCalls.has(call.id)) continue;
          const capped = `Tool call ${
            call.function?.name ?? "unknown"
          } was interrupted before completion. No result exists and none is coming - do not retry this call automatically. Respond to the user's latest message.`;
          // Position the synthetic result immediately after the orphaned
          // call (created_at just below the next message, or +1ms past the
          // call itself when nothing follows) so history order stays
          // coherent: assistant(tool_calls) -> tool(result) adjacency is
          // what the provider APIs require.
          const nextMsg = rows
            .filter((m) => m.createdAt.getTime() > msg.createdAt.getTime())
            .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())[0];
          const stamp = nextMsg
            ? new Date(nextMsg.createdAt.getTime() - 1)
            : new Date(msg.createdAt.getTime() + 1);
          const raw = this.db.getRawDb();
          raw.prepare(
            `INSERT INTO messages (id, conversation_id, role, content, tool_call_id, created_at)
             VALUES (?, ?, 'tool', ?, ?, ?)`,
          ).run(
            crypto.randomUUID(),
            conversationId,
            capped,
            call.id,
            stamp.toISOString(),
          );
          console.log(
            `[EntityTurn] Capped orphaned tool call ${call.id} (${call.function?.name}) in ${conversationId}`,
          );
        }
      }
    } catch (error) {
      // Healing is best-effort; never block the turn on it.
      console.error(
        "[EntityTurn] Orphaned tool-call heal failed (non-fatal):",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  /**
   * Select which historical assistant messages should carry their
   * `reasoning_content` into the outgoing context.
   *
   * Walks history newest→oldest, treating each `user` message as a turn
   * boundary. Collects assistant message IDs from the last `n` entity
   * turns (one entity turn = one user message + all the assistant and
   * tool messages that followed it before the next user message). Tool
   * messages never carry reasoning_content; only assistant rows do.
   *
   * The current user message — passed separately to `buildMessages` —
   * is not in `history` and so is never counted as a turn boundary
   * here. On the retry path, the last user message IS in history and
   * correctly counts as the most recent turn boundary.
   */
  private selectReasoningEligibleHistory(
    history: Message[],
    n: number,
  ): Set<string> {
    if (n <= 0) return new Set();
    const eligible = new Set<string>();
    let turnsSeen = 0;
    for (let i = history.length - 1; i >= 0; i--) {
      const msg = history[i];
      if (msg.role === "user") {
        if (turnsSeen >= n) break;
        turnsSeen++;
      }
      if (msg.role === "assistant" && msg.reasoningContent) {
        eligible.add(msg.id);
      }
    }
    return eligible;
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
  /**
   * Resolves the "Skills I'm holding" block: names from the DB, bodies
   * re-resolved from disk so edits apply immediately. A hold whose skill
   * file is gone drops out here (lazy row cleanup).
   */
  private async buildHeldSkillsContent(
    conversationId: string,
  ): Promise<string | undefined> {
    const heldNames = this.db.getHeldSkills(conversationId);
    if (heldNames.length === 0) return undefined;
    const held: Array<{ name: string; body: string }> = [];
    for (const name of heldNames) {
      const skill = await loadSkill(this.config.dataRoot, name);
      if (skill) {
        held.push({ name: skill.name, body: skill.body });
      } else {
        this.db.releaseSkill(conversationId, name);
      }
    }
    return held.length > 0 ? buildHeldSkillsBlock(held) : undefined;
  }

  private buildMessages(
    systemMessage: string,
    history: Message[],
    userMessage: string,
    appendUserMessage: boolean = true,
    toolDefinitions?: ToolDefinition[],
    visionImages?: ChatImageUrlPart[],
    /** Cache-friendly placement: the dynamic block, emitted as a
     *  trailing system message after the user message. */
    dynamicBlock?: string,
  ): ChatMessage[] {
    const messages: ChatMessage[] = [];

    // Add system message (no timestamp - has its own in content)
    messages.push({
      role: "system",
      content: systemMessage,
    });

    // Add history with timestamps (convert from DB format to LLM format)
    // Scope 2: pick which assistant messages carry their reasoning_content
    // into this request. Empty when persistent reasoning is off (n=0).
    const reasoningEligible = this.selectReasoningEligibleHistory(
      history,
      this.config.persistentReasoningInterTurns ?? 0,
    );
    for (const msg of history) {
      // Skip system messages in history — LLM APIs only allow system role at position 0
      if (msg.role === "system") continue;

      const timestamp = formatMessageTimestamp(msg.createdAt);
      // Strip any <t>...</t> tags the LLM may have echoed in its output
      // to prevent timestamp accumulation across turns. Also strip any
      // stray [Voice Chat] prefixes from content — the authoritative
      // source for voice attribution is now msg.isVoice (column), not
      // content. We re-prepend the prefix below if msg.isVoice is true.
      let cleanContent = msg.content
        .replace(/<t>[^<]*<\/t>\s*/g, "")
        .replace(/\[Voice Chat\]\s*/g, "");
      if (msg.isVoice) {
        cleanContent = "[Voice Chat] " + cleanContent;
      }
      // Strip [IMAGE:{...}] markers from assistant messages — UI-only
      cleanContent = cleanContent.replace(/\[IMAGE:\{.*?\}\]/g, "");
      // Strip [short:...] metadata from tool results — hidden from the LLM
      if (msg.role === "tool") {
        cleanContent = cleanContent.replace(/\[short:.+?\]/g, "");
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
      if (msg.toolCalls && msg.toolCalls.length > 0) {
        chatMsg.tool_calls = msg.toolCalls;
      }

      // Scope 2: attach my reasoning_content from prior entity turns so
      // my thinking carries forward across conversational beats. Only
      // fires for assistant messages in the eligible window AND only
      // when reasoning content actually exists on the row.
      if (
        msg.role === "assistant" &&
        msg.reasoningContent &&
        reasoningEligible.has(msg.id)
      ) {
        chatMsg.reasoning_content = msg.reasoningContent;
      }

      messages.push(chatMsg);
    }

    // Add the new user message with timestamp (skip on retry — it's already in history)
    if (appendUserMessage) {
      const now = formatMessageTimestamp(new Date());
      const content = `${now} ${userMessage}`;
      messages.push({
        role: "user",
        content: visionImages?.length
          ? [{ type: "text", text: content }, ...visionImages]
          : content,
      });
    }

    // Cache-friendly placement: the dynamic block is the LAST message —
    // everything before it (stable core + history + user message) is
    // byte-identical across turns, so provider prompt caches hold.
    if (dynamicBlock?.trim()) {
      messages.push({
        role: "system",
        content: dynamicBlock,
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
      if (result.truncated || result.reasoningStripped > 0) {
        console.log(
          `[Context] Truncated ${result.messagesRemoved} oldest messages — ` +
            `~${result.estimatedTotalTokens}/${result.contextLength} tokens ` +
            `(system: ~${result.systemMessageTokens}, tools: ~${result.toolTokens}, history: ~${result.historyTokens}` +
            (result.reasoningStripped > 0 || result.reasoningRetained > 0
              ? `, reasoning: ${result.reasoningRetained} retained / ${result.reasoningStripped} stripped`
              : "") +
            `)`,
        );
      }
      return result.messages;
    }

    return messages;
  }

  /**
   * Compute the aggregate prompt-hook context budget for this turn.
   *
   * Returns undefined when the LLM profile's context window is unknown, in
   * which case the plugin manager falls back to its built-in default. When
   * known, the budget is 15% of (contextLength - maxTokens), clamped to
   * [4_000, 60_000] chars. The floor keeps plugin context meaningful on
   * small-context models; the ceiling prevents plugin context from
   * dominating on huge-context models.
   */
  private computePluginContextBudget():
    | { maxTotalChars: number }
    | undefined {
    return pluginContextBudget(
      this.config.contextLength,
      this.config.maxTokens,
    );
  }
}

/**
 * The shared plugin prompt-hook budget:
 * 15% of the usable window, clamped to [4k, 60k] chars. Exported so the
 * Flux session's late block sizes its hook budget with the SAME formula
 * classic uses — one source of truth for the cap.
 */
export function pluginContextBudget(
  contextLength?: number,
  maxTokens?: number,
): { maxTotalChars: number } | undefined {
  if (!contextLength || !maxTokens) return undefined;
  const usable = contextLength - maxTokens;
  if (usable <= 0) return { maxTotalChars: 4_000 };
  const computed = Math.floor(usable * 0.15);
  return {
    maxTotalChars: Math.max(4_000, Math.min(60_000, computed)),
  };
}
