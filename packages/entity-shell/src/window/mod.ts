/** A verbatim line preserved through a fold, with attribution. */
export interface PinnedQuote {
  speaker: string;
  text: string;
  timestamp?: string;
}

/**
 * A fold: the oldest scrollback chunk, distilled. Chunks, never "scenes" —
 * sessions fold by volume during lulls, not by dramatic structure. Rooms are
 * named because where-things-happened is load-bearing across sessions.
 * Folds are cache, not memory: the transcript DB is ground truth and any
 * fold can be rebuilt from it.
 */
export * from "./rolling.ts";

export interface FoldSummary {
  rooms: string[];
  people: string[];
  events: string[];
  openThreads: string[];
  pinnedQuotes: PinnedQuote[];
  /** First-person distillation of the chunk, written by the worker model. */
  narrative: string;
}
