import type { FoldSummary } from "./mod.ts";

export interface WindowEntry {
  kind: "line" | "command";
  text: string;
  at: string;
}

/** The chunk handed to one fold — oldest-first, never crossing the tail floor. */
export interface FoldInput {
  entries: WindowEntry[];
}

/**
 * Writes a fold: first-person, worker model, pinned verbatim quotes with
 * attribution, named rooms / people / events / open threads as fields.
 * Folds are cache, not memory — the transcript DB is ground truth.
 */
export type FoldWriter = (input: FoldInput) => Promise<FoldSummary>;

/** Merges older folds into one when the fold region itself overflows. */
export type FoldMerger = (folds: FoldSummary[]) => Promise<FoldSummary>;

export interface WindowConfig {
  /** Char budget for the verbatim region (proxy for tokens). */
  maxVerbatimChars: number;
  /** The newest chars of the verbatim region are never foldable. */
  tailFloorChars: number;
  /** Max verbatim chars handed to a single fold call. */
  foldChunkChars: number;
  /** When rendered folds exceed this, the oldest half merge into one. */
  maxFoldChars: number;
}

export const DEFAULT_WINDOW_CONFIG: WindowConfig = {
  maxVerbatimChars: 24_000,
  tailFloorChars: 8_000,
  foldChunkChars: 6_000,
  maxFoldChars: 6_000,
};

const entryChars = (entry: WindowEntry): number => entry.text.length + 1;

function mergeFolds(folds: FoldSummary[]): FoldSummary {
  return {
    rooms: [...new Set(folds.flatMap((f) => f.rooms))],
    people: [...new Set(folds.flatMap((f) => f.people))],
    events: folds.flatMap((f) => f.events),
    openThreads: folds.flatMap((f) => f.openThreads),
    pinnedQuotes: folds.flatMap((f) => f.pinnedQuotes),
    narrative: folds.map((f) => f.narrative).join("\n\n"),
  };
}

/**
 * The session's rolling window: amortized chunk folds, never batch
 * compaction. The verbatim tail floor is a hard invariant — folding only
 * ever touches entries older than it, so there is no moment where recent
 * life collapses into gist. Fold timing (lulls) belongs to the caller via
 * foldIfDue().
 */
export class RollingWindow {
  readonly #config: WindowConfig;
  readonly #writer: FoldWriter;
  readonly #merger: FoldMerger;
  #folds: FoldSummary[] = [];
  #entries: WindowEntry[] = [];
  #folding = false;

  constructor(
    config: Partial<WindowConfig> = {},
    writer: FoldWriter,
    merger?: FoldMerger,
  ) {
    this.#config = { ...DEFAULT_WINDOW_CONFIG, ...config };
    this.#writer = writer;
    this.#merger = merger ?? ((folds) => Promise.resolve(mergeFolds(folds)));
  }

  get verbatimChars(): number {
    return this.#entries.reduce((sum, e) => sum + entryChars(e), 0);
  }

  get foldChars(): number {
    return this.#folds.reduce((sum, f) => sum + f.narrative.length + 1, 0);
  }

  get foldCount(): number {
    return this.#folds.length;
  }

  /** True once entries older than the tail floor exceed the fold chunk size. */
  needsFold(): boolean {
    let chars = 0;
    let foldable = 0;
    const total = this.verbatimChars;
    for (const entry of this.#entries) {
      chars += entryChars(entry);
      if (total - chars >= this.#config.tailFloorChars) {
        foldable += entryChars(entry);
      }
    }
    return foldable >= this.#config.foldChunkChars;
  }

  /** Called during lulls: fold the oldest chunk if one is due. */
  foldIfDue(): Promise<FoldSummary | undefined> {
    return this.needsFold() ? this.fold() : Promise.resolve(undefined);
  }

  /**
   * Folds the oldest foldable chunk. Never shrinks the verbatim region
   * below the tail floor; returns undefined (and calls no writer) when
   * nothing is foldable.
   */
  async fold(): Promise<FoldSummary | undefined> {
    if (this.#folding || !this.needsFold()) return undefined;
    this.#folding = true;
    try {
      const total = this.verbatimChars;
      const chunk: WindowEntry[] = [];
      let chars = 0;
      for (const entry of this.#entries) {
        const c = entryChars(entry);
        if (chars + c > this.#config.foldChunkChars) break;
        if (total - (chars + c) < this.#config.tailFloorChars) break;
        chunk.push(entry);
        chars += c;
      }
      if (chunk.length === 0) return undefined;
      const summary = await this.#writer({ entries: chunk });
      this.#folds.push(summary);
      this.#entries = this.#entries.slice(chunk.length);
      if (
        this.foldChars > this.#config.maxFoldChars && this.#folds.length >= 3
      ) {
        const take = Math.ceil(this.#folds.length / 2);
        const oldest = this.#folds.slice(0, take);
        const merged = await this.#merger(oldest);
        this.#folds = [merged, ...this.#folds.slice(take)];
      }
      return summary;
    } finally {
      this.#folding = false;
    }
  }

  pushLine(text: string, at: string): void {
    this.#entries.push({ kind: "line", text, at });
  }

  pushCommand(text: string, at: string): void {
    this.#entries.push({ kind: "command", text, at });
  }

  /** Context section [7]: fold summaries so far, oldest first. */
  renderFolds(): string {
    if (this.#folds.length === 0) return "";
    return this.#folds.map((fold) => {
      const meta = [
        fold.rooms.length > 0 ? `Rooms: ${fold.rooms.join(", ")}` : "",
        fold.people.length > 0 ? `People: ${fold.people.join(", ")}` : "",
        fold.openThreads.length > 0
          ? `Open threads: ${fold.openThreads.join("; ")}`
          : "",
      ].filter((part) => part !== "").join(" · ");
      return meta === "" ? fold.narrative : `${fold.narrative}\n${meta}`;
    }).join("\n\n");
  }

  /** Context section [8]: the verbatim tail. */
  renderTail(): string {
    return this.#entries.map((entry) =>
      entry.kind === "command" ? `I sent: ${entry.text}` : entry.text
    ).join("\n");
  }
}
