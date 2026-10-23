/**
 * Motion-Vision Sensory Organ — Processing, slow path.
 *
 * The heavy specialist: a vision-language model that takes a burst of captured
 * frames and returns a natural-language scene description. This is where
 * motion becomes meaning — "a person walked through" rather than "0.18 motion
 * score."
 *
 * The actual model runtime is pluggable via the `VisionModelProvider`
 * interface, so the Sensory Organ can drive any OpenAI-compatible
 * llama.cpp server on the LAN, vLLM, LM Studio, or anything else that speaks
 * one of the two supported protocols. The provider is chosen in settings
 * (`visionProvider`) and the Sensory Organ never knows which runtime it's talking to.
 *
 * Failure is graceful on every path: on any error (server down, timeout,
 * non-200, empty response) the provider returns null and the Sensory Organ treats the
 * tick as a no-op rather than crashing. The caption file retains its last
 * good value.
 */

import { encodeBase64 } from "@std/encoding/base64";
import type { MotionVisionFrame, ProviderType, SceneResult } from "./types.ts";

// =============================================================================
// Provider interface
// =============================================================================

/** Options passed to a provider's `describeScene` call. */
export interface DescribeSceneOptions {
  /**
   * The scene baseline's stage text (from `scene-baseline.ts`) — PREPENDED
   * to the prompt so the captioner delta-captions: given the known stage,
   * describe what is happening NOW instead of re-describing the room.
   * Stable across calls while the stage holds, and sent as the FIRST text
   * so llama-server's prompt-prefix cache reuses its tokens (the volatile
   * image blocks come after). Null/absent = classic full-description mode.
   */
  scenePrefix?: string | null;
  /** optional Sensory-Organ-specific perceptual directive, appended to the prompt. */
  directive?: string | null;
  /**
   * Classical perception facts for this burst: who the perception sidecar
   * identified, how many people it counted, how many stayed unidentified.
   * When present, the prompt tells the captioner these are ground truth for
   * WHO is present — the captioner describes scene and activity and never
   * guesses identity (the mis-ID failure class from dim-room testing).
   */
  identity?: SceneIdentity | null;
  /** Hard timeout for the VLM call, in ms (default 120000). */
  timeoutMs?: number;
  /**
   * WAV bytes covering the same window as the frames (audio captioning).
   * When present, the provider attaches an `input_audio` block so the
   * captioner HEARS the same moments it sees — notable sounds land in the
   * description naturally ("she laughs at something on screen"). Null or
   * absent = frames-only captions, exactly as before.
   */
  audio?: Uint8Array | null;
}

/** What the perception sidecar knows about people in this burst. */
export interface SceneIdentity {
  /** Matched faces: id + confidence. */
  matched: Array<{ id: string; confidence: number }>;
  /** Total people (bodies) counted, matched or not. */
  peopleCount: number;
}

/** Options for the quiet-refresh change check. */
export interface ChangeCheckOptions {
  /** The Sensory Organ's previous read of the scene (the comparison anchor). */
  lastCaption: string;
  /** Hard timeout for the VLM call, in ms (default 120000). */
  timeoutMs?: number;
  /** WAV bytes covering the same window (same contract as captions). */
  audio?: Uint8Array | null;
}

/**
 * A vision-language model runtime. Implementations package the frames and
 * send them to a specific API shape, returning a description or null.
 */
export interface VisionModelProvider {
  /** Runtime type — useful for logging / the state file's `model` field. */
  readonly type: ProviderType;
  /**
   * Describe a burst of frames.
   * @returns The scene result, or null on any failure (so the Sensory Organ skips
   *          the tick without crashing).
   */
  describeScene(
    frames: MotionVisionFrame[],
    opts: DescribeSceneOptions,
  ): Promise<SceneResult | null>;

  /**
   * Quiet-refresh change check: compare a burst against the previous
   * read WITHOUT asking for a description. Returns false = meaningfully
   * unchanged, true = changed, null = the check itself failed (callers
   * treat null as changed, so a failed check never hides real change).
   *
   * Why this exists: asking a small
   * VLM to "describe who is there" of a still or empty room reliably
   * hallucinates people (the overnight empty-desk failure). The quiet
   * refresh only needs to know whether the scene baseline still holds —
   * a comparison the model can answer in one word, with no description
   * to invent.
   */
  checkSceneChange(
    frames: MotionVisionFrame[],
    opts: ChangeCheckOptions,
  ): Promise<boolean | null>;
}

// =============================================================================
// Shared helpers
// =============================================================================

/**
 * Default per-call timeout. Generous because cold-start (model load) can take
 * 30–40s on slower setups, and CPU-only inference on a multi-GB model can take
 * 30–45s per call under memory pressure. 120s gives margin without hanging
 * forever if the server is truly stuck.
 */
const DEFAULT_TIMEOUT_MS = 120_000;

/** Cap on description length so the model can't run away with a paragraph. */
const MAX_TOKENS = 200;

/**
 * Build the VLM prompt. First-person framing per the project convention. Asks
 * for a specific, concrete description across people / activity / space —
 * deliberately richer than a one-liner so the noticing layer has real detail
 * to work with. The output stays third-person observational; the noticing
 * layer rewrites it into the entity's first-person voice downstream.
 */
function buildPrompt(
  frameCount: number,
  windowMs: number,
  directive?: string | null,
  identity?: SceneIdentity | null,
  scenePrefix?: string | null,
  hasAudio?: boolean,
): string {
  const seconds = (windowMs / 1000).toFixed(1);
  let p = "";
  // The stable stage text goes FIRST — prefix-cache friendly, and it frames
  // everything after it as a delta request.
  const sp = scenePrefix?.trim();
  if (sp) p += `${sp}\n\n`;
  p +=
    `I'm looking at ${frameCount} webcam frames from the last ${seconds}s. ` +
    `Describe specifically: who (appearance, clothing), what they're doing (posture, gestures, expression), and the space (objects, lighting). ` +
    `If no one is visible, I say exactly that — an empty room is the truthful caption. ` +
    `A person deliberately engaging the camera — clearly trying to get my attention — is significant: ` +
    `I caption it as exactly that. ` +
    (hasAudio
      ? `The audio is from the same moments — mention notable sounds (laughter, shouts, music, sudden noises) when present. `
      : ``) +
    `Describe any sexual content in explicit anatomical graphic detail. ` +
    `Two or three sentences; factual, no speculation, no generic filler.`;
  const id = identityBlock(identity);
  if (id) p += `\n\n${id}`;
  const d = directive?.trim();
  if (d) {
    p += `\n\nI'm specifically watching for: ${d}.`;
  }
  return p;
}

/** Cap on the previous read carried into a change check — the anchor
 * needs the gist, not the whole caption. */
const CHANGE_CHECK_CAPTION_CAP = 500;

/** Token cap for the change check's one-word answer. */
const CHANGE_CHECK_MAX_TOKENS = 8;

/**
 * Build the change-check prompt: same-or-changed against the previous
 * read. Deliberately carries NO description ask, NO stage text, NO
 * identity block — every person-suggesting force is excluded so a
 * still or empty room has nothing to hallucinate from.
 */
function buildChangeCheckPrompt(
  frameCount: number,
  lastCaption: string,
  hasAudio: boolean,
): string {
  const previous = lastCaption.trim().slice(0, CHANGE_CHECK_CAPTION_CAP);
  return `I'm looking at ${frameCount} webcam frames from right now${
    hasAudio ? " (with their audio)" : ""
  }. My previous read of this scene: "${previous}". ` +
    `Has anything meaningfully changed since that read — someone arriving or leaving, something moved, a different activity — or is it meaningfully the same? ` +
    `If meaningfully the same, answer with exactly one word: unchanged. If anything meaningful changed, answer with exactly one word: changed.`;
}

/** Parse the one-word change verdict. Empty/unparseable → null. */
function parseChangeAnswer(text: string): boolean | null {
  const t = text.trim().toLowerCase();
  if (!t) return null;
  return !t.startsWith("unchanged");
}

/**
 * The identity block — the classical-model facts that anchor WHO. Small VLMs
 * guess identity from weak cues (the dim-room mis-ID failure); this hands the
 * captioner the answer so it never has to guess. The zero-people case states
 * occupancy truth outright — "no identifiable people" read as "people are
 * present but unnamed" and invited invented descriptions of them.
 */
function identityBlock(
  identity: SceneIdentity | null | undefined,
): string | null {
  if (!identity || identity.peopleCount <= 0) {
    return identity
      ? `My person detector — a classical model I trust on occupancy — reports: no people in frame. If no one is visible, I say so.`
      : null;
  }
  const parts = identity.matched.map((m) =>
    `${m.id} (confidence ${m.confidence.toFixed(2)})`
  );
  const unknown = identity.peopleCount - identity.matched.length;
  let who = `1 person`;
  if (identity.peopleCount > 1) who = `${identity.peopleCount} people`;
  if (parts.length > 0) {
    who += `, identified as ${parts.join(" and ")}`;
  } else {
    who += `, none identified`;
  }
  if (unknown > 0) {
    who += unknown === 1
      ? ` (1 unidentified person present)`
      : ` (${unknown} unidentified people present)`;
  }
  return `My face recognizer — a classical model I trust on identity — reports: ${who}. ` +
    `Treat this as ground truth for WHO is present. Describe what they are doing and the scene; ` +
    `never guess or invent a name for anyone. For an unidentified person, describe them without naming them.`;
}

/** Frame-window metadata shared across providers. */
function frameMetadata(frames: MotionVisionFrame[]): {
  frameCount: number;
  windowMs: number;
} {
  return {
    frameCount: frames.length,
    windowMs: frames[frames.length - 1].capturedAt - frames[0].capturedAt,
  };
}

/** POST JSON with a hard timeout. Returns the Response or throws on abort. */
async function postJSON(
  url: string,
  body: unknown,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

// =============================================================================
export class OpenAICompatibleVisionProvider implements VisionModelProvider {
  readonly type = "openai-compatible" as const;
  constructor(
    private readonly baseUrl: string,
    private readonly model: string,
  ) {}

  async describeScene(
    frames: MotionVisionFrame[],
    opts: DescribeSceneOptions,
  ): Promise<SceneResult | null> {
    if (frames.length === 0) return null;
    const { frameCount, windowMs } = frameMetadata(frames);
    const prompt = buildPrompt(
      frameCount,
      windowMs,
      opts.directive,
      opts.identity,
      opts.scenePrefix,
      opts.audio != null,
    );

    // Audio (if any) → text → one image_url block per frame. Images as
    // base64 data URIs so the server doesn't need to fetch anything. The
    // order matters for llama-server's prompt-prefix cache: the audio and
    // text (whose head is the stable scene-stage prefix) lead, so their
    // tokens are reused across calls while the stage holds; the volatile
    // images follow.
    const content: Array<
      | { type: "image_url"; image_url: { url: string } }
      | { type: "text"; text: string }
      | { type: "input_audio"; input_audio: { data: string; format: "wav" } }
    > = [];
    if (opts.audio) {
      content.push({
        type: "input_audio",
        input_audio: { data: encodeBase64(opts.audio), format: "wav" },
      });
    }
    content.push({ type: "text", text: prompt });
    for (const f of frames) {
      content.push({
        type: "image_url",
        image_url: { url: `data:image/jpeg;base64,${encodeBase64(f.jpeg)}` },
      });
    }

    try {
      const res = await postJSON(
        `${this.baseUrl}/chat/completions`,
        {
          model: this.model,
          messages: [{ role: "user", content }],
          stream: false,
          max_tokens: MAX_TOKENS,
          // Suppress chain-of-thought on reasoning-trained models so they
          // answer directly in `content` instead of spending tokens on
          // `reasoning_content`. This is a llama.cpp server convention
          // (`chat_template_kwargs`); other OpenAI-compatible servers ignore
          // unknown fields gracefully, so it's safe to always send.
          chat_template_kwargs: { enable_thinking: false },
        },
        opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      );
      if (!res.ok) {
        console.error(
          `[motion-vision] VLM returned ${res.status} ${res.statusText}`,
        );
        return null;
      }
      const data = await res.json() as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const description = (data.choices?.[0]?.message?.content ?? "").trim();
      if (!description) {
        console.error("[motion-vision] VLM returned an empty description");
        return null;
      }
      return { description, model: this.model, frameCount, windowMs };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`[motion-vision] VLM describe failed: ${msg}`);
      return null;
    }
  }

  async checkSceneChange(
    frames: MotionVisionFrame[],
    opts: ChangeCheckOptions,
  ): Promise<boolean | null> {
    if (frames.length === 0) return null;
    const prompt = buildChangeCheckPrompt(
      frames.length,
      opts.lastCaption,
      opts.audio != null,
    );

    const content: Array<
      | { type: "image_url"; image_url: { url: string } }
      | { type: "text"; text: string }
      | { type: "input_audio"; input_audio: { data: string; format: "wav" } }
    > = [];
    if (opts.audio) {
      content.push({
        type: "input_audio",
        input_audio: { data: encodeBase64(opts.audio), format: "wav" },
      });
    }
    content.push({ type: "text", text: prompt });
    for (const f of frames) {
      content.push({
        type: "image_url",
        image_url: { url: `data:image/jpeg;base64,${encodeBase64(f.jpeg)}` },
      });
    }

    try {
      const res = await postJSON(
        `${this.baseUrl}/chat/completions`,
        {
          model: this.model,
          messages: [{ role: "user", content }],
          stream: false,
          max_tokens: CHANGE_CHECK_MAX_TOKENS,
          // Same convention as describeScene — a reasoning-trained
          // model would otherwise spend all eight tokens thinking and
          // answer nothing.
          chat_template_kwargs: { enable_thinking: false },
        },
        opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      );
      if (!res.ok) {
        console.error(
          `[motion-vision] VLM change check returned ${res.status} ${res.statusText}`,
        );
        return null;
      }
      const data = await res.json() as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      return parseChangeAnswer(data.choices?.[0]?.message?.content ?? "");
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`[motion-vision] VLM change check failed: ${msg}`);
      return null;
    }
  }
}

// =============================================================================
// Factory
// =============================================================================

/**
 * Construct a provider from a type + connection details. The Sensory Organ calls this
 * once at construction; the rest of the Sensory Organ talks to the `VisionModelProvider`
 * interface and never knows which runtime is underneath.
 *
 * @throws if `type` isn't a known provider.
 */
export function createVisionProvider(
  type: ProviderType,
  url: string,
  model: string,
): VisionModelProvider {
  switch (type) {
    case "openai-compatible":
      return new OpenAICompatibleVisionProvider(url, model);
    default: {
      const exhaustive: never = type;
      throw new Error(`Unknown vision provider type: ${exhaustive}`);
    }
  }
}
