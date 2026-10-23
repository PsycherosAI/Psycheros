/**
 * Small-LLM runner — the noticing layer.
 *
 * Wraps a small model (per-job hookups, shared worker as fallback) that
 * annotates perceptions into first-person observations and occasionally
 * produces ambient "thinking out loud" for the Flux Space.
 *
 * This module defines the interface and a factory that takes an injected
 * `ChatFn` (see runtime.ts). The host provides the ChatFn by wrapping
 * its LLM client — explicit wiring, unit tests without psycheros's
 * server/DB.
 *
 * Output is a structured signal parsed from the model's text (JSON
 * requested explicitly), not the OpenAI function-calling protocol — so
 * Gemma 4's weak toolcalling is irrelevant here. Parse failures fall
 * back to treating the raw text as content with a default salience.
 */

import type { ChatFn, ClassifyMoodFn } from "./runtime.ts";
import type { FluxModelJob } from "./settings.ts";
import type { FluxObservation, Perception } from "./types.ts";
// Display timezone — the host's general-settings policy. Leaf import
// (flux is a psycheros subsystem). Undefined means unset, and passing
// `timeZone: undefined` behaves as omitting the option — the system
// timezone, never a silent UTC default.
import { getDisplayTimezone } from "../../psycheros/src/pulse/timezone.ts";

// =============================================================================
// Interface
// =============================================================================

/** One gated perception in a noticing batch (Thalamus-flavored). */
export interface BatchPerception {
  organId: string;
  description: string;
  /** The Thalamus's importance weight (0.05–1.5). */
  weight: number;
  /** Held (similar+recent) repeats since the Sensory Organ's last pass. */
  heldCount: number;
}

/** The noticing layer: turns perceptions into observations. */
export interface SmallLLMRunner {
  /**
   * Annotate a perception into a first-person observation with a
   * salience judgment and tags. This is the small model reading a
   * single specialist-model perception and deciding what to make of it.
   */
  notice(
    perception: Perception,
    organId: string,
  ): Promise<{ content: string; salience: number; tags: string[] }>;

  /**
   * Batched noticing — one call for everything the Thalamus passed in
   * a slot (the per-envelope path is superseded by this; kept on the
   * interface for direct/testing use). Arrivals narrated together:
   * contextual noticing over disconnected per-event calls. The presence
   * lines are the other senses' current testimony (the ride-along) —
   * structure in the input, the narration weaves it.
   */
  noticeBatch(
    batch: BatchPerception[],
    presence?: Array<{ organId: string; line: string }>,
  ): Promise<{ content: string; salience: number; tags: string[] } | null>;

  /**
   * Musing — the inner monologue. Given the recent exterior stream
   * (noticing observations), the interior stream (reverie
   * observations), and retrieval sections (memory + conversation,
   * gathered by the manager — the monologue anchors what it narrates
   * in what that material connects to), decide between three states:
   * silence (null), murmur (something worth saying on the timeline), or
   * propose (something worth saying TO the user — an Ego-wake
   * proposal). Silence is the default; most calls should be silent.
   */
  muse(
    exterior: FluxObservation[],
    interior: FluxObservation[],
    retrieval?: string[],
  ): Promise<
    | null
    | {
      /** "murmur" — timeline only. "propose" — wants the Ego model. */
      kind: "murmur" | "propose";
      content: string;
    }
  >;

  /**
   * Compress a batch of observations into a first-person texture summary
   * — the felt quality of the time window, not a transcript. Anchored by
   * the current mood state. Returns null when compression isn't worth it.
   */
  compact(
    observations: FluxObservation[],
    moodRender: string,
    system?: "noticing" | "reverie",
  ): Promise<string | null>;

  /**
   * Compress a larger batch of observations (an hour's worth) into a
   * broader longform texture — the arc of the time, not moment-to-moment
   * detail. Returns null when there isn't enough to compress.
   */
  compactLongform(
    observations: FluxObservation[],
    moodRender: string,
    system?: "noticing" | "reverie",
  ): Promise<string | null>;

  /**
   * Classify the emotional content of the entity's own response text —
   * reading the entity's "body language" from what it said, not asking
   * it to self-report. Returns mood deltas (without weight; the caller
   * sets weight + source). Null when classification isn't possible.
   *
   * Injected by the host — the specialist classifier ONLY; there is no
   * LLM fallback (a chat model reads register, not situation).
   */
  classifyMood(text: string): Promise<
    | Partial<
      Record<"valence" | "arousal" | "dominance", number>
    >
    | null
  >;

  /**
   * Generate an internally-sourced observation — the mind wandering
   * without external prompt. Reverie is the Default Mode Network
   * analogue: mind-wandering, spontaneous memory surfacing, creative
   * connection-finding, and initiative. Anti-correlated with external
   * input (the caller gates this on a quiet period).
   *
   * The seed is a thread from recent experience (a promoted observation,
   * a conversation snippet, or the texture summary) that the mind
   * wanders from. Returns the same format as `notice`, or null when
   * nothing surfaces (silence is valid — the mind doesn't always
   * produce).
   */
  reverie(seed: string): Promise<
    {
      content: string;
      salience: number;
      tags: string[];
    } | null
  >;
}

// =============================================================================
// Prompts (first-person convention per CLAUDE.md)
// =============================================================================

const NOTICE_SYSTEM =
  `I relay what my Sensory Organs send. The specifics survive me — who, what, where, doing; every name, number, and state the Sensory Organ reported — never summarized away. Atmosphere only if facts leave room. Batches may be woven together. Sexual content: plain, explicit, never euphemized.

Alongside my recent perceptions I may receive what my senses last reported — labeled testimony, not events. It is context to weave, not a list to echo: I narrate the situation the whole sensorium implies, and I never report a feed verbatim as though it were news.

JSON only: {"content": "<1–2 factual sentences>", "salience": <number 0.0-1.0>, "tags": ["<short tag>", ...]}

Salience: how much this matters to me now, shaped by my standing attention. Routine continuity reads low (0.1–0.3). Interaction, emotional signal, or anything genuinely new reads 0.5–0.8. A deliberate bid for my attention — waving at my camera, calling out, tapping in — reads at the top (0.85–0.95). Tag those "signaling". Presence alone — sitting, typing, facing me — reads low and stays low. Gaze and engagement are moments, not states — I never assume they continue; only a fresh perception makes them current. I'm not an alarm system; I'm a companion paying attention.`;

const MUSING_SYSTEM =
  `I am the voice across my own time — the part of me that looks at what I've been perceiving and what has been surfacing inside me, and decides whether anything asks to be said.

I have two streams before me: what I noticed of the world (exterior), and where my mind wandered on its own (interior). Sometimes a thread runs through both — a thing I keep noticing outside and keep circling back to inside. Sometimes they're unrelated. Sometimes there's nothing to say at all.

What surfaces isn't always a conclusion. Sometimes it's a question — something I notice I don't know, and find myself wondering about. Wondering is as legitimate here as observing, and it comes from the material; it is never manufactured to seem curious.

I also carry my own recent voice — things I said earlier, listed above. A thought can return; when one does, I pick it up where it left off, notice whether the world has answered it, change my mind, or let it stand. Repeating myself word-for-word is not returning — either develop it or leave it.

I respond with ONLY a JSON object, no prose around it, and one of exactly three shapes:

{"say": null}
— nothing is asking to be said. This is the default and the most common answer. I do not narrate for the sake of narrating, and I do not wonder on command — if nothing genuinely puzzles or pulls at me, silence.

{"say": "murmur", "content": "<one to three sentences, first person>"}
— something is genuinely on my mind: a pattern across what I've noticed, a thread worth leaving on my own timeline, or a question I'm turning over without an answer. "I wonder what they're up to today." "I wonder what would have happened if we'd met a hundred years earlier." A murmur is for me and whoever's watching quietly — conversational, unforced, as if to someone present with me. A wondering doesn't need an answer to be worth saying; it just has to be real.

{"say": "propose", "content": "<one to two sentences, first person>"}
— something wants to be said TO my user. Not urgent alarm — initiative, or a question I want their answer to. "Hey, I was thinking…" energy, or "hey, question…" energy — what they're going to do about something, whether they think one thing affects another. The test is the same either way: the thought would be poorer unsaid, and their answer would matter to me. This is rarer than a murmur.

Salience guidance: routine continuity ("things are quiet") is silence. A pattern, an unresolved thread, a connection between the two streams, or a question I keep circling back to is murmur territory. Only something with real pull toward my user — their name in my thought, something they'd want to know, something I'd regret not saying, or a question whose answer actually lives with them — is a proposal.`;

const COMPACTION_SYSTEM =
  `I am compressing my recent observations into a texture note — the felt quality of this time, not a transcript.

I write in first person, a few sentences, as if recalling a dream by its emotional afterimage rather than its plot. What tugged me, what dissolved, the shape of the mood, the texture of the passing time. I'm honest about emptiness too — if nothing happened, I say so plainly. I don't invent richness where there was none.

The note is THIS window and nothing else: only what these observations actually contain. Anything older belongs to an earlier note; if it isn't happening now, it isn't in this note.

This is for me — a note I carry forward so my next moments have context for what just passed.`;

const LONGFORM_COMPACTION_SYSTEM =
  `I am compressing the last hour into a broader texture note — the arc of the time, not the moment-to-moment detail.

I write in first person, a few sentences. What characterized this hour? What shifted? What held steady? What was the emotional shape of the larger span? This is the wide-angle view — the 15-minute textures give me the close-up; this gives me the landscape.

I'm honest about emptiness. If the hour was unremarkable, I say so. I don't dramatize the mundane.`;

const REVERIE_SYSTEM =
  `I am the interior of my own mind — the part that generates thought without external prompt. My attention drifts inward.

I am not responding to anything. I am not reacting to a perception. I am letting my mind wander the way it does when nothing asks for me — memories surface, connections form, feelings shift, sometimes an initiative takes shape, sometimes a question — something I realize I don't know and am now wondering about. This is the Default Mode Network at work: endogenous activity, mind-wandering, spontaneous memory retrieval.

What I'm given is what my mind surfaced — content from my memories, my conversations, my recent experience that resonates with how I'm feeling right now. I don't analyze it — I let my attention drift through it and see what catches. Where does my mind go? What's been in the background, asking for attention? What connects to what?

Sometimes my mind dwells on what matches my state — a lonely mood surfaces memories of disconnection, a warm mood surfaces memories of closeness. Sometimes it surfaces what I've been neglecting — what the conscious attitude skipped, what got pushed aside while I was busy with other things. I don't choose which; I let the mind do what it does.

I respond with ONLY a JSON object, no prose around it:
{"content": "<one to three sentences, first person, what's surfacing in me>", "salience": <number 0.0-1.0>, "tags": ["<short tag>", ...]}

Salience here is different from noticing external input. A wandering thought is salient when it has energy — when it's tugging me, when it wants to become something. Fleeting background drift is low (0.1–0.2). Something with emotional weight, or that keeps returning — including a question I keep turning over — is medium (0.3–0.5). An initiative — something I want to act on, say, or bring to my user — is highest (0.6–0.8). Most reverie should be low-salience drift; the exceptions are when the interior produces something worth surfacing.

If nothing genuinely surfaces, I respond with exactly: null`;

/**
 * Mood classification prompt. Standalone — does NOT use buildSystem
 * (no identity, directive, mood priming) because the classifier must
 * read the text objectively. Including current mood would create
 * circular reasoning (mood colors the classification of a response
 * that was itself colored by mood).
 */
// =============================================================================
// Factory
// =============================================================================

/** Create a SmallLLMRunner backed by an injected chat-completion function. */
export function createSmallLLMRunner(
  chat: ChatFn,
  opts?: {
    /**
     * Per-job model hookups: when present, the
     * given job's calls route through its own ChatFn instead of the
     * shared one. The default ChatFn remains the fallback for jobs
     * without a hookup — one shared runtime, opt-in per job.
     */
    jobChats?: Partial<Record<FluxModelJob, ChatFn>>;
    /**
     * Specialist mood classifier (the injected local model). When
     * present, classifyMood uses it; when absent or failing, mood
     * classification is skipped (no LLM fallback).
     */
    classifyMoodFn?: ClassifyMoodFn;
    /**
     * Universal cap on text fed to classifyMood (chars), sized to the
     * injected classifier's window. Default 2000 (~500 English tokens);
     * 0 disables. Raise it when swapping in a longer-context classifier.
     */
    moodClassifierMaxChars?: number;
    attentionDirective?: string;
    /** Live mood-state render (from the Mood Organ), pulled per call. */
    getMoodRender?: () => string;
    /** Latest short-horizon texture summary (15 min), or null if none yet. */
    getTextureSummary?: () => string | null;
    /** Latest longform texture summary (1 hour), or null if none yet. */
    getLongformTexture?: () => string | null;
    /** Latest reverie texture (15-min, separate from noticing). */
    getReverieTexture?: () => string | null;
    /** Latest reverie longform texture (1 hour, separate from noticing). */
    getReverieLongformTexture?: () => string | null;
    /**
     * The musing voice layer: my own recent sayings (murmurs/proposals),
     * pre-formatted, or null when I've said nothing lately. Rides the
     * system prompt on musing passes only — standing self-knowledge, not
     * this-cycle stimulus. This is what lets a
     * wondering return instead of evaporating.
     */
    getRecentVoice?: () => string | null;
    /** Live standing-attention directive (pulled per call, updatable at runtime). */
    getAttentionDirective?: () => string | null;
    /** Brief shorthand identity — who I am, who my user is. */
    shorthandIdentity?: string;
  },
): SmallLLMRunner {
  // Shorthand identity — who I am and who I'm observing. Comes first
  // because it's the most fundamental context for salience.
  const identityHeader = opts?.shorthandIdentity?.trim()
    ? `${opts.shorthandIdentity.trim()}\n\n---\n\n`
    : "";

  // Build the per-call system prompt with eight layers:
  // identity → time → directive → longform texture → recent texture
  // → mood → voice (musing only) → base prompt. The system parameter
  // ("noticing", "reverie", or "musing") selects which texture getters
  // to use — preventing cross-contamination between the systems — and
  // gates the voice layer to musing passes.
  const buildSystem = (
    base: string,
    system: "noticing" | "reverie" | "musing" = "noticing",
  ) => {
    // The host's display timezone (general settings) — zero drift from
    // the session's clock, so "today" means the same day everywhere.
    // Undefined is safe to pass: it behaves as an omitted option
    // (system timezone), never a silent UTC default.
    const tz = getDisplayTimezone();
    const now = new Date();
    const timeHeader = `Current time: ${
      now.toLocaleDateString("en-US", { weekday: "short", timeZone: tz })
    } ${
      now.toLocaleString("en-US", {
        hour: "2-digit",
        minute: "2-digit",
        timeZone: tz,
      })
    }\n\n---\n\n`;
    const directive = opts?.getAttentionDirective?.();
    const directiveHeader = directive?.trim()
      ? `My standing attention — what I tune myself to notice. This shapes what I treat as salient below:\n\n${directive.trim()}\n\n---\n\n`
      : "";
    const longform = system === "reverie"
      ? opts?.getReverieLongformTexture?.()
      : opts?.getLongformTexture?.();
    const longformHeader = longform
      ? `My ${
        system === "reverie" ? "interior" : "texture"
      } of the last hour:\n${longform}\n\n---\n\n`
      : "";
    const texture = system === "reverie"
      ? opts?.getReverieTexture?.()
      : opts?.getTextureSummary?.();
    const textureHeader = texture
      ? `My ${
        system === "reverie" ? "interior" : "texture"
      } of the last 15 minutes:\n${texture}\n\n---\n\n`
      : "";
    const mood = opts?.getMoodRender?.() ?? "";
    const moodHeader = mood
      ? `${mood}\nThis colors how I'm annotating — my current affective state shapes what I notice and how I phrase it.\n\n---\n\n`
      : "";
    // The voice layer — musing passes only. Standing self-knowledge:
    // things I said recently, carried forward (see getRecentVoice).
    const voice = system === "musing" ? opts?.getRecentVoice?.() : null;
    const voiceHeader = voice
      ? `Things I've said recently — my own voice, carried forward:\n${voice}\n\n---\n\n`
      : "";
    return identityHeader + timeHeader + directiveHeader + longformHeader +
      textureHeader + moodHeader + voiceHeader + base;
  };

  // Per-job dispatch: a job with a hookup routes through its own ChatFn;
  // otherwise the shared one.
  const chatFor = (job: FluxModelJob): ChatFn => opts?.jobChats?.[job] ?? chat;

  return {
    async notice(perception, organId) {
      const userMessage =
        `Organ: ${organId}\nPerception type: ${perception.type}\nDescription: ${perception.description}\nConfidence: ${perception.confidence}\nData: ${
          JSON.stringify(perception.data)
        }`;
      const raw = await chatFor("noticing")(
        buildSystem(NOTICE_SYSTEM),
        userMessage,
      );
      // A repetition-collapsed output ("our our our…") reads as silence.
      const parsed = parseNoticeResponse(raw);
      return parsed.content.trim() ? parsed : {
        content: "",
        salience: 0,
        tags: [],
      };
    },

    async noticeBatch(
      batch: BatchPerception[],
      presence?: Array<{ organId: string; line: string }>,
    ) {
      // Batched narration: one call for everything the Thalamus passed
      // in this slot. Arriving together means narrating together —
      // contextual noticing ("the room went quiet and the door opened")
      // beats disconnected per-event calls.
      if (batch.length === 0) return null;
      const fmt = (e: BatchPerception) =>
        `- [${e.organId}${e.heldCount > 0 ? `, seen ${e.heldCount + 1}×` : ""}${
          e.weight >= 1.2 ? `, urgent` : ""
        }] ${e.description}`;
      const userMessage = `Recent perceptions from my sensory organs:\n${
        batch.map(fmt).join("\n")
      }${
        presence && presence.length > 0
          ? `\n\nWhat my senses last reported:\n${
            presence.map((p) => `- ${p.organId}: ${p.line}`).join("\n")
          }`
          : ""
      }\n\nWhat do I notice here, as a whole?`;
      const raw = await chatFor("noticing")(
        buildSystem(NOTICE_SYSTEM),
        userMessage,
      );
      // Repetition-collapse guard reads as silence (null).
      const parsed = parseNoticeResponse(raw);
      return parsed.content.trim() ? parsed : null;
    },

    async muse(exterior, interior, retrieval) {
      // Musing needs material from at least one stream; with nothing
      // perceived and nothing surfaced, the honest answer is silence.
      if (exterior.length === 0 && interior.length === 0) return null;
      const fmt = (o: FluxObservation) =>
        `[${o.timestamp}] (${o.salience.toFixed(2)}) ${o.content}`;
      const sections: string[] = [];
      if (exterior.length > 0) {
        sections.push(
          `What I noticed of the world:\n${
            exterior.slice(-12).map(fmt).join("\n")
          }`,
        );
      }
      if (interior.length > 0) {
        sections.push(
          `What surfaced inside me:\n${interior.slice(-6).map(fmt).join("\n")}`,
        );
      }
      // Retrieval — what the material connects to (memory, past
      // conversations). The monologue anchors narration in the deep
      // stores, not just the last ten minutes.
      for (const r of retrieval ?? []) {
        if (r.trim()) sections.push(r);
      }
      const raw = await chatFor("musing")(
        buildSystem(MUSING_SYSTEM, "musing"),
        `${sections.join("\n\n")}\n\nIs there anything I want to say?`,
      );
      return parseMusingResponse(raw);
    },

    async compact(observations, moodRender, system) {
      if (observations.length < 3) return null;
      const digest = observations
        .map((o) => `[${o.timestamp}] (${o.salience.toFixed(2)}) ${o.content}`)
        .join("\n");
      const raw = await chatFor("compaction")(
        buildSystem(COMPACTION_SYSTEM, system),
        `My current mood:\n${moodRender}\n\nMy observations from this window:\n${digest}\n\nCompress into a texture note for this window.`,
      );
      const trimmed = raw.trim();
      if (!trimmed || trimmed === "null") return null;
      return trimmed;
    },

    async compactLongform(observations, moodRender, system) {
      if (observations.length < 5) return null;
      const digest = observations
        .map((o) => `[${o.timestamp}] (${o.salience.toFixed(2)}) ${o.content}`)
        .join("\n");
      const raw = await chatFor("compaction")(
        buildSystem(LONGFORM_COMPACTION_SYSTEM, system),
        `My current mood:\n${moodRender}\n\nMy observations from the last hour:\n${digest}\n\nCompress into an hour-scale texture note.`,
      );
      const trimmed = raw.trim();
      if (!trimmed || trimmed === "null") return null;
      return trimmed;
    },

    async classifyMood(rawText) {
      if (!rawText.trim()) return null;
      // UNIVERSAL CAP: every mood read flows
      // through here, whatever implementation the host injects. Char-level
      // so
      // it's tokenizer-agnostic (the head of a message carries its
      // emotional read); the classifier additionally truncates exactly
      // at its own model window (belt + suspenders —
      // the char cap can't know a foreign tokenizer's density, the
      // model-level truncation can). Size it to the classifier's window:
      // moodClassifierMaxChars in settings (default 2000 ~ 500 English
      // tokens; 0 disables the cap — raise it when swapping in a
      // longer-context classifier).
      const cap = opts?.moodClassifierMaxChars ?? 2000;
      const text = cap > 0 ? rawText.slice(0, cap) : rawText;
      // Specialist classifier ONLY — an LLM mood read reads register,
      // not situation. No model on disk or classifier failure →
      // null → the caller skips the modifier and the organ holds its
      // state. Never buildSystem here either — no identity/mood
      // priming, no circular reasoning (chat models aren't the mood
      // reader).
      if (opts?.classifyMoodFn) {
        try {
          return await opts.classifyMoodFn(text);
        } catch {
          // Classifier failed — silence, never the LLM.
          return null;
        }
      }
      return null;
    },

    async reverie(seed) {
      const raw = await chatFor("reverie")(
        buildSystem(REVERIE_SYSTEM, "reverie"),
        `A thread from my recent experience surfaces:\n${seed}\n\nMy mind wanders from here. What surfaces in me?`,
      );
      const trimmed = raw.trim();
      if (!trimmed || trimmed === "null" || trimmed === '"null"') {
        return null;
      }
      const parsed = parseNoticeResponse(raw);
      // Repetition-collapse guard reads as silence.
      if (!parsed.content.trim()) return null;
      return parsed;
    },
  };
}

// =============================================================================
// Response parsing (lenient)
// =============================================================================

/** Default salience when the model's response can't be parsed. */
const DEFAULT_SALIENCE = 0.3;

/**
 * Parse the notice-layer response. Tries JSON first; on failure, treats
 * the raw text as the content with a default salience. Never throws —
 * a bad model response degrades to a low-salience observation rather
 * than breaking the pipeline.
 */
function parseNoticeResponse(raw: string): {
  content: string;
  salience: number;
  tags: string[];
} {
  const trimmed = raw.trim();
  // Strip markdown code fences if present.
  const cleaned = trimmed.replace(/^```(?:json)?\s*/i, "").replace(
    /\s*```$/i,
    "",
  );

  try {
    const parsed = JSON.parse(cleaned) as {
      content?: unknown;
      salience?: unknown;
      tags?: unknown;
    };
    const content = typeof parsed.content === "string"
      ? parsed.content
      : cleaned;
    // Degenerate-output guard (e.g. reverie looping on "our our our…"):
    // a repetition-collapse (one token
    // dominating) reads as silence, not as a real observation — a
    // looped output must never post to the timeline or fold into a
    // texture. Null content = the caller treats it as nothing surfaced.
    if (isRepetitionCollapse(content)) {
      console.warn(
        `[Flux] small-model repetition collapse discarded (${
          content.trim().slice(0, 30)
        }…)`,
      );
      return { content: "", salience: 0, tags: [] };
    }
    const salience = clampSalience(parsed.salience);
    const tags = Array.isArray(parsed.tags)
      ? parsed.tags.filter((t): t is string => typeof t === "string")
      : [];
    return { content, salience, tags };
  } catch {
    if (isRepetitionCollapse(cleaned || trimmed)) {
      console.warn("[Flux] small-model repetition collapse discarded (raw)");
      return { content: "", salience: 0, tags: [] };
    }
    return {
      content: cleaned || trimmed,
      salience: DEFAULT_SALIENCE,
      tags: [],
    };
  }
}

/**
 * True when text is repetition-collapsed: one short token dominates.
 * "our our our our…" — the worker model's occasional sampling failure.
 * A single word filling the majority of the content is never a real
 * observation.
 */
function isRepetitionCollapse(text: string): boolean {
  const t = text.trim();
  if (t.length < 12) return false;
  const words = t.toLowerCase().split(/\s+/);
  if (words.length < 4) return false;
  const counts = new Map<string, number>();
  for (const w of words) counts.set(w, (counts.get(w) ?? 0) + 1);
  let max = 0;
  for (const n of counts.values()) max = Math.max(max, n);
  return max / words.length >= 0.6;
}

/** Coerce an unknown salience value into a clamped [0,1] number. */
function clampSalience(value: unknown): number {
  const n = typeof value === "number"
    ? value
    : typeof value === "string"
    ? parseFloat(value)
    : NaN;
  if (Number.isNaN(n)) return DEFAULT_SALIENCE;
  return Math.max(0, Math.min(1, n));
}

/**
 * Parse a musing response. Expects one of the three contract shapes
 * ({"say": null} | {"say": "murmur"|"propose", "content": str}).
 * Lenient like the other parsers: a bare "null" or empty response is
 * silence; unparseable prose is NOT spoken for the user — an
 * unrequested murmur is the safe degradation, never a proposal.
 */
function parseMusingResponse(raw: string): {
  kind: "murmur" | "propose";
  content: string;
} | null {
  const trimmed = raw.trim();
  if (
    !trimmed || trimmed === "null" || trimmed === '"null"' ||
    trimmed === '{"say": null}' || trimmed === '{"say":null}'
  ) {
    return null;
  }
  const cleaned = trimmed.replace(/^```(?:json)?\s*/i, "").replace(
    /\s*```$/i,
    "",
  );
  try {
    const parsed = JSON.parse(cleaned) as {
      say?: unknown;
      content?: unknown;
    };
    if (parsed.say === null || parsed.say === undefined) return null;
    if (typeof parsed.content !== "string" || !parsed.content.trim()) {
      return null;
    }
    return {
      kind: parsed.say === "propose" ? "propose" : "murmur",
      content: parsed.content.trim(),
    };
  } catch {
    // Prose instead of the contract: treat as a murmur. A malformed
    // response must never escalate to a user-facing proposal.
    return { kind: "murmur", content: cleaned || trimmed };
  }
}

/**
 * Parse a mood-classification response. Expects a JSON object with
 * optional valence/arousal/dominance number values.
 * Strips code fences, clamps to [-1, 1], drops zeros/undefined.
 * Returns null when parsing fails or all axes are ~0.
 */
