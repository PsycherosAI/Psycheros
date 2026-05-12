/**
 * Pulse Engine
 *
 * Core execution engine for the Pulse system. Manages scheduling,
 * triggering, and executing pulses via the entity's agentic loop.
 *
 * @module
 */

import type { DBClient } from "../db/mod.ts";
import type { LLMClient } from "../llm/mod.ts";
import type { WebSearchSettings } from "../llm/web-search-settings.ts";
import type { DiscordSettings } from "../llm/discord-settings.ts";
import type { HomeSettings } from "../llm/home-settings.ts";
import type { LovenseSettings } from "../llm/lovense-settings.ts";
import type { ButtplugSettings } from "../llm/buttplug-settings.ts";
import type { ToolRegistry } from "../tools/mod.ts";
import type { ConversationRAG } from "../rag/conversation.ts";
import type { MCPClient } from "../mcp-client/mod.ts";
import type { LorebookManager } from "../lorebook/mod.ts";
import type { VaultManager } from "../vault/mod.ts";
import type { EntityConfig } from "../entity/mod.ts";
import type { ImageGenSettings } from "../llm/image-gen-settings.ts";
import { EntityTurn } from "../entity/mod.ts";
import { getBroadcaster } from "../server/broadcaster.ts";
import { renderMessage } from "../server/templates.ts";
import type { Message, PulseRow } from "../types.ts";

// =============================================================================
// Constants
// =============================================================================

/** Maximum concurrent pulse executions (prevents LLM API overload) */
const MAX_CONCURRENT_PULSES = 3;

/** Default debounce interval for filesystem triggers (ms) */
const FS_DEBOUNCE_MS = 1_000;

/** Default rate limit for webhook triggers (ms per pulse) */
const WEBHOOK_RATE_LIMIT_MS = 10_000;

// =============================================================================
// Semaphore
// =============================================================================

class Semaphore {
  private current = 0;
  private queue: Array<() => void> = [];

  constructor(private max: number) {}

  async acquire(): Promise<void> {
    if (this.current < this.max) {
      this.current++;
      return;
    }
    await new Promise<void>((resolve) => this.queue.push(resolve));
  }

  release(): void {
    this.current--;
    const next = this.queue.shift();
    if (next) {
      this.current++;
      next();
    }
  }
}

// =============================================================================
// Pulse Engine
// =============================================================================

/**
 * Engine configuration — mirrors the services available to the entity turn.
 */
export interface PulseEngineConfig {
  projectRoot: string;
  chatRAG?: ConversationRAG;
  mcpClient?: MCPClient;
  lorebookManager?: LorebookManager;
  vaultManager?: VaultManager;
  /** Getter for web search settings (read fresh each pulse execution) */
  webSearchSettings?: () => WebSearchSettings | undefined;
  /** Getter for Discord settings (read fresh each pulse execution) */
  discordSettings?: () => DiscordSettings | undefined;
  /** Getter for Home settings (read fresh each pulse execution) */
  homeSettings?: () => HomeSettings | undefined;
  /** Getter for image generation settings (read fresh each pulse execution) */
  imageGenSettings?: () => ImageGenSettings | undefined;
  /** Getter for Lovense settings (read fresh each pulse execution) */
  lovenseSettings?: () => LovenseSettings | undefined;
  /** Getter for Buttplug settings (read fresh each pulse execution) */
  buttplugSettings?: () => ButtplugSettings | undefined;
  /** Getter for device status cache (for SA connected devices signal) */
  deviceStatusCache?: () =>
    | import("../server/device-cache.ts").DeviceStatusCache
    | undefined;
  /** Getter for context window size from active LLM profile */
  contextLength?: () => number | undefined;
  /** Getter for max response tokens from active LLM profile */
  maxTokens?: () => number | undefined;
}

/**
 * Core engine for the Pulse system.
 *
 * Manages scheduling (cron, inactivity), external triggers (webhook, filesystem),
 * and execution of pulses via the entity's agentic loop.
 */
export class PulseEngine {
  private runningPulses: Set<string> = new Set();
  private abortedPulses: Set<string> = new Set();
  private semaphore: Semaphore;
  private fsWatchers: Map<string, Deno.FsWatcher> = new Map();
  private fsDebounce: Map<string, number> = new Map();
  private webhookRateLimit: Map<string, number> = new Map();
  private lastGlobalUserMessage: string | null = null;
  private inactivityEnabledAt: Map<string, number> = new Map();
  private started = false;

  constructor(
    private db: DBClient,
    private getLlm: () => LLMClient,
    private tools: () => ToolRegistry,
    private config: PulseEngineConfig,
  ) {
    this.semaphore = new Semaphore(MAX_CONCURRENT_PULSES);
  }

  // ===========================================================================
  // Lifecycle
  // ===========================================================================

  /**
   * Start the pulse engine. Loads enabled pulses and registers schedulers.
   * Should be called once after server initialization.
   */
  start(): void {
    if (this.started) return;
    this.started = true;

    // Hydrate the last global user message timestamp
    this.lastGlobalUserMessage = this.db.getLastUserMessageTimestamp();

    // Load all enabled pulses and register their triggers
    const pulses = this.db.listPulses({ enabled: true });

    for (const pulse of pulses) {
      this.registerTriggers(pulse);
    }

    console.log(`[Pulse] Engine started with ${pulses.length} active pulse(s)`);
  }

  /**
   * Stop the pulse engine. Closes filesystem watchers.
   * Should be called during graceful shutdown.
   */
  stop(): void {
    this.started = false;

    for (const [, watcher] of this.fsWatchers) {
      try {
        watcher.close();
      } catch {
        // Ignore close errors
      }
    }
    this.fsWatchers.clear();
    this.fsDebounce.clear();

    console.log("[Pulse] Engine stopped");
  }

  // ===========================================================================
  // Trigger Registration
  // ===========================================================================

  /**
   * Register all trigger types for a pulse.
   * Called on startup for each enabled pulse, and when a pulse is created/updated.
   */
  registerTriggers(pulse: PulseRow): void {
    if (pulse.triggerType === "cron") {
      this.registerCronTrigger(pulse);
    } else if (pulse.triggerType === "inactivity") {
      // Track when this pulse was enabled so the inactivity timer
      // starts from now, not retroactively from an old user message.
      this.inactivityEnabledAt.set(pulse.id, Date.now());
      this.registerInactivityTrigger(pulse);
    } else if (pulse.triggerType === "filesystem") {
      this.registerFilesystemTrigger(pulse);
    }
    // Webhook pulses don't need registration — they handle POST requests on-demand
  }

  /**
   * Remove triggers for a pulse (e.g., when disabled or deleted).
   */
  removeTriggers(pulse: PulseRow): void {
    if (pulse.triggerType === "filesystem") {
      const watcher = this.fsWatchers.get(pulse.id);
      if (watcher) {
        try {
          watcher.close();
        } catch { /* ignore */ }
        this.fsWatchers.delete(pulse.id);
        this.fsDebounce.delete(pulse.id);
      }
    }
    // Cron and inactivity triggers check `enabled` at execution time,
    // so no explicit removal needed — they'll be skipped.
  }

  // ===========================================================================
  // Abort Control
  // ===========================================================================

  /**
   * Request abort of a running Pulse by pulse ID.
   * The Pulse will stop on its next content chunk check.
   */
  abortPulse(pulseId: string): boolean {
    if (this.runningPulses.has(pulseId)) {
      this.abortedPulses.add(pulseId);
      return true;
    }
    return false;
  }

  /**
   * Get the pulse ID currently running for a conversation, if any.
   */
  getRunningPulseForConversation(conversationId: string): string | null {
    // Check if any running pulse has this conversation assigned
    // We need to query the DB for this since we don't track conversationId in runningPulses
    const pulses = this.db.listPulses({ enabled: true });
    for (const pulse of pulses) {
      if (
        this.runningPulses.has(pulse.id) &&
        pulse.conversationId === conversationId
      ) {
        return pulse.id;
      }
    }
    return null;
  }

  // ===========================================================================
  // Cron Trigger
  // ===========================================================================

  private registerCronTrigger(pulse: PulseRow): void {
    // Determine the effective cron schedule
    let schedule: string;

    if (pulse.intervalSeconds && pulse.intervalSeconds >= 60) {
      const minutes = Math.floor(pulse.intervalSeconds / 60);
      schedule = `*/${minutes} * * * *`;
    } else if (pulse.randomIntervalMin && pulse.randomIntervalMax) {
      // Check every minute, use probability to determine if we should fire
      schedule = "* * * * *";
    } else if (pulse.runAt) {
      // One-shot: check every minute until the time is reached
      schedule = "* * * * *";
    } else {
      schedule = pulse.cronExpression ?? "0 * * * *";
    }

    // Deno.cron doesn't support dynamic cancellation, so we use a generic
    // handler that checks pulse state at execution time.
    // We use the pulse ID as the cron name for identification.
    const cronName = `pulse-cron-${pulse.id}`;

    try {
      Deno.cron(cronName, schedule, async () => {
        await this.handleCronTick(pulse.id);
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (msg.includes("already exists")) {
        // Deno.cron can't be cancelled. The existing handler still reads
        // pulse state from DB each tick, so it will pick up any changes.
        console.log(
          `[Pulse] Cron "${cronName}" already registered for "${pulse.name}" — existing handler will use updated config`,
        );
      } else {
        console.error(
          `[Pulse] Failed to register cron for "${pulse.name}":`,
          msg,
        );
      }
    }
  }

  /**
   * Called on each cron tick. Checks timing guards and fires if appropriate.
   */
  private async handleCronTick(pulseId: string): Promise<void> {
    const pulse = this.db.getPulse(pulseId);
    if (!pulse || !pulse.enabled) return;

    // Interval guard for sub-minute intervals
    if (
      pulse.intervalSeconds && pulse.intervalSeconds < 60 && pulse.lastRunAt
    ) {
      const elapsed = Date.now() - new Date(pulse.lastRunAt).getTime();
      if (elapsed < pulse.intervalSeconds * 1000) return;
    }

    // Random interval guard
    if (pulse.randomIntervalMin && pulse.randomIntervalMax && pulse.lastRunAt) {
      const avgInterval = (pulse.randomIntervalMin + pulse.randomIntervalMax) /
        2 * 1000;
      const probability = 60_000 / avgInterval;
      if (Math.random() > probability) return;
    }

    // One-shot run_at check
    const isOneshot = !!pulse.runAt;
    if (isOneshot) {
      if (Date.now() < new Date(pulse.runAt!).getTime()) return;
      // Clear runAt to prevent re-firing on the next cron tick.
      // Do NOT disable here — executePulse re-reads from DB and checks enabled.
      this.db.updatePulse(pulse.id, { runAt: null });
    }

    await this.executePulse(pulseId, "cron", 0, null);

    // Disable one-shot pulses after execution (auto-delete already handled inside executePulse)
    if (isOneshot) {
      const stillExists = this.db.getPulse(pulseId);
      if (stillExists && stillExists.enabled) {
        this.db.updatePulse(pulseId, { enabled: false });
      }
    }
  }

  // ===========================================================================
  // Inactivity Trigger
  // ===========================================================================

  /**
   * Register an inactivity monitor that checks every minute.
   */
  private registerInactivityTrigger(pulse: PulseRow): void {
    if (!pulse.inactivityThresholdSeconds) return;

    const cronName = `pulse-inactivity-${pulse.id}`;
    try {
      Deno.cron(cronName, "* * * * *", async () => {
        await this.handleInactivityTick(pulse.id);
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (msg.includes("already exists")) {
        // Deno.cron can't be cancelled. The existing handler still reads
        // pulse state from DB each tick, so it will pick up any changes.
        console.log(
          `[Pulse] Inactivity cron "${cronName}" already registered for "${pulse.name}" — existing handler will use updated config`,
        );
      } else {
        console.error(
          `[Pulse] Failed to register inactivity trigger for "${pulse.name}":`,
          msg,
        );
      }
    }
  }

  private async handleInactivityTick(pulseId: string): Promise<void> {
    const pulse = this.db.getPulse(pulseId);
    if (!pulse || !pulse.enabled || !pulse.inactivityThresholdSeconds) return;

    // Don't fire if already running
    if (this.runningPulses.has(pulseId)) return;

    // Use cached timestamp (updated when user messages arrive)
    if (!this.lastGlobalUserMessage) {
      return;
    }

    // The inactivity clock starts from whichever is more recent:
    // - when the pulse was enabled/saved (prevents retroactive firing)
    // - when the user last sent a message (resets on activity)
    const lastMessageMs = new Date(this.lastGlobalUserMessage).getTime();
    const enabledAtMs = this.inactivityEnabledAt.get(pulseId) ?? lastMessageMs;
    const effectiveStartMs = Math.max(enabledAtMs, lastMessageMs);

    const elapsedMs = Date.now() - effectiveStartMs;
    const thresholdMs = pulse.inactivityThresholdSeconds * 1000;

    // Hard threshold: must be inactive for at least the set duration
    if (elapsedMs < thresholdMs) return;

    // Cooldown: don't fire again until the full threshold has elapsed since
    // the last successful run (or since user activity, whichever is later).
    // This prevents rapid-fire when the user stays inactive.
    if (pulse.lastRunAt) {
      const sinceLastRunMs = Date.now() - new Date(pulse.lastRunAt).getTime();
      if (sinceLastRunMs < thresholdMs) {
        return;
      }
    }

    // If random jitter is enabled (randomIntervalMin/Max set), add organic delay.
    // randomIntervalMin/Max represent the absolute elapsed time range from
    // the effective start during which the pulse may fire.
    if (pulse.randomIntervalMin && pulse.randomIntervalMax) {
      const windowStartMs = pulse.randomIntervalMin * 1000;
      const windowEndMs = pulse.randomIntervalMax * 1000;

      if (elapsedMs < windowStartMs) return; // Too early even with jitter

      if (elapsedMs <= windowEndMs) {
        // Within the jitter window — use probability for organic feel.
        // Linear ramp from 0 to 40% across the window.
        const windowProgress = (elapsedMs - windowStartMs) /
          (windowEndMs - windowStartMs);
        const probability = Math.min(0.4, windowProgress * 0.6);
        if (Math.random() > probability) return;
      }
      // Past the window — fall through and fire.
      // The threshold is exceeded and the jitter window was just for timing,
      // not permanent suppression.
    }

    await this.executePulse(pulseId, "inactivity", 0, null);
  }

  /**
   * Update the last global user message timestamp.
   * Called by the chat handler when a user message is received.
   * Uses Date.now() directly since we know a message just arrived,
   * rather than querying the DB (which may not have the message yet
   * since EntityTurn.process() hasn't run).
   */
  updateLastUserMessage(): void {
    this.lastGlobalUserMessage = new Date().toISOString();
  }

  // ===========================================================================
  // Filesystem Trigger
  // ===========================================================================

  private registerFilesystemTrigger(pulse: PulseRow): void {
    if (!pulse.filesystemWatchPath) return;

    // Close existing watcher if any
    const existing = this.fsWatchers.get(pulse.id);
    if (existing) {
      try {
        existing.close();
      } catch { /* ignore */ }
    }

    try {
      const watcher = Deno.watchFs(pulse.filesystemWatchPath);
      this.fsWatchers.set(pulse.id, watcher);

      // Run the watcher loop (non-blocking)
      (async () => {
        try {
          for await (const event of watcher) {
            if (event.kind === "create" || event.kind === "modify") {
              await this.handleFsEvent(pulse.id);
            }
          }
        } catch (error) {
          if (this.started) {
            console.error(
              `[Pulse] Filesystem watcher error for "${pulse.name}":`,
              error instanceof Error ? error.message : String(error),
            );
          }
        }
      })();

      console.log(
        `[Pulse] Watching ${pulse.filesystemWatchPath} for "${pulse.name}"`,
      );
    } catch (error) {
      console.error(
        `[Pulse] Failed to watch ${pulse.filesystemWatchPath}:`,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private async handleFsEvent(pulseId: string): Promise<void> {
    const now = Date.now();
    const lastTrigger = this.fsDebounce.get(pulseId) ?? 0;

    // Debounce: ignore events within the cooldown period
    if (now - lastTrigger < FS_DEBOUNCE_MS) return;

    this.fsDebounce.set(pulseId, now);
    const pulse = this.db.getPulse(pulseId);
    if (!pulse || !pulse.enabled) return;

    await this.executePulse(pulseId, "filesystem", 0, null);
  }

  // ===========================================================================
  // Webhook Trigger
  // ===========================================================================

  /**
   * Handle a webhook trigger. Returns an error message if the trigger should be rejected.
   */
  checkWebhookTrigger(
    pulseId: string,
  ): { ok: true } | { ok: false; error: string } {
    const now = Date.now();
    const lastTrigger = this.webhookRateLimit.get(pulseId) ?? 0;

    if (now - lastTrigger < WEBHOOK_RATE_LIMIT_MS) {
      return { ok: false, error: "Rate limited" };
    }

    this.webhookRateLimit.set(pulseId, now);
    return { ok: true };
  }

  // ===========================================================================
  // Execution
  // ===========================================================================

  /**
   * Execute a pulse.
   *
   * @param pulseId - The pulse to execute
   * @param triggerSource - What triggered this execution
   * @param chainDepth - Current depth in the chain (0 for root execution)
   * @param parentRunId - The run ID of the parent in a chain (null for root)
   */
  async executePulse(
    pulseId: string,
    triggerSource:
      | "cron"
      | "webhook"
      | "filesystem"
      | "chain"
      | "manual"
      | "inactivity",
    chainDepth: number,
    parentRunId: string | null,
  ): Promise<void> {
    const pulse = this.db.getPulse(pulseId);
    if (!pulse || !pulse.enabled) return;

    // Guard: already running
    if (this.runningPulses.has(pulseId)) {
      console.debug(`[Pulse] Skipping "${pulse.name}" — already running`);
      return;
    }

    // Guard: chain depth
    if (chainDepth > pulse.maxChainDepth) {
      console.debug(
        `[Pulse] Skipping "${pulse.name}" — chain depth ${chainDepth} exceeds max ${pulse.maxChainDepth}`,
      );
      return;
    }

    // Guard: cycle detection
    if (parentRunId && this.db.detectPulseChainCycle(pulseId, parentRunId)) {
      console.debug(
        `[Pulse] Skipping "${pulse.name}" — cycle detected in chain`,
      );
      return;
    }

    // Acquire semaphore (wait if at capacity)
    await this.semaphore.acquire();
    this.runningPulses.add(pulseId);

    let errorMessage: string | null = null;
    let conversationId: string | null = pulse.conversationId;
    let runId: string | undefined;
    try {
      // For visible mode with no assigned conversation, create a dedicated one
      if (!conversationId && pulse.chatMode === "visible") {
        const conv = this.db.createConversation(`[Pulse] ${pulse.name}`);
        conversationId = conv.id;
        // Store back on the pulse for reuse
        this.db.updatePulse(pulseId, { conversationId });
      }

      // For silent mode with no conversation, create a temporary one
      if (!conversationId && pulse.chatMode === "silent") {
        const conv = this.db.createConversation(`[Pulse:silent] ${pulse.name}`);
        conversationId = conv.id;
      }

      // Create run record
      runId = this.db.addPulseRun({
        pulseId,
        conversationId,
        triggerSource,
        chainDepth,
        chainParentRunId: parentRunId,
      });

      console.log(
        `[Pulse] Executing "${pulse.name}" (trigger: ${triggerSource}, chain: ${chainDepth})`,
      );

      // Build entity config
      const entityConfig: EntityConfig = {
        projectRoot: this.config.projectRoot,
        chatRAG: this.config.chatRAG,
        mcpClient: this.config.mcpClient,
        lorebookManager: this.config.lorebookManager,
        vaultManager: this.config.vaultManager,
        webSearchSettings: this.config.webSearchSettings?.(),
        discordSettings: this.config.discordSettings?.(),
        homeSettings: this.config.homeSettings?.(),
        imageGenSettings: this.config.imageGenSettings?.(),
        lovenseSettings: this.config.lovenseSettings?.(),
        buttplugSettings: this.config.buttplugSettings?.(),
        deviceStatusCache: this.config.deviceStatusCache?.(),
        contextLength: this.config.contextLength?.(),
        maxTokens: this.config.maxTokens?.(),
      };

      const turn = new EntityTurn(
        this.getLlm(),
        this.db,
        this.tools,
        entityConfig,
      );

      // Broadcast the Pulse prompt message to the chat in real time
      if (pulse.chatMode === "visible" && conversationId) {
        try {
          const pulseMsg: Message = {
            id: crypto.randomUUID(),
            role: "user",
            content: pulse.promptText,
            createdAt: new Date(),
            pulseId: pulse.id,
            pulseName: pulse.name,
          };
          const msgHtml = renderMessage(pulseMsg);
          getBroadcaster().broadcastUpdate({
            target: "#messages",
            html: msgHtml,
            swap: "beforeend",
          }, conversationId);
        } catch {
          // Broadcaster may have no connected clients
        }
      }

      // Execute the agentic loop
      let fullContent = "";
      let toolCallsCount = 0;

      for await (
        const chunk of turn.process(conversationId!, pulse.promptText, {
          pulseId: pulse.id,
          pulseName: pulse.name,
          skipStickyDecrement: true,
        })
      ) {
        // Check if this Pulse was aborted by the user
        if (this.abortedPulses.has(pulseId)) {
          console.log(`[Pulse] "${pulse.name}" aborted by user`);
          break;
        }
        switch (chunk.type) {
          case "content":
            fullContent += chunk.content;
            if (pulse.chatMode === "visible" && conversationId) {
              try {
                getBroadcaster().broadcastEvent(
                  "content",
                  chunk.content,
                  conversationId,
                );
              } catch { /* no clients */ }
            }
            break;
          case "thinking":
            if (pulse.chatMode === "visible" && conversationId) {
              try {
                getBroadcaster().broadcastEvent(
                  "thinking",
                  chunk.content,
                  conversationId,
                );
              } catch { /* no clients */ }
            }
            break;
          case "tool_call":
            if (pulse.chatMode === "visible" && conversationId) {
              try {
                getBroadcaster().broadcastEvent(
                  "tool_call",
                  chunk.toolCall,
                  conversationId,
                );
              } catch { /* no clients */ }
            }
            break;
          case "tool_result": {
            toolCallsCount++;
            if (pulse.chatMode === "visible" && conversationId) {
              // Truncate tool result content before broadcasting to keep
              // the JSON valid on the client side. The LLM still receives
              // the full result in its agentic loop context.
              const result = chunk.result;
              const MAX_TOOL_CONTENT = 50 * 1024;
              const content = result.content;
              const truncatedContent = content.length > MAX_TOOL_CONTENT
                ? content.substring(0, MAX_TOOL_CONTENT) +
                  `\n\n[... ${
                    (content.length - MAX_TOOL_CONTENT).toLocaleString()
                  } characters truncated]`
                : content;
              try {
                getBroadcaster().broadcastEvent("tool_result", {
                  toolCallId: result.toolCallId,
                  content: truncatedContent,
                  isError: result.isError,
                  affectedRegions: result.affectedRegions,
                }, conversationId);
              } catch { /* no clients */ }
            }
            break;
          }
          case "dom_update":
            if (pulse.chatMode === "visible" && conversationId) {
              try {
                getBroadcaster().broadcastUpdate(chunk.update, conversationId);
              } catch { /* no clients */ }
            }
            break;
          case "status":
          case "metrics":
          case "context":
            break;
        }
      }

      // Signal stream completion to the chat client
      if (pulse.chatMode === "visible" && conversationId) {
        try {
          getBroadcaster().broadcastEvent("done", {}, conversationId);
          // Fallback: tell client to reload messages in case streaming was missed
          getBroadcaster().broadcastEvent(
            "pulse_complete",
            { conversationId },
            conversationId,
          );
        } catch {
          // Broadcaster may have no connected clients
        }
      }

      // Complete the run record
      const resultSummary = fullContent.length > 500
        ? fullContent.substring(0, 500) + "..."
        : fullContent;

      this.db.completePulseRun(runId, {
        status: "success",
        resultSummary,
        toolCallsCount,
        outputContent: pulse.chatMode === "silent" ? fullContent : null,
      });

      this.db.updatePulseRunStats(pulseId, "success");

      // Execute chained pulses
      if (pulse.chainPulseIds.length > 0) {
        for (const nextPulseId of pulse.chainPulseIds) {
          try {
            await this.executePulse(
              nextPulseId,
              "chain",
              chainDepth + 1,
              runId,
            );
          } catch (chainError) {
            console.error(
              `[Pulse] Chain error from "${pulse.name}" -> "${nextPulseId}":`,
              chainError instanceof Error
                ? chainError.message
                : String(chainError),
            );
          }
        }
      }

      // Auto-delete for entity-created one-shot pulses
      if (pulse.autoDelete) {
        this.deletePulseAndRuns(pulseId);
        console.log(
          `[Pulse] Auto-deleted "${pulse.name}" after successful execution`,
        );
      }
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`[Pulse] Error executing "${pulse.name}":`, errorMessage);

      // Notify the client of the error
      if (pulse.chatMode === "visible" && conversationId) {
        try {
          getBroadcaster().broadcastEvent("status", {
            error: `Pulse error: ${errorMessage}`,
          }, conversationId);
          getBroadcaster().broadcastEvent("done", "error", conversationId);
          // Fallback: tell client to reload messages in case streaming was missed
          getBroadcaster().broadcastEvent(
            "pulse_complete",
            { conversationId },
            conversationId,
          );
        } catch {
          // Broadcaster may have no connected clients
        }
      }

      // Complete run record with error status so it doesn't stay stuck as "running"
      if (runId) {
        this.db.completePulseRun(runId, {
          status: "error",
          errorMessage,
        });
      }
      this.db.updatePulseRunStats(pulseId, "error");
    } finally {
      this.runningPulses.delete(pulseId);
      this.abortedPulses.delete(pulseId);
      this.semaphore.release();
    }
  }

  /**
   * Delete a pulse and clean up its resources.
   */
  private deletePulseAndRuns(pulseId: string): void {
    // Close filesystem watcher if any
    const watcher = this.fsWatchers.get(pulseId);
    if (watcher) {
      try {
        watcher.close();
      } catch { /* ignore */ }
      this.fsWatchers.delete(pulseId);
      this.fsDebounce.delete(pulseId);
    }

    this.db.deletePulse(pulseId);
  }
}
