/**
 * Runtime capability types — the dependency-injection seam.
 *
 * Flux defines these function types and the host (Psycheros) provides
 * concrete implementations by wrapping its `getEmbedder()` and
 * `createWorkerClient()` / `createClientFromProfile()` — explicit
 * wiring, unit tests without psycheros's server/DB.
 *
 * TypeScript structural typing means psycheros's `LLMClient.chatStream`
 * satisfies `ChatFn` once wrapped, without flux importing the
 * `LLMClient` type.
 */

/**
 * Embeds text into a vector. Provided by the host wrapping the shared
 * `LocalEmbedder` (`all-MiniLM-L6-v2`, 384-dim). Used by the promotion
 * filter for cosine-similarity focus matching and corroboration.
 */
export type EmbedFn = (text: string) => Promise<number[]>;

/**
 * Completes a single chat turn: given a system message and a user
 * message, returns the full assistant text. Provided by the host
 * wrapping its small-model LLM client (worker model). Used by the
 * noticing layer and the thoughtstream puller.
 */
export type ChatFn = (
  systemMessage: string,
  userMessage: string,
) => Promise<string>;

/**
 * Classifies text into mood axis deltas — the Mood Organ's specialist
 * classifier seam. Provided by the host running an in-process emotion
 * classifier (v1: GoEmotions + the mood table). Returns null when
 * classification isn't possible (model unavailable, empty text) — the
 * caller skips the modifier rather than failing. Unlike ChatFn this is
 * NOT an LLM call: it's a frozen model, deterministic, milliseconds.
 */
export type ClassifyMoodFn = (
  text: string,
) => Promise<
  | Partial<Record<"valence" | "arousal" | "dominance", number>>
  | null
>;
