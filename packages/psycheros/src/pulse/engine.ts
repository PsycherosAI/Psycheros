/**
 * Pulse Engine
 *
 * The Pulse subsystem lets me execute prompts autonomously — on a
 * schedule, in response to user inactivity, on a filesystem event, or
 * from an external webhook.
 *
 * I am a consumer of the durable scheduler. Cron and inactivity pulses
 * become schedules in the scheduler's `schedules` table; webhook and
 * filesystem pulses enqueue jobs directly on event. Manual triggers and
 * chained executions enqueue jobs the same way. Every actual execution
 * runs inside the `pulse.execute` handler I register here.
 *
 * The benefits of routing everything through the scheduler:
 *   - Missed cron fires are evaluated on each boot per the schedule's
 *     catchup policy (most pulses skip missed fires; one-shots fire once).
 *   - In-flight runs at crash become `dead` rows with a clear reason on
 *     the next boot, instead of zombie `running` rows that never resolve.
 *   - Run history is the same `job_runs` table the admin UI reads, so
 *     "OK/Err" counts and "last fired at" are derived from one source.
 *
 * @module
 */

import type { Scheduler } from "../scheduler/mod.ts";
import type {
  HandlerContext,
  HandlerResult,
  JobRunRow,
} from "../scheduler/mod.ts";
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
import { generateUIUpdates } from "../server/ui-updates.ts";
import { renderMessage } from "../server/templates.ts";
import { VoiceSessionManager } from "../voice/mod.ts";
import type { Message, PulseRow } from "../types.ts";

// =============================================================================
// Constants
// =============================================================================

/** Maximum concurrent pulse executions — bounds LLM API load. */
const MAX_CONCURRENT_PULSES = 3;

/** Filesystem-event debounce window per pulse, in milliseconds. */
const FS_DEBOUNCE_MS = 1_000;

/** Webhook-trigger rate limit window per pulse, in milliseconds. */
const WEBHOOK_RATE_LIMIT_MS = 10_000;

/** Inactivity pulses tick this often — the handler decides whether to fire. */
const INACTIVITY_TICK_CRON = "* * * * *";

/** Pulse trigger sources, recorded in the job_runs payload. */
export type PulseTriggerSource =
  | "cron"
  | "webhook"
  | "filesystem"
  | "chain"
  | "manual"
  | "inactivity"
  | "data_event";

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
// Engine Configuration
// =============================================================================

/**
 * Engine configuration — mirrors the services available to the entity turn.
 */
export interface PulseEngineConfig {
  /** Source root — psycheros source location. */
  projectRoot: string;
  /** Data root — runtime state location (PSYCHEROS_DATA_DIR or projectRoot). */
  dataRoot: string;
  chatRAG?: ConversationRAG;
  mcpClient?: MCPClient;
  lorebookManager?: LorebookManager;
  vaultManager?: VaultManager;
  webSearchSettings?: () => WebSearchSettings | undefined;
  discordSettings?: () => DiscordSettings | undefined;
  homeSettings?: () => HomeSettings | undefined;
  imageGenSettings?: () => ImageGenSettings | undefined;
  lovenseSettings?: () => LovenseSettings | undefined;
  buttplugSettings?: () => ButtplugSettings | undefined;
  bleSettings?: () => import("../llm/ble-settings.ts").BLESettings | undefined;
  deviceStatusCache?: () =>
    | import("../server/device-cache.ts").DeviceStatusCache
    | undefined;
  contextLength?: () => number | undefined;
  maxTokens?: () => number | undefined;
  pluginManager?: import("../plugins/mod.ts").PluginManager;
}

// =============================================================================
// Pulse Engine
// =============================================================================

/**
 * Core engine for the Pulse system.
 *
 * Holds transient in-memory state (currently-running pulses, fs-watcher
 * handles, webhook rate-limit timestamps). All durable state — schedule
 * definitions, run history, retry attempts — lives in the scheduler's
 * SQLite tables.
 */
export class PulseEngine {
  private runningPulses: Set<string> = new Set();
  private abortedPulses: Set<string> = new Set();
  private semaphore: Semaphore;
  private fsWatchers: Map<string, Deno.FsWatcher> = new Map();
  private fsDebounce: Map<string, number> = new Map();
  private webhookRateLimit: Map<string, number> = new Map();
  private started = false;

  constructor(
    private db: DBClient,
    private scheduler: Scheduler,
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
   * Start the pulse engine. Registers the `pulse.execute` handler with the
   * scheduler and defines schedules for every enabled pulse.
   * Idempotent — calling twice is a no-op.
   */
  start(): void {
    if (this.started) return;
    this.started = true;

    this.scheduler.register(
      "pulse.execute",
      (ctx) => this.handlePulseExecute(ctx),
    );

    const pulses = this.db.listPulses({ enabled: true });
    for (const pulse of pulses) {
      this.registerTriggers(pulse);
    }

    console.log(`[Pulse] Engine started with ${pulses.length} active pulse(s)`);
  }

  /**
   * Stop the pulse engine. Closes filesystem watchers; the scheduler
   * itself is owned and stopped by the server.
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
   * Register a pulse's trigger surface — schedules go to the scheduler,
   * filesystem watchers open here. Called on startup for each enabled
   * pulse, and whenever a pulse is created or updated.
   */
  registerTriggers(pulse: PulseRow): void {
    if (pulse.triggerType === "cron" || pulse.triggerType === "inactivity") {
      this.defineSchedule(pulse);
    } else if (pulse.triggerType === "filesystem") {
      this.openFilesystemWatcher(pulse);
    }
    // Webhook pulses have no persistent registration — incoming HTTP
    // requests enqueue jobs directly.
  }

  /**
   * Remove a pulse's trigger surface. Schedules are deleted from the
   * scheduler so they stop firing; filesystem watchers are closed.
   */
  removeTriggers(pulse: PulseRow): void {
    this.scheduler.removeSchedule(this.scheduleIdFor(pulse.id));
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
  }

  private scheduleIdFor(pulseId: string): string {
    return `pulse-${pulseId}`;
  }

  private defineSchedule(pulse: PulseRow): void {
    const id = this.scheduleIdFor(pulse.id);
    const handler = "pulse.execute";
    const payload = { pulseId: pulse.id, triggerSource: pulse.triggerType };

    if (pulse.runAt) {
      // One-shot at a specific time. Use the scheduler's oneshot kind so
      // the schedule disables itself after firing.
      this.scheduler.defineSchedule({
        id,
        kind: "oneshot",
        handler,
        payload,
        runAt: pulse.runAt,
        catchupPolicy: "fire_once_then_align",
        maxAttempts: 1,
      });
      return;
    }

    if (pulse.triggerType === "inactivity") {
      // Inactivity pulses tick every minute; the handler checks the user's
      // last activity timestamp and the cooldown before firing for real.
      this.scheduler.defineSchedule({
        id,
        kind: "recurring",
        handler,
        payload,
        cronExpr: INACTIVITY_TICK_CRON,
        catchupPolicy: "skip_missed",
        maxAttempts: 1,
      });
      return;
    }

    if (pulse.intervalSeconds && pulse.intervalSeconds > 0) {
      this.scheduler.defineSchedule({
        id,
        kind: "recurring",
        handler,
        payload,
        intervalSeconds: pulse.intervalSeconds,
        catchupPolicy: "skip_missed",
        maxAttempts: 1,
      });
      return;
    }

    if (pulse.randomIntervalMin && pulse.randomIntervalMax) {
      this.scheduler.defineSchedule({
        id,
        kind: "recurring",
        handler,
        payload,
        randomMinSeconds: pulse.randomIntervalMin,
        randomMaxSeconds: pulse.randomIntervalMax,
        catchupPolicy: "skip_missed",
        maxAttempts: 1,
      });
      return;
    }

    this.scheduler.defineSchedule({
      id,
      kind: "recurring",
      handler,
      payload,
      cronExpr: pulse.cronExpression ?? "0 * * * *",
      catchupPolicy: "skip_missed",
      maxAttempts: 1,
    });
  }

  private openFilesystemWatcher(pulse: PulseRow): void {
    if (!pulse.filesystemWatchPath) return;

    const existing = this.fsWatchers.get(pulse.id);
    if (existing) {
      try {
        existing.close();
      } catch { /* ignore */ }
    }

    try {
      const watcher = Deno.watchFs(pulse.filesystemWatchPath);
      this.fsWatchers.set(pulse.id, watcher);

      (async () => {
        try {
          for await (const event of watcher) {
            if (event.kind === "create" || event.kind === "modify") {
              this.onFilesystemEvent(pulse.id);
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

  private onFilesystemEvent(pulseId: string): void {
    const now = Date.now();
    const lastTrigger = this.fsDebounce.get(pulseId) ?? 0;
    if (now - lastTrigger < FS_DEBOUNCE_MS) return;
    this.fsDebounce.set(pulseId, now);

    const pulse = this.db.getPulse(pulseId);
    if (!pulse || !pulse.enabled) return;

    this.enqueueExecution(pulseId, "filesystem", 0, null);
  }

  // ===========================================================================
  // External Triggers — enqueue jobs through the scheduler
  // ===========================================================================

  /**
   * Manually trigger a pulse. Used by the HTTP route, the pulse tool
   * (from entity-generated pulses), and chained executions.
   *
   * Returns the queued job_run row. The actual execution happens
   * asynchronously when the scheduler ticks (within ~5 seconds).
   */
  triggerPulse(
    pulseId: string,
    triggerSource: PulseTriggerSource,
    chainDepth = 0,
    parentRunId: string | null = null,
  ): JobRunRow {
    return this.enqueueExecution(
      pulseId,
      triggerSource,
      chainDepth,
      parentRunId,
    );
  }

  /**
   * Webhook trigger. Rate-limited per pulse (in-memory). On success,
   * enqueues a job and returns its id.
   */
  triggerWebhook(
    pulseId: string,
  ): { ok: true; jobId: string } | { ok: false; error: string } {
    const now = Date.now();
    const lastTrigger = this.webhookRateLimit.get(pulseId) ?? 0;
    if (now - lastTrigger < WEBHOOK_RATE_LIMIT_MS) {
      return { ok: false, error: "Rate limited" };
    }
    this.webhookRateLimit.set(pulseId, now);
    const job = this.enqueueExecution(pulseId, "webhook", 0, null);
    return { ok: true, jobId: job.id };
  }

  private enqueueExecution(
    pulseId: string,
    triggerSource: PulseTriggerSource,
    chainDepth: number,
    parentRunId: string | null,
  ): JobRunRow {
    const job = this.scheduler.enqueue({
      handler: "pulse.execute",
      payload: { pulseId, triggerSource, chainDepth, parentRunId },
      maxAttempts: 1,
    });
    // Manual / webhook / filesystem triggers are user-driven; the user
    // shouldn't wait up to the tick interval for execution to start.
    this.scheduler.nudge();
    return job;
  }

  // ===========================================================================
  // Abort Control
  // ===========================================================================

  /**
   * Request abort of a running Pulse. The Pulse loop checks this flag on
   * every content chunk and exits cleanly.
   */
  abortPulse(pulseId: string): boolean {
    if (this.runningPulses.has(pulseId)) {
      this.abortedPulses.add(pulseId);
      return true;
    }
    return false;
  }

  /**
   * Get the pulse currently running in a given conversation, if any.
   */
  getRunningPulseForConversation(conversationId: string): string | null {
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
  // Handler
  // ===========================================================================

  /**
   * The `pulse.execute` handler. Reads the pulse, checks eligibility,
   * acquires the LLM-concurrency semaphore, and runs the agentic loop.
   *
   * Returns:
   *   - `success` when the loop completes (even with an empty result),
   *   - `skipped` when a guard rejects the run (pulse disabled, already
   *     running, inactivity threshold not met, chain depth exceeded,
   *     cycle detected) — no LLM call, no chat side effects.
   *
   * Throws on real execution errors so the scheduler marks the run
   * `error` / `dead` and records the message.
   */
  private async handlePulseExecute(
    ctx: HandlerContext,
  ): Promise<HandlerResult> {
    const payload = ctx.payload as {
      pulseId?: string;
      triggerSource?: PulseTriggerSource;
      chainDepth?: number;
      parentRunId?: string | null;
    };

    const pulseId = payload.pulseId;
    if (!pulseId) {
      return { status: "skipped", result: "Missing pulseId in payload" };
    }
    const triggerSource: PulseTriggerSource = payload.triggerSource ?? "cron";
    const chainDepth = payload.chainDepth ?? 0;
    const parentRunId = payload.parentRunId ?? null;

    const pulse = this.db.getPulse(pulseId);
    if (!pulse) {
      return { status: "skipped", result: "Pulse no longer exists" };
    }
    if (!pulse.enabled) {
      return { status: "skipped", result: "Pulse disabled" };
    }

    if (pulse.triggerType === "inactivity" && triggerSource === "inactivity") {
      const eligibility = this.checkInactivityEligibility(pulse);
      if (!eligibility.ok) {
        return { status: "skipped", result: eligibility.reason };
      }
    }

    if (this.runningPulses.has(pulseId)) {
      return { status: "skipped", result: "Already running" };
    }

    if (chainDepth > pulse.maxChainDepth) {
      return {
        status: "skipped",
        result: `Chain depth ${chainDepth} exceeds max ${pulse.maxChainDepth}`,
      };
    }

    if (parentRunId && this.db.detectPulseChainCycle(pulseId, parentRunId)) {
      return { status: "skipped", result: "Cycle detected in chain" };
    }

    const isOneshot = !!pulse.runAt;

    await this.semaphore.acquire();
    this.runningPulses.add(pulseId);

    try {
      const result = await this.runAgenticLoop(
        pulse,
        triggerSource,
        chainDepth,
        ctx.jobId,
      );

      // Fire chained pulses — each becomes its own scheduler job so they
      // survive a crash mid-chain. Chain order is preserved by the
      // scheduler's FIFO claim within a tick.
      if (pulse.chainPulseIds.length > 0) {
        for (const nextPulseId of pulse.chainPulseIds) {
          this.enqueueExecution(
            nextPulseId,
            "chain",
            chainDepth + 1,
            ctx.jobId,
          );
        }
      }

      // Entity-created one-shots auto-delete after they fire.
      if (pulse.autoDelete) {
        this.deletePulseAndRuns(pulseId);
        console.log(
          `[Pulse] Auto-deleted "${pulse.name}" after successful execution`,
        );
      } else if (isOneshot) {
        // Clear runAt and disable so the pulse can't fire again. The
        // scheduler's oneshot already disabled the schedule.
        this.db.updatePulse(pulseId, { runAt: null, enabled: false });
      }

      return result;
    } finally {
      this.runningPulses.delete(pulseId);
      this.abortedPulses.delete(pulseId);
      this.semaphore.release();
    }
  }

  /**
   * Inactivity-pulse eligibility check. Reads the user's last message
   * timestamp from the DB (no in-memory cache — survives restart) and
   * decides whether this tick should fire.
   */
  private checkInactivityEligibility(
    pulse: PulseRow,
  ): { ok: true } | { ok: false; reason: string } {
    if (!pulse.inactivityThresholdSeconds) {
      return { ok: false, reason: "No inactivity threshold configured" };
    }

    const lastUserMessage = this.db.getLastUserMessageTimestamp();
    if (!lastUserMessage) {
      return { ok: false, reason: "No user message yet" };
    }

    const elapsedMs = Date.now() - new Date(lastUserMessage).getTime();
    const thresholdMs = pulse.inactivityThresholdSeconds * 1000;
    if (elapsedMs < thresholdMs) {
      return { ok: false, reason: "Below inactivity threshold" };
    }

    // Cooldown: don't fire again until the full threshold has elapsed
    // since the last successful run. Derived from job_runs (via a
    // success-only query) rather than an in-memory cache so it survives
    // restart. Must NOT gate on `skipped` ticks — those are produced by
    // this very check, so gating on them would self-deadlock the pulse.
    const lastSuccessAt = this.db.getLastSuccessfulPulseRunAt(pulse.id);
    if (lastSuccessAt) {
      const sinceLastRunMs = Date.now() - new Date(lastSuccessAt).getTime();
      if (sinceLastRunMs < thresholdMs) {
        return { ok: false, reason: "Cooldown active" };
      }
    }

    // Optional random jitter — linear-ramp probability inside the window.
    if (pulse.randomIntervalMin && pulse.randomIntervalMax) {
      const windowStartMs = pulse.randomIntervalMin * 1000;
      const windowEndMs = pulse.randomIntervalMax * 1000;
      if (elapsedMs < windowStartMs) {
        return { ok: false, reason: "Too early even with jitter" };
      }
      if (elapsedMs <= windowEndMs) {
        const windowProgress = (elapsedMs - windowStartMs) /
          (windowEndMs - windowStartMs);
        const probability = Math.min(0.4, windowProgress * 0.6);
        if (Math.random() > probability) {
          return { ok: false, reason: "Jitter probability gate" };
        }
      }
      // Past the window: fall through and fire.
    }

    return { ok: true };
  }

  /**
   * The agentic loop — same shape as before, just with explicit
   * job_id-based bookkeeping. The scheduler tracks status/duration; this
   * function focuses on streaming and broadcasting.
   */
  private async runAgenticLoop(
    pulse: PulseRow,
    triggerSource: PulseTriggerSource,
    chainDepth: number,
    jobId: string,
  ): Promise<HandlerResult> {
    let conversationId: string | null = pulse.conversationId;

    // For visible mode with no assigned conversation, create a dedicated one.
    if (!conversationId && pulse.chatMode === "visible") {
      const conv = this.db.createConversation(`[Pulse] ${pulse.name}`);
      conversationId = conv.id;
      this.db.updatePulse(pulse.id, { conversationId });
    }

    // For silent mode with no conversation, create a temporary one.
    if (!conversationId && pulse.chatMode === "silent") {
      const conv = this.db.createConversation(`[Pulse:silent] ${pulse.name}`);
      conversationId = conv.id;
    }

    // Refresh the sidebar whenever a pulse creates a new conversation.
    try {
      const updates = generateUIUpdates(["conv-list"], this.db);
      getBroadcaster().broadcastUpdates(updates, null);
    } catch {
      // Broadcaster may have no connected clients
    }

    // If this conversation is in an active voice call, hand the Pulse off
    // to the voice pipeline instead of running it through the text chat
    // path. The voice session queues it, drains at the next idle transition
    // (after entity finishes any in-flight response), plays a heartbeat cue
    // + shows a toast, and reads the entity's response aloud via TTS.
    // Returns the same HandlerResult shape so the scheduler's job_runs
    // tracking works identically.
    if (conversationId) {
      const voiceSession = VoiceSessionManager.getInstance()
        .getSessionByConversation(conversationId);
      if (voiceSession) {
        console.log(
          `[Pulse] "${pulse.name}" routed to voice session in ${
            conversationId.slice(0, 8)
          }`,
        );
        return await VoiceSessionManager.getInstance().executePulseInVoice(
          conversationId,
          {
            id: pulse.id,
            name: pulse.name,
            promptText: pulse.promptText,
          },
        );
      }
    }

    console.log(
      `[Pulse] Executing "${pulse.name}" (trigger: ${triggerSource}, chain: ${chainDepth}, job: ${
        jobId.slice(0, 8)
      })`,
    );

    const entityConfig: EntityConfig = {
      projectRoot: this.config.projectRoot,
      dataRoot: this.config.dataRoot,
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
      pluginManager: this.config.pluginManager,
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

    let fullContent = "";

    try {
      for await (
        const chunk of turn.process(conversationId!, pulse.promptText, {
          pulseId: pulse.id,
          pulseName: pulse.name,
          skipStickyDecrement: true,
        })
      ) {
        if (this.abortedPulses.has(pulse.id)) {
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
            if (pulse.chatMode === "visible" && conversationId) {
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
          getBroadcaster().broadcastEvent(
            "pulse_complete",
            { conversationId },
            conversationId,
          );
        } catch {
          // Broadcaster may have no connected clients
        }
      }

      const resultSummary = fullContent.length > 500
        ? fullContent.substring(0, 500) + "..."
        : fullContent;

      return { status: "success", result: resultSummary };
    } catch (error) {
      const errorMessage = error instanceof Error
        ? error.message
        : String(error);
      console.error(`[Pulse] Error executing "${pulse.name}":`, errorMessage);

      if (pulse.chatMode === "visible" && conversationId) {
        try {
          getBroadcaster().broadcastEvent("status", {
            error: `Pulse error: ${errorMessage}`,
          }, conversationId);
          getBroadcaster().broadcastEvent("done", "error", conversationId);
          getBroadcaster().broadcastEvent(
            "pulse_complete",
            { conversationId },
            conversationId,
          );
        } catch {
          // Broadcaster may have no connected clients
        }
      }

      // Rethrow so the scheduler marks the run `error` / `dead`.
      throw error;
    }
  }

  /**
   * Delete a pulse and clean up its resources. Used by auto-delete.
   */
  private deletePulseAndRuns(pulseId: string): void {
    const watcher = this.fsWatchers.get(pulseId);
    if (watcher) {
      try {
        watcher.close();
      } catch { /* ignore */ }
      this.fsWatchers.delete(pulseId);
      this.fsDebounce.delete(pulseId);
    }
    this.scheduler.removeSchedule(this.scheduleIdFor(pulseId));
    this.db.deletePulse(pulseId);
  }
}
