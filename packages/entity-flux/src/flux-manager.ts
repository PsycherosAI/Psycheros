/**
 * FluxManager — the central orchestrator.
 *
 * Holds all the injected host capabilities plus the organs, the
 * continuous driver, and the thoughtstream puller. The host
 * (Psycheros) constructs one FluxManager when flux is enabled, wires
 * it in server.init(), starts it in server.start(), stops it in
 * server.stop().
 *
 * Follows the PulseEngine / WearableConnectionManager lifecycle
 * pattern: instantiate → wire via constructor → start/stop. Internal
 * services (organs, driver, thoughtstream) are owned here and
 * started/stopped together.
 */

import { join } from "@std/path";
import { runPromotionFilter } from "./promotion-filter.ts";
import { cosineSimilarity, Tier1Store } from "./tier1-store.ts";
import * as tier2 from "./tier2-store.ts";
// Display timezone — the host's general-settings policy (leaf import;
// flux is a psycheros subsystem).
import { getDisplayTimezone } from "../../psycheros/src/pulse/timezone.ts";
// The host's data-layout convention — one home for the folder name.
import { psycherosDir } from "../../psycheros/src/utils/paths.ts";
import {
  createSmallLLMRunner,
  type SmallLLMRunner,
} from "./small-llm-runner.ts";
import type { ThoughtstreamPuller } from "./thoughtstream.ts";
import { runFluxConsolidation } from "./consolidation.ts";
import { MoodOrgan } from "./mood-organ.ts";
import { DEFAULT_SENSORY_MODES, SituationDetector } from "./situation.ts";
import { PostureState } from "./posture.ts";
import type { SituationClassifier } from "./situation.ts";
import { applyAffinity } from "./mood-affinity.ts";
import { FluxDriver } from "./driver.ts";
import { Readiness } from "./readiness.ts";
import { Dreamer } from "./dreamer.ts";
import { Compaction } from "./compaction.ts";
import { DEFAULT_FAMILIARITY_CONFIG, Familiarity } from "./familiarity.ts";
import { type VolatileState, VolatileStateStore } from "./volatile-state.ts";
import { type NoticingBatch, Thalamus } from "./thalamus.ts";
import type { FluxHostConfig } from "./host.ts";
import type {
  FluxDurableEntry,
  FluxObservation,
  Organ,
  OrganEnvelope,
  PromotionThresholds,
  SensoryOrgan,
} from "./types.ts";

/** Static focus fallback when there's no recent user message to center on. */
const FOCUS_FALLBACK =
  "what is happening around me right now and what should I pay attention to";

/** How long to cache the focus embedding (ms). */
const FOCUS_CACHE_MS = 30_000;

/**
 * The musing voice layer: how far back my own sayings ride in context.
 * A day — long enough for a morning's wondering to survive the
 * afternoon, short enough that the layer is presence, not residue.
 */
const MUSING_VOICE_WINDOW_MS = 24 * 3_600_000;

/** The musing voice layer: how many of my sayings ride in context. */
const MUSING_VOICE_CAP = 6;

// =============================================================================
// FluxManager
// =============================================================================

/** Marker clock (user-facing posture rows): the display timezone's
 * date-time, matching the Flux State markers' format — the messages'
 * stamp format minus the <t> wrapper (a system row is not a message). */
function markerTime(): string {
  const tz = getDisplayTimezone();
  return new Date().toLocaleString("en-CA", {
    ...(tz ? { timeZone: tz } : {}),
    weekday: "short",
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).replace(",", "");
}

/** The startup settling window. Wakes that arrive inside it are queued
 * and flushed as ONE combined call — the noticing storm's observations
 * still land on tier-1 and the timeline (nothing is lost); only the
 * Ego-call count coalesces. */
const STARTUP_SETTLING_MS = 10_000;

/**
 * The mood-feedback text for one Ego generation: the reasoning trace
 * when the model produced one, the spoken reply otherwise (the
 * interior, not the performance). Source labels split so the ledger
 * can tell them apart.
 */
export function moodFeedbackText(
  utterance: { content: string; thinking: string | null },
): { text: string; source: "conscious-thinking" | "conscious-speech" } {
  const thinking = utterance.thinking?.trim();
  if (thinking) return { text: thinking, source: "conscious-thinking" };
  return { text: utterance.content, source: "conscious-speech" };
}

export class FluxManager {
  readonly settings;
  private tier1: Tier1Store;
  private sharedDb;
  private embed;
  private broadcaster;
  private memoryWriter;
  private memoryReader;
  private conversationReader;
  private chatRAG;
  private egoTrigger;
  private smallLLM: SmallLLMRunner;
  private thoughtstream: ThoughtstreamPuller | null;
  private driver: FluxDriver;
  /** Readiness — the Subconscious's shared timing sense. */
  private readiness: Readiness;
  /** Compaction — shared working-memory maintenance for all processes. */
  private compaction: Compaction;
  /** Familiarity — the shared pool behind habituation + satiation. */
  private familiarity: Familiarity;
  /** The consolidated volatile-state snapshot (restart containment). */
  private volatile: VolatileStateStore;
  /** The Thalamus — the Sensory subsystem's router (gate + batcher). */
  private thalamus: Thalamus;
  /** The Mood Organ — classical affective state (PAD). */
  private moodOrgan: MoodOrgan;
  /** Situation detection — the Thalamus's mode layer. */
  private situation: SituationDetector;
  /** The chosen posture (THE SPLIT): sleep is the entity's call via
   * the modulation bus — never classifier-forced. */
  private posture = new PostureState();
  /** The host's data root — Sensory Organ state files (the ride-along) live
   * under its .psycheros/organ-state/. */
  private readonly dataRootPath: string;
  /** User-facing posture markers (host seam; see FluxHostConfig). */
  private readonly recordSystemMessage?: (content: string) => void;
  /** The host-injected classifier; absent = situation detection inert. */
  private situationClassifier: SituationClassifier | undefined;
  /** The host-seam voice-call state on the host conversation (ONE
   *  MOUTH) — null when no call. See FluxHostConfig.voiceCallState. */
  private voiceCallState:
    | (() => "quiet" | "user-speaking" | "busy" | null)
    | undefined;
  /** The host-seam spontaneous-speech push — speak an already-generated
   *  Ego reply into the active call (the door passed during quiet). */
  private speakSpontaneous: ((text: string) => boolean) | undefined;

  // Dreams v1: the dreamer replaces waking Musing +
  // Reverie while sleeping. The manager owns the pace clock, the mood
  // feedback, and the wake summary; the Dreamer owns the dream's text
  // mechanics.
  private dreamer: Dreamer | null = null;
  /** The dreamer's chat fn — its own model hookup, worker fallback. */
  private readonly dreamChat: import("./runtime.ts").ChatFn;
  /** When the last dream fragment generated (ms epoch; 0 = none). */
  private lastDreamAt = 0;
  /** The fading carry from the last closed dream cycle. */
  private dreamCarry: string | null = null;

  // Startup settling: wakes inside the window queue here;
  // one combined wake flushes when it closes.
  private startupSettlesAt = 0;
  private pendingStartupWakes: Array<
    { contextQuery: string; sourceDescription: string }
  > = [];
  private settlingTimer: ReturnType<typeof setTimeout> | null = null;

  private organs = new Map<string, Organ>();
  private fluxSpaceId: string;
  /** The host conversation (conversation-hosted consciousness) — null
   * in legacy mode. Opaque to entity-flux beyond consolidation + status. */
  private readonly hostConvId: string | null;
  private started = false;

  // Focus-embedding cache.
  private focusEmbedding: number[] | null = null;
  private focusCachedAt = 0;

  // Temporary focus override (set by the pay_attention tool). When
  // active, this replaces the default focus (last user message) in
  // the promotion filter's relevance scoring. TTL-bounded.
  private focusOverride: { text: string; expiresAt: number } | null = null;

  // Mood ledger minute-tick (queryable history; see briefing mechanics).
  private moodLedgerTimer: ReturnType<typeof setInterval> | null = null;

  // Standing-attention directive — the entity's living note to itself
  // about what deserves attention. Loaded at startup, updatable at
  // runtime via tune_attention tool. Read live by the SmallLLMRunner
  // via getAttentionDirective().
  private attentionDirective: string | null = null;

  constructor(host: FluxHostConfig) {
    this.settings = host.settings;
    this.sharedDb = host.sharedDb;
    this.embed = host.embed;
    this.broadcaster = host.broadcaster;
    this.recordSystemMessage = host.recordSystemMessage;
    this.memoryWriter = host.memoryWriter;
    this.memoryReader = host.memoryReader;
    this.conversationReader = host.conversationReader;
    this.chatRAG = host.chatRAG;
    this.egoTrigger = host.egoTrigger;

    this.tier1 = new Tier1Store(
      join(psycherosDir(host.dataRoot), "flux-working.db"),
    );
    // Construct the Mood Organ before the small LLM runner so the runner
    // can capture a mood-getter that reads live state on each call.
    this.moodOrgan = new MoodOrgan(
      host.settings.moodDecayPerSec,
      host.settings.baselineDriftPerSec,
    );
    // Store the attention directive for live access by the SmallLLMRunner.
    this.attentionDirective = host.attentionDirective?.trim() || null;
    // Situation detection (mode layer): configured modes or the default
    // set; the classifier is host-injected and optional (absent = inert).
    this.situation = new SituationDetector(
      host.settings.sensoryModes?.length
        ? host.settings.sensoryModes
        : DEFAULT_SENSORY_MODES,
    );
    this.situationClassifier = host.situationClassifier;
    this.voiceCallState = host.voiceCallState;
    this.speakSpontaneous = host.speakSpontaneous;
    this.posture = new PostureState();
    this.dataRootPath = host.dataRoot;
    // Dreams v1: the dreamer drives its own chat directly (multi-turn
    // composition lives in the Dreamer; the runner's jobs are
    // single-shot). It rides the REVERIE hookup — dreams are a function
    // of reverie — with the shared worker as fallback.
    this.dreamChat = host.jobChats?.reverie ?? host.chat;
    this.smallLLM = createSmallLLMRunner(host.chat, {
      // Per-job model hookups: the host (psycheros) turns each settings
      // entry into a ChatFn. Jobs without an entry stay on the shared
      // chat fn — the fallback is the whole migration path.
      jobChats: host.jobChats,
      // Mood Organ specialist classifier (v1: GoEmotions + mood table).
      classifyMoodFn: host.classifyMood,
      // Universal mood-classifier cap: sized to the injected
      // classifier's window; 0 disables.
      moodClassifierMaxChars: host.settings.moodClassifierMaxChars ?? 2000,
      getAttentionDirective: () => this.attentionDirective,
      shorthandIdentity: host.settings.shorthandIdentity,
      getMoodRender: () => this.moodOrgan.renderFelt(),
      getTextureSummary: () => this.compaction.get("noticing").short,
      getLongformTexture: () => this.compaction.get("noticing").long,
      getReverieTexture: () => this.compaction.get("reverie").short,
      getReverieLongformTexture: () => this.compaction.get("reverie").long,
      // The voice layer — my own past murmurs/proposals carried into
      // every musing pass, so a thought can return instead of
      // evaporating.
      getRecentVoice: () => this.getRecentVoice(),
    });
    // Thoughtstream disabled: the cross-surface "overheard"
    // puller is dormant until its design is revisited — it's not a Sensory
    // Organ and its wiring predates the module map. The puller class,
    // driver branch, and settings field all stay; only construction is
    // off, so re-enabling is one line.
    this.thoughtstream = null;

    this.fluxSpaceId = loadOrCreateFluxSpaceId(host.dataRoot);
    this.hostConvId = host.hostConversationId ?? null;
    // Readiness: the Subconscious's shared timing
    // sense — its own pulse, cheap checks, no model calls until a
    // module is ripe. Bases inherit the existing cadence settings.
    this.readiness = new Readiness(
      {
        tier1: this.tier1,
        getMoodState: () => {
          const s = this.moodOrgan.getState();
          // The connection axis reads 0 until behavioral re-sourcing
          // returns it.
          return { arousal: s.arousal, connection: 0 };
        },
        msSinceOrganEvent: () => this.driver.msSinceOrganEvent(),
        msSinceUserActivity: () =>
          // A generating Ego turn counts as live conversation — remote
          // inference can take minutes (long generations, image gen),
          // and a murmur beside a still-forming reply steps on it.
          this.driver.isEgoTurnInFlight()
            ? 0
            : tier2.getLastUserEntryAt(this.sharedDb) === null
            ? null
            : Date.now() - (tier2.getLastUserEntryAt(this.sharedDb) ?? 0),
      },
      {
        musingBaseMs: host.settings.ambientSpeechMs,
        reverieBaseMs: host.settings.reverieCadenceMs,
      },
    );
    this.compaction = new Compaction(
      {
        tier1: this.tier1,
        smallLLM: this.smallLLM,
        getMoodRender: () => this.moodOrgan.renderFelt(),
        // Texture updates are ambient briefings — the session's rolling
        // window carries them; they never invoke the Ego.
        onTexture: (chain, kind, summary) => {
          this.flushVolatile();
          this.egoTrigger?.ambientBriefing?.(
            `[texture — ${chain} ${
              kind === "long" ? "hour arc" : "recent while"
            }]\n${summary}`,
            `compaction:${chain}`,
          );
        },
      },
      {
        cadenceMs: host.settings.compactionCadenceMs,
        longformCadenceMs: host.settings.longformCompactionCadenceMs,
      },
    );
    // Familiarity (self-regulation): the shared pool of
    // what was recently expressed. Habituation reads it from the wake
    // paths; Ego speech enters it via noteEgoSpeech. Same shared
    // embedder as everything else — never flux's own.
    this.familiarity = new Familiarity(
      host.embed,
      {
        halfLifeMs: host.settings.familiarityHalfLifeMs ??
          DEFAULT_FAMILIARITY_CONFIG.halfLifeMs,
        k: host.settings.familiarityTopK ??
          DEFAULT_FAMILIARITY_CONFIG.k,
        ratioThreshold: host.settings.familiarityRatioThreshold ??
          DEFAULT_FAMILIARITY_CONFIG.ratioThreshold,
        fullRatio: host.settings.familiarityFullRatio ??
          DEFAULT_FAMILIARITY_CONFIG.fullRatio,
        maxEntries: host.settings.familiarityMaxEntries ??
          DEFAULT_FAMILIARITY_CONFIG.maxEntries,
        minPoolSize: host.settings.familiarityMinPoolSize ??
          DEFAULT_FAMILIARITY_CONFIG.minPoolSize,
      },
    );
    // Seed from any textures the old inline fields carried (fresh start:
    // null — the chains rebuild on their first pass).
    // The Thalamus: the Sensory subsystem's
    // router. Organs → gate (pass-weighted / hold-counted / reflex) →
    // batcher (slots as max-wait; empty = no call) → Noticing batches.
    // Attention inputs read the SAME signals everything reads — no
    // private notion of relevance.
    this.thalamus = new Thalamus({
      // The ride-along: at flush, every fresh sense's
      // presence testifies. Gathered here (file IO stays manager-side,
      // the Thalamus stays pure): fresh state files only, red organs
      // silenced, presence never triggers a wake — it attends one.
      getPresence: () => this.gatherPresence(),
      slotMs: host.settings.thalamusSlotMs ?? 3_000,
      flushMass: host.settings.thalamusFlushMass ?? 1.6,
      reflexThreshold: host.settings.thalamusReflexThreshold ?? 0.7,
      holdCooldownMs: host.settings.thalamusHoldCooldownMs ?? 60_000,
      getAttention: () => ({
        directive: this.attentionDirective,
        focusOverride: this.focusOverride?.expiresAt &&
            this.focusOverride.expiresAt > Date.now()
          ? this.focusOverride.text
          : null,
      }),
      similarity: async (a, b) => {
        const [ea, eb] = await Promise.all([
          this.embed(a).catch(() => null),
          this.embed(b).catch(() => null),
        ]);
        if (!ea || !eb || ea.length !== eb.length) return 0;
        return cosineSimilarity(ea, eb);
      },
      onBatch: (batch) => this.consumeNoticingBatch(batch),
      onHoldStateChange: () => this.flushVolatile(),
      // Sensory Organ health: each tick's report broadcasts as SSE
      // (flux_organ_health) for the Flux page strip under the PAD meters.
      onHealthUpdate: (report) => {
        this.broadcaster.broadcastEvent(
          "flux_organ_health",
          { organs: report, timestamp: new Date().toISOString() },
          null,
        );
      },
    });
    this.driver = new FluxDriver(this);
    this.volatile = new VolatileStateStore(this.sharedDb);
  }

  /** The driver consults this each tick: is a Subconscious module ripe? */
  isReady(module: "musing" | "reverie"): boolean {
    return this.readiness.evaluate()[module];
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /** Whether the manager is currently running (ticking). The status
   * endpoint reads this — a stopped-but-not-destroyed manager (the
   * Ego's end_flux_state path) must not report "running". */
  get isRunning(): boolean {
    return this.started;
  }

  /** Start organs, driver, tier-1 cleanup. Idempotent. */
  start(): void {
    if (this.started) return;
    this.started = true;
    // The settling window: cold familiarity makes everything novel at
    // start; the resulting wake cluster coalesces into one call.
    this.startupSettlesAt = Date.now() + STARTUP_SETTLING_MS;
    this.pendingStartupWakes = [];
    this.settlingTimer = setTimeout(
      () => void this.flushStartupWakes(),
      STARTUP_SETTLING_MS,
    );
    // Restart containment: restore the volatile snapshot BEFORE the
    // driver starts ticking (await-ordered inside; the manager's start
    // stays sync for callers). Organs also start post-restore so the
    // Thalamus hold-states are live before the first envelope.
    void this.bootFromSnapshot().finally(() =>
      void this.seedMoodFromConversation()
    );

    // Warm the embedder so the first promotion check doesn't block on
    // the ~80MB model download.
    this.embed(FOCUS_FALLBACK).then((e) => {
      this.focusEmbedding = e;
      this.focusCachedAt = Date.now();
    }).catch(() => {/* host will surface embedder errors */});

    this.tier1.startCleanupTimer(this.settings.retentionDays);
    this.thalamus.start();

    // Mood ledger tick (briefing mechanics): one classical
    // sample per minute — the queryable history. Generation-linked
    // samples are recorded by the session at generate-time.
    this.moodLedgerTimer = setInterval(() => {
      this.egoTrigger?.recordMoodSample?.(this.moodOrgan.getState(), false);
    }, 60_000);

    for (const organ of this.organs.values()) {
      organ.start();
    }

    void this.driver.start({
      baseTickMs: this.settings.baseTickMs,
      minTickMs: this.settings.minTickMs,
      maxTickMs: this.settings.maxTickMs,
      arousalInfluence: this.settings.arousalInfluence,
      quietThresholdMs: this.settings.quietThresholdMs,
      ambientMs: this.settings.ambientSpeechMs,
      thoughtstreamMs: this.settings.thoughtstreamMs,
      compactionMs: this.settings.compactionCadenceMs,
      longformCompactionMs: this.settings.longformCompactionCadenceMs,
      reverieMs: this.settings.reverieCadenceMs,
    });
  }

  /**
   * Restore the volatile snapshot (await-ordered boot). The driver's
   * first tick must see restored cadences — fire-and-forget loses
   * this race (observed twice); organs/tick pieces that start inside
   * start() may run pre-restore once (safe — just eager), but the
   * flushes and hold-states land within milliseconds of boot.
   */
  private bootFromSnapshot(): Promise<void> {
    const snap = this.volatile.load();
    if (snap) {
      try {
        this.moodOrgan.restoreSnapshot(snap.mood);
        this.compaction.restoreSnapshot(snap.compaction ?? {});
        this.thalamus.restoreHoldStates(snap.thalamus ?? {});
        this.thalamus.restoreHealthSnapshot(snap.organHealth);
        if (snap.focus?.override) this.focusOverride = snap.focus.override;
        if (snap.focus?.embedding) {
          this.focusEmbedding = snap.focus.embedding;
          this.focusCachedAt = snap.focus.cachedAt ?? 0;
        }
        this.readiness.restoreSnapshot(snap.readiness ?? {});
        this.driver.restoreSnapshot(snap.driver ?? {});
        if (snap.posture) {
          this.posture.restore(snap.posture);
          // Dreams v1: a sleep that survives a restart keeps its lean
          // and resumes dreaming one interval later. The transcripts
          // don't survive — dreams fade; the next dream starts fresh.
          this.moodOrgan.setSleepDrift(this.posture.isSleeping);
          this.lastDreamAt = Date.now();
          this.broadcastMode();
        }
        this.familiarity.restoreSnapshot(snap.familiarity?.entries);
        console.log("[Flux] Volatile state restored (restart containment)");
      } catch (error) {
        console.warn(
          "[Flux] Volatile restore partial:",
          error instanceof Error ? error.message : String(error),
        );
      }
      this.volatile.dropLegacyTables();
    }
    // Sync body, Promise contract (the boot path chains .finally).
    return Promise.resolve();
  }

  /** Flush the consolidated volatile snapshot (call on every mutation). */
  private flushVolatile(): void {
    const snap: VolatileState = {
      savedAt: Date.now(),
      mood: this.moodOrgan.exportSnapshot(),
      compaction: this.compaction.exportSnapshot(),
      thalamus: this.thalamus.exportHoldStates(),
      organHealth: this.thalamus.exportHealthSnapshot(),
      familiarity: { entries: this.familiarity.exportSnapshot() },
      focus: {
        override: this.focusOverride ? { ...this.focusOverride } : null,
        embedding: this.focusEmbedding ? [...this.focusEmbedding] : null,
        cachedAt: this.focusCachedAt,
      },
      readiness: this.readiness.exportSnapshot(),
      driver: this.driver.exportSnapshot(),
      posture: this.posture.export(),
    };
    this.volatile.save(snap);
  }

  /** Stop organs, driver, tier-1 cleanup. Idempotent. Flushes the
   *  volatile snapshot so a graceful stop loses nothing. */
  stop(): void {
    if (!this.started) return;
    this.started = false;
    // The settling window closes with the stop; queued wakes drop —
    // their observations already landed on tier-1 and the timeline,
    // so nothing is lost but the deferred Ego calls themselves.
    if (this.settlingTimer !== null) clearTimeout(this.settlingTimer);
    this.settlingTimer = null;
    this.startupSettlesAt = 0;
    this.pendingStartupWakes = [];
    // STOPPING ENDS SLEEP: the Flux
    // State's stop is a full end of presence — the posture resets
    // BEFORE the final snapshot, so the next start begins awake. No
    // wake summary: stop is not waking, the night simply ends. (A
    // daemon crash/restart skips this path — the last snapshot keeps
    // the sleep, restart containment unchanged.)
    // Every step is guarded: a stop must never abort half-way. A thrown
    // child-kill inside one organ's stop once aborted the loop before the
    // organs after it ran — ghost organs probed on for days with the
    // manager gone (the escalating blind-flap storm of 2026-10-23..25).
    // The organ loop is unconditional, and one organ's failure stops
    // nothing but itself.
    const step = (name: string, fn: () => void): void => {
      try {
        fn();
      } catch (error) {
        console.error(
          `[Flux] stop step "${name}" failed (continuing):`,
          error instanceof Error ? error.message : String(error),
        );
      }
    };
    step("posture", () => this.posture.exitSleep());
    step("mood sleep drift", () => this.moodOrgan.setSleepDrift(false));
    this.dreamer = null;
    step("volatile snapshot", () => this.flushVolatile());
    step("driver", () => this.driver.stop());
    for (const organ of this.organs.values()) {
      step(`organ ${organ.config.id}`, () => organ.stop());
    }
    step("thalamus", () => this.thalamus.stop());
    step("tier-1 cleanup timer", () => this.tier1.stopCleanupTimer());
    if (this.moodLedgerTimer !== null) {
      clearInterval(this.moodLedgerTimer);
      this.moodLedgerTimer = null;
    }
    console.log("[Flux] Manager stopped");
  }

  /** Close the tier-1 database (called on server shutdown, after stop). */
  close(): void {
    this.tier1.close();
  }

  // ---------------------------------------------------------------------------
  // Organs
  // ---------------------------------------------------------------------------

  registerOrgan(organ: Organ): void {
    this.organs.set(organ.config.id, organ);
    // The Thalamus holds the sensorium's registry, including capability
    // flags the modulation router resolves against.
    // The modulation inlets live on the SENSORY contract, not the base
    // Organ (types.ts: "these inlets extend the sensory contract
    // specifically") — probe them through the extension view.
    const sensor = organ as SensoryOrgan;
    this.thalamus.register({
      organId: organ.config.id,
      type: organ.config.id.split("-")[0],
      capabilities: {
        takesDirectives: typeof sensor.receiveDirective === "function",
        hasControls: typeof sensor.applyControl === "function",
      },
      // Self-declared by the Sensory Organ (OrganConfig.healthProbeUrl)
      // — USB-flavored monitoring; the registration site knows nothing
      // about which sense is which.
      healthProbeUrl: organ.config.healthProbeUrl ?? null,
    });
    if (this.started && organ.config.enabled) organ.start();
  }

  /**
   * Host seam (browser eyes): one JPEG from a connected
   * app's camera, routed to the motion-vision Sensory Organ when it
   * runs its browser frame source. Returns false when there's no
   * motion-vision organ to receive it.
   */
  pushBrowserVideoFrame(jpeg: Uint8Array): boolean {
    const organ = this.organs.get("motion-vision") as
      | { pushBrowserFrame?(j: Uint8Array): void }
      | undefined;
    if (!organ?.pushBrowserFrame) return false;
    organ.pushBrowserFrame(jpeg);
    return true;
  }

  unregisterOrgan(id: string): void {
    const organ = this.organs.get(id);
    if (organ) {
      organ.stop();
      this.organs.delete(id);
      this.thalamus.unregister(id);
    }
  }

  // ---------------------------------------------------------------------------
  // Ingestion (called by organs via their sink)
  // ---------------------------------------------------------------------------

  /**
   * Receive a Sensory Organ envelope: mood-modifier ingestion and the reflex
   * tick stay PER-ENVELOPE (pre-noticing, by design), then the envelope
   * enters the THALAMUS GATE. Noticing no longer runs here — it runs
   * per-BATCH when the Thalamus flushes (see consumeNoticingBatch).
   */
  async ingestEnvelope(envelope: OrganEnvelope): Promise<void> {
    // Guard: ignore stale organ ticks that arrive after stop/pause.
    if (!this.started) return;
    // Embed the perception description for mood-source tracking. This
    // is the raw signal that caused any mood shift — the Mood Organ
    // uses it to derive the mood direction in embedding space.
    const perceptionEmbedding = await this.embed(
      envelope.perception.description,
    ).catch(() => undefined);

    // Mood modifiers flow into the Mood Organ regardless of whether the
    // noticing-layer annotation succeeds — mood shifts on signal, not on
    // successful LLM annotation of the signal. Declared modifiers get
    // host-side relationship weighting first: the Sensory Organ says WHO the
    // modifier is about (subject); settings say how much that subject
    // matters (faceAffinity). The Sensory Organ itself never holds relationship
    // knowledge.
    if (envelope.moodModifiers) {
      const now = Date.now();
      for (const mod of envelope.moodModifiers) {
        this.moodOrgan.ingest(
          perceptionEmbedding
            ? {
              ...applyAffinity(mod, this.settings.faceAffinity ?? {}),
              sourceEmbedding: perceptionEmbedding,
            }
            : applyAffinity(mod, this.settings.faceAffinity ?? {}),
          now,
        );
        this.flushVolatile();
      }
    } else {
      // Bottom-up mood, the USB-flavored half: the host offers affect
      // classification as a generic service to EVERY plugged-in organ —
      // any envelope that doesn't declare its own modifiers has its
      // description run through the Mood Organ's classifier (GoEmotions +
      // mood table) at observation weight. Opting out = declaring your
      // own modifiers. No organ names or type strings appear here; a
      // future audio organ gets felt-quality for free.
      void this.classifyPerceptionMood(
        envelope.organId,
        envelope.perception.description,
        perceptionEmbedding,
      );
    }
    // Urgency bypass: high-amplitude organ events bypass the adaptive
    // cadence and trigger an immediate tick. This is the reflex arc —
    // the Sensory Organ's local processor flagged something urgent, and the
    // system processes it now, not on the next scheduled tick.
    if (envelope.amplitude >= 0.7) {
      this.driver.requestImmediateTick();
    }
    // Into the Thalamus gate. Verdicts: pass (weighted) / hold (counted
    // — repetition becomes weight later) / reflex (passes AND flushes
    // the batch immediately). Noticing happens per-BATCH downstream.
    await this.thalamus.receive(envelope).catch((error) => {
      console.error(
        `[Thalamus] gate failed for ${envelope.organId}:`,
        error instanceof Error ? error.message : String(error),
      );
    });
  }

  /**
   * Consume a Noticing batch from the Thalamus — one small-model call
   * narrating the slot's arrivals TOGETHER (contextual noticing), then
   * embed + insert as one tier-1 observation. The batch's flushReason
   * rides into the observation's tags for later inspection.
   */
  private async consumeNoticingBatch(batch: NoticingBatch): Promise<void> {
    if (batch.envelopes.length === 0) return;
    try {
      const perceptions = batch.envelopes.map((e) => ({
        organId: e.envelope.organId,
        description: e.envelope.perception.description,
        weight: e.weight,
        heldCount: e.heldCount,
      }));
      const noticed = await this.smallLLM.noticeBatch(
        perceptions,
        batch.presence,
      );
      if (!noticed) return;
      const embedding = await this.embed(noticed.content).catch(() =>
        undefined
      );
      // Event marker for the wake path: a reflex-class batch (amplitude
      // ≥ the Thalamus reflex threshold, or an envelope in the batch at
      // that amplitude) is an EVENT — Familiarity never damps it (the
      // sneeze case: same scene, new event). Tags persist on the row;
      // the promotion path reads this back at wake time.
      const reflexEvent = batch.flushReason === "reflex" ||
        batch.envelopes.some((e) =>
          e.envelope.amplitude >= this.thalamus.getReflexThreshold()
        );
      // Declared novelty (generic USB service): any envelope may declare
      // `perception.data.surprise` (the scene baseline does —
      // contrast-normalized novelty of the caption against its stage). The
      // promotion filter multiplies it into effective salience so a
      // high-salience observation of a deeply familiar scene doesn't
      // escalate just because the small model is enamored of the subject.
      const surprises = batch.envelopes
        .map((e) => e.envelope.perception.data?.surprise)
        .filter((s): s is number =>
          typeof s === "number" && Number.isFinite(s)
        );
      const maxSurprise = surprises.length > 0 ? Math.max(...surprises) : null;
      // FULL PROVENANCE: a batch may weave envelopes from several Sensory
      // Organs into one contextual observation. The primary keeps the
      // batch's first organ (exact-match filters depend on it); the list
      // records every contributor (dropping all but the first is the
      // failure mode).
      const organIds = [
        ...new Set(batch.envelopes.map((e) => e.envelope.organId)),
      ];
      const observation: FluxObservation = {
        id: crypto.randomUUID(),
        timestamp: batch.flushedAt,
        sourceOrganId: organIds[0],
        sourceOrganIds: organIds,
        content: noticed.content,
        salience: noticed.salience,
        embedding,
        tags: [
          ...noticed.tags,
          `thalamus:${batch.flushReason}`,
          ...(reflexEvent ? ["event:reflex"] : []),
          ...(maxSurprise !== null
            ? [`surprise:${maxSurprise.toFixed(2)}`]
            : []),
        ],
        promoted: false,
      };
      this.tier1.insert(observation);
      // Direct engagement wakes the Ego: someone signaling at a sense
      // is an event, not a promotion-scored observation — the direct
      // requestWake bypasses the promotion filter's escalation bar
      // entirely (which sleep raises to 0.90 — combined scores
      // structurally can't reach it single-source). Not event-exempt —
      // an interpreted tag can be the same wrong guess many times, so
      // it clears novelty like every other interpreted signal (one
      // shared clock — engagement carries no private fast clock).
      // Sleep still doesn't hold it — the 0.90 salience floor meets
      // the posture bar — and a wake still doesn't end sleep: the
      // entity answers, then re-parks or wakes by choice.
      if (observation.tags.includes("signaling")) {
        // The cause posts to the timeline at wake time: a wake with no
        // visible cause reads as the Ego talking to nothing. The door
        // rules FIRST: the tint means "this woke the Ego", so a bid the
        // damper vetoes or sleep holds posts untinted, same shape as
        // every non-waking noticing. Order stays cause-before-reply —
        // requestWake fires the generation without awaiting it, and the
        // entry posts before any Ego output can land. Promotion later
        // reaching this observation skips the duplicate post.
        const woke = await this.requestWake(
          observation.content,
          // The one wire that promotes DIRECTLY from a sense — the
          // label names the organ it came from (owner's ruling
          // 2026-10-23); everything observation-carried names Noticing.
          `direct engagement (${observation.sourceOrganId}, signaling)`,
          { interior: false, salience: Math.max(observation.salience, 0.9) },
        );
        this.appendAmbient(observation.content, {
          salience: observation.salience,
          organId: observation.sourceOrganId,
          organIds: observation.sourceOrganIds ?? [observation.sourceOrganId],
          sourceObservationId: observation.id,
          escalated: woke,
        });
      }
      // Situation detection (the Thalamus's mode layer): the observation's
      // prose feeds the detector; evaluation is delta-driven (no wall
      // clocks) and completed transitions are announced. Inert without a
      // host-provided classifier.
      this.situation.note(observation.content);
      const modeChange = await this.situation.maybeEvaluate(
        this.situationClassifier,
      );
      if (modeChange) {
        console.log(
          `[Flux] sensory mode: ${
            modeChange.from ?? "unestablished"
          } → ${modeChange.to}`,
        );
        // Establishments stay silent: every restart would
        // otherwise announce "Flux mode: normal." — noise, and the Flux
        // Mode line already carries current state to the Ego each turn.
        // CHANGES announce in the system register, matching the
        // [Flux State started/stopped] markers.
        if (modeChange.from !== null) {
          this.appendAmbient(
            `[Flux mode changed: ${modeChange.from} → ${modeChange.to}]`,
            { organId: "thalamus", kind: "mode-change" },
          );
        }
        this.broadcastMode();
      }
    } catch (error) {
      console.error(
        `[Thalamus] batch noticing failed:`,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Promotion batch (called by the driver on its cadence)
  // ---------------------------------------------------------------------------

  /**
   * Run the promotion filter over recent unpromoted observations.
   * Promoted observations land in tier 2 (promoted-observations table
   * + an ambient durable entry on the Flux Space timeline) and emit a
   * toast. If one crosses the escalation threshold, trigger an Ego
   * turn. Returns the number promoted.
   */
  async runPromotionBatch(): Promise<number> {
    const sinceISO = new Date(
      Date.now() - this.settings.promotionThresholds.corroborationWindowMs * 2,
    ).toISOString();
    const unpromoted = this.tier1.queryUnpromoted(50, sinceISO, {
      excludeSource: "reverie",
    });
    if (unpromoted.length === 0) return 0;

    const focus = await this.getFocusEmbedding();
    // Posture-aware thresholds (THE SPLIT): while sleeping, the
    // escalation bar rises — fewer things even reach the wake door.
    const thresholds = this.posture.isSleeping
      ? {
        ...this.settings.promotionThresholds,
        escalation: this.posture.effectiveEscalationThreshold(
          this.settings.promotionThresholds.escalation,
        ),
      }
      : this.settings.promotionThresholds;
    const result = runPromotionFilter(
      unpromoted,
      focus,
      thresholds,
      (emb, threshold, since) =>
        this.tier1.querySimilar(emb, threshold, since, 10, {
          excludeSource: "reverie",
        }),
    );

    for (const { observation, combinedScore, reason } of result.promoted) {
      this.tier1.markPromoted(observation.id);

      tier2.insertPromotedObservation(this.sharedDb, {
        id: crypto.randomUUID(),
        timestamp: observation.timestamp,
        originalObservationId: observation.id,
        content: observation.content,
        salience: combinedScore,
        promotionReason: reason,
      });

      // The escalation target (if any) is inside this loop's batch, but
      // its timeline entry posts BELOW, after the wake door rules — the
      // tint means "this woke the Ego", and the door can veto
      // (Familiarity) or hold (sleep). Every other promoted
      // observation posts here, untinted.
      const isEscalationTarget =
        result.escalateToEgo?.observation.id === observation.id;
      const alreadyPosted = tier2.hasDurableEntryForObservation(
        this.sharedDb,
        observation.id,
      );
      if (!isEscalationTarget && !alreadyPosted) {
        this.appendAmbient(observation.content, {
          salience: combinedScore,
          organId: observation.sourceOrganId,
          // Full provenance on the timeline row too (mixed batches show
          // every contributing organ; UI renders the module label, the
          // list rides for detail/tooltip + future display).
          organIds: observation.sourceOrganIds ?? [observation.sourceOrganId],
          sourceObservationId: observation.id,
          escalated: false,
        });
      }

      // No toast here — promoted observations land on the timeline
      // silently. Toasts are reserved for escalations (below), the
      // "this is worth interrupting the user for" signal.
    }

    if (result.escalateToEgo && this.egoTrigger) {
      const { observation, combinedScore } = result.escalateToEgo;
      // Through the universal wake door — satiation only for exterior
      // sources (corroboration upstream already vouches for the
      // observation; only don't-wake-twice applies), and event-class
      // observations (reflex-tagged at noticing time) are exempt from
      // damping entirely — the sneeze case.
      const woke = await this.requestWake(
        observation.content,
        // The promotion filter escalates NOTICING observations — the
        // wake briefing names the module that picked this up (owner's
        // ruling 2026-10-23: he hears Noticing as Noticing).
        `noticing escalation (salience ${combinedScore.toFixed(2)})`,
        {
          interior: false,
          salience: combinedScore,
          eventTag: observation.tags.includes("event:reflex"),
        },
      );
      // The cause posts with the door's verdict — escalated means "this
      // woke the Ego". The signaling wire may have posted this
      // observation untinted (its own bid was damped); a promotion wake
      // that fires now flips that row instead of duplicating the post
      // (the tier-2 row is still the durable record).
      const posted = tier2.hasDurableEntryForObservation(
        this.sharedDb,
        observation.id,
      );
      if (woke && posted) {
        const flipped = tier2.escalateDurableEntryForObservation(
          this.sharedDb,
          observation.id,
        );
        if (flipped) this.broadcastEntry(flipped);
      } else if (!posted) {
        this.appendAmbient(observation.content, {
          salience: combinedScore,
          organId: observation.sourceOrganId,
          organIds: observation.sourceOrganIds ?? [observation.sourceOrganId],
          sourceObservationId: observation.id,
          escalated: woke,
        });
      }
      if (woke) {
        this.emitToast("escalation", observation.content, combinedScore);
      }
    }

    return result.promoted.length;
  }

  // ---------------------------------------------------------------------------
  // Focus embedding (cached, refreshed from recent user message)
  // ---------------------------------------------------------------------------

  private async getFocusEmbedding(): Promise<number[]> {
    if (
      this.focusEmbedding &&
      Date.now() - this.focusCachedAt < FOCUS_CACHE_MS
    ) {
      return this.focusEmbedding;
    }

    const focusText = this.computeFocusText();
    try {
      this.focusEmbedding = await this.embed(focusText);
      this.focusCachedAt = Date.now();
      return this.focusEmbedding;
    } catch {
      // Fall back to whatever we last had, or a zero vector.
      return this.focusEmbedding ?? new Array(384).fill(0);
    }
  }

  /**
   * Focus = the active override (if set by pay_attention and not expired),
   * else the last user message in the Flux Space, else the last user
   * message in any classic conversation, else the static fallback.
   */
  private computeFocusText(): string {
    // Check for an active focus override first.
    if (this.focusOverride && Date.now() < this.focusOverride.expiresAt) {
      return this.focusOverride.text;
    }
    // Expired override — clear it.
    if (this.focusOverride && Date.now() >= this.focusOverride.expiresAt) {
      this.focusOverride = null;
    }

    const entries = tier2.getRecentDurableEntries(this.sharedDb, 8);
    const lastUserFlux = [...entries].reverse().find((e) => e.role === "user");
    if (lastUserFlux) return lastUserFlux.content;

    if (this.conversationReader) {
      const actives = this.conversationReader.listActiveConversations(
        new Date(Date.now() - 3_600_000).toISOString(),
      );
      for (const conv of actives.slice(0, 3)) {
        const msgs = this.conversationReader.getRecentMessages(conv.id, 4);
        const lastUser = [...msgs].reverse().find((m) => m.role === "user");
        if (lastUser) return lastUser.content;
      }
    }

    return FOCUS_FALLBACK;
  }

  // ---------------------------------------------------------------------------
  // Flux Space durable stream
  // ---------------------------------------------------------------------------

  /** The Flux Space conversation ID (stable, persisted). */
  get fluxSpaceConversationId(): string {
    return this.fluxSpaceId;
  }

  /** The host conversation the Ego's dialogue record lives in (null in
   * legacy mode — dialogue then targets the resolved Flux Space). */
  get hostConversationId(): string | null {
    return this.hostConvId;
  }

  /** Post a user message to the Flux Space. Returns the entry. */
  /**
   * A Pulse fired into the HOST conversation: enters the
   * session as a user-class turn — one assistant turn through his
   * continuous consciousness, recorded in the host with classic pulse
   * rendering metadata. Prevents the classic episodic path from forking
   * a second Ego turn into a hosted conversation.
   */
  postPulseMessage(
    content: string,
    pulseMeta: { pulseId?: string; pulseName?: string },
  ): void {
    void this.classifyUserMessageMood(content);
    this.driver.requestEgoTurn(
      content,
      `pulse "${pulseMeta.pulseName ?? "unnamed"}"`,
      pulseMeta,
    );
    this.driver.requestImmediateTick();
  }

  postUserMessage(content: string): void {
    // Storage alignment: the user message's RECORD is the messages table
    // (recordUserMessage hook). No durable write — durable held dialogue
    // pre-session and double-rendered. Broadcast still fires for the
    // live timeline.
    // The user's words land in the Mood Organ immediately — before the
    // Ego responds. Until now mood moved only from the entity's own
    // output (body language); this is the other half of the relational
    // loop: what the user says shifts how the entity feels, which then
    // colors the response it's about to give. Same classifier (v1:
    // GoEmotions + mood table), weight 0.4 matching spoken Ego output.
    void this.classifyUserMessageMood(content);
    // Queue the user-message Ego turn and request immediate processing
    // so the entity responds promptly.
    this.driver.requestEgoTurn(content, "user message in Flux Space");
    this.driver.requestImmediateTick();
  }

  /** Classify a user message and ingest it into the Mood Organ. */
  private async classifyUserMessageMood(content: string): Promise<void> {
    try {
      const deltas = await this.smallLLM.classifyMood(content);
      if (!deltas) return;
      const embedding = await this.embed(content).catch(() => undefined);
      this.moodOrgan.ingest({
        ...deltas,
        weight: 0.4,
        source: "user-message",
        sourceEmbedding: embedding,
      });
    } catch {
      // Non-fatal — mood classification is a bonus, not critical.
    }
  }

  /** Last perception description classified — identical consecutive
   * descriptions don't re-shift mood (ratchet guard; habituation upstream
   * already thins repeat emissions, this closes the gap). */
  private lastClassifiedPerception: string | null = null;

  /**
   * Classify a perception description and ingest it into the Mood Organ —
   * the generic bottom-up mood service: what the entity PERCEIVED (a
   * dropped plate, a relaxed evening, a dim cozy room) moves how it feels.
   * Weight 0.2: observed text is one step less personal than addressed
   * text. Null deltas (classifier unavailable, or nothing crossed the
   * label threshold) = no shift, never an error.
   */
  private async classifyPerceptionMood(
    organId: string,
    description: string,
    embedding?: number[],
  ): Promise<void> {
    try {
      const norm = description.toLowerCase().replace(/\s+/g, " ").trim();
      if (!norm || norm === this.lastClassifiedPerception) return;
      const deltas = await this.smallLLM.classifyMood(description);
      if (!deltas) {
        // Affectless descriptions count as seen — don't re-classify repeats.
        this.lastClassifiedPerception = norm;
        return;
      }
      this.lastClassifiedPerception = norm;
      this.moodOrgan.ingest({
        ...deltas,
        weight: 0.2,
        source: `perception:${organId}`,
        ...(embedding ? { sourceEmbedding: embedding } : {}),
      });
      this.flushVolatile();
    } catch {
      // Non-fatal — perception mood is a bonus, not critical.
    }
  }

  /** Record an entity (Ego-model) response in the Flux Space. */
  addEntityResponse(content: string): FluxDurableEntry {
    const entry = this.durableEntry("entity", content);
    tier2.insertDurableEntry(this.sharedDb, entry);
    this.broadcastEntry(entry);
    return entry;
  }

  /**
   * Record an ambient entry (promoted observation or thoughtstream
   * summary). Returns the entry.
   */
  /**
   * The ride-along gatherer: every registered organ's
   * presence state file, filtered to the trustworthy. A sense testifies
   * when its state file exists, parses, carries a caption, and is fresh
   * (5 min — presence certifies itself by its own timestamp; red organs
   * excluded as belt-and-suspenders). Returns lines for every
   * qualifying organ INCLUDING ones in the current batch — presence is
   * the moment's whole texture, not just "other" senses.
   */
  private gatherPresence(): Array<{ organId: string; line: string }> {
    const red = new Set(
      this.thalamus.healthReport()
        .filter((r) => r.health.state === "red")
        .map((r) => r.organId),
    );
    const lines: Array<{ organId: string; line: string }> = [];
    for (const organId of this.organs.keys()) {
      if (red.has(organId)) continue;
      try {
        const path = join(
          psycherosDir(this.dataRootPath),
          "organ-state",
          `${organId}.json`,
        );
        const raw = Deno.readTextFileSync(path);
        const state = JSON.parse(raw) as {
          caption?: unknown;
          timestamp?: unknown;
        };
        if (typeof state.caption !== "string" || !state.caption.trim()) {
          continue;
        }
        const at = typeof state.timestamp === "string"
          ? new Date(state.timestamp).getTime()
          : Number.NaN;
        if (!Number.isFinite(at) || Date.now() - at > 300_000) continue;
        lines.push({ organId, line: state.caption.trim() });
      } catch {
        // No state file / unreadable — that sense stays silent.
      }
    }
    return lines;
  }

  /** The current sensory mode: the chosen posture first (sleep is the
   * entity's state, the headline), else the detected situation. */
  getSensoryMode(): string | null {
    if (this.posture.isSleeping) return "sleep";
    return this.situation.mode;
  }

  /** Enter the sleep posture (the sleep tool). False if already asleep. */
  enterSleep(): boolean {
    const entered = this.posture.enterSleep();
    if (entered) {
      console.log("[Flux] posture: sleep (entity-chosen)");
      this.recordSystemMessage?.("[Sleep at " + markerTime() + "]");
      // Dreams v1: the night's interior begins. Arousal gets its
      // downward lean; the dream clock starts (first fragment after
      // one pace interval — sleep doesn't dream instantly).
      this.moodOrgan.setSleepDrift(true);
      this.lastDreamAt = Date.now();
      this.dreamCarry = null;
      this.broadcastMode();
      this.appendAmbient("[Flux: I am going to sleep]", {
        organId: "thalamus",
        kind: "posture",
      });
      this.flushVolatile();
    }
    return entered;
  }

  /**
   * Leave the sleep posture (the wake_up tool). Summarizes the night's
   * dreams — a couple of plain sentences plus "I feel <felt-sense>" —
   * posts them to the timeline as the dream entry, and returns the
   * briefing for the waking tool result. `exited` false if already
   * awake; `dreamBriefing` null on a dreamless night.
   */
  async exitSleep(): Promise<
    { exited: boolean; dreamBriefing: string | null }
  > {
    const exited = this.posture.exitSleep();
    if (!exited) return { exited: false, dreamBriefing: null };
    console.log("[Flux] posture: awake (entity-chosen)");
    this.recordSystemMessage?.("[Woke at " + markerTime() + "]");
    this.moodOrgan.setSleepDrift(false);
    this.broadcastMode();
    this.appendAmbient("[Flux: I am awake]", {
      organId: "thalamus",
      kind: "posture",
    });
    let dreamBriefing: string | null = null;
    if (this.dreamer?.hasDreamed) {
      const summary = await this.dreamer.summarize();
      if (summary) {
        dreamBriefing = `${summary}\n\nI feel ${this.moodOrgan.feltSense()}.`;
        this.appendAmbient(dreamBriefing, {
          organId: "dream",
          kind: "dream",
        });
      }
    }
    this.dreamer = null;
    this.dreamCarry = null;
    this.lastDreamAt = 0;
    this.flushVolatile();
    return { exited: true, dreamBriefing };
  }

  /**
   * Mood-at-start (recent exchanges, not the last message alone — the
   * freshest message can read bland-positive while the exchange that
   * matters is one back): when
   * Flux starts, the mood STATE seeds from a RECENCY-WEIGHTED read of
   * the dialogue conversation's recent messages — up to the last 8
   * user/entity messages, each classified through the same GoEmotions
   * seam as live turns, weight decaying ×0.65 per message back (the
   * fresh matters most; grief one exchange back still dominates a
   * pleasantry). Baseline untouched; no messages / no classifications
   * → the snapshot mood stands.
   */
  private async seedMoodFromConversation(): Promise<void> {
    if (!this.conversationReader) return;
    const convId = this.hostConvId ?? this.fluxSpaceId;
    if (!convId) return;
    try {
      const msgs = this.conversationReader.getRecentMessages(convId, 12)
        .filter((m) => m.role === "user" || m.role === "assistant")
        .slice(-8);
      if (msgs.length === 0) return;
      const seed: Partial<
        Record<"valence" | "arousal" | "dominance", number>
      > = {};
      let scored = 0;
      // Oldest → newest, weight rising toward the present: the freshest
      // message weighs 1.0, each step back ×0.65.
      for (let i = 0; i < msgs.length; i++) {
        const weight = Math.pow(0.65, msgs.length - 1 - i);
        const deltas = await this.smallLLM.classifyMood(msgs[i].content);
        if (!deltas) continue;
        scored++;
        for (const key of ["valence", "arousal", "dominance"] as const) {
          const v = deltas[key];
          if (v === undefined) continue;
          seed[key] = (seed[key] ?? 0) + v * weight;
        }
      }
      if (scored === 0 || Object.keys(seed).length === 0) return;
      this.moodOrgan.seedState(seed);
      console.log(
        `[Flux] mood seeded from the last ${scored} message(s): ${
          Object.entries(seed).map(([k, v]) =>
            `${k} ${(v as number).toFixed(2)}`
          ).join(", ")
        }`,
      );
    } catch {
      // Non-fatal — the snapshot mood stands.
    }
  }

  /** Whether the sleep posture is active (dreams v1: driver gating). */
  isSleeping(): boolean {
    return this.posture.isSleeping;
  }

  /**
   * The light moment at the top of a sleep cycle — the sanctioned,
   * undamped decision point. The entity always gets it between cycles;
   * it arrives fast when the night runs hot and slow when it's calm
   * (the mood-set pace is the same dial). Dreams v2: the wake returns
   * INTO the open sleep call, and the return carries the WHOLE
   * completed dream (raw fragments, so the wake-or-drift decision is
   * made knowing what was just dreamt). The
   * briefing stays short: truncated presence lines only.
   */
  private deliverSleepCycleTop(cycles: number, fragments: string[]): void {
    this.appendAmbient(
      `[Sleep: cycle ${cycles} complete]`,
      { organId: "thalamus", kind: "sleep-cycle" },
    );
    // Presence lines truncated — whole captions are unreadable
    // briefing noise.
    const presence = this.gatherPresence()
      .map((l) => `${l.organId} — ${l.line.slice(0, 80)}`)
      .join("; ") || "quiet";
    this.driver.requestEgoWake(
      `The top of sleep cycle ${cycles} — a light moment between cycles. My senses say: ${presence}. I've slept ${
        cycles === 1 ? "1 cycle" : `${cycles} cycles`
      }. I can call sleep to drift back under, or wake fully with sleep {wake: true}.`,
      "sleep cycle decision point",
      { kind: "light-moment", fragments, cycles },
    );
    this.flushVolatile();
  }

  /**
   * Dreams v1: whether a dream fragment is due. The interval is the
   * pace base scaled by arousal — calm stretches it toward 1.5×
   * (deeper sleep), a worked-up interior quickens it toward 0.5×
   * (shorter, hotter cycles). No clamps: mood is the only dial.
   */
  isDreamDue(): boolean {
    if (!this.posture.isSleeping) return false;
    if (this.lastDreamAt === 0) return true;
    const arousal = this.moodOrgan.getState().arousal;
    const interval = this.settings.dreamPaceMs * (1 - 0.5 * arousal);
    return Date.now() - this.lastDreamAt >= interval;
  }

  /**
   * Dreams v1: generate one dream fragment — the forced dreaming beat.
   * The Dreamer owns the text mechanics; here: the seed on a fresh
   * cycle (mood-directed day residue + the faded carry), the fragment's
   * mood feedback (GoEmotions, waking-reverie weight — "a shitty dream
   * can fuck you up for three hours"), the
   * fragment clock, and the cycle-top light moment. A failed fragment
   * is a skipped beat — the dream resumes on its next due interval.
   */
  async runDreamFragment(): Promise<void> {
    if (!this.posture.isSleeping) return;
    this.dreamer ??= new Dreamer(
      this.dreamChat,
      () => this.moodOrgan.feltSense(),
    );
    if (!this.dreamer.cycleOpen) {
      const seed = await this.gatherReverieContext();
      this.dreamer.beginCycle(seed, this.dreamCarry);
    }
    // The associative walk: from the second fragment on, this beat's
    // material is retrieved against the previous fragment's imagery —
    // the dream drifts THROUGH the day's material, not away from it.
    const anchor = this.dreamer.previousFragment();
    const material = anchor === null
      ? undefined // the opening beat dreams on the cycle seed
      : await this.gatherReverieContext(
        anchor,
        await this.embed(anchor).catch(() => undefined),
      );
    const fragment = await this.dreamer.nextFragment(material);
    this.lastDreamAt = Date.now();
    if (fragment === null) return;

    // Visible on the timeline as it generates — the night is
    // watchable, not silent until a marker.
    this.appendAmbient(fragment, {
      organId: "dream",
      kind: "dream-fragment",
    });

    // Mood is the loop: the fragment classifies and feeds the Sensory Organ at
    // waking-reverie weight; the NEXT beat's "I am <felt-sense>" line
    // is generated from inside the mood this one just made.
    try {
      const moodDeltas = await this.smallLLM.classifyMood(fragment);
      if (moodDeltas) {
        this.moodOrgan.ingest({
          ...moodDeltas,
          weight: 0.3,
          source: "dream",
        });
      }
    } catch {
      // Non-fatal — mood classification is a bonus.
    }

    const pass = this.posture.noteDreamFragment(
      this.settings.dreamCycleFragments,
    );
    if (pass.kind === "cycle-top") {
      // Fresh dream per cycle, faded carry: close this dream, keep its
      // whisper for the next — and hand the whole dream to the light
      // moment's return.
      const closed = this.dreamer.closeCycle();
      this.dreamCarry = closed?.carryToNext ?? null;
      this.deliverSleepCycleTop(pass.cycles, closed?.fragments ?? []);
    }
    this.flushVolatile();
  }

  /**
   * DEBUG: promote a synthetic line through the
   * REAL promotion path — timeline entry with the module's tint, then the
   * universal wake door (interior; satiation applies). For testing where
   * Ego wakes land in the UI. Remove when the tuning talk lands.
   */
  async debugPromote(
    source: "musing" | "reverie" | "noticing",
    content: string,
  ): Promise<{ woke: boolean }> {
    // Door first — the tint and kind reflect the verdict (a damped
    // debug proposal renders as a plain murmur, like the real path).
    const woke = await this.requestWake(
      content,
      `debug promotion (${source})`,
      {
        interior: true,
        salience: 0.75,
      },
    );
    this.appendAmbient(content, {
      organId: source,
      kind: source === "musing" ? (woke ? "propose" : "murmur") : "escalated",
      escalated: woke,
    });
    return { woke };
  }

  /** The most recent dream fragment (engagement returns carry it as
   * "I was dreaming: …"), or null before the first. */
  getLatestDreamFragment(): string | null {
    return this.dreamer?.latestFragment() ?? null;
  }

  /**
   * Broadcast the effective mode (posture-first) for at-a-glance UI —
   * so nobody wonders why the entity
   * behaves a certain way. Called on posture changes, situation
   * changes, and after volatile restore.
   */
  broadcastMode(): void {
    this.broadcaster.broadcastEvent(
      "flux_mode",
      { mode: this.getSensoryMode(), timestamp: new Date().toISOString() },
      null,
    );
  }

  /** Current posture + cycles, for status/tool results. */
  getPosture(): { posture: "awake" | "sleep"; sleepCycles: number } {
    return {
      posture: this.posture.posture,
      sleepCycles: this.posture.sleepCycles,
    };
  }

  appendAmbient(
    content: string,
    meta?: {
      salience?: number;
      organId?: string;
      sourceObservationId?: string;
      sourceConversationId?: string;
      /** Free-form extra metadata (e.g. musing kind: murmur/propose). */
      [key: string]: unknown;
    },
  ): FluxDurableEntry | null {
    const entry: FluxDurableEntry = {
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      role: "ambient",
      content,
      sourceObservationId: meta?.sourceObservationId,
      sourceConversationId: meta?.sourceConversationId,
      metadata: meta
        ? {
          ...(meta.salience !== undefined ? { salience: meta.salience } : {}),
          ...(meta.organId ? { organId: meta.organId } : {}),
          // Carry the rest of the caller's meta through — escalated
          // (the tint), kind (musing murmur/propose), anything an
          // organ or the surface path attaches. Dropping keys here
          // silently breaks UI features keyed on them (the promotion
          // tint going missing, for instance).
          ...(meta as Record<string, unknown>),
        }
        : undefined,
    };
    const inserted = tier2.insertDurableEntry(this.sharedDb, entry);
    if (!inserted) {
      // The same observation already holds a row (the double-post
      // race lost to the other writer): no broadcast, no ambient
      // briefing — the surviving row already carries both. My caller's
      // own degrade paths have run; only this row's carriage is
      // dropped.
      return null;
    }
    this.broadcastEntry(entry);
    // Ambient briefing (briefing mechanics): timeline
    // entries are remember-not-wake context — they ride the session's
    // rolling window without invoking the Ego.
    if (this.egoTrigger?.ambientBriefing) {
      try {
        // SOURCE TRUTH (owner's ruling 2026-10-23): observation-carried
        // entries are NOTICING's woven output — the briefing names the
        // module that shaped the thought, never the organ that saw the
        // light (the organ stays in the row's metadata for the timeline
        // + detail). Everything else keeps its module label (musing,
        // reverie, thalamus, …). Without this, Noticing is nameless —
        // its observations read as raw organ streams.
        this.egoTrigger.ambientBriefing(
          content,
          meta?.sourceObservationId ? "noticing" : meta?.organId ?? "timeline",
        );
      } catch {
        // Non-fatal — the timeline entry still landed.
      }
    }
    return entry;
  }

  /** Recent timeline entries (for the UI on load). Oldest-first. */
  getRecentEntries(limit: number): FluxDurableEntry[] {
    return tier2.getRecentDurableEntries(this.sharedDb, limit);
  }

  /** Entries newer than a timestamp (for live SSE append). */
  getEntriesSince(sinceISO: string): FluxDurableEntry[] {
    return tier2.getDurableEntriesSince(this.sharedDb, sinceISO);
  }

  /** Whether a user message is pending (the driver checks this). */
  pendingUserMessage(sinceISO: string): FluxDurableEntry | null {
    return tier2.hasPendingUserMessage(this.sharedDb, sinceISO);
  }

  // ---------------------------------------------------------------------------
  // Musing (called by the driver on the musing cadence)
  // ---------------------------------------------------------------------------

  /**
   * The musing voice layer: my own recent sayings —
   * murmurs and proposals from the timeline — formatted for the system
   * prompt. Without this, every musing pass was its first; with it, a
   * wondering can return, be answered by the world, or be changed.
   * Timestamps render in the display timezone — the same clock the
   * session sees, zero drift.
   */
  private getRecentVoice(): string | null {
    const since = new Date(Date.now() - MUSING_VOICE_WINDOW_MS).toISOString();
    const entries = tier2.getRecentMusingEntries(
      this.sharedDb,
      since,
      MUSING_VOICE_CAP,
    );
    if (entries.length === 0) return null;
    const tz = getDisplayTimezone();
    const fmt = (e: FluxDurableEntry) => {
      const t = new Date(e.timestamp);
      const day = t.toLocaleDateString("en-US", {
        weekday: "short",
        timeZone: tz,
      });
      const time = t.toLocaleString("en-US", {
        hour: "2-digit",
        minute: "2-digit",
        timeZone: tz,
      });
      const kind = typeof e.metadata?.kind === "string"
        ? ` ${e.metadata.kind}`
        : "";
      return `[${day} ${time}${kind}] ${e.content}`;
    };
    return entries.map(fmt).join("\n");
  }

  /**
   * Run one musing pass — the voice across time, seeing both streams.
   * Silence: nothing happens. Murmur: the entry lands on the Flux Space
   * timeline (organId "musing"). Propose: the murmur still lands, and
   * the Ego model is woken with the proposal as its RAG context —
   * same path as reverie initiative. The Ego check-in's
   * silence-is-valid contract governs whether the user is actually
   * addressed; the toast belongs to that turn, not the proposal.
   */
  async runMusing(): Promise<"silent" | "murmur" | "propose"> {
    const sinceISO = new Date(Date.now() - 600_000).toISOString();
    const exterior = this.tier1.queryTopSalient(12, sinceISO, {
      excludeSource: "reverie",
    });
    const interior = this.tier1.queryTopSalient(6, sinceISO, {
      onlySource: "reverie",
    });
    const retrieval = await this.gatherMusingRetrieval(exterior);
    const musing = await this.smallLLM.muse(exterior, interior, retrieval);
    // Readiness learns the outcome: genuinely speaking satisfies the
    // monologue for a while; silence does not.
    this.readiness.noteMusingRan();
    // Silent runs log like reverie's — without the line, silence's
    // cost is invisible (murmurs/proposals get lines, silence
    // doesn't), and quiet-evening billing goes uncounted.
    if (!musing) {
      console.log("[Flux] musing — nothing surfaced");
      return "silent";
    }
    this.readiness.noteMusingSpoke(musing.kind === "propose");

    // A proposal that wakes gets the escalate tint; one the wake door
    // damps degrades to a murmur on the timeline — nothing lost, only
    // volume controlled (the universal-door contract).
    let woke = false;
    if (musing.kind === "propose" && this.egoTrigger) {
      woke = await this.requestWake(musing.content, `musing proposal`, {
        interior: true,
        salience: 0.75, // categorical judgment; the door applies novelty
      });
    }

    this.appendAmbient(musing.content, {
      organId: "musing",
      // kind (murmur|propose) and escalated (propose wakes the Ego) —
      // escalated is the timeline's significance tint, uniform across
      // all Subconscious sources. A damped proposal renders as a plain
      // murmur: it didn't wake the Ego.
      kind: woke ? "propose" : "murmur",
      escalated: woke,
    });
    console.log(
      `[Flux] musing (${woke ? "propose" : "murmur"}) — ${
        musing.content.slice(0, 80)
      }${musing.content.length > 80 ? "…" : ""}`,
    );
    return musing.kind;
  }

  /**
   * Run one Ego-model cognition turn targeting the Flux Space.
   * Called by the driver when a user message or an escalation is
   * pending. Records the response as a durable entry. No-op when no
   * Ego trigger is wired (MCP/host not providing one).
   */
  async runEgoTurn(
    prompt: string,
    sourceDescription: string,
    pulseMeta?: { pulseId?: string; pulseName?: string },
  ): Promise<void> {
    if (!this.egoTrigger) {
      console.log(
        `[Flux] Ego turn skipped (no trigger): ${sourceDescription}`,
      );
      return;
    }
    console.log(`[Flux] Ego turn — ${sourceDescription}`);
    try {
      const utterance = await this.egoTrigger.triggerFluxTurn(
        prompt,
        sourceDescription,
        pulseMeta,
      );
      const response = utterance.content;
      // NOTE: no durable mirror — the session log IS the timeline record
      // for ego speech (durable-entity rows double-rendered every
      // generation). Mood classification below reads the response text
      // directly and needs no durable row.
      if (response.trim()) {
        // Classify the entity's own emotional output and feed it to the
        // Mood Organ. THE INTERIOR, NOT THE PERFORMANCE: the
        // reasoning trace is scored when the
        // model produced one — the visible reply is a composed surface
        // (steady support reads warm while the entity is wrecked); the
        // thinking is where the felt reaction lives. Speech is the
        // fallback when no reasoning exists.
        const feedback = moodFeedbackText(utterance);
        try {
          const moodDeltas = await this.smallLLM.classifyMood(feedback.text);
          if (moodDeltas) {
            const responseEmbedding = await this.embed(feedback.text).catch(
              () => undefined,
            );
            this.moodOrgan.ingest({
              ...moodDeltas,
              weight: 0.4,
              source: feedback.source,
              sourceEmbedding: responseEmbedding,
            });
          }
        } catch {
          // Non-fatal — mood classification is a bonus, not critical.
        }
      }
    } catch (error) {
      console.error(
        `[Flux] Ego turn failed:`,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  /**
   * Run one Ego-model wake: the entity's subconscious escalated
   * something and the Ego model wakes to consider speaking. Calls
   * egoTrigger.triggerEgoWake() — EntityTurn in self-initiated mode
   * (full RAG, no user message). If the response is non-empty, persists
   * it and runs mood classification.
   */
  async runEgoWake(
    contextQuery: string,
    sourceDescription: string,
    dreamReturn?: import("./host.ts").DreamReturn,
  ): Promise<void> {
    // The startup settling gate: during the first
    // STARTUP_SETTLING_MS, escalations queue instead of waking — one
    // combined call flushes at window close (the cold-familiarity
    // storm: three engagement wakes in the first minute). Sleep
    // machinery (dreamReturn) is exempt — the light moment keeps its
    // own clock. USER turns take the triggerFluxTurn path, not this
    // one — messages always reach the Ego immediately.
    if (
      this.startupSettlesAt > 0 && Date.now() < this.startupSettlesAt &&
      dreamReturn === undefined
    ) {
      this.pendingStartupWakes.push({ contextQuery, sourceDescription });
      console.log(
        `[Flux] Startup settling: deferred wake (${sourceDescription}) — ${this.pendingStartupWakes.length} queued`,
      );
      return;
    }
    if (!this.egoTrigger) {
      console.log(
        `[Flux] Ego wake skipped (no trigger): ${sourceDescription}`,
      );
      return;
    }
    console.log(`[Flux] Ego wake — ${sourceDescription}`);
    try {
      const utterance = await this.egoTrigger.triggerEgoWake(
        contextQuery,
        sourceDescription,
        dreamReturn,
      );
      const response = utterance.content;
      // Same as the turn path: session log is the record; no durable mirror.
      if (response.trim()) {
        // ONE MOUTH: the door passed during quiet, so this
        // wake's reply is spoken into the call — spontaneous speech.
        // No-op when the call ended mid-generation (returns false; the
        // reply already lives as text in the session record).
        this.speakSpontaneous?.(response);
        // "He's speaking — read your screen":
        // every responded wake announces itself. A live voice call plays
        // its own pre-speech earcon; away from a call (or when the
        // pipeline couldn't take the reply) this event is what tells the
        // user to look.
        this.broadcaster.broadcastEvent(
          "flux_ego_spoke",
          { hostConversationId: this.hostConvId ?? null },
          this.hostConvId,
        );
        // Mood-from-interior classifier — same as for EntityTurn
        // responses: the thinking when present, speech as fallback.
        const feedback = moodFeedbackText(utterance);
        try {
          const moodDeltas = await this.smallLLM.classifyMood(feedback.text);
          if (moodDeltas) {
            this.moodOrgan.ingest({
              ...moodDeltas,
              weight: 0.4,
              source: feedback.source,
            });
          }
        } catch {
          // Non-fatal.
        }
      } else {
        console.log("[Flux] Ego wake: entity chose silence");
      }
    } catch (error) {
      console.error(
        `[Flux] Ego wake failed:`,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Thoughtstream (called by the driver on the thoughtstream cadence)
  // ---------------------------------------------------------------------------

  /** Run one thoughtstream pass; inject summaries as ambient entries. */
  async runThoughtstream(): Promise<number> {
    if (!this.thoughtstream) return 0;
    const activeSince = new Date(Date.now() - 3_600_000).toISOString();
    const updated = await this.thoughtstream.run(activeSince);
    for (const s of updated) {
      this.appendAmbient(s.summary, {
        organId: "thoughtstream",
        sourceConversationId: s.conversationId,
      });
    }
    return updated.length;
  }

  // ---------------------------------------------------------------------------
  // Compaction (called by the driver on the compaction cadence)
  // ---------------------------------------------------------------------------

  /**
   * Run one short-horizon compaction pass: compress the last window's
   * salient observations into a first-person texture summary. The
   * summary becomes the small model's rolling context, giving it
   * continuity across noticing calls instead of being stateless.
   * Anchored by the current mood state so the texture stays honest.
   */
  runCompactionPass(): Promise<boolean> {
    return this.compaction.runShortPass("noticing");
  }

  /**
   * Run one reverie compaction pass: compress the last window's reverie
   * observations into a separate texture summary. This is the mind's
   * interior continuity — what it's been thinking about, independent of
   * what it's been sensing. Separate from the noticing texture to prevent
   * cross-contamination between the two systems.
   */
  runReverieCompactionPass(): Promise<boolean> {
    return this.compaction.runShortPass("reverie");
  }

  /** The latest texture summary (for the small model's rolling context). */
  getTextureSummary(): string | null {
    return this.compaction.get("noticing").short;
  }

  /** The latest longform (1-hour) texture summary. */
  getLongformTextureSummary(): string | null {
    return this.compaction.get("noticing").long;
  }

  /** The latest reverie texture summary (interior continuity). */
  getReverieTextureSummary(): string | null {
    return this.compaction.get("reverie").short;
  }

  getReverieLongformTextureSummary(): string | null {
    return this.compaction.get("reverie").long;
  }

  // ---------------------------------------------------------------------------
  // Modulation bus (conscious → subconscious, vian Ego-callable tools)
  // ---------------------------------------------------------------------------

  /**
   * GRADED DAMPING: a damped wake survives when its novelty-scaled
   * salience still clears the escalation bar — never the binary cliff
   * where ANY factor < 1 kills the bid (a factor-0.99 bid, 99% novel,
   * must not die at the ratio-1.3 edge). One rule
   * for every trigger class: engagement bids (0.90 floor) wake at
   * factor ≥ ~0.83, presence twins (deep under the bar) stay dead, and
   * categorical interior judgments (0.75 at the bar) still die to any
   * damping, preserving murmur/propose semantics.
   */
  static dampedWakeClearsBar(
    salience: number,
    factor: number,
    bar: number,
  ): boolean {
    return salience * factor >= bar;
  }

  /**
   * THE UNIVERSAL WAKE DOOR (self-regulation). Every path
   * that would wake the Ego — reverie escalation, musing proposal,
   * noticing promotion — passes through here after its own nature gate
   * upstream. The door applies SATIATION (novelty vs the Familiarity
   * pool; the trigger enters the pool either way) and, for interior
   * sources, HABITUATION (novelty multiplies the salience that judged
   * the wake). Event-class triggers (reflex-tagged) are exempt — an
   * event is novel by definition (the sneeze case). Audience is NOT a
   * factor here by design (separate concern, organ-side).
   *
   * `interior` selects the treatment: reverie/musing get full
   * habituation (their repetition-in-text genuinely is repetition-in-
   * meaning); noticing gets satiation only (its corroboration already
   * vouches for it — only the don't-wake-twice-about-the-same-thing
   * rule applies).
   */
  private async requestWake(
    trigger: string,
    sourceDescription: string,
    opts: {
      interior: boolean;
      salience: number;
      eventTag?: boolean;
    },
  ): Promise<boolean> {
    // Posture gate (THE SPLIT): while sleeping, only the
    // genuinely significant wakes. Reflex-class events (eventTag —
    // amplitude ≥ reflex threshold at noticing time) still fire by
    // design: a loud bang works. Everything else needs the sleep
    // threshold; a refused wake degrades to the timeline (the
    // observation/proposal already landed there) — sleep persists
    // across wakes; only wake_up ends it.
    if (this.posture.isSleeping && !opts.eventTag) {
      if (opts.salience < this.posture.effectiveEscalationThreshold(1)) {
        console.log(
          `[Flux] wake held (sleep): ${sourceDescription}, salience ${
            opts.salience.toFixed(2)
          } < 0.90 — timeline only`,
        );
        return false;
      }
    }

    const verdict = await this.familiarity.novelty(trigger);
    // The trigger enters the pool whether or not the wake fires —
    // repeated attempts at the same thing are themselves familiarity.
    // Engagement triggers enter on their own faster clock.
    await this.familiarity.note(trigger, "wake-trigger");

    let effective = opts.salience;
    if (verdict.factor < 1) {
      if (opts.eventTag) {
        // Event-exempt: reflex-class amplitude skips damping.
        console.log(
          `[Flux] wake allowed (event-exempt): ${sourceDescription}, ratio ${
            verdict.ratio.toFixed(2)
          } — events are novel by definition`,
        );
      } else {
        effective = opts.salience * verdict.factor;
        this.familiarity.noteDamped(trigger);
        // Posture-aware escalation bar (sleep raises it, same as the
        // top-of-door sleep gate).
        const bar = this.posture.isSleeping
          ? this.posture.effectiveEscalationThreshold(
            this.settings.promotionThresholds.escalation,
          )
          : this.settings.promotionThresholds.escalation;
        if (
          FluxManager.dampedWakeClearsBar(opts.salience, verdict.factor, bar)
        ) {
          console.log(
            `[Flux] wake damped (graded pass): ${sourceDescription}, ratio ${
              verdict.ratio.toFixed(2)
            } → factor ${verdict.factor.toFixed(2)}, effective ${
              effective.toFixed(2)
            } ≥ bar ${bar.toFixed(2)} — novelty-scaled salience still clears`,
          );
        } else {
          console.log(
            `[Flux] wake damped: ${sourceDescription}, ratio ${
              verdict.ratio.toFixed(2)
            } (topk ${verdict.topkSimilarity.toFixed(2)} / density ${
              verdict.poolDensity.toFixed(2)
            }) → factor ${verdict.factor.toFixed(2)}, salience ${
              opts.salience.toFixed(2)
            } → effective ${effective.toFixed(2)} < bar ${
              bar.toFixed(2)
            }, matched: "${
              verdict.matched?.text ?? ""
            }" — degrading to timeline`,
          );
          this.flushVolatile();
          return false;
        }
      }
    }

    // ONE MOUTH: during an active voice
    // call on the host, the Ego's spoken voice is his only output
    // channel. A wake while the user is speaking or a turn is in
    // flight doesn't generate — he is already conscious and talking;
    // the trigger rides his context as an ambient briefing (each
    // caller's degrade path posts it untinted) and he weaves it into
    // his next spoken turn by choice. Only quiet lets the door open
    // his mouth. The trigger stays in the pool (noted above): it was
    // surfaced, so repetition is familiarity.
    const voiceState = this.voiceCallState?.() ?? null;
    if (voiceState === "user-speaking" || voiceState === "busy") {
      console.log(
        `[Flux] wake held (voice: ${voiceState}): ${sourceDescription} — briefing rides context`,
      );
      this.flushVolatile();
      return false;
    }
    // Dreams v2: a wake while sleeping returns INTO the open sleep
    // call — the return carries the latest fragment ("I was dreaming:
    // …") so the entity answers from inside the dream it was having.
    this.driver.requestEgoWake(
      trigger,
      sourceDescription,
      this.posture.isSleeping
        ? {
          kind: "engagement",
          fragment: this.dreamer?.latestFragment() ?? null,
        }
        : undefined,
    );
    this.flushVolatile();
    return true;
  }

  /**
   * Ego speech enters the Familiarity pool (the self-seed cut): the
   * Ego's spoken output is what ChatRAG feeds reverie's retrieval, so
   * it must also feed the pool that damps reverie's wakes — otherwise
   * expression keeps funding its own escalation.
   */
  async noteEgoSpeech(content: string): Promise<void> {
    await this.familiarity.note(content, "ego-speech");
  }

  /** The current Sensory Organ health report (status API + boot). */
  getOrganHealth(): import("./thalamus.ts").SensoryOrganHealthReport[] {
    return this.thalamus.healthReport();
  }

  /** Familiarity pool state (status/observability). */
  getFamiliarityStatus(): { size: number; lastDamped: string | null } {
    return {
      size: this.familiarity.size,
      lastDamped: this.familiarity.lastDamped,
    };
  }

  /**
   * Set a temporary focus override (from the `pay_attention` tool). While
   * active, the promotion filter weights observations semantically near
   * this text more heavily. TTL-bounded — expires automatically.
   */
  setFocusOverride(text: string, ttlMs: number): void {
    this.focusOverride = {
      text,
      expiresAt: Date.now() + Math.max(1_000, Math.min(3_600_000, ttlMs)),
    };
    // Invalidate the focus-embedding cache so the next promotion batch
    // picks up the new focus immediately.
    this.focusCachedAt = 0;
    this.flushVolatile();
  }

  /**
   * Route an attention instruction through the Thalamus (the
   * modulation router): organ-directed when the target
   * names a registered organ that takes directives (the instruction
   * rides into the Sensory Organ's perception model), content-directed
   * otherwise (the focus override the gate and promotion filter read).
   * Returns a human-readable routing note for the caller.
   */
  routeAttention(target: string, ttlMs: number): string {
    // Organ-directed? Match the target against the registry.
    const organs = this.thalamus.listOrgans();
    const named = organs.find((o) =>
      target.toLowerCase().includes(o.organId.replace(/-/g, " ")) ||
      target.toLowerCase().includes(o.organId)
    );
    const directable = named?.capabilities.takesDirectives
      ? this.organs.get(named.organId) as SensoryOrgan | undefined
      : undefined;
    if (named && directable?.receiveDirective) {
      // Down-chain: the sensor itself now watches for this.
      directable.receiveDirective(target);
      // Content-directed ALSO applies (the gate weights alignment) —
      // belt and suspenders: the Sensory Organ looks, and the gate listens.
      this.setFocusOverride(target, ttlMs);
      return `routed to ${named.organId} (organ-directed) + attention weighting`;
    }
    this.setFocusOverride(target, ttlMs);
    return "routed to attention weighting (content-directed)";
  }

  /** Clear the active focus override (if any). */
  clearFocusOverride(): void {
    this.focusOverride = null;
    this.focusCachedAt = 0;
  }

  /**
   * Update the standing-attention directive at runtime (from the
   * `tune_attention` tool). The SmallLLMRunner picks this up via
   * `getAttentionDirective()` on the next call — no restart needed.
   */
  setAttentionDirective(text: string | null): void {
    this.attentionDirective = text?.trim() || null;
  }

  /** Current standing-attention directive (null when absent). */
  getAttentionDirective(): string | null {
    return this.attentionDirective;
  }

  /**
   * Run one longform compaction pass: compress the last hour's salient
   * observations into a broader texture summary — the arc of the hour,
   * not moment-to-moment detail. Gives the small model wide-angle
   * context alongside the 15-minute close-up.
   */
  runLongformCompactionPass(): Promise<boolean> {
    return this.compaction.runLongPass("noticing");
  }

  /**
   * Run one reverie longform compaction pass — the arc of the mind's
   * interior life over the last hour, separate from the noticing longform.
   */
  runReverieLongformCompactionPass(): Promise<boolean> {
    return this.compaction.runLongPass("reverie");
  }

  // ---------------------------------------------------------------------------
  // Reverie (called by the driver on the reverie cadence)
  // ---------------------------------------------------------------------------

  /**
   * Run one reverie pass: the mind's Default Mode Network analogue —
   * endogenous generation without external prompt. The small model
   * generates an internally-sourced observation from mood-directed
   * retrieval: the current mood direction (derived empirically from
   * what shaped the mood) combines with recent activity to form a
   * search query across memories, conversations, and observations.
   *
   * The observation flows into tier-1, mood is classified and fed
   * back (third source of mood recursion), and if salient enough the
   * Ego model wakes directly (initiative). Returns true when
   * something was generated, false when the mind was quiet.
   */
  async runReverie(): Promise<boolean> {
    const seed = await this.gatherReverieContext();
    let result;
    try {
      result = await this.smallLLM.reverie(seed);
    } catch (error) {
      console.error(
        "[Flux] reverie failed:",
        error instanceof Error ? error.message : String(error),
      );
      return false;
    }

    // A completed pass is a completed pass — silent included (fixed-
    // length cycles): the model was asked,
    // the interior had its moment, the cycle advances. (Under dreams
    // v1 reverie is suppressed while sleeping, so this path is the
    // awake-mode no-op; the live sleep clock is noteDreamFragment.)
    const pass = this.posture.noteReveriePass();
    if (pass.kind === "cycle-top") {
      this.deliverSleepCycleTop(pass.cycles, []);
    }

    if (!result) {
      // Nothing surfaced — silence is valid. Readiness notes the run
      // (silence doesn't satisfy; the interior will be asked again on
      // its ordinary schedule).
      this.readiness.noteReverieRan();
      console.log("[Flux] reverie — nothing surfaced");
      return false;
    }
    // Genuinely surfaced — satisfies the interior for a while.
    this.readiness.noteReverieSurfaced();

    // Insert as a tier-1 observation so it's part of the ambient
    // stream (compaction picks it up, future observations can
    // corroborate it).
    const embedding = await this.embed(result.content).catch(() => undefined);
    const observation: FluxObservation = {
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      sourceOrganId: "reverie",
      sourceOrganIds: ["reverie"],
      content: result.content,
      salience: result.salience,
      embedding,
      tags: result.tags,
      promoted: false,
    };
    this.tier1.insert(observation);

    // Surface on the Flux Space timeline directly. Reverie observations
    // are low-volume, already filtered by the small model, and internally
    // generated — they don't need the promotion filter's corroboration
    // gate to reach the timeline (that gate is for defending against
    // high-volume external noise, not for gating interior monologue).
    // escalated marks the ones that cross the escalation threshold below
    // and wake the Ego — the timeline's significance tint.
    const reverieEscalates = result.salience >=
      this.posture.effectiveEscalationThreshold(
        this.settings.promotionThresholds.escalation,
      );
    this.appendAmbient(result.content, {
      salience: result.salience,
      organId: "reverie",
      escalated: reverieEscalates,
      sourceObservationId: observation.id,
    });

    // Mood feedback: classify the emotional content of the reverie
    // and feed it to the Mood Organ. Internally-generated mood shifts
    // are softer (weight 0.3) than spoken-word shifts (0.4). The
    // sourceEmbedding is reused from the observation — zero extra cost.
    try {
      const moodDeltas = await this.smallLLM.classifyMood(result.content);
      if (moodDeltas) {
        this.moodOrgan.ingest({
          ...moodDeltas,
          weight: 0.3,
          source: "reverie",
          sourceEmbedding: embedding,
        });
      }
    } catch {
      // Non-fatal — mood classification is a bonus.
    }

    // Direct escalation: if the reverie is salient enough, wake the
    // Ego model directly. This bypasses the promotion filter's
    // corroboration gate — architecturally correct for internally-
    // generated signal (corroboration is a defense against external
    // injection, which reverie doesn't need). The observation is still
    // in tier-1 for the standard promotion batch to handle tier-2.
    if (reverieEscalates) {
      // Through the universal wake door: habituation (novelty ×
      // salience) + satiation. A damped reverie still entered tier-1
      // and the timeline above — only the wake is refused.
      const woke = await this.requestWake(
        result.content,
        `reverie (salience ${result.salience.toFixed(2)})`,
        { interior: true, salience: result.salience },
      );
      if (woke) {
        this.emitToast("escalation", result.content, result.salience);
        // Satiation: an escalated wake satisfies the interior hard
        // (the ×4 pattern — three more in six minutes read as pressure).
        this.readiness.noteReverieSurfaced(4);
        console.log(
          `[Flux] reverie initiative — salience ${
            result.salience.toFixed(2)
          }, waking Ego model`,
        );
      }
    }

    console.log(
      `[Flux] reverie — salience ${result.salience.toFixed(2)}, ${
        result.content.slice(0, 80)
      }${result.content.length > 80 ? "…" : ""}`,
    );
    return true;
  }

  /**
   * Gather reverie seed context — the interior's material, only:
   * memory and conversation (the deep stores). Tier-1 recent
   * experience is excluded — that is exterior residue steering the
   * interior, and associative commentary on recent observation is
   * Musing's job, not reverie's. The query direction is the mood's
   * (E_mood); recent exterior activity never shapes it.
   *
   * ALWAYS seedable (the DMN is never idle): no early return. The
   * query degrades gracefully — E_mood when present; when mood is
   * neutral too, the stores still get the keyword query; and in the
   * empty-mind extreme (no results anywhere), generation proceeds from
   * identity + mood + interior texture alone — genuinely unprompted.
   */
  /**
   * Gather Musing's retrieval sections — what the un-narrated material
   * connects to in the deep stores. The query is the centroid of the
   * exterior observations' embeddings blended with the mood direction
   * (the narrator narrates from where it stands); memory and
   * conversation, up to 3 each. Returns ready-to-embed prompt sections.
   */
  private async gatherMusingRetrieval(
    exterior: FluxObservation[],
  ): Promise<string[]> {
    if (exterior.length === 0) return [];
    const eMood = this.moodOrgan.getMoodEmbedding();

    // Centroid of the exterior embeddings (the material's direction).
    const dims = exterior[0].embedding?.length ?? 0;
    if (dims === 0) return [];
    const centroid = new Array(dims).fill(0);
    let counted = 0;
    for (const o of exterior) {
      if (!o.embedding || o.embedding.length !== dims) continue;
      for (let i = 0; i < dims; i++) centroid[i] += o.embedding[i];
      counted++;
    }
    if (counted === 0) return [];
    for (let i = 0; i < dims; i++) centroid[i] /= counted;

    // Blend with the mood direction when present (mood-weighted, like
    // the old reverie query: the material leads, the mood colors it).
    let eQuery = centroid;
    if (eMood && eMood.length === dims) {
      const blended = new Array(dims);
      for (let i = 0; i < dims; i++) {
        blended[i] = 0.6 * centroid[i] + 0.4 * eMood[i];
      }
      eQuery = blended;
    }

    const textQuery = exterior.map((o) => o.content).join(" ").slice(0, 400);
    const sections: string[] = [];

    if (this.memoryReader) {
      try {
        const memories = await this.memoryReader.searchMemories(textQuery, {
          maxResults: 3,
          queryEmbedding: eQuery,
        });
        if (memories.length > 0) {
          const lines = memories.map((m) =>
            `- [${m.granularity} ${m.date}] ${m.excerpt}`
          );
          sections.push(
            "What this connects to in my memory:\n" + lines.join("\n"),
          );
        }
      } catch {
        // Non-fatal.
      }
    }

    if (this.chatRAG) {
      try {
        const chatResults = await this.chatRAG.search(textQuery, {
          limit: 3,
          queryEmbedding: eQuery,
        });
        if (chatResults.length > 0) {
          const lines = chatResults.map((r) => `- ${r.content}`);
          sections.push(
            "What this connects to in my conversations:\n" + lines.join("\n"),
          );
        }
      } catch {
        // Non-fatal.
      }
    }

    return sections;
  }

  /**
   * Gather reverie/dream seed material: mood-directed retrieval across
   * memories, conversations, and observations. Defaults center on the
   * mood direction + noticing texture (waking reverie, dream-cycle
   * openings). An explicit `anchorText`/`anchorEmbedding` pair re-aims
   * the retrieval — the dream's associative walk: each fragment
   * after the first retrieves against the
   * PREVIOUS FRAGMENT's imagery, so one image pulls the next memory
   * and the symbolism stays answerable to the material every beat.
   */
  private async gatherReverieContext(
    anchorText?: string,
    anchorEmbedding?: number[],
  ): Promise<string> {
    // E_mood: the mood direction in embedding space (null when neutral).
    const eMood = this.moodOrgan.getMoodEmbedding();
    const eQuery = anchorEmbedding ?? (eMood ? [...eMood] : null);

    // Text query for keyword-matching secondary signals (memories/chat).
    const textQuery = anchorText ??
      (this.compaction.get("noticing").short ??
        this.compaction.get("reverie").short ?? "");

    const sections: string[] = [];

    // Memories (entity-core via MCP).
    if (this.memoryReader) {
      try {
        const memories = await this.memoryReader.searchMemories(textQuery, {
          maxResults: 3,
          queryEmbedding: eQuery ?? undefined,
        });
        if (memories.length > 0) {
          const lines = memories.map((m) =>
            `- [${m.granularity} ${m.date}] ${m.excerpt}`
          );
          sections.push("What surfaced from my memory:\n" + lines.join("\n"));
        }
      } catch {
        // Non-fatal.
      }
    }

    // Chat history (ConversationRAG).
    if (this.chatRAG) {
      try {
        const chatResults = await this.chatRAG.search(textQuery, {
          limit: 3,
          queryEmbedding: eQuery ?? undefined,
        });
        if (chatResults.length > 0) {
          const lines = chatResults.map((r) => `- ${r.content}`);
          sections.push(
            "What surfaced from my conversations:\n" + lines.join("\n"),
          );
        }
      } catch {
        // Non-fatal.
      }
    }

    if (sections.length > 0) {
      return sections.join("\n\n");
    }

    // Empty-mind extreme: nothing surfaced from the stores. The DMN
    // still generates — from mood, texture, and itself alone.
    return this.compaction.get("reverie").short ??
      this.compaction.get("noticing").short ??
      "Nothing in particular surfaced. My mind is quiet and free — what forms here on its own?";
  }

  // ---------------------------------------------------------------------------
  // Consolidation (called by the host's scheduler at 5am)
  // ---------------------------------------------------------------------------

  /**
   * Run the daily consolidation pass: previous day's flux activity →
   * entity-core daily memory via MCP. The host registers this as the
   * `flux.consolidate` scheduler handler. No-op-safe when MCP is off
   * (the pass defers; tier-2 data persists for next time).
   */
  runConsolidation(targetDateISO?: string): Promise<boolean> {
    // Dialogue's record is the messages table (storage alignment): read
    // via the host's conversation reader when available. The HOST
    // conversation when set (conversation-hosted consciousness); the
    // legacy flux-space id otherwise. NOTE: the legacy id is a random
    // linkage UUID, NOT a conversation row id — that read always comes
    // back empty (a dead dialogue section); hosting makes it real.
    const dialogueConvId = this.hostConvId ?? this.fluxSpaceId;
    let dialogue: Array<{ role: string; content: string }> | undefined;
    if (this.conversationReader) {
      try {
        const msgs = this.conversationReader.getRecentMessages(
          dialogueConvId,
          200,
        );
        dialogue = msgs
          .filter((m) => m.role === "user" || m.role === "assistant")
          .map((m) => ({ role: m.role, content: m.content }));
      } catch {
        // Fall back to durable dialogue below.
      }
    }
    return runFluxConsolidation(
      this.sharedDb,
      this.memoryWriter,
      dialogueConvId,
      targetDateISO,
      dialogue,
    );
  }

  /**
   * Clear the workspace for a fresh start. Wipes tier-1 observations,
   * tier-2 durable entries + promoted observations, and texture
   * summaries. The Ego model's Flux-Space dialogue history and Mood
   * Organ state are preserved — the entity's conversational memory and
   * emotional continuity don't reset with the workspace, only the
   * sensory/ambient layer does.
   */
  clearWorkspace(): void {
    // Tier-1: clear all observations.
    this.tier1.clear();

    // Tier-2: clear durable entries (the visible timeline) and promoted
    // observations.
    this.sharedDb.exec("DELETE FROM flux_durable_entries");
    this.sharedDb.exec("DELETE FROM flux_promoted_observations");

    // Texture summaries: reset to null (both systems).
    this.compaction.seed("noticing", { short: null, long: null });
    this.compaction.seed("reverie", { short: null, long: null });

    // Reset the focus-embedding cache and any active pay_attention override.
    this.focusEmbedding = null;
    this.focusCachedAt = 0;
    this.focusOverride = null;

    console.log(
      "[Flux] Workspace cleared — tier-1, tier-2 timeline, texture summaries wiped. Dialogue + mood preserved.",
    );
  }

  // ---------------------------------------------------------------------------
  // SA snapshot (consumed by the SA formatter)
  // ---------------------------------------------------------------------------

  /** Flush the startup settling queue: every deferred wake lands in
   * the session under its own source — exactly like any other
   * accumulating briefings — and the LAST one wakes the Ego. One
   * generation for the whole opening, no synthetic cluster label.
   * Runs at window close; a stop before then clears the queue
   * instead. */
  private async flushStartupWakes(): Promise<void> {
    if (!this.started || this.pendingStartupWakes.length === 0) return;
    const wakes = this.pendingStartupWakes;
    this.pendingStartupWakes = [];
    console.log(
      `[Flux] Startup settling flushed: ${wakes.length} wakes coalesced`,
    );
    for (const w of wakes.slice(0, -1)) {
      this.egoTrigger?.ambientBriefing(w.contextQuery, w.sourceDescription);
    }
    const last = wakes[wakes.length - 1];
    await this.runEgoWake(last.contextQuery, last.sourceDescription);
  }

  /** Rendered current mood state (for status/inspection endpoints —
   *  the numeric render; models get renderMoodFelt). */
  renderMood(): string {
    return this.moodOrgan.render();
  }

  /** The felt render (band words, no numbers) for model-facing surfaces
   *  (mindfulness and any future consumer). */
  renderMoodFelt(): string {
    return this.moodOrgan.renderFelt();
  }

  /** Terse one-line mood (the session's <mood> block). */
  renderMoodTerse(): string {
    return this.moodOrgan.renderTerse();
  }

  /** Raw current mood state (for structured API consumers / UI). */
  getMoodState() {
    return this.moodOrgan.getState();
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private durableEntry(
    role: "user" | "entity",
    content: string,
  ): FluxDurableEntry {
    return {
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      role,
      content,
    };
  }

  private broadcastEntry(entry: FluxDurableEntry): void {
    this.broadcaster.broadcastEvent("flux_entry", entry, null);
  }

  private emitToast(
    type: "promotion" | "ambient" | "escalation",
    message: string,
    salience?: number,
  ): void {
    this.broadcaster.broadcastEvent(
      "flux_toast",
      {
        type,
        message: message.length > 200 ? `${message.slice(0, 200)}…` : message,
        salience,
        timestamp: new Date().toISOString(),
      },
      null,
    );
  }

  /**
   * Broadcast a tool call to the Flux Space (called by the Ego trigger
   * when EntityTurn yields tool_result chunks). Lets the UI show what
   * the entity is doing internally during a Flux Space turn — rendered
   * as a collapsible tool card matching the regular chat style.
   */
  emitToolCall(
    toolCallId: string,
    name: string,
    args: string,
    result: string,
    isError: boolean,
  ): void {
    this.broadcaster.broadcastEvent(
      "flux_tool_call",
      {
        toolCallId,
        name,
        args,
        result,
        isError,
        timestamp: new Date().toISOString(),
      },
      null,
    );
  }

  /**
   * Broadcast a tool RESULT (toolcall parity): classic
   * Psycheros shows the call and what came back as one card — the
   * timeline's tool card fills in when the result lands, matched by
   * toolCallId (the call broadcasts first with an empty result).
   */
  emitToolResult(
    toolCallId: string,
    name: string,
    result: string,
    isError: boolean,
    metadata?: unknown,
  ): void {
    this.broadcaster.broadcastEvent(
      "flux_tool_result",
      {
        toolCallId,
        name,
        result,
        isError,
        metadata,
        timestamp: new Date().toISOString(),
      },
      null,
    );
  }

  /**
   * Emit the Ego's reasoning chain for a Flux Space turn — streamed in
   * fragments as the Ego thinks (the host's Ego trigger forwards
   * `thinking` chunks here). Rendered as a collapsible card, so the
   * entity's interior monologue is visible without dominating the
   * timeline. Not persisted — thinking is live-streamed only, like tool
   * calls.
   */
  emitEgoThinking(fragment: string): void {
    if (!fragment) return;
    this.broadcaster.broadcastEvent(
      "flux_ego_thinking",
      { fragment, timestamp: new Date().toISOString() },
      null,
    );
  }

  /**
   * Live-stream an Ego content fragment: a long generation
   * grows visibly in the Flux timeline instead of freezing until
   * completion. The session's own generation loop forwards content
   * chunks here (onContent — thinking's sibling; NOT EntityTurn, which
   * the flux session never uses). Live-only like thinking: the durable
   * entry lands once, at stream close, unchanged.
   */
  emitEgoContent(fragment: string): void {
    if (!fragment) return;
    this.broadcaster.broadcastEvent(
      "flux_ego_stream",
      { fragment, timestamp: new Date().toISOString() },
      null,
    );
  }

  /** Expose promotion thresholds for tests / host introspection. */
  get promotionThresholds(): PromotionThresholds {
    return this.settings.promotionThresholds;
  }
}

// =============================================================================
// Flux Space ID persistence
// =============================================================================

/**
 * Load or create the stable Flux Space conversation ID. Kept in
 * `.psycheros/flux-space-id` so the Flux Space is the same surface
 * across restarts — its durable dialogue is permanent, like classic
 * conversation history.
 */

function loadOrCreateFluxSpaceId(dataRoot: string): string {
  const path = join(psycherosDir(dataRoot), "flux-space-id");
  try {
    return Deno.readTextFileSync(path).trim();
  } catch {
    const id = crypto.randomUUID();
    try {
      Deno.mkdirSync(psycherosDir(dataRoot), { recursive: true });
      Deno.writeTextFileSync(path, id);
    } catch (error) {
      console.warn(
        "[Flux] Could not persist flux-space-id:",
        error instanceof Error ? error.message : String(error),
      );
    }
    return id;
  }
}

// Re-export cosineSimilarity here too so driver.ts can import from the manager
// module if convenient. (Already exported from tier1-store.)
export { cosineSimilarity };
