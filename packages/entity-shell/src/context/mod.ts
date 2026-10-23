/**
 * Context assembly order — stablest first, so whatever prompt caching the
 * provider does stays hot. Everything through `session-context` holds across
 * turns; `hud` onward is the churny section. Do not reorder casually.
 */
export const CONTEXT_SECTIONS = [
  "suit-core",
  "identity",
  "custom-instructions",
  "game-pack",
  "character-state",
  "session-context",
  "hud",
  "folds",
  "verbatim-tail",
  "retrieval",
] as const;

export type ContextSection = typeof CONTEXT_SECTIONS[number];

export interface ContextSectionContent {
  section: ContextSection;
  content: string;
}
