/**
 * Host-capability interfaces — the second DI seam.
 *
 * `runtime.ts` defines function-injection for the embedder and chat
 * client. This file defines interface-injection for the broader host
 * capabilities flux needs: broadcasting live UI events, writing durable
 * memories via entity-core, reading classic conversations (for
 * thoughtstream summaries), and triggering Ego-model turns.
 *
 * Psycheros provides concrete implementations by wrapping its existing
 * `getBroadcaster()`, `MCPClient`, `DBClient`, and `EntityTurn`. The seam
 * exists for explicit wiring and unit tests that run without psycheros's
 * server/DB — flux is a Psycheros subsystem, not a host-agnostic library.
 * TypeScript structural typing makes the wrap a one-liner per capability.
 */

import type { Database } from "@db/sqlite";
import type { FluxModelJob, FluxSettings } from "./settings.ts";
import type { ChatFn, ClassifyMoodFn, EmbedFn } from "./runtime.ts";
import type { SituationClassifier } from "./situation.ts";

// =============================================================================
// Individual capabilities
// =============================================================================

/**
 * Broadcasts live events to connected clients (SSE). Used for the toast
 * notification (flux wants attention while the user is elsewhere) and
 * for streaming new Flux Space entries to the open timeline view.
 * `conversationId` null = global broadcast.
 */
export interface FluxBroadcaster {
  broadcastEvent(
    eventType: string,
    data: unknown,
    conversationId: string | null,
  ): void;
}

/**
 * Writes durable memories to the canonical store (entity-core via MCP).
 * Used by the consolidation pass. `granularity` is "daily" | "weekly" |
 * "monthly" | "yearly". Returns true on success.
 */
export interface FluxMemoryWriter {
  createMemory(
    granularity: string,
    date: string,
    content: string,
    chatIds: string[],
    slug?: string,
  ): Promise<boolean>;
}

/**
 * Reads classic conversations for thoughtstream summaries. Flux pulls
 * from classic conversations read-only — it never mutates them.
 */
export interface FluxConversationReader {
  /** Conversations with activity since `sinceISO`. */
  listActiveConversations(
    sinceISO: string,
  ): Array<{
    id: string;
    title: string | null;
    lastMessageAt: string;
  }>;
  /** Recent messages from a conversation, oldest-first. */
  getRecentMessages(
    conversationId: string,
    limit: number,
  ): Array<{ role: string; content: string; createdAt: string }>;
}

/**
 * Triggers an Ego-model cognition turn targeting the Flux Space.
 * Returns the entity's response text. The host implements this by
 * constructing an EntityTurn aimed at the flux conversation, with the
 * flux state injected into context. Used when the promotion filter
 * escalates or when a user message arrives in the Flux Space.
 */
/**
 * Dream material riding a wake while the entity sleeps: the session
 * materializes the open sleep call's return
 * from it. A light moment carries the whole completed cycle's dream;
 * an engagement carries the latest fragment ("I was dreaming: …").
 */
/**
 * One Ego generation's output: the spoken/visible reply plus the
 * reasoning trace when the model produced one. The Mood Organ reads
 * the THINKING when present — the interior, not the performance.
 */
export type EgoUtterance = {
  content: string;
  thinking: string | null;
};

export type DreamReturn =
  | { kind: "light-moment"; fragments: string[]; cycles: number }
  | { kind: "engagement"; fragment: string | null };

export interface FluxEgoTrigger {
  /**
   * User-initiated Ego turn — the user message enters the Ego's
   * session (the persistent context) and the session generates.
   */
  triggerFluxTurn(
    prompt: string,
    sourceDescription: string,
    /** Optional pulse provenance for the persisted user row (classic
     * pulse rendering parity when a Pulse fires into the hosted
     * session). */
    pulseMeta?: { pulseId?: string; pulseName?: string },
    /** Ephemeral per-turn system framing (voice-mode brevity) —
     *  appended to this generation's late block only. */
    systemSuffix?: string,
  ): Promise<EgoUtterance>;

  /**
   * Self-initiated Ego wake — a generate-class briefing (escalation,
   * proposal, initiative) appends into the session and the session
   * generates. The briefing is structurally the newest input. While the
   * entity sleeps, `dreamReturn` carries the dream material the session
   * materializes as the open sleep call's return.
   */
  triggerEgoWake(
    contextQuery: string,
    sourceDescription: string,
    dreamReturn?: DreamReturn,
  ): Promise<EgoUtterance>;

  /**
   * Ambient briefing — Subconscious context worth remembering but not
   * worth waking for (promoted timeline entries, textures). Appends to
   * the session; never invokes the model.
   */
  ambientBriefing(content: string, source: string): void;

  /**
   * Record a mood sample in the ledger (the queryable history, separate
   * from generation).
   */
  recordMoodSample(
    mood: {
      valence: number;
      arousal: number;
      dominance: number;
    },
    atGeneration: boolean,
  ): void;
}

/**
 * Reads durable memories from the canonical store (entity-core via MCP).
 * Used by reverie's mood-directed retrieval — searching for memories that
 * resonate with the current mood/activity state. When `queryEmbedding` is
 * provided, the search uses the pre-computed vector for semantic matching
 * (skipping internal re-embedding). The text `query` is still passed for
 * keyword matching as a secondary signal.
 */
export interface FluxMemoryReader {
  searchMemories(
    query: string,
    options?: {
      minScore?: number;
      maxResults?: number;
      queryEmbedding?: number[];
    },
  ): Promise<
    Array<{
      granularity: string;
      date: string;
      score: number;
      excerpt: string;
    }>
  >;
}

/**
 * Semantic search over classic conversation history (chat RAG). Used by
 * reverie to find past conversation turns that resonate with the current
 * mood/activity state. Same embedding space as everything else
 * (all-MiniLM-L6-v2, 384-dim), so `queryEmbedding` is directly compatible.
 */
export interface FluxChatRAG {
  search(
    query: string,
    options?: {
      limit?: number;
      minScore?: number;
      queryEmbedding?: number[];
    },
  ): Promise<
    Array<{
      content: string;
      role: string;
      score: number;
    }>
  >;
}

// =============================================================================
// Bundle
// =============================================================================

/**
 * All host-injected capabilities the FluxManager needs, plus the
 * settings and the shared-DB handle (for tier-2 tables). The host
 * constructs this during server init when flux is enabled.
 */
export interface FluxHostConfig {
  /** Path under which `.psycheros/flux-working.db` lives. */
  dataRoot: string;
  /** USER-FACING posture markers: write a
   *  system row into the host conversation when sleep begins/ends —
   *  the classic UI shows the transitions the way it shows Flux State
   *  start/stop. NOT entity-visible: the session window's system-row
   *  filter passes only the Flux State markers, so these rows never
   *  enter the Ego's context (the entity experiences the posture
   *  directly; the markers are for the user). */
  recordSystemMessage?: (content: string) => void;
  /**
   * The conversation the Ego's dialogue record lives in — the host
   * conversation Flux was started from, or null in legacy mode (dialogue in
   * the resolved "Flux Space" conversation). Always a real
   * conversation row id from the host. Used for the consolidation
   * dialogue read and memory chatIds; the persisted flux-space
   * linkage id remains the fallback.
   */
  hostConversationId?: string | null;
  /** Shared psycheros.db handle, for tier-2 tables (via getRawDb). */
  sharedDb: Database;
  /** Embedding function (wraps the shared LocalEmbedder). */
  embed: EmbedFn;
  /** Small-model chat function (wraps the worker LLM client). */
  chat: ChatFn;
  /** Live-event broadcaster (wraps getBroadcaster). */
  broadcaster: FluxBroadcaster;
  /** Durable-memory writer (wraps MCPClient.createMemory). */
  memoryWriter: FluxMemoryWriter | null;
  /** Durable-memory reader (wraps MCPClient.searchMemories). Null when MCP off. */
  memoryReader: FluxMemoryReader | null;
  /** Classic-conversation reader (wraps DBClient). */
  conversationReader: FluxConversationReader | null;
  /** Chat-history semantic search (wraps ConversationRAG). */
  chatRAG: FluxChatRAG | null;
  /** Ego model turn trigger (wraps EntityTurn). */
  egoTrigger: FluxEgoTrigger | null;
  /**
   * Situation detection's classifier: prose digest in, scores over
   * configured mode names out. The shipped engine
   * is a frozen encoder + trained head (ONNX, CPU); absent = situation
   * detection is inert (never runs, costs nothing).
   */
  situationClassifier?: SituationClassifier;
  /**
   * Optional first-person identity system message (from the host's
   * buildIdentitySystemMessage). Prepended to thoughtstream and
   * consolidation prompts so summaries stay in-entity voice. When
   * omitted, prompts are self-contained.
   */
  identitySystemMessage?: string;
  /**
   * Optional first-person "standing attention" directive — the entity's
   * living note to itself about what deserves its attention (a kind of
   * mindfulness). Loaded from `identity/self/attention.md` by the host.
   * Prepended to the small noticing model's system prompt so it shapes
   * what the model flags as salient. Authored by the entity (and user),
   * in first person; synced via entity-core like any identity file.
   */
  attentionDirective?: string;
  /**
   * Per-job model hookups, already resolved into ChatFns by the host
   * (the host reads `settings.modelHookups` and builds one ChatFn per
   * entry — see `makeHookupChatFn` in psycheros's flux wiring). Jobs
   * without an entry fall back to the shared `chat`. Undefined when no
   * hookups are configured — identical to pre-hookup behavior.
   */
  jobChats?: Partial<Record<FluxModelJob, ChatFn>>;
  /**
   * The Mood Organ's specialist classifier — in-process, deterministic,
   * no ChatFn. When present, mood classification uses it and the LLM
   * PoC becomes the fallback; when absent, the PoC still runs (the
   * migration is per-installation). v1: GoEmotions + mood table.
   */
  classifyMood?: ClassifyMoodFn;
  /**
   * The voice-call state on the Flux host conversation:
   * "quiet" = call open, nobody speaking, nothing in
   * flight — the wake door may open his mouth; "user-speaking" = the
   * user is talking (or holding push-to-talk); "busy" = a turn is
   * generating or his TTS is playing; null = no call — the door runs
   * as it always has. The wake door holds mid-exchange wakes as
   * ambient briefings: the Ego is already conscious and talking, so
   * nothing needs waking — the trigger rides his context and he
   * weaves it into his next spoken turn by choice.
   */
  voiceCallState?: () => "quiet" | "user-speaking" | "busy" | null;
  /**
   * Speak a spontaneous Ego reply into the active voice call on the
   * host conversation — the door passed during quiet, so his mouth
   * opens unprompted (the walk-with-a-camera magic). The reply is
   * already generated; the host TTS-es and pushes it to the call.
   * Returns true when a call took it, false when no call is active.
   */
  speakSpontaneous?: (text: string) => boolean;
  /** Flux settings. */
  settings: FluxSettings;
}
