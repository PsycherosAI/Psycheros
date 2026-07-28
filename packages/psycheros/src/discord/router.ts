/**
 * Discord Message Router
 *
 * Processes incoming Discord messages through the gate pipeline:
 * hard gates → accumulation buffer → entity turn trigger → response posting.
 */

import type { DiscordGatewayClient, DiscordMessage } from "./gateway.ts";
import type {
  ActiveTier,
  ChannelMode,
  DiscordChannelConfig,
  DiscordGatewayConfig,
} from "../llm/discord-settings.ts";
import type { ConversationMapper } from "./conversation-map.ts";
import type {
  DiscordPendingStore,
  PendingDiscordMessage,
} from "./pending-store.ts";

// =============================================================================
// Types
// =============================================================================

export interface AccumulatedMessage {
  authorId: string;
  authorUsername: string;
  authorBot: boolean;
  content: string;
  timestamp: string;
  messageId: string;
  mentionsBot: boolean;
  replyToBot: boolean;
  referenceMessageId: string | null;
}

export interface RouterDeps {
  gateway: DiscordGatewayClient;
  config: DiscordGatewayConfig;
  conversationMapper: ConversationMapper;
  onTurn: (
    conversationId: string,
    userMessage: string,
    context: DiscordTurnContext,
  ) => Promise<DiscordTurnOutcome | void>;
  onMessage?: (
    channelId: string,
    message: AccumulatedMessage,
  ) => Promise<void> | void;
  pendingStore?: DiscordPendingStore;
}

export type DiscordTurnDisposition =
  | "contributed"
  | "deliberately_quiet"
  | "failed";

export interface DiscordTurnOutcome {
  disposition: DiscordTurnDisposition;
}

export interface DiscordTurnContext {
  channelId: string;
  channelName: string;
  serverId: string | null;
  serverName: string | null;
  channelMode: ChannelMode;
  isDM: boolean;
  senderUsername: string;
  senderUserId: string;
  /** Messages in this bounded batch that replies and reactions may target. */
  eligibleMessageIds: string[];
  /** Commit durable receipt work after the first visible Discord action. */
  commitVisibleAction?: () => void;
  /** In lurk mode, individual messages are already persisted — skip userMessage persistence in the turn */
  skipUserMessagePersist?: boolean;
  /** The active mode tier that triggered this turn (only set for active mode channels) */
  activeTier?: ActiveTier;
}

interface DeferredFlush {
  mode: ChannelMode;
  tier?: ActiveTier;
}

// =============================================================================
// MessageRouter
// =============================================================================

export class MessageRouter {
  private deps: RouterDeps;
  /** Per-channel accumulation buffers */
  private buffers: Map<string, AccumulatedMessage[]> = new Map();
  /** Per-channel debounce timers */
  private timers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  /** Per-channel processing lock to prevent overlapping turns */
  private processing: Set<string> = new Set();
  /** One coalesced eligible flush waiting behind the active channel turn. */
  private deferredFlushes: Map<string, DeferredFlush> = new Map();
  /** Per-channel message timestamps for rate calculation (rolling window) */
  private messageTimestamps: Map<string, number[]> = new Map();
  /** Per-channel periodic digest timers (for medium/fast tiers) */
  private periodicTimers: Map<string, ReturnType<typeof setInterval>> =
    new Map();
  /** Per-channel cached tier (recalculated on each flush) */
  private channelTiers: Map<string, ActiveTier> = new Map();
  /** Handle for the timestamp pruning interval */
  private pruneInterval: ReturnType<typeof setInterval> | null = null;
  /** Failed or interrupted durable work retries without requiring a new post. */
  private pendingRecoveryInterval: ReturnType<typeof setInterval> | null = null;
  /** DM channel IDs currently being tracked (not in server config) */
  private dmChannels: Set<string> = new Set();

  constructor(deps: RouterDeps) {
    this.deps = deps;
  }

  start(): void {
    this.deps.gateway.on("MESSAGE_CREATE", (event, data) => {
      if (event === "MESSAGE_CREATE") {
        this.handleMessageCreate(data as unknown as DiscordMessage);
      }
    });
    this.deps.gateway.on("GUILD_CREATE", (event, data) => {
      if (event === "GUILD_CREATE") {
        this.handleGuildCreate(data);
      }
    });
    // Prune stale message timestamps every 5 minutes to prevent unbounded growth.
    // Wrap in try/catch so an error inside the (best-effort) prune routine
    // can never take down the whole daemon — an uncaught throw inside a
    // setInterval callback kills the Deno process.
    this.pruneInterval = setInterval(() => {
      try {
        this.pruneStaleTimestamps();
      } catch (error) {
        console.error("[Discord] prune timer error (non-fatal):", error);
      }
    }, 5 * 60 * 1000);
    if (this.deps.pendingStore) {
      queueMicrotask(() => this.recoverPendingMessages());
      this.pendingRecoveryInterval = setInterval(
        () => this.recoverPendingMessages(),
        30_000,
      );
    }
    console.log("[Discord] Message router started");
  }

  stop(): void {
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
    for (const timer of this.periodicTimers.values()) {
      clearInterval(timer);
    }
    this.periodicTimers.clear();
    if (this.pruneInterval) {
      clearInterval(this.pruneInterval);
      this.pruneInterval = null;
    }
    if (this.pendingRecoveryInterval) {
      clearInterval(this.pendingRecoveryInterval);
      this.pendingRecoveryInterval = null;
    }
    this.buffers.clear();
    this.processing.clear();
    this.deferredFlushes.clear();
    this.messageTimestamps.clear();
    this.channelTiers.clear();
    this.dmChannels.clear();
    console.log("[Discord] Message router stopped");
  }

  updateConfig(config: DiscordGatewayConfig): void {
    this.deps = { ...this.deps, config };

    // Tear down per-channel state for channels no longer in the config.
    // Without this, periodic timers and debounce timers keep firing for
    // removed channels (especially active-mode channels with medium/fast
    // tiers that have persistent periodic flush timers).
    const activeChannelIds = new Set<string>();
    for (const server of config.servers) {
      for (const ch of server.channels) {
        activeChannelIds.add(ch.channelId);
      }
    }

    for (const channelId of this.buffers.keys()) {
      // Don't clean up DM channels — they're not in server config
      if (this.dmChannels.has(channelId)) continue;
      if (!activeChannelIds.has(channelId)) {
        this.clearPeriodicTimer(channelId);
        const debounce = this.timers.get(channelId);
        if (debounce) {
          clearTimeout(debounce);
          this.timers.delete(channelId);
        }
        const discarded = this.buffers.get(channelId) ?? [];
        this.buffers.delete(channelId);
        this.settlePending(discarded.map((message) => message.messageId));
        this.deferredFlushes.delete(channelId);
        this.channelTiers.delete(channelId);
        this.messageTimestamps.delete(channelId);
        console.log(
          `[Discord] Cleaned up state for removed channel ${channelId}`,
        );
      }
    }
  }

  // -------------------------------------------------------------------------
  // Message handling
  // -------------------------------------------------------------------------

  private handleMessageCreate(msg: DiscordMessage): void {
    // Ignore own messages
    if (msg.author.id === this.deps.gateway.getBotUserId()) return;

    const isDM = msg.guild_id == null;
    const channelId = msg.channel_id;

    // --- DM handling ---
    if (isDM) {
      this.handleDm(msg);
      return;
    }

    // --- Server message handling ---
    const serverId = msg.guild_id!;
    const channelConfig = this.getChannelConfig(serverId, channelId);

    // Hard gate: channel must be in configured allowlist
    if (!channelConfig) return;

    // Hard gate: filter command prefixes
    if (msg.content.startsWith("!") || msg.content.startsWith("/")) return;

    // Check if message is from a blocked bot
    if (
      msg.author.bot && this.deps.config.blockedBotIds.includes(msg.author.id)
    ) return;

    // Check @everyone/@here
    const isEveryoneHere = msg.mention_everyone &&
      this.deps.config.respondToEveryoneHere;

    // Check if bot is mentioned or replied to
    const mentionsBot = msg.mentions.some((m) =>
      m.id === this.deps.gateway.getBotUserId()
    );
    const replyToBot = msg.reference?.message_id != null; // Simplified: treat any reply as potential bot reply

    // Accumulate message
    const mode = channelConfig.mode;
    const shouldAccumulate = mode === "active" ||
      mode === "lurk" ||
      (mode === "strict" && (mentionsBot || replyToBot || isEveryoneHere));

    if (!shouldAccumulate) return;

    const accumulated: AccumulatedMessage = {
      authorId: msg.author.id,
      authorUsername: msg.author.global_name || msg.author.username,
      authorBot: msg.author.bot,
      content: msg.content,
      timestamp: msg.timestamp,
      messageId: msg.id,
      mentionsBot: mentionsBot || isEveryoneHere || replyToBot,
      replyToBot,
      referenceMessageId: msg.reference?.message_id ?? null,
    };
    this.persistPending({
      channelId,
      serverId,
      isDM: false,
      mode,
      directlyAddressed: mentionsBot || replyToBot || isEveryoneHere,
      message: accumulated,
    });

    this.addToBuffer(
      channelId,
      accumulated,
      mode,
      mentionsBot || replyToBot || isEveryoneHere,
    );
  }

  private handleDm(msg: DiscordMessage): void {
    // Only whitelisted users can DM
    if (!this.deps.conversationMapper.isDmUserAllowed(msg.author.id)) {
      console.log(
        `[Discord] DM from non-whitelisted user ${msg.author.username} (${msg.author.id}) — ignored`,
      );
      return;
    }

    // Track DM channel so flushBuffer's config-removal safety gate
    // doesn't silently drop it (DM channels are never in server config).
    this.dmChannels.add(msg.channel_id);

    const accumulated: AccumulatedMessage = {
      authorId: msg.author.id,
      authorUsername: msg.author.global_name || msg.author.username,
      authorBot: false,
      content: msg.content,
      timestamp: msg.timestamp,
      messageId: msg.id,
      mentionsBot: true, // DMs always trigger
      replyToBot: false,
      referenceMessageId: msg.reference?.message_id ?? null,
    };
    this.persistPending({
      channelId: msg.channel_id,
      serverId: null,
      isDM: true,
      mode: "active",
      directlyAddressed: true,
      message: accumulated,
    });
    this.addToBuffer(
      msg.channel_id,
      accumulated,
      "active",
      true,
    );
  }

  private handleGuildCreate(data: unknown): void {
    // Log guild creation — useful for debugging
    const guild = data as { id: string; name: string };
    console.log(`[Discord] Guild available: ${guild.name} (${guild.id})`);
  }

  // -------------------------------------------------------------------------
  // Buffer management
  // -------------------------------------------------------------------------

  private addToBuffer(
    channelId: string,
    message: AccumulatedMessage,
    mode: ChannelMode,
    forceTrigger: boolean,
  ): void {
    let buffer = this.buffers.get(channelId) ?? [];

    buffer.push(message);

    // Cap buffer size
    const maxSize = this.deps.config.maxBufferSize;
    if (buffer.length > maxSize) {
      const discarded = buffer.slice(0, buffer.length - maxSize);
      buffer = buffer.slice(-maxSize);
      this.settlePending(discarded.map((item) => item.messageId));
    }

    this.buffers.set(channelId, buffer);

    // In strict mode with mention, flush immediately
    if (mode === "strict" && forceTrigger) {
      this.flushBuffer(channelId, mode);
      return;
    }

    // Record timestamp for rate tracking (active mode only)
    if (mode === "active") {
      this.recordMessageTimestamp(channelId);
    }

    // --- Mention/reply handling in active mode ---
    if (mode === "active" && forceTrigger) {
      const tier = this.channelTiers.get(channelId) ??
        this.calculateTier(channelId);
      this.channelTiers.set(channelId, tier);

      // Use short mention debounce, then flush immediately + reset periodic timer
      const existingTimer = this.timers.get(channelId);
      if (existingTimer) clearTimeout(existingTimer);

      const mentionDebounce =
        this.deps.config.activeModeTiers.mentionDebounceMs;
      const timer = setTimeout(() => {
        this.onMentionFlush(channelId);
      }, mentionDebounce);
      this.timers.set(channelId, timer);
      return;
    }

    // --- Active mode with tiered behavior ---
    if (mode === "active") {
      const previousTier = this.channelTiers.get(channelId);
      const tier = this.calculateTier(channelId);
      this.channelTiers.set(channelId, tier);

      if (tier === "slow") {
        // Slow tier: per-message debounce (entity decides whether to respond)
        const existingTimer = this.timers.get(channelId);
        if (existingTimer) clearTimeout(existingTimer);

        const timer = setTimeout(() => {
          this.flushBuffer(channelId, "active", tier);
        }, this.deps.config.debounceWindowMs);
        this.timers.set(channelId, timer);

        // No periodic timer needed for slow tier
        this.clearPeriodicTimer(channelId);
      } else if (tier === "medium") {
        // Medium tier: periodic digest only. The entity checks in on the
        // channel at a measured pace, like someone glancing at it periodically.
        // No per-message debounce — the periodic timer is the sole trigger.
        const tierTransitioned = previousTier !== tier;

        if (tierTransitioned || !this.periodicTimers.has(channelId)) {
          this.restartPeriodicTimer(channelId);
        }
      } else {
        // Fast tier: per-message debounce + buffer-size limit.
        // Debounce catches natural pauses. If the channel never pauses, the
        // buffer-size limit guarantees the entity can participate after enough
        // conversation has accumulated — like someone chiming in during a
        // lively group discussion.
        this.clearPeriodicTimer(channelId);

        // Buffer-size limit: flush immediately when enough messages accumulate.
        if (
          buffer.length >= this.deps.config.activeModeTiers.fastBufferFlushSize
        ) {
          const existingTimer = this.timers.get(channelId);
          if (existingTimer) clearTimeout(existingTimer);
          this.timers.delete(channelId);
          this.flushBuffer(channelId, "active", tier);
          return;
        }

        // Per-message debounce: reset on each new message.
        const existingTimer = this.timers.get(channelId);
        if (existingTimer) clearTimeout(existingTimer);

        const timer = setTimeout(() => {
          this.flushBuffer(channelId, "active", tier);
        }, this.deps.config.debounceWindowMs);
        this.timers.set(channelId, timer);
      }
      return;
    }

    // --- Lurk/strict mode: reset debounce timer (original behavior) ---
    const existingTimer = this.timers.get(channelId);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    const timer = setTimeout(() => {
      this.flushBuffer(channelId, mode);
    }, this.deps.config.debounceWindowMs);
    this.timers.set(channelId, timer);
  }

  private async flushBuffer(
    channelId: string,
    mode: ChannelMode,
    tier?: ActiveTier,
  ): Promise<void> {
    // Safety: skip if channel was removed from config between timer ticks.
    // DM channels are exempt — they're not part of the server config.
    if (
      !this.dmChannels.has(channelId) &&
      !this.getChannelConfigByChannelId(channelId)
    ) {
      this.clearPeriodicTimer(channelId);
      const discarded = this.buffers.get(channelId) ?? [];
      this.buffers.delete(channelId);
      this.settlePending(discarded.map((message) => message.messageId));
      this.deferredFlushes.delete(channelId);
      return;
    }

    const buffer = this.buffers.get(channelId);
    if (!buffer || buffer.length === 0) return;

    // Determine if entity turn should trigger BEFORE clearing the buffer.
    // In lurk/strict mode, if no message mentions the bot we must keep the
    // messages in the buffer so they're available when a mention eventually arrives.
    let shouldTrigger = false;
    if (mode === "active") {
      shouldTrigger = true;
    } else if (mode === "lurk") {
      shouldTrigger = buffer.some((m) => m.mentionsBot);
    } else if (mode === "strict") {
      shouldTrigger = buffer.some((m) => m.mentionsBot || m.replyToBot);
    }

    if (!shouldTrigger) {
      // In lurk/strict mode, messages accumulate until a mention arrives.
      // Don't clear the buffer — just let the debounce timer restart on the next message.
      if (mode === "lurk" || mode === "strict") {
        return;
      }
      // Active mode shouldn't reach here, but clear defensively.
      this.buffers.delete(channelId);
      return;
    }

    // Clear timer
    const timer = this.timers.get(channelId);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(channelId);
    }

    // Prevent overlapping turns per channel
    if (this.processing.has(channelId)) {
      this.deferredFlushes.set(channelId, { mode, tier });
      console.log(
        `[Discord] Channel ${channelId} already processing; flush deferred`,
      );
      return;
    }

    // Clear the buffer now that we're committed to processing. Messages that
    // arrive during the entity turn will be added to a fresh buffer.
    this.buffers.delete(channelId);

    this.processing.add(channelId);
    const messageIds = [...new Set(buffer.map((message) => message.messageId))];
    try {
      this.deps.pendingStore?.claim(messageIds);
    } catch (error) {
      console.warn(
        `[Discord] Could not claim durable batch for ${channelId}:`,
        error instanceof Error ? error.message : String(error),
      );
    }
    let durableWorkCommitted = false;
    try {
      // Build conversation ID and user message
      const isDM = !buffer[0]?.replyToBot &&
        !this.deps.config.servers.some((s) =>
          s.channels.some((c) => c.channelId === channelId)
        );

      const conversationId = await this.deps.conversationMapper
        .getOrCreateConversation(
          channelId,
          isDM ? null : this.getServerIdForChannel(channelId),
          isDM ? null : this.getServerNameForChannel(channelId),
          channelId,
          this.getChannelNameForChannel(channelId),
          isDM,
          buffer[0].authorUsername,
        );

      // Format accumulated messages
      const userMessage = this.formatAccumulatedMessages(buffer);

      // Find the most relevant sender (the one who mentioned/replied to bot, or the last sender)
      const triggerMsg = [...buffer].reverse().find((m) => m.mentionsBot) ??
        buffer[buffer.length - 1];

      const context: DiscordTurnContext = {
        channelId,
        channelName: this.getChannelNameForChannel(channelId),
        serverId: isDM ? null : this.getServerIdForChannel(channelId),
        serverName: isDM ? null : this.getServerNameForChannel(channelId),
        channelMode: mode,
        isDM,
        senderUsername: triggerMsg.authorUsername,
        senderUserId: triggerMsg.authorId,
        eligibleMessageIds: messageIds,
        commitVisibleAction: () => {
          if (durableWorkCommitted) return;
          this.settlePending(messageIds);
          durableWorkCommitted = true;
        },
        skipUserMessagePersist: false,
        activeTier: tier,
      };

      const outcome = await this.deps.onTurn(
        conversationId,
        userMessage,
        context,
      );
      if (outcome?.disposition === "failed") {
        if (!durableWorkCommitted) this.releasePending(messageIds);
      } else {
        this.settlePending(messageIds);
        durableWorkCommitted = true;
      }
    } catch (error) {
      if (!durableWorkCommitted) this.releasePending(messageIds);
      console.error(
        `[Discord] Error processing turn for channel ${channelId}:`,
        error,
      );
    } finally {
      this.processing.delete(channelId);
      const deferred = this.deferredFlushes.get(channelId);
      this.deferredFlushes.delete(channelId);
      if (deferred && (this.buffers.get(channelId)?.length ?? 0) > 0) {
        queueMicrotask(() => {
          void this.flushBuffer(channelId, deferred.mode, deferred.tier);
        });
      }
    }
  }

  private persistPending(record: PendingDiscordMessage): void {
    try {
      this.deps.pendingStore?.enqueue(record);
    } catch (error) {
      console.warn(
        `[Discord] Could not persist pending message ${record.message.messageId}:`,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private settlePending(messageIds: string[]): void {
    try {
      this.deps.pendingStore?.settle(messageIds);
    } catch (error) {
      console.warn(
        "[Discord] Could not settle durable pending work:",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private releasePending(messageIds: string[]): void {
    try {
      this.deps.pendingStore?.release(messageIds);
    } catch (error) {
      console.warn(
        "[Discord] Could not release durable pending work:",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private recoverPendingMessages(): void {
    const store = this.deps.pendingStore;
    if (!store) return;
    let recovered: PendingDiscordMessage[];
    try {
      recovered = store.recoverReady();
    } catch (error) {
      console.warn(
        "[Discord] Pending-message recovery failed:",
        error instanceof Error ? error.message : String(error),
      );
      return;
    }

    let added = 0;
    for (const record of recovered) {
      try {
        if (
          !record.isDM &&
          (!record.serverId ||
            !this.getChannelConfig(record.serverId, record.channelId))
        ) {
          this.settlePending([record.message.messageId]);
          continue;
        }
        const alreadyBuffered = this.buffers.get(record.channelId)?.some(
          (message) => message.messageId === record.message.messageId,
        ) === true;
        if (alreadyBuffered) continue;
        if (record.isDM) this.dmChannels.add(record.channelId);
        this.addToBuffer(
          record.channelId,
          record.message,
          record.mode,
          record.directlyAddressed,
        );
        added++;
      } catch (error) {
        console.warn(
          `[Discord] Could not restore pending message ${record.message.messageId}:`,
          error instanceof Error ? error.message : String(error),
        );
      }
    }
    if (added > 0) {
      console.log(`[Discord] Recovered ${added} durable pending message(s)`);
    }
  }

  // -------------------------------------------------------------------------
  // Message formatting
  // -------------------------------------------------------------------------

  private formatAccumulatedMessages(messages: AccumulatedMessage[]): string {
    return messages.map((msg) => {
      const time = new Date(msg.timestamp).toLocaleTimeString([], {
        hour: "numeric",
        minute: "2-digit",
        hour12: true,
      });
      const botTag = msg.authorBot ? " [BOT]" : "";
      const replyTag = msg.referenceMessageId
        ? ` (replying to ${msg.referenceMessageId})`
        : "";
      return `**${msg.authorUsername}** (<@${msg.authorId}>)${botTag} (${time}) [msg:${msg.messageId}]${replyTag}:\n${msg.content}`;
    }).join("\n\n");
  }

  // -------------------------------------------------------------------------
  // Rate tracking and tier calculation
  // -------------------------------------------------------------------------

  private recordMessageTimestamp(channelId: string): void {
    const timestamps = this.messageTimestamps.get(channelId) ?? [];
    timestamps.push(Date.now());
    this.messageTimestamps.set(channelId, timestamps);
  }

  private getMessageRate(channelId: string): number {
    const tierConfig = this.deps.config.activeModeTiers;
    const cutoff = Date.now() - (tierConfig.rateWindowMinutes * 60 * 1000);

    let timestamps = this.messageTimestamps.get(channelId) ?? [];
    timestamps = timestamps.filter((ts) => ts > cutoff);
    this.messageTimestamps.set(channelId, timestamps);

    const windowHours = tierConfig.rateWindowMinutes / 60;
    return timestamps.length / windowHours;
  }

  private calculateTier(channelId: string): ActiveTier {
    const tierConfig = this.deps.config.activeModeTiers;
    const rate = this.getMessageRate(channelId);

    if (rate >= tierConfig.mediumToFastThreshold) return "fast";
    if (rate > tierConfig.slowToMediumThreshold - 1) return "medium";
    return "slow";
  }

  // -------------------------------------------------------------------------
  // Periodic timer management
  // -------------------------------------------------------------------------

  private restartPeriodicTimer(channelId: string): void {
    this.clearPeriodicTimer(channelId);

    const tier = this.channelTiers.get(channelId) ?? "slow";
    if (tier !== "medium") return;

    const intervalMs = this.deps.config.activeModeTiers.mediumDigestIntervalMs;
    const timer = setInterval(() => {
      this.onPeriodicFlush(channelId);
    }, intervalMs);
    this.periodicTimers.set(channelId, timer);
  }

  private clearPeriodicTimer(channelId: string): void {
    const existing = this.periodicTimers.get(channelId);
    if (existing) {
      clearInterval(existing);
      this.periodicTimers.delete(channelId);
    }
  }

  private async onPeriodicFlush(channelId: string): Promise<void> {
    // Safety: skip if channel was removed from config between timer ticks.
    // DM channels are exempt — they're not part of the server config.
    if (
      !this.dmChannels.has(channelId) &&
      !this.getChannelConfigByChannelId(channelId)
    ) {
      this.clearPeriodicTimer(channelId);
      const discarded = this.buffers.get(channelId) ?? [];
      this.buffers.delete(channelId);
      this.settlePending(discarded.map((message) => message.messageId));
      this.deferredFlushes.delete(channelId);
      return;
    }

    const buffer = this.buffers.get(channelId);
    if (!buffer || buffer.length === 0) return;

    // Recalculate tier — channel activity may have changed
    const newTier = this.calculateTier(channelId);
    const oldTier = this.channelTiers.get(channelId) ?? "slow";
    this.channelTiers.set(channelId, newTier);

    // If tier changed, restart periodic timer with new interval
    if (newTier !== oldTier) {
      if (newTier === "slow") {
        this.clearPeriodicTimer(channelId);
      } else {
        this.restartPeriodicTimer(channelId);
      }
    }

    // Clear debounce timer to prevent double-flush
    const debounce = this.timers.get(channelId);
    if (debounce) {
      clearTimeout(debounce);
      this.timers.delete(channelId);
    }

    console.log(
      `[Discord] Periodic flush for ${channelId} (tier: ${newTier}, ${buffer.length} messages)`,
    );
    await this.flushBuffer(channelId, "active", newTier);
  }

  private async onMentionFlush(channelId: string): Promise<void> {
    const tier = this.channelTiers.get(channelId) ?? "slow";

    // Clear debounce timer
    const debounce = this.timers.get(channelId);
    if (debounce) {
      clearTimeout(debounce);
      this.timers.delete(channelId);
    }

    // Reset periodic timer for medium tier (mention resets the digest clock)
    if (tier === "medium") {
      this.restartPeriodicTimer(channelId);
    }

    console.log(`[Discord] Mention flush for ${channelId} (tier: ${tier})`);
    await this.flushBuffer(channelId, "active", tier);
  }

  private pruneStaleTimestamps(): void {
    const tierConfig = this.deps.config.activeModeTiers;
    // Defensive guard: if activeModeTiers is missing or malformed (e.g. a
    // stale discord-gateway.json from before this field existed, or a config
    // that hasn't been deep-merged against current defaults), bail out
    // rather than crash the daemon. The prune timer is best-effort cleanup;
    // skipping a cycle just means timestamps grow a little longer until the
    // config is repaired.
    if (!tierConfig || typeof tierConfig.rateWindowMinutes !== "number") {
      console.warn(
        "[Discord] Skipping stale-timestamp prune: activeModeTiers.rateWindowMinutes missing or invalid",
      );
      return;
    }
    const cutoff = Date.now() - (tierConfig.rateWindowMinutes * 60 * 1000);

    for (const [channelId, timestamps] of this.messageTimestamps) {
      const pruned = timestamps.filter((ts) => ts > cutoff);
      if (pruned.length === 0) {
        this.messageTimestamps.delete(channelId);
      } else {
        this.messageTimestamps.set(channelId, pruned);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Config lookups
  // -------------------------------------------------------------------------

  private getChannelConfig(
    serverId: string,
    channelId: string,
  ): DiscordChannelConfig | null {
    const server = this.deps.config.servers.find((s) =>
      s.serverId === serverId
    );
    if (!server) return null;
    return server.channels.find((c) => c.channelId === channelId) ?? null;
  }

  /** Look up channel config by channel ID alone (server ID unknown). */
  private getChannelConfigByChannelId(
    channelId: string,
  ): DiscordChannelConfig | null {
    for (const server of this.deps.config.servers) {
      const ch = server.channels.find((c) => c.channelId === channelId);
      if (ch) return ch;
    }
    return null;
  }

  private getServerIdForChannel(channelId: string): string | null {
    for (const server of this.deps.config.servers) {
      if (server.channels.some((c) => c.channelId === channelId)) {
        return server.serverId;
      }
    }
    return null;
  }

  private getServerNameForChannel(channelId: string): string | null {
    for (const server of this.deps.config.servers) {
      if (server.channels.some((c) => c.channelId === channelId)) {
        return server.serverName;
      }
    }
    return null;
  }

  private getChannelNameForChannel(channelId: string): string {
    const cached = this.deps.gateway.getChannels().get(channelId);
    if (cached?.name) return cached.name;
    return channelId;
  }

  // -------------------------------------------------------------------------
  // Public: flush a specific channel (for testing)
  // -------------------------------------------------------------------------

  async flushChannel(channelId: string): Promise<void> {
    const buffer = this.buffers.get(channelId);
    if (!buffer || buffer.length === 0) return;
    const mode = this.getActiveMode(channelId) ?? "active";
    await this.flushBuffer(channelId, mode);
  }

  private getActiveMode(channelId: string): ChannelMode | null {
    for (const server of this.deps.config.servers) {
      const channel = server.channels.find((c) => c.channelId === channelId);
      if (channel) return channel.mode;
    }
    return null;
  }
}
