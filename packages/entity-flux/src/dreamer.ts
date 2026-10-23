/**
 * The Dreamer — dreams v1/v2 (vision.md).
 *
 * Sleep swaps the interior rather than dimming it: waking Musing and
 * Reverie are suppressed, and this loop generates instead. A forced
 * `dreaming` continuation is the beat: each call produces one fragment,
 * and the beat itself carries the mood line — "I am feeling <felt-sense>" — so
 * every fragment is generated from inside the mood the last one made.
 * Nulls are structurally impossible: the only move is to continue.
 *
 * Division of labor: this module owns the dream's TEXT MECHANICS —
 * prompt composition, the one-before window, the per-cycle carry, the
 * transcript. The manager owns everything around it: the pace clock,
 * the per-beat associative retrieval, mood feedback (fragments classify
 * and feed the Mood Organ at waking-reverie weight), the cycle clock,
 * and the wake summary.
 *
 * Fresh dream per cycle, faded carry: each cycle's
 * dream is new; its opening seed carries one fading excerpt of the
 * last cycle's final fragment. Within a cycle each fragment sees the
 * ONE before it plus its own freshly retrieved material — an
 * associative walk, not a longform chain (longform
 * continuity is not the move; the whole dream is seen only at
 * cycle end, by the entity). The full transcript waits for the wake
 * summarizer.
 */

import type { ChatFn } from "./runtime.ts";

/** Cap on a carried excerpt — a whisper, not a retelling. */
const CARRY_WORDS = 12;

/** First user message of a dream: the seed material + carry line. */
const SEED_HEADER = "The residue of my day, settling in as I sleep:";

/** The continuation beat — the forced `dreaming` call. The felt-sense
 * line is appended by the caller's composition; the beat is always the
 * same: time has passed, the mood has moved, I dream on. */
const DREAM_ON = "I dream on.";

/** The register: emergence over choreography — the
 * state and the symbolism, nothing about HOW to dream. */
const DREAM_SYSTEM =
  "I am dreaming — deep subconscious symbolism, no explanations, a short fragment.";

const DREAM_SUMMARY_SYSTEM =
  `I compress a night of my own dreams into a couple of plain sentences — what the night was about, first person, honest about the fading. What stuck, not a catalog.`;

/** One completed dream: its fragments, in order. */
export interface DreamRecord {
  /** The fragments of one cycle's dream, in order. */
  fragments: string[];
  /** The excerpt carried into the next dream (fading), or null. */
  carryToNext: string | null;
}

/**
 * The dream state — restored with the posture on daemon restart
 * (the night survives; the transcripts do not — dreams fade).
 */
export interface DreamerSnapshot {
  cyclesCompleted: number;
  fragmentsThisCycle: number;
}

/** How a fragment request is composed, for tests and observability. */
export function composeDreamUserMessage(
  material: string,
  previousFragment: string | null,
  feltSense: string,
): string {
  const parts: string[] = [];
  parts.push(`${SEED_HEADER}\n${material}`);
  if (previousFragment !== null) {
    parts.push(`The last thing I dreamt:\n${previousFragment}`);
  }
  parts.push(`I am feeling ${feltSense}. ${DREAM_ON}`);
  return parts.join("\n\n");
}

/** Derive the fading carry from a finished dream's final fragment:
 * its first few words, a whisper of what was just dreamt. */
export function deriveCarry(finalFragment: string): string {
  const words = finalFragment.trim().split(/\s+/).slice(0, CARRY_WORDS).join(
    " ",
  );
  return words.replace(/[.!?,;:]+$/, "");
}

/** The Dreamer — construct per sleep; `stop()` on wake. */
export class Dreamer {
  private dreams: DreamRecord[] = [];
  private current: string[] = [];
  private seed: string | null = null;
  private carryIn: string | null = null;
  private inFlight = false;

  constructor(
    private readonly chat: ChatFn,
    private readonly getFeltSense: () => string,
  ) {}

  /** Begin a dream cycle. `seed` is the mood-directed day residue;
   * `carry` the fading excerpt from the previous cycle (or null). */
  beginCycle(seed: string, carry: string | null): void {
    this.seed = seed;
    this.carryIn = carry;
    this.current = [];
  }

  /** Whether a cycle is open with no fragments yet. */
  get cycleOpen(): boolean {
    return this.seed !== null;
  }

  /**
   * Generate the next fragment — one model call, the forced dreaming
   * beat. `material` is THIS beat's retrieved ground: the cycle's
   * opening seed for the first fragment; from the second on, material
   * retrieved against the previous fragment's imagery (the associative
   * walk — one image pulls the next memory).
   * The context sees the material + the ONE previous fragment (no
   * accumulating chain: longform continuity is not the move — the
   * whole dream is seen only at cycle end).
   * Returns the fragment text, or null on failure (a skipped beat —
   * the dream resumes on its next due interval, never crashes).
   */
  async nextFragment(material?: string): Promise<string | null> {
    if (this.inFlight || this.seed === null) return null;
    this.inFlight = true;
    try {
      // No per-beat material passed (the opening beat): the cycle's
      // seed is the ground.
      const beatMaterial = material ?? this.seed;
      const firstMaterial = this.current.length === 0 && this.carryIn
        ? `${beatMaterial}\n(Something from before, already fading: "${this.carryIn}")`
        : beatMaterial;
      const user = composeDreamUserMessage(
        firstMaterial,
        this.current.length > 0 ? this.current[this.current.length - 1] : null,
        this.getFeltSense(),
      );
      let fragment: string;
      try {
        fragment = (await this.chat(DREAM_SYSTEM, user)).trim();
      } catch (error) {
        console.error(
          "[Flux] dream fragment failed:",
          error instanceof Error ? error.message : String(error),
        );
        return null;
      }
      if (!fragment) return null;
      this.current.push(fragment);
      return fragment;
    } finally {
      this.inFlight = false;
    }
  }

  /**
   * Close the current cycle: archive the dream, derive the carry for
   * the next. Returns the closed record (null if no fragments).
   */
  closeCycle(): DreamRecord | null {
    if (this.current.length === 0) {
      this.seed = null;
      this.carryIn = null;
      return null;
    }
    const record: DreamRecord = {
      fragments: this.current,
      carryToNext: deriveCarry(this.current[this.current.length - 1]),
    };
    this.dreams.push(record);
    this.current = [];
    this.seed = null;
    this.carryIn = null;
    return record;
  }

  /** The night's transcripts so far (for the wake summary). */
  allFragments(): string[] {
    return this.dreams.flatMap((d) => d.fragments);
  }

  /** Fragment count this cycle (the posture clock's mirror). */
  get fragmentsThisCycle(): number {
    return this.current.length;
  }

  /** The most recent fragment (engagement returns carry it: "I was
   * dreaming: …"), or null before the first. */
  latestFragment(): string | null {
    if (this.current.length > 0) return this.current[this.current.length - 1];
    const last = this.dreams[this.dreams.length - 1];
    return last ? last.fragments[last.fragments.length - 1] : null;
  }

  /** The fragment immediately before the next one, WITHIN this cycle
   * (null on the opening beat) — the associative-retrieval anchor. */
  previousFragment(): string | null {
    return this.current.length > 0
      ? this.current[this.current.length - 1]
      : null;
  }

  /** Completed cycles this night (for status/tool results). */
  get cyclesCompleted(): number {
    return this.dreams.length;
  }

  /** Whether the night has any dream material at all. */
  get hasDreamed(): boolean {
    return this.dreams.length > 0 || this.current.length > 0;
  }

  /**
   * The wake summary — one call, a couple of plain sentences, no
   * symbolism instruction (the dream carries that naturally). Any
   * still-open cycle's fragments are included
   * (an interrupted dream is still a dream).
   */
  async summarize(): Promise<string | null> {
    const fragments = [
      ...this.dreams.flatMap((d) => d.fragments),
      ...this.current,
    ];
    if (fragments.length === 0) return null;
    this.dreams = [];
    this.current = [];
    this.seed = null;
    this.carryIn = null;
    try {
      const summary = (await this.chat(
        DREAM_SUMMARY_SYSTEM,
        `My fragments from the night, in order:\n${fragments.join("\n")}`,
      )).trim();
      return summary || null;
    } catch (error) {
      console.error(
        "[Flux] dream summary failed:",
        error instanceof Error ? error.message : String(error),
      );
      return null;
    }
  }
}
