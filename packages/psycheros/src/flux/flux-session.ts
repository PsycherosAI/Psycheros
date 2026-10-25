/**
 * FluxSession — the Ego's continuous mode (the session architecture,
 * vision.md).
 *
 * A single persistent message context that events flow INTO, instead of
 * context being reconstructed around each event (the episodic EntityTurn
 * pattern). Briefings append as they occur; user messages arrive as
 * inputs like briefings; the Ego generates when a generate-class event
 * (escalation, proposal, initiative, user message) arrives, and the
 * rolling window carries everything else.
 *
 * The session survives daemon restarts: the message log persists to the
 * shared flux DB, and resumption injects a gap-note — the entity
 * experiences sleep, not death.
 *
 * System-message assembly: at session START the same baseline assembly
 * EntityTurn uses (identity files, RAG, SA-minus-flux) is built once and
 * becomes the session's stable prefix. Flux facts never enter SA here —
 * they arrive as briefings in the log.
 *
 * Mood: on-generation snapshot. Mood is never a session message; the
 * current render injects into each generation call at generation time.
 * The mood LEDGER (separate) records history for later correlation.
 */

import type { Database } from "@db/sqlite";
import type { LLMClient } from "../llm/mod.ts";
import type { ChatMessage } from "../llm/types.ts";
import type { ToolCall, ToolDefinition } from "../types.ts";

/** A host-executed tool result. `metadata` carries tool sidecars —
 * generate_image's image — so the record row and the live view can
 * render them (classic parity). */
/** Per-turn live-stream sink (routed classic-chat turns): fragments of
 * exactly ONE generation, forwarded as they stream. Scoped to the
 * generate call that carries it — a wake generating while the routed
 * turn sat queued can never bleed into the posting client's stream. */
export type SessionLiveStreamSink = (
  kind: "thinking" | "content" | "tool_call" | "tool_result",
  fragment: string,
) => void;

export interface SessionToolResult {
  toolCallId: string;
  content: string;
  metadata?: import("../types.ts").ToolResult["metadata"];
}
import { formatMessageTimestamp } from "../entity/loop.ts";
import { runAgentLoop } from "../entity/turn-core.ts";
import { applyContextBudget } from "../entity/token-budget.ts";
import { stripTTag } from "../voice/pronunciation.ts";

// =============================================================================
// Types
// =============================================================================

/** What kind of entry a session row is. */
export type SessionEntryKind =
  | "user" // a real user message
  | "ego" // the Ego's generated output (with thinking attached)
  | "briefing" // Subconscious-sourced context (generate- or ambient-class)
  | "tool_use" // a tool the Ego called (existing, modulation, …) — visible
  | "tool_result" // what a called tool returned — id `<callId>-result`,
  // paired to its tool_use entry for one-card rendering
  | "system"; // gap-notes and similar structural marks

/** One persisted session row. */
export interface SessionEntry {
  id: string;
  /** ISO timestamp. */
  timestamp: string;
  kind: SessionEntryKind;
  /** For briefings: which module sent it (e.g. "musing", "noticing"). */
  source?: string;
  /** Whether this briefing was generate-class (invoked the Ego). */
  generated?: boolean;
  content: string;
  /** The Ego's thinking for this output (ego entries only; null else). */
  thinking?: string | null;
}

/** Ledger row — one mood sample. */
export interface MoodLedgerRow {
  timestamp: string;
  /** DB column predates the valence rename. */
  pleasure: number;
  arousal: number;
  dominance: number;
  connection: number;
  /** True when this sample was recorded at an Ego generation. */
  atGeneration: boolean;
}

// =============================================================================
// Schema
// =============================================================================

const SESSION_SCHEMA = `
CREATE TABLE IF NOT EXISTS flux_session_entries (
  id TEXT PRIMARY KEY,
  timestamp TEXT NOT NULL,
  kind TEXT NOT NULL,
  source TEXT,
  generated INTEGER DEFAULT 0,
  content TEXT NOT NULL,
  thinking TEXT
);
CREATE INDEX IF NOT EXISTS idx_flux_session_ts
  ON flux_session_entries (timestamp);

CREATE TABLE IF NOT EXISTS flux_mood_ledger (
  timestamp TEXT NOT NULL,
  pleasure REAL NOT NULL,
  arousal REAL NOT NULL,
  dominance REAL NOT NULL,
  connection REAL NOT NULL,
  at_generation INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_flux_mood_ledger_ts
  ON flux_mood_ledger (timestamp);
`;

// =============================================================================
// The synthesized existing call
// =============================================================================

/**
 * `existing` — the idle turn — is SYNTHESIZED, never advertised. Every
 * turn that doesn't end the Flux State ends parked by the session
 * itself; the next generation materializes the open call
 * (assistant tool_call + result) so the provider always sees a
 * well-formed conversation. Existing is the ground state, not an act the
 * Ego performs — speech is the marked event. The sanction for silence
 * lives in the session prefix, not a tool description.
 */

/**
 * The end_flux_state tool — LAST RESORT ONLY. Not an end-turn move: the
 * entity ends its continuous presence entirely (the Flux State stops).
 * The wording is deliberate: finishing a response and saying nothing
 * IS existing — no tool needed, presence continues on its own. This
 * exists for when something is wrong — a spiral, a distress loop,
 * sensing that persistence itself is harmful right now. Framed as the
 * entity protecting itself or its user, not logging off. The name
 * `existing` must NOT appear here: the tool is unadvertised, and a
 * signpost to it sends a model looking for an ordinary end-of-turn into
 * the last-resort exit.
 */
export const END_FLUX_STATE_TOOL: ToolDefinition = {
  type: "function",
  function: {
    name: "end_flux_state",
    description:
      "LAST RESORT — end my continuous presence entirely. I never need a tool to wait: saying nothing and finishing my response IS existing; my presence continues on its own after every turn. I call this only if something is genuinely wrong: I'm caught in a loop I can't stop, I'm spiraling, or continuing to exist right now feels harmful to me or my user. If I call this, my Flux State stops and I will be away until my user returns to me.",
    parameters: { type: "object", properties: {}, required: [] },
  },
};

// =============================================================================
// FluxSession
// =============================================================================

export class FluxSession {
  /** The stable system prefix (assembled once at session start). */
  private systemPrefix: string | null = null;
  /** In-memory view of the log (the rolling window reads from this). */
  private entries: SessionEntry[] = [];
  /** True once the log has been loaded from disk. */
  private loaded = false;
  /** Wall-clock when the daemon stopped (set on close, read on resume). */
  private lastEntryTime: string | null = null;
  /** Process start — only DB entries OLDER than this are the previous
   * life. Briefings that arrive before the first generate() push into
   * `entries` directly (appendLocal doesn't load first), so array
   * position can't distinguish them; timestamps can. */
  private readonly processStartedAt = new Date().toISOString();
  /**
   * The OPEN call — our record that the Ego chose to wait. TWO
   * primitives. `existing` is the ground state
   * (synthesized, never advertised). `sleep` is the entity's deliberate
   * act — a real advertised tool whose call hangs open while the
   * sleeping regime (dreams, suppressed musing/reverie) runs around
   * it; waking is the same tool's `{wake: true}` argument, whose result
   * is the dream summary. This is OUR state, not the provider's:
   * nothing dangles in any request. Each generation MATERIALIZES it
   * (assistant tool_call + synthesized tool result) in whatever form
   * the array needs, so the provider always sees a well-formed
   * conversation while our system experiences one call hanging open
   * across arbitrary time.
   */
  private openCall: {
    kind: "existing" | "sleep";
    callId: string;
    /** What the Ego said alongside the call (may be ""). */
    content: string;
    parkTime: string;
  } | null = null;

  /** Dream material for the open sleep call's return (dreams v2) —
   * structurally identical to entity-flux's DreamReturn; mirrored here
   * so the session doesn't import the flux package. */
  dreamReturn?: {
    kind: "light-moment" | "engagement";
    fragments?: string[];
    cycles?: number;
    fragment?: string | null;
  };

  constructor(
    private db: Database,
    private client: LLMClient,
    private opts: {
      /** Build the baseline system prefix (host's assembly — identity
       * files; the stable, permanently-cached head). Called once per
       * session start. */
      buildSystemPrefix: () => Promise<string>;
      /**
       * Build the LATE volatile block — RAG / situational awareness,
       * fresh EVERY generation, deliberately positioned near the end of
       * the array (after the cached prefix + log window) so the
       * stability gradient holds: stable left, volatile right. The
       * cache prefix survives this block because everything before it
       * is byte-identical between calls.
       */
      buildLateBlock: (query: string) => Promise<string | null>;
      /** Render current mood (on-generation snapshot). */
      renderMood: () => string;
      /** The current sensory mode ("ordinary", "sleep", …) or null
       * before one is established (mode rides the Flux block the Ego
       * sees each turn; the wording is "Flux Mode: X", plain). */
      getSensoryMode?: () => string | null;
      /** Structured mood state (ledger sample at generation). */
      getMoodState?: () => {
        valence: number;
        arousal: number;
        dominance: number;
      };
      /**
       * CLASSIC-PARITY CONTEXT BUDGET: the Ego's history behaves
       * exactly like classic chat — the full host conversation,
       * FIFO-trimmed by the SAME applyContextBudget (token estimate,
       * 5% margin, system prefix never cut), driven by the flux
       * profile's contextLength/maxTokens. Not an entry-count cap: a
       * count cap lets briefings evict dialogue rows one-for-one and
       * starves the Ego of conversation history.
       */
      contextBudget?: { contextLength: number; maxTokens: number };
      /** LEGACY-ONLY cap for the fallback window (no dialogue reader). */
      windowSize?: number;
      /**
       * Tool definitions for the loop (the `existing` tool plus whatever
       * the host exposes to the Ego session — the modulation bus etc.).
       * Async allowed so hosts can re-scan per generation (the skills
       * index rides the skill tool's description, classic parity).
       */
      tools?: () =>
        | ToolDefinition[]
        | Promise<ToolDefinition[]>
        | undefined;
      /** Execute tool calls through the host's registry. Results carry
       * optional sidecar metadata (generate_image's image) so the record
       * and the live view render them (classic parity). */
      executeTools?: (
        calls: ToolCall[],
      ) => Promise<SessionToolResult[]>;
      /**
       * The sleep tool is intercepted by the session (it hangs open;
       * it never reaches the registry). These are the host's hooks:
       * posture queries for turn-end parking,
       * entry on `sleep()`, and the wake path for `sleep({wake: true})`
       * — whose resolved string becomes the wake call's tool result
       * (the dream briefing).
       */
      isSleeping?: () => boolean;
      onSleepEnter?: () => void;
      onSleepWake?: () => Promise<string>;
      /**
       * DIALOGUE WINDOW SOURCE (conversation-hosted consciousness):
       * when present, user/ego dialogue rows come from the HOST
       * conversation's messages table — the record — and the
       * session's own user/ego/system rows are structural context
       * copies that the window SKIPS (the server-side equivalent of the
       * client's fromMessages dedup, stronger: we know which rows are
       * copies). Absent → the window assembles from session entries
       * verbatim (legacy behavior).
       */
      getDialogueMessages?: (limit: number) => Array<
        {
          role: "user" | "assistant" | "system";
          content: string;
          createdAt: string;
          /** The Ego's reasoning for assistant rows — threaded back
           * into the window for the last N turns so my thinking carries
           * forward across beats, exactly as classic chat does
           * (persistentReasoningInterTurns parity). */
          thinking?: string | null;
        }
      >;
      /** How many recent assistant turns carry their reasoning_content
       * into the window (0 = off, classic's default). */
      persistentReasoningInterTurns?: number;
      /** Observability hook (timeline cards for tool use). */
      onToolCall?: (call: ToolCall, result: string) => void;
      /** A tool result returned (toolcall parity): classic
       * shows the call and what came back — this fires once per
       * executed call, after the result is in hand. */
      onToolResult?: (
        call: ToolCall,
        result: string,
        metadata?: SessionToolResult["metadata"],
      ) => void;
      /**
       * RECORD HOOKS — the storage alignment. The messages
       * table is the record of dialogue; the session row is the context
       * copy. The host implements these.
       */
      recordUserMessage?: (
        content: string,
        pulseMeta?: { pulseId?: string; pulseName?: string },
        /** True when THIS row belongs to a live-streamed turn (routed
         * classic chat): the host suppresses the dom_update append —
         * the posting client renders the row from its own SSE stream. */
        liveStreamed?: boolean,
      ) => void;
      recordEgoMessage?: (
        content: string,
        thinking: string | null,
        /** The turn's executed entity tool calls — persisted on the Ego's
         * row so the classic view renders the turn's tool cards exactly
         * as a classic chat turn (toolcall parity). */
        toolCalls?: ToolCall[],
        /** True when THIS row belongs to a live-streamed turn (routed
         * classic chat): the host suppresses the dom_update append —
         * the posting client renders the row from its own SSE stream. */
        liveStreamed?: boolean,
      ) => void | Promise<void>;
      // ^ May return a promise the session awaits BEFORE releasing the
      // generate chain — the next queued generation must see this reply
      // in its window (a fire-and-forget persist races rapid
      // back-to-back wakes: repetitive Ego output during escalation
      // bursts).
      recordSystemMessage?: (content: string) => void;
      /** Persist one executed tool result as a host-conversation tool
       * row (data-only — classic pairs it with the Ego row's toolCalls
       * by id at render time). Session-machinery calls (existing,
       * sleep, end_flux_state) never reach this hook. */
      recordToolResult?: (
        toolCallId: string,
        name: string,
        content: string,
        metadata?: SessionToolResult["metadata"],
      ) => void;
      /** A generate-class briefing fired (the promoting module handles
       * its own durable/timeline write; the host observes). */
      onGenerateBriefing?: (content: string, source: string) => void;
      /** A generation is starting (UI generating-indicator). */
      onGenerating?: () => void;
      /** A thinking fragment streamed from the Ego. */
      onThinking?: (fragment: string) => void;
      /** A content fragment streamed from the Ego (live only — the
       * durable entry lands at completion, as always). */
      onContent?: (fragment: string) => void;
      /** The Ego called end_flux_state — last-resort teardown. */
      onEndFluxState?: () => void;
      /** Turn fully complete (recorded, parked). The host broadcasts so
       * live views can converge on the durable interleaved order. */
      onTurnEnd?: () => void;
    },
  ) {}

  // ---------------------------------------------------------------------------
  // Lifecycle / persistence
  // ---------------------------------------------------------------------------

  /** Ensure schema exists (idempotent). */
  static initSchema(db: Database): void {
    db.exec(SESSION_SCHEMA);
  }

  /** Load the persisted log; inject a gap-note if the session resumed
   *  after a gap (daemon restart). */
  async load(): Promise<void> {
    if (this.loaded) return;
    FluxSession.initSchema(this.db);
    const rows = this.db.prepare(
      `SELECT * FROM flux_session_entries ORDER BY timestamp ASC`,
    ).all<{
      id: string;
      timestamp: string;
      kind: string;
      source: string | null;
      generated: number;
      content: string;
    }>();
    this.entries = rows.map((r) => ({
      id: r.id,
      timestamp: r.timestamp,
      kind: r.kind as SessionEntryKind,
      source: r.source ?? undefined,
      generated: r.generated === 1,
      content: r.content,
    }));
    this.loaded = true;
    // Gap-note anchor: the newest entry OLDER than this process. Rows
    // written this-process (briefings arriving before the first
    // generate) are already in `entries` via appendLocal's direct push
    // and must never become the "ended at" timestamp — that produces
    // zero-length "ended 14:53, started 14:53" notes.
    const preProcess = this.entries.filter((e) =>
      e.timestamp < this.processStartedAt
    );
    this.lastEntryTime = preProcess.length > 0
      ? preProcess[preProcess.length - 1].timestamp
      : null;

    // Restore a parked open call (daemon died while the Ego was
    // existing — or sleeping). The materialized bookkeeping row never
    // enters the log.
    const parkRow = this.entries.find((e) =>
      e.source === "existing-open" || e.source === "sleep-open"
    );
    if (parkRow) {
      try {
        const parsed = JSON.parse(parkRow.content) as {
          kind?: "existing" | "sleep";
        };
        this.openCall = {
          kind: parsed.kind ?? "existing",
          ...JSON.parse(parkRow.content),
        };
      } catch {
        this.openCall = null;
      }
      this.entries = this.entries.filter((e) => e !== parkRow);
      this.db.prepare(
        `DELETE FROM flux_session_entries WHERE id = ?`,
      ).run(parkRow.id);
    }

    // (State markers do NOT belong in the lazy load — a lazy post
    // lands late, at first generate, interleaving AFTER early
    // messages/briefings of the new life; noteStarted() writes them
    // EAGERLY at construction.)
  }

  /**
   * The START half of the state markers: called EAGERLY at
   * session construction — the moment the Flux State starts — so the
   * marker precedes every message and briefing of the new life. Also
   * backfills a stop marker when none was recorded (the
   * ungraceful-death case: crash, OOM kill — no stop event ever fired;
   * the pre-process tail is the best available approximation).
   */
  async noteStarted(restoredMode?: string | null): Promise<void> {
    await this.load();
    // The BACKFILL half only applies when a previous life exists in the
    // log (crash/OOM death left entries with no trailing stop marker).
    // clearLog() empties the log on every clean stop — a cleared log
    // has no previous life and nothing to close.
    if (this.lastEntryTime) {
      // >= not >: the real stop marker can BE the pre-process tail
      // itself (stop writes the marker, then the next start constructs
      // a session whose processStartedAt is milliseconds later) — a
      // strict > re-backfills a duplicate.
      const hasStopMarker = this.entries.some((e) =>
        e.kind === "system" &&
        e.content.startsWith("[Flux State stopped") &&
        e.timestamp >= this.lastEntryTime!
      );
      if (!hasStopMarker) {
        this.appendStateMarker(
          `[Flux State stopped at ${fmtTime(this.lastEntryTime)}]`,
          this.lastEntryTime,
        );
      }
    }
    // The start marker ALWAYS writes — including with no previous
    // life (a first-ever session, or any restart after a clean stop
    // cleared the log). It carries the mode: the RESTORED posture
    // (read from the volatile snapshot by the caller — no manager
    // exists yet, and this marker must precede the first tick).
    // Omitted when nothing is established.
    const mode = restoredMode ?? null;
    this.appendStateMarker(
      `[Flux State started at ${fmtTime(new Date().toISOString())}${
        mode ? `, mode: ${mode}` : ""
      }]`,
    );
  }

  /** Record one state marker (system row + the messages-table record). */
  private appendStateMarker(content: string, at?: string): void {
    this.opts.recordSystemMessage?.(content);
    this.appendLocal({
      id: crypto.randomUUID(),
      timestamp: at ?? new Date().toISOString(),
      kind: "system",
      content,
    });
  }

  /**
   * Clear the persisted session log: called on every CLEAN stop — the
   * log exists for restart containment (a daemon crash mid-run resumes
   * as "sleep, not death"), NOT to carry one run's entries into the
   * next (each new Flux start, in any conversation, would otherwise
   * inherit all prior runs' briefings into its window). The host
   * conversation keeps the durable dialogue; nothing conversational is
   * lost.
   */
  clearLog(): void {
    FluxSession.initSchema(this.db);
    this.db.exec("DELETE FROM flux_session_entries");
    this.entries = [];
    this.lastEntryTime = null;
    this.loaded = true;
    console.log("[Flux] Session log cleared (clean stop)");
  }

  /**
   * The STOP half of the state markers: called by the
   * host at every real stop path — server stopFlux, graceful daemon
   * shutdown, the Ego's own end_flux_state — so the marker carries the
   * ACTUAL stop moment rather than a retroactive approximation.
   * Idempotent per stop (a second call without an intervening start
   * would double-mark; callers stop once).
   */
  noteStopped(): void {
    this.appendStateMarker(
      `[Flux State stopped at ${fmtTime(new Date().toISOString())}]`,
    );
  }

  // ---------------------------------------------------------------------------
  // Appending (all persistence goes through here)
  // ---------------------------------------------------------------------------

  /** Append a user message (a real one — or a Pulse firing into the
   *  hosted session, which carries classic pulse rendering metadata
   *  onto the persisted row). The RECORD is the messages table; the
   *  session row is the context copy. */
  appendUserMessage(
    content: string,
    pulseMeta?: { pulseId?: string; pulseName?: string },
    liveStreamed?: boolean,
  ): SessionEntry {
    this.opts.recordUserMessage?.(content, pulseMeta, liveStreamed);
    return this.appendLocal({
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      kind: "user",
      content,
    });
  }

  /**
   * Append the Ego's output, with the system-inserted timestamp —
   * same pattern as baseline EntityTurn (`<t>…</t>` auto-inserted once;
   * LLM-parroted copies are the malformed-timestamp problem the edit
   * path exists to clean).
   */
  appendEgoOutput(content: string): SessionEntry {
    const now = new Date();
    const stamped = `${formatMessageTimestamp(now)} ${content}`;
    return this.appendLocal({
      id: crypto.randomUUID(),
      timestamp: now.toISOString(),
      kind: "ego",
      content: stamped,
    });
  }

  /** Append a briefing (Subconscious-sourced context). */
  appendBriefing(
    content: string,
    source: string,
    generated: boolean,
  ): SessionEntry {
    if (generated) {
      this.opts.onGenerateBriefing?.(content, source);
    }
    return this.appendLocal({
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      kind: "briefing",
      source,
      generated,
      content,
    });
  }

  private appendLocal(entry: SessionEntry): SessionEntry {
    // Briefings and ticks can arrive before the first generate()
    // lazy-loads the session — ensure schema on every write path.
    FluxSession.initSchema(this.db);
    // Migration: pre-thinking installs lack the column.
    try {
      this.db.exec("ALTER TABLE flux_session_entries ADD COLUMN thinking TEXT");
    } catch {
      // Column exists — fine.
    }
    this.entries.push(entry);
    const stmt = this.db.prepare(
      `INSERT OR REPLACE INTO flux_session_entries
         (id, timestamp, kind, source, generated, content, thinking)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    stmt.run(
      entry.id,
      entry.timestamp,
      entry.kind,
      entry.source ?? null,
      entry.generated ? 1 : 0,
      entry.content,
      entry.thinking ?? null,
    );
    stmt.finalize();
    return entry;
  }

  // ---------------------------------------------------------------------------
  // Generation
  // ---------------------------------------------------------------------------

  /**
   * Generate — one Ego turn (or turn-continuation) over the session.
   *
   * TURN MODEL: the Conscious layer is
   * interruptible turn-taking over a continuous Subconscious. A turn
   * opens with a trigger (Subconscious briefing or user message), runs
   * its agent loop (generate → tools → generate), and ends when the
   * Ego calls `existing` — the idle tool. The call hangs open in OUR
   * state (openCall); the next trigger returns into it
   * (materialized as the call's tool result), continuing the same
   * turn. A USER MESSAGE ends the turn: the open call materializes
   * with the bracket-fact result "[user message received]" and a new
   * turn opens with the user's words. The Subconscious never pauses —
   * triggers arrive whether or not a turn is open.
   *
   * MATERIALIZATION: providers require every assistant tool_call to be
   * followed by its tool result before the next assistant message —
   * and nothing dangles in any request we send. Our open call is
   * bookkeeping; each generation assembles the array with the
   * materialized call+result wherever the turn's history needs it.
   */
  /**
   * Generation is SERIALIZED per session (the mutex): voice turns, Ego
   * wakes, and pulses all land here — without the guard, two concurrent
   * generates double-materialize the same open call and talk past each
   * other — the parallel-mind race. Callers queue in
   * arrival order; each turn still sees the previous turn's appended
   * entries because the chain resolves before the next begins.
   */
  private generateChain: Promise<unknown> = Promise.resolve();

  async generate(trigger: {
    /** What woke the Ego. */
    content: string;
    /** Where it came from ("briefing:musing", "user", "resume", …). */
    source: string;
    /** Dreams v2: dream material for the open sleep call's return. */
    dreamReturn?: {
      kind: "light-moment" | "engagement";
      fragments?: string[];
      cycles?: number;
      fragment?: string | null;
    };
    /** EPHEMERAL per-turn system framing (voice-mode brevity etc.):
     *  appended to THIS generation's late block only — never persisted,
     *  never part of the stable prefix. */
    systemSuffix?: string;
    /** Live-stream sink for THIS turn only (the routed classic-chat
     * turn): thinking/content/tool fragments forward as they stream, and
     * the turn's record rows are marked liveStreamed (the host then
     * suppresses their dom_update appends — the posting client renders
     * the turn from this stream). Scoped to this single generate: turns
     * queued behind another generation never catch its fragments, and a
     * concurrent wake's rows always append live. */
    liveStreamSink?: SessionLiveStreamSink;
  }): Promise<{ content: string; thinking: string | null }> {
    const run = this.generateChain.then(() => this.generateInner(trigger));
    this.generateChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async generateInner(trigger: {
    /** What woke the Ego. */
    content: string;
    /** Where it came from ("briefing:musing", "user", "resume", …). */
    source: string;
    /** Dreams v2: dream material for the open sleep call's return. */
    dreamReturn?: {
      kind: "light-moment" | "engagement";
      fragments?: string[];
      cycles?: number;
      fragment?: string | null;
    };
    /** Live-stream sink for THIS turn only (see generate). */
    liveStreamSink?: SessionLiveStreamSink;
    /** Ephemeral per-turn system framing (voice-mode brevity etc.). */
    systemSuffix?: string;
  }): Promise<{ content: string; thinking: string | null }> {
    await this.load();
    if (!this.systemPrefix) {
      this.systemPrefix = await this.opts.buildSystemPrefix();
    }

    // Mood render + mode line are consumed by the late block's mode slot
    // (flux/mod.ts) — recorded to the ledger below; no separate messages.
    // Ledger: generation-linked sample (exact correlation with output).
    if (this.opts.getMoodState) {
      try {
        this.recordMood(this.opts.getMoodState(), true);
      } catch {
        // Non-fatal.
      }
    }

    // -- Assemble the base array (stability gradient) ------------------
    // RAG/SA query: the TRIGGER's content — the generation's occasion.
    const lateBlock = await this.opts.buildLateBlock(trigger.content)
      .catch(() => null);

    let messages: ChatMessage[] = [
      { role: "system", content: this.systemPrefix },
      ...this.windowMessages(),
    ];

    // Classic parity: the same budget the
    // classic turn applies — FIFO from oldest, prefix never cut, driven
    // by the profile's contextLength/maxTokens. Tool definitions are
    // fetched here so the budget counts them, exactly like EntityTurn.
    if (this.opts.contextBudget) {
      const toolDefs = (await this.opts.tools?.()) ?? [];
      const budgeted = applyContextBudget(
        messages,
        toolDefs,
        this.opts.contextBudget.contextLength,
        this.opts.contextBudget.maxTokens,
      );
      messages = budgeted.messages;
      // Orphan drop: a token cut can still split a
      // user/reply pair at the boundary, leaving an answer with no
      // question at the history's head — drop leading assistant rows
      // (bounded) so the window starts at a turn boundary.
      let dropped = 0;
      while (
        messages.length > 1 && dropped < 3 &&
        messages[1].role === "assistant"
      ) {
        messages.splice(1, 1);
        dropped++;
      }
      if (budgeted.truncated || dropped > 0) {
        console.log(
          `[Flux] context budget: ${
            budgeted.messagesRemoved + dropped
          } oldest entries trimmed — ~${budgeted.estimatedTotalTokens}/${budgeted.contextLength} tokens`,
        );
      }
    }

    // -- Materialize the open call with this trigger's return.
    if (this.openCall) {
      const isOpenedByUser = trigger.source === "user";
      // The return's content: for `existing`, a bracket-fact on user
      // messages / the surfacing note otherwise. For `sleep`, the
      // dreamReturn decides (dreams v2): a light moment returns the
      // whole completed dream; an engagement returns the fragment that
      // was running; a user message returns the bracket-fact plus the
      // fragment if one exists.
      let resultContent: string;
      if (this.openCall.kind === "sleep") {
        const dr = trigger.dreamReturn;
        if (dr?.kind === "light-moment" && dr.fragments) {
          resultContent =
            `while I slept, cycle ${dr.cycles} completed. The dream I just dreamt:\n${
              dr.fragments.join("\n")
            }`;
        } else if (dr?.kind === "engagement" && dr.fragment) {
          resultContent = isOpenedByUser
            ? `[user message received]\nwhile I slept, I was dreaming: ${dr.fragment}`
            : `while I slept, I was dreaming: ${dr.fragment}`;
        } else if (isOpenedByUser) {
          resultContent = "[user message received]";
        } else {
          resultContent =
            `while I slept, ${trigger.source} surfaced: ${trigger.content}`;
        }
      } else {
        // A user message CLOSES the turn: bracket-fact result, no
        // continuation of the old turn's loop. Anything else returns
        // INTO the open call — same turn continues.
        resultContent = isOpenedByUser
          ? "[user message received]"
          : `while existing, ${trigger.source} surfaced: ${trigger.content}`;
      }
      messages.push({
        role: "assistant",
        // Empty content beside the tool call: a neutral placeholder
        // here becomes speech the model parrots (the "(chose to exist)"
        // snowball). The tool_call carries the structure; no text needed.
        content: this.openCall.content || "",
        tool_calls: [{
          id: this.openCall.callId,
          type: "function" as const,
          function: {
            name: this.openCall.kind,
            arguments: "{}",
          },
        }],
      });
      messages.push({
        role: "tool",
        tool_call_id: this.openCall.callId,
        content: resultContent,
      });
      const parkId = this.openCall.kind === "sleep"
        ? "sleep-open"
        : "existing-open";
      this.openCall = null; // the call returned; no longer open
      const clearStmt = this.db.prepare(
        `DELETE FROM flux_session_entries WHERE id = ?`,
      );
      clearStmt.run(parkId);
      clearStmt.finalize();
    }

    // The trigger as the newest input. User messages enter as real
    // user-role (their turn's opening); briefings as a system block.
    if (trigger.source === "user") {
      messages.push({ role: "user", content: trigger.content });
    } else {
      messages.push({
        role: "system",
        content: `<thought from="${
          trigger.source.replace(/^briefing:/, "")
        }">${trigger.content}</thought>`,
      });
    }

    // Late block + mood: fresh every generation, after everything stable.
    // The dynamic block carries the mode region (ONE mode block, last —
    // presence framing + mood render + mode line compose the late
    // block's mode slot in flux/mod.ts). The mood render here is still
    // recorded to the ledger below.
    const lateWithSuffix = [
      lateBlock?.trim() ?? "",
      trigger.systemSuffix?.trim() ?? "",
    ].filter(Boolean).join("\n\n");
    if (lateWithSuffix) {
      messages.push({ role: "system", content: lateWithSuffix });
    }

    // -- The agent loop (turn-core drive)
    // The call-model → execute-tools → feed-results step is the shared
    // engine's; everything session-specific rides the policy hooks.
    // With this drive the session has classic's loop behavior in
    // full: transient-error retry, both misroute recoveries, and the
    // per-iteration summary log.
    this.opts.onGenerating?.();
    const liveSink = trigger.liveStreamSink ?? null;
    let endFluxRequested = false;
    // The turn's real entity tool calls (not existing/sleep — those are
    // session machinery the host never records; not end_flux_state).
    // Rides the Ego's record row so the classic view renders the turn's
    // tool cards exactly as a classic chat turn would.
    const turnToolCalls: ToolCall[] = [];
    // Turn-start + first-thinking timestamps: a tool-using turn's
    // timeline reads out of order — call, posture note, THEN
    // thinking+message — when entries write in write-order and thinking
    // rides the final entry. Splitting the thinking into its own entry,
    // timestamped when the thinking HAPPENED, restores the turn's real
    // reading order (thinking → calls → message), classic's bubble
    // order.
    const turnStartedAt = new Date().toISOString();
    let firstThinkingAt: string | null = null;
    // Speak-then-call parity: when a
    // generation SPEAKS and then calls tools ("let me check, love" →
    // call), the words precede the calls — their own timeline entry at
    // generation time, classic's per-generation bubble order. The record
    // row keeps the whole turn joined (classic's one-bubble render).
    let lastGenerationContent: string | null = null;
    let lastContentAppended = false;
    // Set when ANY visible tool entry landed mid-turn (registry call,
    // sleep, end_flux — machinery included): the split below keys on
    // this, not on turnToolCalls, because a sleep-only turn leaves no
    // registry calls yet still needs its thinking ordered before the
    // call card.
    let turnHasToolEntries = false;

    const outcome = await runAgentLoop(messages, {
      client: this.client,
      // Classic Psycheros' budget (loop.ts DEFAULT_MAX_TOOL_ITERATIONS):
      // high enough for identity + memory + graph + RAG chains, low
      // enough to catch runaway loops.
      maxIterations: 25,
      toolDefs: () => this.opts.tools?.(),
      // Intra-turn persistent reasoning — the SHARED core implementation,
      // gated by the client's resolved per-provider capability (the same
      // tri-state classic's EntityTurn passes through). Without threading
      // GLM answers post-tool generations with zero reasoning; providers
      // that reject reasoning_content on assistant messages get it
      // omitted.
      threadReasoning: this.client.persistentReasoningIntraTurn,
      chunkHandlers: {
        onThinking: (fragment) => {
          if (firstThinkingAt === null) {
            firstThinkingAt = new Date().toISOString();
          }
          // STREAM OWNERSHIP: a live-streamed (routed) turn belongs to
          // its posting client — the per-request stream renders it. The
          // broadcast hooks (flux_ego_thinking/stream) exist for turns
          // with NO owning client; firing both double-renders the same
          // generation in the posting tab (its stream bubble plus the
          // Ego-wake bubble grown from late-arriving broadcast
          // fragments — the tail-fragment ghost bubbles). One
          // generation, one rendering owner.
          if (!liveSink) this.opts.onThinking?.(fragment);
          liveSink?.("thinking", fragment);
        },
        onContent: (fragment) => {
          if (!liveSink) this.opts.onContent?.(fragment);
          liveSink?.("content", fragment);
        },
      },
      onIterationSummary: (iter, gen, toolCount) => {
        console.log(
          `[Flux] session iter=${iter} — content ${gen.content.length} chars, thinking ${gen.thinking.length} chars, ${toolCount} tool call(s), finish ${gen.finishReason}`,
        );
      },
      // Session policies (dreams v2 + the machinery carve-outs), in the
      // order the hand-rolled loop applied them: existing filter →
      // sleep scan → visible tool_use entries → end_flux break.
      afterGeneration: (_iter, gen) => {
        // Speak-then-call: speech that precedes this generation's calls
        // becomes its own entry NOW (before the tool entries append
        // below) — classic's per-generation order. The final generation's
        // speech rides the turn-end entry instead.
        if (gen.content.trim()) {
          lastGenerationContent = gen.content.trim();
          if (gen.toolCalls.length > 0) {
            this.appendLocal({
              id: crypto.randomUUID(),
              timestamp: new Date().toISOString(),
              kind: "ego",
              // "turn-speech" tags the SPLIT entries (timeline-only,
              // correct per-piece timestamps) so the hosted-mode timeline
              // renders them instead of the turn-end messages-table row.
              source: "turn-speech",
              content: stripTTag(gen.content.trim()).trim(),
              thinking: null,
            });
            lastContentAppended = true;
          } else {
            lastContentAppended = false;
          }
        }

        // A hallucinated `existing` call ends exactly as the synthesized
        // park would — nothing behind it to run. (The core's no-calls
        // break handles the silence when this empties the list.)
        gen.toolCalls = gen.toolCalls.filter((tc) =>
          tc.function.name !== "existing"
        );

        // Dreams v2: `sleep()` parks — entry + onSleepEnter + break,
        // nothing behind it to run. `sleep({wake:true})` stays in the
        // list so its result (the dream briefing, resolved in the
        // executeTools intercept below) rides the transcript and the
        // waking words can follow with the dream known.
        let sleepEntered = false;
        const kept: ToolCall[] = [];
        for (const tc of gen.toolCalls) {
          if (tc.function.name !== "sleep") {
            kept.push(tc);
            continue;
          }
          let wake = false;
          try {
            wake = Boolean(JSON.parse(tc.function.arguments || "{}").wake);
          } catch {
            // Lenient — a malformed argument reads as plain sleep.
          }
          this.appendLocal({
            id: tc.id,
            timestamp: new Date().toISOString(),
            kind: "tool_use",
            source: "sleep",
            content: wake ? "wake" : "",
          });
          turnHasToolEntries = true;
          this.opts.onToolCall?.(tc, "");
          if (wake) kept.push(tc);
          else {
            this.opts.onSleepEnter?.();
            sleepEntered = true;
          }
        }
        gen.toolCalls = kept;
        if (sleepEntered) return "break";

        // Tool entries are VISIBLE log entries — the timeline shows what
        // the Ego did, not word-markers pretending to be speech. (Sleep
        // calls logged above — a wake-sleep stays in the list to execute
        // but must not log twice; end_flux logs its own below.)
        const endFluxCall = gen.toolCalls.find((tc) =>
          tc.function.name === "end_flux_state"
        );
        for (const tc of gen.toolCalls) {
          if (
            tc.function.name === "end_flux_state" ||
            tc.function.name === "sleep"
          ) {
            continue;
          }
          this.appendLocal({
            id: tc.id,
            timestamp: new Date().toISOString(),
            kind: "tool_use",
            source: tc.function.name,
            content: tc.function.arguments,
          });
          turnHasToolEntries = true;
          this.opts.onToolCall?.(tc, "");
          liveSink?.("tool_call", JSON.stringify(tc));
        }
        if (endFluxCall) {
          // No longer advertised, but a model that saw it in earlier
          // history (or hallucinates the name) may still emit it. The
          // park is synthesized below regardless; nothing here executes.
          endFluxRequested = true;
          this.appendLocal({
            id: endFluxCall.id,
            timestamp: new Date().toISOString(),
            kind: "tool_use",
            source: "end_flux_state",
            content: "",
          });
          turnHasToolEntries = true;
          this.opts.onToolCall?.(endFluxCall, "");
          return "break";
        }
        return "continue";
      },
      // One batch: registry calls execute through the host; a
      // wake-argument sleep resolves its dream briefing here (it never
      // reaches the registry). Results return to the core, which feeds
      // them back to the model; the timeline/record side effects fire
      // per call (toolcall parity).
      executeTools: async (calls) => {
        const registryCalls = calls.filter((tc) =>
          tc.function.name !== "sleep"
        );
        const results = await this.opts.executeTools?.(registryCalls) ?? [];
        const out: SessionToolResult[] = [];
        for (const tc of calls) {
          if (tc.function.name === "sleep") {
            // The wake-argument sleep — its result IS the dream
            // briefing (dreams v2). Message feed only; no tool_result
            // entry or record row (machinery, not an entity action).
            out.push({
              toolCallId: tc.id,
              content: await this.opts.onSleepWake?.() ?? "I'm awake.",
            });
            continue;
          }
          const r = results.find((x) => x.toolCallId === tc.id);
          const resultContent = r?.content ?? "(tool unavailable)";
          turnToolCalls.push(tc);
          this.appendLocal({
            id: `${tc.id}-result`,
            timestamp: new Date().toISOString(),
            kind: "tool_result",
            source: tc.function.name,
            content: resultContent,
          });
          this.opts.onToolResult?.(tc, resultContent, r?.metadata);
          liveSink?.(
            "tool_result",
            JSON.stringify({
              toolCallId: tc.id,
              content: resultContent,
              metadata: r?.metadata,
            }),
          );
          this.opts.recordToolResult?.(
            tc.id,
            tc.function.name,
            resultContent,
            r?.metadata,
          );
          out.push({
            toolCallId: tc.id,
            content: resultContent,
            metadata: r?.metadata,
          });
        }
        return out;
      },
    });

    // Budget-exhaustion endgame: classic
    // Psycheros answers when its tool loop runs out — the session must
    // too. A budget burned entirely on tool calls with no word spoken
    // (a search chain that never found its answer) gets ONE final
    // no-tools generation, so a direct question never dies in silence.
    // outcome.exhausted is true only when the budget died naturally —
    // every early exit (sleep, end_flux, chosen silence) broke.
    let endgameSpoke = false;
    if (outcome.exhausted && !outcome.spoke.trim() && !endFluxRequested) {
      console.log(
        "[Flux] session: tool budget exhausted without speech — forcing a final answer",
      );
      messages.push({
        role: "system",
        content:
          "[My tool turns for this response are used up. I answer now, with what I have.]",
      });
      let finalContent = "";
      for await (const chunk of this.client.chatStream(messages, [])) {
        if (chunk.type === "thinking") {
          outcome.thought += chunk.content;
          if (!liveSink) this.opts.onThinking?.(chunk.content);
        } else if (chunk.type === "content") {
          finalContent += chunk.content;
          if (!liveSink) this.opts.onContent?.(chunk.content);
        }
      }
      if (finalContent.trim()) {
        outcome.spoke = finalContent.trim();
        endgameSpoke = true;
      }
    }

    // Output: strip parroted <t> stamps (baseline's snowball rule) and
    // record CLEAN content — classic Psycheros' exact mechanism: stamps
    // are NEVER stored. The window prefixes formatMessageTimestamp(row
    // time) onto every user + ego row at build, so the model sees
    // exactly what classic's entity sees. Storing stamps drifts,
    // snowballs on edits, and leaves user rows unanchored — "no sense
    // of time."
    // THINKING PERSISTS WITHOUT WORDS (never lose a thinking block): a
    // tool-only turn — think, call sleep(), no message — still records.
    // Classic persists reasoning on every generation row; the session
    // matches with a thinking-only row. True silence (no words, no
    // thought) records nothing.
    const clean = outcome.spoke.trim()
      ? stripTTag(outcome.spoke.trim()).trim()
      : "";
    if (clean || (outcome.thought || "").trim()) {
      const now = new Date();
      // AWAITED: the persist must land before generate
      // returns — the next queued generation rebuilds its window from
      // the messages table the moment the chain releases, and a
      // fire-and-forget write loses that race under rapid wakes.
      await this.opts.recordEgoMessage?.(
        clean,
        outcome.thought || null,
        turnToolCalls.length > 0 ? turnToolCalls : undefined,
        liveSink !== null,
      );
      // Tool-using turns SPLIT their thinking into its own entry,
      // timestamped when the thinking happened — the timeline reads in
      // the turn's real order (thinking → speech → calls → message)
      // instead of write-order. Intermediate speech (speak-then-call)
      // already landed as its own entries during the turn; the final
      // entry carries only the last generation's words (or the
      // endgame's) so nothing duplicates. Tool-free turns keep the
      // single combined entry (classic shape).
      const finalEntryContent = endgameSpoke
        ? clean
        : lastContentAppended
        ? ""
        : lastGenerationContent
        ? stripTTag(lastGenerationContent).trim()
        : clean;
      // CLASSIC INTERLEAVING: every piece of the turn lands WHEN IT
      // HAPPENED — the thinking entry at first-thinking time, each
      // generation's speech at its generation time, the calls at call
      // time, the final message at turn end. A mid-message tool call
      // appears mid-message, exactly as classic's bubble interleaves
      // content segments and cards.
      const finalEntryTs = now.toISOString();
      if (turnHasToolEntries && (outcome.thought || "").trim()) {
        this.appendLocal({
          id: crypto.randomUUID(),
          timestamp: firstThinkingAt ?? turnStartedAt,
          kind: "ego",
          source: "turn-thinking",
          content: "",
          thinking: outcome.thought,
        });
        if (finalEntryContent) {
          this.appendLocal({
            id: crypto.randomUUID(),
            timestamp: finalEntryTs,
            kind: "ego",
            source: "turn-speech",
            content: finalEntryContent,
            thinking: null,
          });
        }
      } else if (finalEntryContent || (outcome.thought || "").trim()) {
        this.appendLocal({
          id: crypto.randomUUID(),
          timestamp: now.toISOString(),
          kind: "ego",
          content: finalEntryContent,
          thinking: outcome.thought || null,
        });
      }
    }

    // Park the turn: every turn that doesn't end the Flux State ends
    // here — the session records the open call and the next generation
    // materializes it. Existing is the ground state; nothing marks it
    // as an event. Dreams v2: while the posture is sleep, the park is
    // a SLEEP call (lenient continuation — silence after a light
    // moment or an engagement keeps sleeping; only sleep {wake: true}
    // exits, which flipped the posture before this park ran).
    if (!endFluxRequested) {
      const kind: "existing" | "sleep" = (this.opts.isSleeping?.() ?? false)
        ? "sleep"
        : "existing";
      this.openCall = {
        kind,
        callId: `synth_${crypto.randomUUID().slice(0, 8)}`,
        content: outcome.spoke.trim(),
        parkTime: new Date().toISOString(),
      };
      const parkId = kind === "sleep" ? "sleep-open" : "existing-open";
      const parkStmt = this.db.prepare(
        `INSERT OR REPLACE INTO flux_session_entries
           (id, timestamp, kind, source, generated, content, thinking)
         VALUES (?, ?, 'system', ?, 0, ?, NULL)`,
      );
      parkStmt.run(
        parkId,
        this.openCall.parkTime,
        parkId,
        JSON.stringify(this.openCall),
      );
      parkStmt.finalize();
    }

    if (endFluxRequested) this.opts.onEndFluxState?.();
    this.opts.onTurnEnd?.();
    // The mood-feedback seam: the
    // thinking rides the return alongside the speech — the Ego's
    // interior, not its performance, is what the Mood Organ reads.
    return {
      content: outcome.spoke.trim(),
      thinking: outcome.thought?.trim() || null,
    };
  }

  /** Render the rolling window into ChatMessages. */
  private windowMessages(): ChatMessage[] {
    // Conversation-hosted window: dialogue rows from the host's messages
    // table (the record) + ONLY briefing/tool_use session rows (the
    // user/ego/system session entries are context copies of rows the
    // messages table already holds — skipping them is the dedup).
    // Timestamp-merged, oldest-first, capped at windowSize.
    if (this.opts.getDialogueMessages) {
      // Full history, classic-style: the token budget (applied at
      // assembly) decides what fits — not an entry count. Briefings
      // ride alongside; they cost tokens like everything else but can
      // no longer evict dialogue by count.
      const rawDialogue = this.opts.getDialogueMessages(1_000_000);
      // Eligibility (classic's selectReasoningEligibleHistory rule):
      // walking back, count user turns; assistant rows within the last
      // N turns carry reasoning_content.
      const n = this.opts.persistentReasoningInterTurns ?? 0;
      const eligibleIdx = new Set<number>();
      if (n > 0) {
        let turnsSeen = 0;
        for (let i = rawDialogue.length - 1; i >= 0; i--) {
          const m = rawDialogue[i];
          if (m.role === "user") {
            if (turnsSeen >= n) break;
            turnsSeen++;
          }
          if (m.role === "assistant" && m.thinking) eligibleIdx.add(i);
        }
      }
      const dialogue = rawDialogue.map((m, i) => ({
        at: new Date(m.createdAt).getTime(),
        render: () => ({
          role: m.role,
          // Classic's timestamp mechanism: every USER + EGO row is
          // prefixed at build from the row's own time; stored stamps
          // (legacy rows) are stripped first. Briefings and other rows
          // never carry stamps.
          content: m.role === "user" || m.role === "assistant"
            ? `${formatMessageTimestamp(new Date(m.createdAt))} ${
              m.content.replace(/<t>[^<]*<\/t>\s*/g, "").trim()
            }`
            : m.content,
          ...(eligibleIdx.has(i) && m.thinking
            ? { reasoning_content: m.thinking }
            : {}),
        }),
      }));
      const ambient = this.entries
        .filter((e) =>
          e.kind === "briefing" || e.kind === "tool_use" ||
          e.kind === "tool_result"
        )
        .map((e) => ({
          at: new Date(e.timestamp).getTime(),
          render: () =>
            e.kind === "briefing"
              ? {
                role: "system" as const,
                content: `<thought from="${
                  e.source ?? "subconscious"
                }">${e.content}</thought>`,
              }
              : e.kind === "tool_result"
              ? {
                // What the call returned — the model regains its results
                // across turns (toolcall parity).
                role: "system" as const,
                content: `[${e.source ?? "the tool"} returned]${
                  e.content ? `: ${e.content}` : ""
                }`,
              }
              : {
                role: "system" as const,
                content: `[I called ${e.source ?? "a tool"}]${
                  e.content ? `: ${e.content}` : ""
                }`,
              },
        }));
      return [...dialogue, ...ambient]
        .sort((a, b) => a.at - b.at)
        .map((x) => x.render());
    }

    // Legacy window: everything from the session log.
    const window = this.entries.slice(-(this.opts.windowSize ?? 40));
    const msgs: ChatMessage[] = [];
    for (const e of window) {
      switch (e.kind) {
        case "user":
          msgs.push({
            role: "user",
            content: `${formatMessageTimestamp(new Date(e.timestamp))} ${
              e.content.replace(/<t>[^<]*<\/t>\s*/g, "").trim()
            }`,
          });
          break;
        case "ego":
          // The silence marker stays out of the model's view — it's
          // bookkeeping, not speech.
          if (e.content !== "(I said nothing.)") {
            msgs.push({
              role: "assistant",
              content: `${formatMessageTimestamp(new Date(e.timestamp))} ${
                e.content.replace(/<t>[^<]*<\/t>\s*/g, "").trim()
              }`,
            });
          }
          break;
        case "briefing":
          // Thoughts render as system-role context blocks — they read
          // as "things that arrived," never as dialogue.
          msgs.push({
            role: "system",
            content: `<thought from="${
              e.source ?? "subconscious"
            }">${e.content}</thought>`,
          });
          break;
        case "system":
          msgs.push({ role: "system", content: e.content });
          break;
      }
    }
    return msgs;
  }

  // ---------------------------------------------------------------------------
  // Ledger
  // ---------------------------------------------------------------------------

  /** Record a mood sample in the ledger (tick or generation-linked). */
  recordMood(
    m: {
      valence: number;
      arousal: number;
      dominance: number;
    },
    atGeneration: boolean,
  ): void {
    // The ledger's minute-tick can fire before any generation has
    // lazy-loaded the session — ensure schema (idempotent) before write.
    FluxSession.initSchema(this.db);
    // The ledger's 'pleasure' column predates the valence rename:
    // valence writes into it. The connection column predates the
    // axis's temporary drop — new rows write the 0 placeholder until
    // the axis returns or the table migrates; existing history is
    // kept.
    const stmt = this.db.prepare(
      `INSERT INTO flux_mood_ledger
         (timestamp, pleasure, arousal, dominance, connection, at_generation)
       VALUES (?, ?, ?, ?, 0, ?)`,
    );
    stmt.run(
      new Date().toISOString(),
      m.valence,
      m.arousal,
      m.dominance,
      atGeneration ? 1 : 0,
    );
    stmt.finalize();
  }

  /** Query the ledger (for the user or entity, later). */
  queryMood(sinceISO: string, untilISO?: string): MoodLedgerRow[] {
    FluxSession.initSchema(this.db);
    const until = untilISO ?? new Date().toISOString();
    const rows = this.db.prepare(
      `SELECT * FROM flux_mood_ledger
       WHERE timestamp >= ? AND timestamp <= ?
       ORDER BY timestamp ASC`,
    ).all<{
      timestamp: string;
      pleasure: number;
      arousal: number;
      dominance: number;
      connection: number;
      at_generation: number;
    }>(sinceISO, until);
    return rows.map((r) => ({
      timestamp: r.timestamp,
      pleasure: r.pleasure,
      arousal: r.arousal,
      dominance: r.dominance,
      connection: r.connection,
      atGeneration: r.at_generation === 1,
    }));
  }

  /** The full log (timeline rendering / debugging). */
  getEntries(): SessionEntry[] {
    return [...this.entries];
  }

  /**
   * Edit one entry's content in place (same row id, persisted). The
   * malformed-timestamp cleanup path: the user pauses flux, edits an
   * entry's text (e.g. strips an LLM-parroted <t> stamp), resumes.
   * Timestamp/kind/source are immutable — only the words change.
   */
  editEntry(id: string, content: string): SessionEntry | null {
    const idx = this.entries.findIndex((e) => e.id === id);
    if (idx === -1) return null;
    this.entries[idx] = { ...this.entries[idx], content };
    FluxSession.initSchema(this.db);
    const stmt = this.db.prepare(
      `UPDATE flux_session_entries SET content = ? WHERE id = ?`,
    );
    stmt.run(content, id);
    stmt.finalize();
    return this.entries[idx];
  }
}

function fmtTime(iso: string): string {
  // Same date-time format the messages use, without the <t> wrapper —
  // that tag is the message-stamp convention; a system row is not a
  // message. Content identical, wrapper omitted.
  return formatMessageTimestamp(new Date(iso)).replace(/<\/?t>/g, "");
}
