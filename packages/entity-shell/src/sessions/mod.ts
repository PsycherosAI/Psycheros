export * from "./shell-session.ts";

import type { FoldSummary } from "../window/mod.ts";

export interface GameSessionRecord {
  id: string;
  gameId: string;
  entityName: string;
  characterName: string;
  /** Home-harness origin (Psycheros: the origin conversation). */
  originId?: string;
  startedAt: string;
  endedAt?: string;
}

/**
 * Written by the entity's main model at session end — these are the notes
 * that carry across sessions.
 */
export type SessionEndSummary = FoldSummary;
