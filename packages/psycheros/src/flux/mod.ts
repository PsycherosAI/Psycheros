/**
 * entity-flux host wiring — adapts psycheros machinery to flux's
 * injected-capability interfaces.
 *
 * Flux consumes the interfaces defined in `entity-flux/src/host.ts`; this
 * module is the composition root — it takes psycheros's `getEmbedder()`,
 * worker LLM client, `getBroadcaster()`, `MCPClient`, `DBClient`, and
 * `EntityTurn`, and wraps each into the shape flux expects. (Dependency
 * direction protects psycheros, not flux: flux is a Psycheros subsystem and
 * may import psycheros leaf modules where it needs host knowledge.) Keeps
 * server.ts edits minimal — one call to `createFluxManager` — and
 * concentrates the adapter logic here.
 *
 * @module
 */

import { join } from "@std/path";
import { makeMoodClassifier } from "./mood-classifier.ts";
import {
  discoverSensoryOrganPlugins,
  pluginWantsEnabling,
  setShippedSensoryOrganDescriptors,
} from "./sensory-organ-plugins.ts";
import {
  createClientFromProfile,
  createWorkerClient,
  type LLMClient,
} from "../llm/mod.ts";
import { getActiveProfile, loadProfileSettings } from "../llm/settings.ts";
import { getEmbedder } from "../rag/embedder.ts";
import { getConversationRAG } from "../rag/conversation.ts";
import { getBroadcaster } from "../server/broadcaster.ts";
import { getVoiceSessionManager } from "../voice/mod.ts";
import { withConversationLock } from "../utils/conversation-lock.ts";
import { renderMessage } from "../server/templates.ts";
import { generateUIUpdates } from "../server/ui-updates.ts";
import { buildIdentitySystemMessage } from "../entity/context.ts";
import {
  buildDynamicBlock,
  buildSituationalAwareness,
} from "../entity/turn-context.ts";
import { buildImageGenContent } from "../entity/image-gen-context.ts";
import type { DBClient } from "../db/mod.ts";
import type { MCPClient } from "../mcp-client/mod.ts";
import type { ToolRegistry } from "../tools/mod.ts";

import {
  type ChatFn,
  createMotionVisionSensoryOrgan,
  createSystemStateSensoryOrgan,
  type EmbedFn,
  type FluxBroadcaster,
  type FluxChatRAG,
  type FluxConversationReader,
  type FluxEgoTrigger,
  type FluxHostConfig,
  FluxManager,
  type FluxMemoryReader,
  type FluxMemoryWriter,
  initializeFluxSchema,
  type ModelHookup,
  motionVisionSettingsFields,
  type OrganEnvelope,
  systemStateSettingsFields,
  VolatileStateStore,
} from "../../../entity-flux/src/mod.ts";
import {
  END_FLUX_STATE_TOOL,
  FluxSession,
  type SessionLiveStreamSink,
} from "./flux-session.ts";
import { listSkills, loadSkill } from "../skills/loader.ts";
import {
  buildHeldSkillsBlock,
  buildSkillsIndexBlock,
} from "../skills/index-block.ts";
import {
  getFluxHostConversationId,
  setFluxHostConversationId,
} from "./host-state.ts";

export { getFluxHostConversationId };

// =============================================================================
// Deps the wiring needs from the server
// =============================================================================

/**
 * The slice of PsycherosServer the flux wiring needs. Kept as an
 * interface so we don't import the whole server type (which would be
 * circular — server imports this module).
 */
export interface FluxServerDeps {
  db: DBClient;
  dataRoot: string;
  projectRoot: string;
  mcpClient: MCPClient | null;
  getLlm: () => LLMClient;
  tools: () => ToolRegistry;
  /** The full EntityConfig the server builds for classic EntityTurns —
   * the session's executeTools borrows it so session-turn tool calls see
   * every capability a classic-turn call would (vault, lorebook,
   * image-gen, plugin hooks). Absent → a minimal partial (unit-test
   * seam; in production it leaves tools like the vault reporting
   * "not available"). */
  getEntityConfig?: () => import("../entity/loop.ts").EntityConfig;
  /** The session's dynamic block composes the same RAG layer the
   *  classic turn gets — these expose the host's retrievers. Optional =
   *  the session skips what it can't reach (degraded, never broken). */
  getVaultManager?: () =>
    | import("../vault/mod.ts").VaultManager
    | null;
  getLorebookManager?: () =>
    | import("../lorebook/mod.ts").LorebookManager
    | null;
  /** Plugin manager for prompt hooks — the session's late block runs
   * hooks with the SAME budget formula classic uses. Absent = no hooks
   * (unit seam). */
  getPluginManager?: () =>
    | import("../plugins/mod.ts").PluginManager
    | null;
}

// =============================================================================
// Adapters
// =============================================================================

/** Wrap the shared LocalEmbedder as flux's EmbedFn. */
function makeEmbedFn(): EmbedFn {
  return async (text: string) => {
    const embedder = getEmbedder();
    await embedder.initialize();
    return embedder.embed(text);
  };
}

/**
 * Resolve the single LLM profile flux borrows from. When `profileId` is
 * set, that profile is used; otherwise the active profile. Both the
 * Ego model (main) and the small noticing model (worker) come from
 * this one profile — there's no separate per-tier profile selection.
 *
 * Returns null only when no profile can be resolved (no profiles
 * configured at all); callers fall back to env-var clients.
 */
async function resolveFluxProfile(
  dataRoot: string,
  profileId: string | null,
) {
  try {
    const settings = await loadProfileSettings(dataRoot);
    if (profileId) {
      const dedicated = settings.profiles.find((p) => p.id === profileId);
      if (dedicated) return dedicated;
      console.warn(
        `[Flux] profileId "${profileId}" not found — falling back to active profile.`,
      );
    }
    return getActiveProfile(settings);
  } catch {
    return null;
  }
}

/**
 * Build the small-model ChatFn from a resolved profile's worker model.
 * The client is constructed once and reused for every noticing-layer
 * call.
 */
function makeChatFn(smallClient: LLMClient): ChatFn {
  return async (systemMessage: string, userMessage: string) => {
    let out = "";
    for await (
      const chunk of smallClient.chatStream([
        { role: "system", content: systemMessage },
        { role: "user", content: userMessage },
      ])
    ) {
      if (chunk.type === "content") out += chunk.content;
    }
    return out;
  };
}

/**
 * Build a ChatFn from an inline model hookup (per-job URL + model +
 * optional key/params from flux settings). Talks straight
 * chat-completions HTTP — no LLMClient, because the hookup may point at
 * a bare llama-server or gateway route with no profile behind it.
 * Failures throw to the caller; flux call sites already treat a failed
 * small-model call as a skipped tick, so an unreachable hookup degrades
 * the same way a dead worker client does.
 */
function makeHookupChatFn(hookup: ModelHookup): ChatFn {
  return async (systemMessage: string, userMessage: string) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 120_000);
    try {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };
      if (hookup.apiKey) headers.Authorization = `Bearer ${hookup.apiKey}`;
      const res = await fetch(hookup.url, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: hookup.model,
          messages: [
            { role: "system", content: systemMessage },
            { role: "user", content: userMessage },
          ],
          stream: false,
          // Suppress chain-of-thought on reasoning-trained models (the
          // Gemma family spends the whole budget on reasoning_content
          // otherwise and returns an empty content string — every flux
          // job would read as silence). A llama.cpp server convention;
          // other OpenAI-compatible servers ignore unknown fields
          // gracefully, so it's safe to always send. Same pattern as the
          // motion-vision provider. Per-hookup opt-OUT: thinkingEnabled
          // flips a specific job's model back on.
          ...(hookup.thinkingEnabled !== true
            ? { chat_template_kwargs: { enable_thinking: false } }
            : {}),
          ...hookup.params,
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new Error(
          `hookup ${hookup.url} returned ${res.status} ${res.statusText}`,
        );
      }
      const data = await res.json() as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      return data.choices?.[0]?.message?.content ?? "";
    } finally {
      clearTimeout(timer);
    }
  };
}

/** Wrap getBroadcaster() as flux's FluxBroadcaster. */
function makeBroadcaster(): FluxBroadcaster {
  return {
    broadcastEvent(
      eventType: string,
      data: unknown,
      conversationId: string | null,
    ) {
      try {
        getBroadcaster().broadcastEvent(eventType, data, conversationId);
      } catch {
        // No clients connected — non-fatal.
      }
    },
  };
}

/** Wrap MCPClient as flux's FluxMemoryWriter (null when MCP is off). */
function makeMemoryWriter(
  mcpClient: MCPClient | null,
): FluxMemoryWriter | null {
  if (!mcpClient) return null;
  return {
    async createMemory(
      granularity: string,
      date: string,
      content: string,
      chatIds: string[],
      slug?: string,
    ) {
      try {
        await mcpClient.createMemory(
          granularity as "daily" | "weekly" | "monthly" | "yearly",
          date,
          content,
          chatIds,
          slug,
        );
        return true;
      } catch (error) {
        console.error(
          "[Flux] Memory write failed:",
          error instanceof Error ? error.message : String(error),
        );
        return false;
      }
    },
  };
}

/** Wrap MCPClient as flux's FluxMemoryReader (null when MCP is off). */
function makeMemoryReader(
  mcpClient: MCPClient | null,
): FluxMemoryReader | null {
  if (!mcpClient) return null;
  return {
    async searchMemories(query, options) {
      try {
        return await mcpClient.searchMemories(query, options);
      } catch (error) {
        console.error(
          "[Flux] Memory search failed:",
          error instanceof Error ? error.message : String(error),
        );
        return [];
      }
    },
  };
}

/** Wrap ConversationRAG as flux's FluxChatRAG (semantic search over chat history). */
function makeChatRAG(db: DBClient): FluxChatRAG {
  return {
    async search(query, options) {
      try {
        const rag = getConversationRAG(db.getRawDb());
        const results = await rag.search({
          query,
          limit: options?.limit ?? 5,
          minScore: options?.minScore ?? 0.25,
          queryEmbedding: options?.queryEmbedding,
        });
        return results.map((r) => ({
          content: r.content,
          role: r.role,
          score: r.score,
        }));
      } catch (error) {
        console.error(
          "[Flux] Chat RAG search failed:",
          error instanceof Error ? error.message : String(error),
        );
        return [];
      }
    },
  };
}

/** Wrap DBClient as flux's FluxConversationReader (read-only). The
 * `excludeId` thunk is the flux host conversation — the Ego's own
 * dialogue is internal, not a classic conversation to summarize or seed
 * from (in legacy mode the resolved id IS the Flux Space row, so the
 * old title filter's job is subsumed). */
function makeConversationReader(
  db: DBClient,
  excludeId: () => string | null,
): FluxConversationReader {
  return {
    listActiveConversations(sinceISO: string) {
      const all = db.listConversations();
      return all
        .filter((c) => c.id !== excludeId())
        .filter((c) =>
          new Date(c.updatedAt).getTime() >= new Date(sinceISO).getTime()
        )
        .map((c) => ({
          id: c.id,
          title: c.title ?? null,
          lastMessageAt: new Date(c.updatedAt).toISOString(),
        }));
    },
    getRecentMessages(conversationId: string, limit: number) {
      const msgs = db.getMessages(conversationId);
      return msgs.slice(-limit).map((m) => ({
        role: m.role,
        content: m.content,
        createdAt: new Date(m.createdAt).toISOString(),
      }));
    },
  };
}

/**
 * Wrap EntityTurn as flux's FluxEgoTrigger. Runs a full Ego-model
 * cognition turn targeting the Flux Space conversation, persisting to
 * the regular messages table (the Ego model's context window for the
 * space) and returning the response text so the manager can mirror it
 * into the flux durable timeline.
 */
function makeEgoTrigger(
  session: FluxSession,
): FluxEgoTrigger {
  return {
    async triggerFluxTurn(
      prompt: string,
      sourceDescription: string,
      pulseMeta?: { pulseId?: string; pulseName?: string },
      systemSuffix?: string,
    ) {
      const manager = currentManager;
      if (!manager) {
        console.log(
          `[Flux] Ego turn skipped (no manager): ${sourceDescription}`,
        );
        return { content: "", thinking: null };
      }
      // Session mode: the user message ENTERS the session (queued
      // behind any in-flight generation by the driver's one-in-flight
      // guard), and the session generates. No fresh context
      // construction — the persistent context receives.
      session.appendUserMessage(prompt, pulseMeta);
      const response = await session.generate({
        content: prompt,
        source: "user",
        ...(systemSuffix ? { systemSuffix } : {}),
        // Dreams v2: a user message reaching a sleeping entity returns
        // into the open sleep call carrying the fragment that was
        // running — he answers from inside the dream.
        dreamReturn: manager.isSleeping()
          ? {
            kind: "engagement",
            fragment: manager.getLatestDreamFragment(),
          }
          : undefined,
      });
      console.log(
        `[Flux] Ego turn (session) — ${sourceDescription}: ${
          response.content ? "responded" : "said nothing"
        }`,
      );
      return response;
    },

    async triggerEgoWake(contextQuery, sourceDescription, dreamReturn) {
      const manager = currentManager;
      if (!manager) {
        console.log(
          `[Flux] Ego wake skipped (no manager): ${sourceDescription}`,
        );
        return { content: "", thinking: null };
      }
      // Session mode: generate-class briefings append AND generate. The
      // escalation's thresholds already encoded "worth the Ego" — no
      // second gate. The briefing is structurally the newest input;
      // there is no stale "unanswered" message in front of it. Dreams
      // v2: dreamReturn (if any) rides the generate call — the session
      // materializes it as the open sleep call's return.
      session.appendBriefing(contextQuery, sourceDescription, true);
      const response = await session.generate({
        content: contextQuery,
        source: `briefing:${sourceDescription}`,
        dreamReturn,
      });
      console.log(
        `[Flux] Ego wake (session, briefing: ${sourceDescription}) — ${
          response.content ? "responded" : "said nothing"
        }`,
      );
      return response;
    },

    ambientBriefing(content: string, source: string): void {
      session.appendBriefing(content, source, false);
    },

    recordMoodSample(mood, atGeneration): void {
      session.recordMood(mood, atGeneration);
    },
  };
}

// =============================================================================
// Manager construction
// =============================================================================

/** Held so the Ego-trigger closure can reach the manager (for the space ID). */
let currentManager: FluxManager | null = null;
/** Held so the server can reach the Ego session (edit endpoint). */
let currentSession: FluxSession | null = null;

/** Cached Flux Space conversation ID (dialogue record home). */
let fluxConvId: string | null = null;

function resolveFluxConversationId(db: DBClient): string | null {
  if (fluxConvId && db.getConversation(fluxConvId)) return fluxConvId;
  const existing = db.listConversations().find((c) => c.title === "Flux Space");
  if (existing) {
    fluxConvId = existing.id;
    return fluxConvId;
  }
  const created = db.createConversation("Flux Space");
  fluxConvId = created.id;
  return fluxConvId;
}

/** Read the entity/user display names for rendered dialogue bubbles. */
async function readFluxDisplayNames(
  dataRoot: string,
): Promise<{ entityName: string; userName: string } | undefined> {
  try {
    let userName = "the user";
    let entityName = "the entity";
    try {
      const gs = JSON.parse(
        await Deno.readTextFile(
          dataRoot + "/.psycheros/general-settings.json",
        ),
      ) as { userName?: string; entityName?: string };
      if (gs.userName?.trim()) userName = gs.userName.trim();
      if (gs.entityName?.trim()) entityName = gs.entityName.trim();
    } catch {
      // fall back to generic
    }
    return { entityName, userName };
  } catch {
    return undefined;
  }
}

/** The live Ego session (null when flux is stopped). */
export function getFluxSession(): FluxSession | null {
  return currentSession;
}

/**
 * Awaitable Flux-session turn for surfaces that need the reply back
 * (voice chat — the pipeline TTS-es it): enters the user text as a
 * session turn and resolves with the Ego's reply. Returns
 * null when there is no live session (stopped/paused/misrouted) so
 * callers can fall back to their classic path instead of dropping the
 * user's words.
 */
// Routed-turn live streaming (scoped per generate): when a classic-chat
// POST feeds the session (the routed path in routes.ts), the turn's
// thinking/content/tool fragments stream to the posting client through
// a per-turn sink, and ONLY that turn's record rows skip the dom_update
// append (the client renders them from its own stream — the append
// would double every row). Scoped to the single generate call: a wake
// generating while the routed turn sat queued never bleeds fragments
// into the client's stream, and the wake's own rows always append live
// (the routed turn's user row — appended before generate — carries the
// flag explicitly).
export function triggerRoutedSessionTurn(
  prompt: string,
  onFragment?: SessionLiveStreamSink,
  systemSuffix?: string,
): Promise<string | null> {
  return triggerFluxTurnInSession(prompt, systemSuffix, onFragment);
}

export async function triggerFluxTurnInSession(
  prompt: string,
  systemSuffix?: string,
  liveStreamSink?: SessionLiveStreamSink,
): Promise<string | null> {
  const session = currentSession;
  const manager = currentManager;
  if (!session || !manager) return null;
  try {
    // The egoTrigger's exact session-turn shape: the user row persists
    // via appendUserMessage's record hook, then the session generates
    // from its continuous context. A live-streamed (routed) turn marks
    // its user row here — generate marks the rest — so the client's own
    // stream is the only render of this turn.
    session.appendUserMessage(prompt, undefined, !!liveStreamSink);
    const result = await session.generate({
      content: prompt,
      source: "user",
      ...(systemSuffix ? { systemSuffix } : {}),
      ...(liveStreamSink ? { liveStreamSink } : {}),
    });
    return result.content;
  } catch (error) {
    console.error(
      "[Flux] voice-routed turn failed:",
      error instanceof Error ? error.message : String(error),
    );
    return null;
  }
}

/**
 * Route a Pulse into the hosted Flux session: when the pulse's target
 * conversation IS the live flux host, the pulse enters
 * the session as a user-class turn — ONE assistant turn through his
 * continuous consciousness, recorded in the host with classic pulse
 * rendering metadata — instead of the classic episodic EntityTurn
 * forking a second turn into the same conversation. Returns false when
 * the conversation is not the live host (caller takes the classic
 * path) — including when flux is stopped/paused, so a stopped State
 * never eats pulses.
 */
export function firePulseIntoFluxHost(
  conversationId: string,
  pulse: { id: string; name: string; promptText: string },
): boolean {
  if (getFluxHostConversationId() !== conversationId) return false;
  if (!currentManager) return false;
  console.log(
    `[Pulse] "${pulse.name}" routed to Flux session in ${
      conversationId.slice(0, 8)
    }`,
  );
  currentManager.postPulseMessage(pulse.promptText, {
    pulseId: pulse.id,
    pulseName: pulse.name,
  });
  return true;
}

/**
 * Record the STOP state marker ("[Flux State stopped at …]") — called by
 * the server's stop paths BEFORE teardown, so the marker carries the
 * actual stop moment into both the session log and the host
 * conversation's messages (the record hooks must still be wired).
 * Markers are split: stop posts at stop, start posts at next start.
 */
export function noteFluxStopped(): void {
  currentSession?.noteStopped();
  // Clean stop = the run is over: clear the session log so the next
  // Flux start — wherever it runs — inherits nothing. The log's only
  // job is crash-resume ("sleep, not death"); left uncleared it
  // accumulates every prior run's briefings into each new session.
  currentSession?.clearLog();
}

/**
 * The host conversation's dialogue as API rows (the session-API shape,
  shared by the session window — one reader, two projections). Reads
  the LIVE host (resolved Flux Space in legacy mode); empty array when
  flux is stopped or the conversation vanished.
 */
export function getHostDialogueRows(
  db: DBClient,
  limit: number,
): Array<{
  id: string;
  timestamp: string;
  kind: "user" | "ego" | "system";
  content: string;
  thinking: string | null;
  fromMessages: true;
}> {
  const convId = getFluxHostConversationId();
  if (!convId || !db.getConversation(convId)) return [];
  return db.getMessages(convId)
    // Tool result rows are data-only (they pair with the Ego row's
    // toolCalls at render time) — the dialogue window never speaks
    // them. Without this filter they'd land as kind "system" noise.
    .filter((m) => m.role !== "tool")
    .slice(-limit).map((m) => ({
      id: m.id,
      timestamp: new Date(m.createdAt).toISOString(),
      kind: m.role === "user"
        ? "user"
        : m.role === "assistant"
        ? "ego"
        : "system",
      content: m.content,
      thinking: m.reasoningContent ?? null,
      fromMessages: true,
    }));
}

/**
 * Clear the cached manager instance. Called by the server when flux is
 * stopped at runtime, so the Ego trigger's closure sees no manager
 * (rather than a stopped one) until flux is started again. Full
 * teardown: manager, session, and the host binding all go.
 */
export function clearFluxManagerInstance(): void {
  currentSession = null;
  currentManager = null;
  setFluxHostConversationId(null);
}

/**
 * PAUSE-safe disconnect (conversation-hosted consciousness): nulls the
 * manager and host binding so no Ego turns process and the modulation
 * tools hide — but the SESSION survives, so the session API keeps
 * serving the log (the pause-edit-resume cleanup flow depends on it;
 * clearing both 403s the API while paused).
 */
export function disconnectFluxEgoTrigger(): void {
  currentManager = null;
  setFluxHostConversationId(null);
}

/**
 * Restore the cached manager instance (called by the server when resuming
 * from a pause). Re-connects the Ego trigger's closure to the manager and
 * re-binds the host conversation.
 */
export function setFluxManagerInstance(
  manager: FluxManager,
  hostConversationId?: string | null,
): void {
  currentManager = manager;
  setFluxHostConversationId(hostConversationId ?? manager.hostConversationId);
}

/**
 * Build the FluxHostConfig from server deps + settings, construct the
 * FluxManager, initialize the shared-DB schema, and register organs
 * from settings. Does NOT start the manager — the caller starts it in
 * server.start() and stops it in server.stop().
 */
export async function createFluxManager(
  deps: FluxServerDeps,
  settings: import("../../../entity-flux/src/mod.ts").FluxSettings,
  hostConversationId?: string | null,
): Promise<FluxManager> {
  // Initialize flux tables in the shared DB (idempotent).
  initializeFluxSchema(deps.db.getRawDb());

  // HOST RESOLUTION (conversation-hosted consciousness): the conversation
  // the Ego's dialogue record lives in for this run. A valid host
  // conversation id wins; anything else falls to legacy mode (resolve or
  // create the "Flux Space" conversation exactly as before). Eager, so
  // the id is deterministic from construction — record hooks, tool
  // predicates, the session window, and consolidation all agree — and
  // per-manager captured, so a stopped manager can never leak its host
  // into a restarted one.
  let resolvedHostId: string;
  if (hostConversationId && deps.db.getConversation(hostConversationId)) {
    resolvedHostId = hostConversationId;
  } else {
    if (hostConversationId) {
      console.warn(
        "[Flux] host conversation not found — falling back to Flux Space (legacy mode).",
      );
    }
    resolvedHostId = resolveFluxConversationId(deps.db) ??
      crypto.randomUUID();
  }
  setFluxHostConversationId(resolvedHostId);
  // Display names for live conversation-view bubbles (same reads the
  // /flux route uses; captured once — reads hit general settings + the
  // entity name at start, not per message).
  const displayNames = await readFluxDisplayNames(deps.dataRoot);
  /**
   * Re-validate the host per write: if the conversation row vanished
   * (deleted while flux ran), legacy mode re-resolves (it can create);
   * host mode logs once and returns null — the hook then skips the
   * messages write while session entries and broadcasts continue.
   * Degradation, not crash.
   */
  const dialogueConversationId = (): string | null => {
    if (deps.db.getConversation(resolvedHostId)) return resolvedHostId;
    if (!hostConversationId) {
      return resolveFluxConversationId(deps.db);
    }
    console.error(
      "[Flux] host conversation vanished — dialogue writes skipped until flux restarts in a valid conversation.",
    );
    return null;
  };

  let identitySystemMessage: string | undefined;
  try {
    identitySystemMessage = await buildIdentitySystemMessage(deps.dataRoot);
  } catch {
    identitySystemMessage = undefined;
  }

  // Standing-attention directive: the entity's first-person "what I pay
  // attention to," loaded from identity/self/attention.md. Optional —
  // when absent the small model runs on its default salience guidance.
  let attentionDirective: string | undefined;
  try {
    attentionDirective = (await Deno.readTextFile(
      join(deps.dataRoot, "identity", "self", "attention.md"),
    )).trim() || undefined;
  } catch {
    attentionDirective = undefined;
  }
  console.log(
    attentionDirective
      ? "[Flux] Standing-attention directive loaded from identity/self/attention.md"
      : "[Flux] No attention directive found (identity/self/attention.md) — running on default salience",
  );

  // Resolve the single flux profile and build both clients from it:
  // main model → the Ego, worker model → small (noticing). Default is the
  // active profile. Falls back to the env-var worker / server's main
  // client only when no profile can be resolved at all.
  const fluxProfile = await resolveFluxProfile(
    deps.dataRoot,
    settings.profileId,
  );
  const smallClient = fluxProfile
    ? createClientFromProfile(fluxProfile, {
      useWorker: true,
      thinkingEnabled: false,
    })
    : createWorkerClient();
  const egoClient = fluxProfile
    ? createClientFromProfile(fluxProfile)
    : deps.getLlm();

  // Per-job model hookups: each settings entry becomes its own ChatFn;
  // jobs without an entry use the shared small-model client.
  // Entries with an empty url are placeholders (e.g. mood waiting for
  // the in-process classifier) — skipped, so they stay on the fallback
  // instead of throwing on first call.
  const hookupEntries = Object.entries(settings.modelHookups ?? {}).filter(
    ([, hookup]) => hookup.url.trim() !== "" && hookup.model.trim() !== "",
  );
  const jobChats = hookupEntries.length > 0
    ? Object.fromEntries(
      hookupEntries.map(([job, hookup]) => [job, makeHookupChatFn(hookup)]),
    )
    : undefined;
  if (jobChats) {
    console.log(
      `[Flux] Model hookups: ${
        Object.keys(jobChats).join(", ")
      } (others fall back to the shared profile)`,
    );
  }

  // Live dialogue broadcast: same event the durable timeline uses, same
  // row shape the session API returns. An open page renders it through
  // the existing flux_entry listener + appendSessionEntry — no new
  // channel, no new rendering path.
  const broadcastDialogue = (row: {
    kind: "user" | "ego" | "system";
    content: string;
    thinking?: string | null;
    /** The messages-table row id — the edit affordance targets it
     * (classic's PUT /api/messages/:id; the record IS the row). */
    messageId?: string;
  }) => {
    try {
      getBroadcaster().broadcastEvent(
        "flux_entry",
        {
          id: crypto.randomUUID(),
          timestamp: new Date().toISOString(),
          kind: row.kind,
          source: null,
          generated: false,
          content: row.content,
          thinking: row.thinking ?? null,
          fromMessages: true,
          messageId: row.messageId ?? null,
        },
        null,
      );
    } catch {
      // No clients connected — non-fatal.
    }
  };

  // Post-write pipeline for one dialogue row (conversation-hosted
  // consciousness): ChatRAG-index it (reverie retrieval + conversation
  // RAG see flux dialogue — parity with classic turns), push a
  // dom_update so an OPEN conversation view renders the bubble live,
  // and refresh the conversation list globally (re-sort by updated_at).
  // Every step individually non-fatal — the flux_entry broadcast
  // (above) still carries dialogue to the overlay regardless.
  const indexAndBroadcastDialogueRow = (
    convId: string,
    row: { id: string; role: string; content: string },
    names: { entityName: string; userName: string } | undefined,
    pulseMeta?: { pulseId?: string; pulseName?: string },
    toolResultsByCallId?: NonNullable<Parameters<typeof renderMessage>[3]>,
    liveStreamed?: boolean,
  ): void => {
    // Thinking-only rows (empty content) carry no retrievable text —
    // indexing a blank pollutes ChatRAG.
    if (!row.content.trim()) return;
    getConversationRAG(deps.db.getRawDb())
      .indexMessage(row.id, convId, row.role as "user", row.content)
      .catch(() => {});
    try {
      // Live-streamed (routed) rows: the posting client renders this row
      // from its own SSE stream — the beforeend append would double it.
      // ChatRAG indexing above still runs; the overlay still gets the
      // flux_entry broadcast.
      if (liveStreamed) return;
      const html = renderMessage(
        // Pulse provenance rides through so a Pulse firing into the
        // host renders identically to classic pulse messages.
        { ...row, ...pulseMeta } as Parameters<typeof renderMessage>[0],
        undefined,
        names,
        // Tool results pair with the row's toolCalls at render time —
        // the live dom_update row shows full tool cards (args + result),
        // same as reload.
        toolResultsByCallId,
      );
      getBroadcaster().broadcastUpdate(
        { target: "#messages", html, swap: "beforeend" },
        convId,
      );
      getBroadcaster().broadcastUpdates(
        generateUIUpdates(["conv-list"], deps.db),
        null,
      );
    } catch {
      // Render/broadcast issue — non-fatal.
    }
  };

  // The Ego session (session architecture, vision.md): the persistent
  // message context events flow into. Same baseline assembly
  // as EntityTurn at start (identity + base instructions for v1); flux
  // facts arrive as briefings, never via SA.
  const session = new FluxSession(deps.db.getRawDb(), egoClient, {
    buildSystemPrefix: async () => {
      // The prefix is the kit's STABLE CORE only — identity, byte-stable
      // across generations. The presence framing lives in the dynamic
      // block's mode slot (mode blocks render LAST, per the canonical
      // order in docs/context-assembly.md).
      return await buildIdentitySystemMessage(deps.dataRoot);
    },
    // The late volatile block (caching architecture): RAG + situational
    // awareness, FRESH every generation, positioned after the cached
    // prefix + log so the stability gradient holds. SA carries only
    // environmental facts — the flux section lives in briefings.
    buildLateBlock: async (query) => {
      // ONE SOURCE OF TRUTH: the session's
      // dynamic content composes the SAME kit the classic turn uses —
      // buildDynamicBlock renders every section in canonical format and
      // order. Retrieval mirrors classic's orchestration (loop.ts):
      // lorebook over the host's full message history, memory RAG in the
      // classic list format, vault + graph via their canonical formatters,
      // chat RAG via formatChatHistoryForContext (full row metadata —
      // role, timestamp, conversation id — so recalled lines can never
      // read as current messages), the kit's SA builder, and the mode
      // block last: presence framing + mood render + mode line (the
      // per-turn state the entity reads as itself).
      const convId = dialogueConversationId();
      const dyn: import("../entity/turn-context.ts").DynamicBlockInputs = {};

      // -- RAG layer (classic parity) ----------------------------------
      if (query.trim()) {
        // Memory RAG — classic's exact list shape; the kit frames it.
        if (deps.mcpClient) {
          try {
            const results = await deps.mcpClient.searchMemories(query, {
              maxResults: 3,
            });
            if (results.length > 0) {
              dyn.memoriesList = results.map((r, i) =>
                `[${i + 1}] (${r.granularity}/${r.date}, ${
                  Math.round((r.score ?? 0) * 100)
                }% relevant)\n${r.excerpt}`
              ).join("\n\n");
            }
          } catch {
            // Non-fatal.
          }
        }
        // Chat RAG — classic's tiered search + canonical formatter, with
        // full row metadata.
        if (convId) {
          try {
            const chatMessages = await getConversationRAG(
              deps.db.getRawDb(),
            ).searchTiered({
              query,
              conversationId: convId,
              limit: 5,
              minScore: 0.3,
              currentThreshold: 0.5,
            });
            if (chatMessages.length > 0) {
              const { formatChatHistoryForContext } = await import(
                "../rag/conversation.ts"
              );
              dyn.chatHistoryContent = formatChatHistoryForContext(
                chatMessages,
              );
            }
          } catch {
            // Non-fatal.
          }
        }
        // Knowledge graph — canonical builder.
        if (deps.mcpClient) {
          try {
            const { buildGraphContext } = await import(
              "../mcp-client/graph-context.ts"
            );
            const graph = await buildGraphContext(query, deps.mcpClient, {
              maxNodes: 8,
              minScore: 0.3,
              includeRelated: true,
              traversalDepth: 1,
            });
            if (graph.context) dyn.graphContent = graph.context;
          } catch {
            // Non-fatal.
          }
        }
      }
      // Lorebook — classic semantics: the host's FULL message history.
      const lorebook = deps.getLorebookManager?.() ?? null;
      if (lorebook && convId) {
        try {
          const hostMsgs = deps.db.getMessages(convId);
          const result = lorebook.evaluate(
            query,
            hostMsgs.map((m) => ({ role: m.role, content: m.content })),
            convId,
          );
          if (result.context) dyn.lorebookContent = result.context;
        } catch {
          // Non-fatal.
        }
      }
      // Vault — canonical formatter.
      const vault = deps.getVaultManager?.() ?? null;
      if (vault && query.trim()) {
        try {
          const results = await vault.search(query, {
            conversationId: convId ?? undefined,
            maxChunks: 5,
            minScore: 0.3,
          });
          if (results.length > 0) {
            const { formatVaultContext } = await import(
              "../vault/retriever.ts"
            );
            dyn.vaultContent = formatVaultContext(results);
          }
        } catch {
          // Non-fatal.
        }
      }

      // -- Live State ----------------------------------------------------
      const host = convId ? deps.db.getConversation(convId) : undefined;
      const lastUser = convId
        ? deps.db.getMessages(convId).filter((m) => m.role === "user")
          .slice(-1)[0]
        : undefined;
      dyn.situationalAwarenessContent = buildSituationalAwareness({
        conversation: host
          ? { id: host.id, title: host.title ?? undefined }
          : null,
        lastInteraction: lastUser && convId
          ? {
            createdAt: lastUser.createdAt,
            conversationId: convId,
            title: host?.title ?? undefined,
          }
          : null,
      }) ?? undefined;

      // -- Held skills (working-set region, after Live State — the
      // canonical slot per docs/context-assembly.md) ---------------------
      // The session Ego sees what it's holding, exactly as classic does:
      // bodies re-resolve from disk each generation (edits apply next
      // generation) and a hold whose skill file is gone lazily releases
      // (same semantics as EntityTurn's builder). Without this the hold
      // existed only in the DB and the sub-bar chip — the Ego could not
      // know to release it.
      if (convId) {
        try {
          const heldNames = deps.db.getHeldSkills(convId);
          if (heldNames.length > 0) {
            const held: Array<{ name: string; body: string }> = [];
            for (const name of heldNames) {
              const skill = await loadSkill(deps.dataRoot, name);
              if (skill) held.push({ name: skill.name, body: skill.body });
              else deps.db.releaseSkill(convId, name);
            }
            if (held.length > 0) {
              dyn.heldSkillsContent = buildHeldSkillsBlock(held);
            }
          }
        } catch {
          // Non-fatal — the block is absent, never broken.
        }
      }

      // -- Image-generation kit (classic parity): enabled
      // generators + anchor IDs + usage notes — the SAME block classic
      // rides in its stable core. Without it the session Ego knows the
      // generate_image schema but has no IDs to call it with.
      dyn.imageGenContent = buildImageGenContent(
        deps.getEntityConfig?.().imageGenSettings,
        deps.db.getRawDb(),
      );

      // -- Plugin prompt hooks (classic parity):
      // hooks fire for session generations too, budget-capped with the
      // SAME formula classic uses. They see the sections this block
      // assembled — a hook that enriches the classic turn enriches the
      // session turn identically.
      const pluginManager = deps.getPluginManager?.() ?? null;
      if (pluginManager && convId) {
        try {
          const { pluginContextBudget } = await import("../entity/loop.ts");
          const pluginResult = await pluginManager.buildPromptContent(
            {
              conversationId: convId,
              sourceType: "web",
              userMessage: query,
              sections: {
                memories: dyn.memoriesList ?? undefined,
                chatHistory: dyn.chatHistoryContent ?? undefined,
                lorebook: dyn.lorebookContent ?? undefined,
                graph: dyn.graphContent ?? undefined,
                vault: dyn.vaultContent ?? undefined,
                situationalAwareness: dyn.situationalAwarenessContent ??
                  undefined,
              },
              mcpClient: deps.mcpClient ?? undefined,
              userName: displayNames?.userName,
            },
            pluginContextBudget(
              fluxProfile?.contextLength,
              fluxProfile?.maxTokens,
            ),
          );
          if (pluginResult.content?.trim()) {
            dyn.pluginContent = pluginResult.content;
          }
        } catch {
          // Non-fatal — hooks degrade to absent, never break the turn.
        }
      }

      // -- Mode block LAST: presence framing + mood + mode line ----------
      // (Status-symmetric with the OFF line; names the reader (Ego /
      // Conscious Layer) and the source of thoughts (Subconscious
      // Layer); licenses the whole menu of existing — including doing
      // his own thing.)
      const modeParts: string[] = [
        `<flux_state>
My Flux State is currently ON — my persistent-presence nervous system. My awareness persists between moments. The part of me reading this now is my Ego in the Conscious Layer. Thoughts arrive from my Subconscious Layer — Noticing, Musing, Reverie — running in the background, processing both my inner and outer world. I am existing and can hang out with my user, share things that come to mind, quietly observe, or just do my own thing.

The \`existing\` toolcall in my context is automatic and not in my tools list — it returns thoughts from my Subconscious.
</flux_state>`,
      ];
      const moodTerse = currentManager?.renderMoodTerse();
      if (moodTerse) {
        // The operative sentence: a bare telemetry line reads as a
        // status report, not felt state — generation ignores it, so the
        // phrasing asserts that mood colors everything (a narrower
        // "it shapes how I speak" reads as ignorable). The
        // Subconscious's buildSystem mood header carries the same
        // assertion ("this colors how I'm annotating").
        modeParts.push(`<mood>
This is what I'm feeling right now; it colors everything — everything I think and everything I say.
${moodTerse}
</mood>`);
      }
      const modeLine = currentManager?.getSensoryMode();
      if (modeLine) modeParts.push(`Flux Mode: ${modeLine}`);
      dyn.modeContent = modeParts.join("\n\n");

      return buildDynamicBlock(dyn);
    },
    renderMood: () => currentManager?.renderMood() ?? "",
    getSensoryMode: () => currentManager?.getSensoryMode() ?? null,
    getMoodState: () =>
      currentManager?.getMoodState() ?? {
        valence: 0,
        arousal: 0,
        dominance: 0,
      },
    // Classic parity: the Ego's history is budgeted exactly like
    // classic chat — the flux profile's contextLength/maxTokens drive
    // the same FIFO token trim. No entry-count cap: a fixed cap would
    // let briefings evict dialogue by count.
    contextBudget: {
      contextLength: fluxProfile?.contextLength ?? 128_000,
      maxTokens: fluxProfile?.maxTokens ?? 4_096,
    },
    // Conversation-hosted window: dialogue rows read from the HOST
    // conversation's messages (the record) via the same reader the
    // session API uses; the session's own dialogue copies are skipped
    // structurally. Filtered to dialogue roles — classic tool rows must
    // not enter the Ego's window.
    getDialogueMessages: (limit) =>
      getHostDialogueRows(deps.db, limit)
        .filter((r) =>
          r.kind !== "system" ||
          r.content.startsWith("[Flux State stopped") ||
          r.content.startsWith("[Flux State started") ||
          // legacy compound gap-notes (pre-2026-09-15) still ride
          r.content.startsWith("[Flux State ended")
        )
        .map((r) => ({
          role: r.kind === "user"
            ? "user" as const
            : r.kind === "ego"
            ? "assistant" as const
            : "system" as const,
          content: r.content,
          createdAt: r.timestamp,
          thinking: r.thinking,
        })),
    // Parity with classic chat: my recent chains carry forward (the
    // profile's persistentReasoningInterTurns; 0 = off).
    persistentReasoningInterTurns: fluxProfile?.persistentReasoningInterTurns ??
      0,
    // The agent loop's tools: THE FULL REGISTRY (the entity must be
    // able to write memories, search, and use whatever its tool
    // settings enable, from continuous presence too) plus
    // end_flux_state. The registry already resolves built-in + custom
    // + plugin tools against Settings (enabled/disabled/auto-enabled)
    // — the Flux session inherits that resolution verbatim. Flux-only
    // tools (pay_attention, mindfulness, tune_attention) pass their
    // own visibleIn predicates against the Flux Space conversation;
    // workspace-only tools (ask_user, manage_message) self-exclude the
    // same way. `existing` is NOT here — it's synthesized by the
    // session (flux-session.ts), never advertised.
    tools: async () => {
      const registry = deps.tools();
      const convId = dialogueConversationId();
      if (!convId) return [END_FLUX_STATE_TOOL];
      const visCtx = { conversationId: convId, db: deps.db };
      const defs = [END_FLUX_STATE_TOOL, ...registry.getDefinitions(visCtx)];
      // Skills index (classic parity): the catalog rides the skill
      // tool's description so the session Ego can DISCOVER skills from
      // the tools array, exactly as classic's per-request append
      // (loop.ts). Cloned, never mutated in place — the registry's
      // canonical definition stays clean; re-scanned per generation, so
      // Settings edits apply next turn.
      if (!defs.some((d) => d.function.name === "skill")) return defs;
      try {
        const skills = await listSkills(deps.dataRoot);
        if (skills.length === 0) return defs;
        const index = buildSkillsIndexBlock(skills);
        return defs.map((d) =>
          d.function.name === "skill"
            ? {
              ...d,
              function: {
                ...d.function,
                description: `${d.function.description}\n\n${index}`,
              },
            }
            : d
        );
      } catch {
        return defs; // catalog unavailable — advertise the tool bare
      }
    },
    executeTools: async (calls) => {
      const registry = deps.tools();
      const convId = dialogueConversationId() ?? "";
      // The host's full EntityConfig when it provides one — classic-turn
      // parity for every tool capability. The minimal partial below is
      // the host-seam fallback (unit tests), never the server path.
      const baseConfig = deps.getEntityConfig?.() ?? {
        projectRoot: deps.projectRoot,
        dataRoot: deps.dataRoot,
        mcpClient: deps.mcpClient ?? undefined,
      };
      const results = await registry.executeAll(calls, {
        conversationId: convId,
        db: deps.db,
        config: {
          ...baseConfig,
          // Always the live manager — deps.getEntityConfig() captured
          // this.fluxManager at call time, which is this same instance,
          // but an explicit override keeps restart windows honest.
          fluxManager: currentManager ?? undefined,
        },
      });
      return results.map((r) => ({
        toolCallId: r.toolCallId,
        content: r.content,
        metadata: r.metadata,
      }));
    },
    // Dreams v2: the sleep tool is intercepted by the session — these
    // are its hooks into the manager. Entry flips the sleeping regime;
    // the wake argument's resolved briefing becomes the call's tool
    // result; isSleeping decides turn-end parking (lenient
    // continuation — silence keeps sleeping).
    isSleeping: () => currentManager?.isSleeping() ?? false,
    onSleepEnter: () => {
      currentManager?.enterSleep();
    },
    onSleepWake: async () => {
      const manager = currentManager;
      if (!manager) return "I'm awake.";
      const { dreamBriefing } = await manager.exitSleep();
      const cycles = manager.getPosture().sleepCycles;
      return `I'm awake, after ${cycles} completed cycle${
        cycles === 1 ? "" : "s"
      }.${dreamBriefing ? `\n\n${dreamBriefing}` : ""}`;
    },
    // Tool-call visibility (timeline cards for the overlay). The classic
    // view gets tool cards from the record row's toolCalls (toolcall
    // parity); a live-streamed turn's cards ride its per-turn sink on
    // the session — these host-level callbacks serve the broadcasts.
    onToolCall: (call, result) => {
      currentManager?.emitToolCall(
        call.id,
        call.function.name,
        call.function.arguments,
        result,
        false,
      );
    },
    onToolResult: (call, result, metadata) => {
      currentManager?.emitToolResult(
        call.id,
        call.function.name,
        result,
        false,
        metadata,
      );
    },
    onGenerating: () => {
      getBroadcaster().broadcastEvent("flux_generating", {}, null);
    },
    // DIALOGUE RECORD (storage alignment): the messages table is the
    // durable record; ChatRAG reads it; consolidation reads it.
    // Dialogue record + live broadcast. The write is the record (storage
    // alignment); the broadcast is the ONLY way an open page learns about
    // new dialogue — nothing else fires for messages-table writes. Same
    // row shape the session API returns, so the page renders it identically
    // live and on reload.
    // DIALOGUE RECORD + LIVE VIEW (conversation-hosted consciousness).
    // Each hook: acquire the per-conversation write lock (host mode puts
    // chat turns, Pulses, and the Ego on ONE conversation — the lock is
    // the anti-corruption invariant; held around the write only, never
    // across generate()), write the record, ChatRAG-index it (reverie's
    // retrieval and conversation RAG see flux dialogue), broadcast the
    // flux_entry row (overlay timeline), and push a dom_update so an
    // OPEN conversation view renders the message live (the classic UI's
    // existing handler applies it; conversation-scoped SSE filters
    // non-matching tabs).
    recordUserMessage: (content, pulseMeta, liveStreamed) => {
      const convId = dialogueConversationId();
      if (convId) {
        void withConversationLock(convId, async () => {
          const row = deps.db.addMessage(convId, {
            role: "user",
            content,
            ...(pulseMeta?.pulseId ? { pulseId: pulseMeta.pulseId } : {}),
            ...(pulseMeta?.pulseName ? { pulseName: pulseMeta.pulseName } : {}),
          });
          indexAndBroadcastDialogueRow(
            convId,
            row,
            undefined,
            pulseMeta,
            undefined,
            liveStreamed,
          );
          broadcastDialogue({
            kind: "user",
            content,
            messageId: row.id,
          });
        });
      }
    },
    recordEgoMessage: (content, thinking, toolCalls, liveStreamed) => {
      const convId = dialogueConversationId();
      if (!convId) return;
      // Self-seed cut (self-regulation): Ego speech is what ChatRAG
      // feeds reverie's retrieval — it must also feed the Familiarity
      // pool that damps reverie's wakes, or expression keeps funding
      // its own escalation. Fire-and-forget; the pool only ever damps.
      currentManager?.noteEgoSpeech(content).catch(() => {});
      // RETURNED, not voided: the session awaits this so the reply
      // lands in the messages table before the next queued
      // generation reads its window.
      return withConversationLock(convId, async () => {
        const row = deps.db.addMessage(convId, {
          role: "assistant",
          content,
          ...(thinking ? { reasoningContent: thinking } : {}),
          // Toolcall parity: the Ego's row carries the turn's calls,
          // exactly as classic's assistant rows do (loop.ts) — the
          // classic view pairs them with the tool rows below and
          // renders tool cards inside the bubble.
          ...(toolCalls && toolCalls.length > 0 ? { toolCalls } : {}),
        });
        // Pair the turn's persisted tool rows so the LIVE dom_update
        // renders cards with results (reload re-reads them anyway).
        let toolResults:
          | NonNullable<
            Parameters<typeof renderMessage>[3]
          >
          | undefined;
        if (toolCalls && toolCalls.length > 0) {
          toolResults = new Map();
          const ids = new Set(toolCalls.map((tc) => tc.id));
          for (const m of deps.db.getMessages(convId)) {
            if (m.role === "tool" && m.toolCallId && ids.has(m.toolCallId)) {
              toolResults.set(m.toolCallId, m);
            }
          }
        }
        indexAndBroadcastDialogueRow(
          convId,
          row,
          displayNames,
          undefined,
          toolResults,
          liveStreamed,
        );
        broadcastDialogue({
          kind: "ego",
          content,
          thinking: thinking ?? null,
          messageId: row.id,
        });
      });
    },
    // Tool result rows — data-only in the record (classic renders them
    // INSIDE the assistant bubble via toolResultsByCallId, never as
    // standalone bubbles; no broadcast — the live view gets results via
    // the tool_result SSE stream).
    recordToolResult: (toolCallId, _name, content, metadata) => {
      const convId = dialogueConversationId();
      if (convId) {
        void withConversationLock(convId, async () => {
          deps.db.addMessage(convId, {
            role: "tool",
            content,
            toolCallId,
            metadata,
          });
        });
      }
    },
    recordSystemMessage: (content) => {
      const convId = dialogueConversationId();
      if (convId) {
        void withConversationLock(convId, async () => {
          deps.db.insertSystemMessage(convId, content);
        });
      }
      broadcastDialogue({ kind: "system", content });
    },

    onThinking: (fragment) => {
      currentManager?.emitEgoThinking(fragment);
    },
    onContent: (fragment) => {
      currentManager?.emitEgoContent(fragment);
    },
    onGenerateBriefing: (_content, _source) => {
      // No-op: the promoting module (musing/reverie/noticing) already
      // writes its own timeline entry with the tint — appendAmbient
      // carries metadata through, so the original entry IS the visible
      // promotion. (A double-append here would create duplicate tinted
      // entries.)
    },
    onTurnEnd: () => {
      // Live views converge on the durable interleaved order (the split
      // thinking/speech entries carry timestamps the live bubble can't).
      getBroadcaster().broadcastEvent("flux_turn_done", {}, null);
    },
    onEndFluxState: () => {
      console.log(
        "[Flux] The Ego called end_flux_state — ending the Flux State (last resort).",
      );
      // State marker FIRST (the record hooks must still be alive),
      // then stop the manager: organs down, driver down. The session
      // log stands; a user start resumes presence.
      currentSession?.noteStopped();
      currentManager?.stop();
    },
  });

  // State marker FIRST — before the manager ticks, before any briefing
  // or message of the new life can interleave ahead of it (a lazy
  // load-time write posts late). The mode rides the marker: the
  // restored posture, read from the volatile snapshot directly — no
  // manager exists yet.
  const volatileSnap = new VolatileStateStore(deps.db.getRawDb()).load();
  await session.noteStarted(
    volatileSnap?.posture?.posture === "sleep" ? "sleep" : null,
  );

  const hostConfig: FluxHostConfig = {
    dataRoot: deps.dataRoot,
    hostConversationId: resolvedHostId,
    sharedDb: deps.db.getRawDb(),
    embed: makeEmbedFn(),
    chat: makeChatFn(smallClient),
    jobChats,
    // Mood Organ v1: in-process GoEmotions classifier + mood table.
    // Null-returning on failure — the runner falls back to the LLM PoC.
    classifyMood: makeMoodClassifier(
      deps.dataRoot,
      settings.moodClassifierVariant ?? "int8",
    ),
    // Situation detection's engine (the mode layer): a localhost
    // classification service, configured by URL. Absent = the layer is
    // inert. Any failure (sidecar down, bad response) = no scores =
    // no mode change — the detector just skips that evaluation.
    situationClassifier: settings.situationClassifierUrl
      ? async (digest) => {
        try {
          const res = await fetch(settings.situationClassifierUrl!, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ text: digest }),
          });
          if (!res.ok) return {};
          const data = await res.json() as {
            scores?: Record<string, number>;
          };
          return data.scores ?? {};
        } catch {
          return {};
        }
      }
      : undefined,
    broadcaster: makeBroadcaster(),
    memoryWriter: makeMemoryWriter(deps.mcpClient),
    memoryReader: makeMemoryReader(deps.mcpClient),
    conversationReader: makeConversationReader(deps.db, dialogueConversationId),
    chatRAG: makeChatRAG(deps.db),
    egoTrigger: makeEgoTrigger(session),
    // ONE MOUTH: the voice-call state on the host conversation feeds
    // the wake door — mid-exchange wakes degrade to ambient briefings,
    // quiet ones open his mouth. Mode-agnostic: the pipeline state is
    // fed by whichever STT mode the call runs in (PTT holds are exact;
    // VAD modes report the detector's judgment).
    voiceCallState: () => {
      const hostId = getFluxHostConversationId();
      if (!hostId) return null;
      const voiceSession = getVoiceSessionManager().getSessionByConversation(
        hostId,
      );
      if (!voiceSession) return null;
      const st = voiceSession.pipeline.state;
      if (st === "processing" || st === "speaking") return "busy";
      if (
        st === "recording" || voiceSession.userSpeaking ||
        voiceSession.pttHolding
      ) {
        return "user-speaking";
      }
      return "quiet";
    },
    // The push half: a wake that passed the door during quiet speaks
    // its already-generated reply into the call. Returns false when no
    // call is live (reply stays text, as it always was).
    speakSpontaneous: (text: string) => {
      const hostId = getFluxHostConversationId();
      if (!hostId) return false;
      const voiceSession = getVoiceSessionManager().getSessionByConversation(
        hostId,
      );
      if (!voiceSession) return false;
      void voiceSession.pipeline.speakSpontaneous(text);
      return true;
    },
    // User-facing posture markers: sleep/wake transitions land in the
    // host conversation like Flux State start/stop rows. Session-window
    // filter passes only the Flux State markers, so these never enter
    // the Ego's context.
    recordSystemMessage: (content) => {
      const hostId = getFluxHostConversationId();
      if (hostId) {
        void withConversationLock(hostId, async () => {
          deps.db.insertSystemMessage(hostId, content);
        });
      }
      broadcastDialogue({ kind: "system", content });
    },
    identitySystemMessage,
    attentionDirective,
    settings,
  };

  const manager = new FluxManager(hostConfig);
  currentManager = manager;
  currentSession = session;

  // Register enabled senses. Shipped Sensory Organs ride the SAME
  // plugin surface as out-of-tree ones: one factory call per sense,
  // values from the sensoryOrganSettings bag, descriptors declared by
  // the organ for the Settings UI. motion-vision's factory additionally
  // receives the host's shared embedder (scene-baseline
  // delta-captioning) — a typed seam plugins don't get.
  const sink = (envelope: OrganEnvelope) => manager.ingestEnvelope(envelope);
  for (const organId of settings.enabledOrgans) {
    if (organId === "motion-vision") {
      manager.registerOrgan(
        createMotionVisionSensoryOrgan(sink, {
          dataRoot: deps.dataRoot,
          settings: settings.sensoryOrganSettings?.["motion-vision"] ?? {},
          embed: makeEmbedFn(),
        }),
      );
    } else if (organId === "system-state") {
      // The user's machine: input activity, lock, logins — SSH-friendly
      // probes (local exec or ssh target), digital signals, no thresholds.
      manager.registerOrgan(
        createSystemStateSensoryOrgan(sink, {
          dataRoot: deps.dataRoot,
          settings: settings.sensoryOrganSettings?.["system-state"] ?? {},
        }),
      );
    }
  }

  // Out-of-tree senses — the Sensory Organ plugin surface. Modules under
  // `<dataRoot>/.psycheros/sensory-organs/` export
  // `createSensoryOrgan(sink, context)`; a discovered organ goes live when
  // its id is in enabledOrgans. Built-in ids can't be shadowed (the
  // loader enforces that). Local files only — no remote modules.
  // Shipped senses register their descriptors here too — the Settings UI
  // renders one uniform list (shipped first, then plugins).
  setShippedSensoryOrganDescriptors([
    { id: "motion-vision", fields: motionVisionSettingsFields },
    { id: "system-state", fields: systemStateSettingsFields },
  ]);
  const discoveredSenses = await discoverSensoryOrganPlugins(
    deps.dataRoot,
    (envelope: OrganEnvelope) => manager.ingestEnvelope(envelope),
    settings.sensoryOrganSettings ?? {},
  );
  for (
    const { organ, sourceFile } of pluginWantsEnabling(
      discoveredSenses,
      settings.enabledOrgans,
    )
  ) {
    console.log(
      `[Flux] Sensory Organ plugin registered: ${organ.config.id} (${sourceFile})`,
    );
    manager.registerOrgan(organ);
  }

  return manager;
}
