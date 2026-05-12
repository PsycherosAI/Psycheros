/**
 * Lorebook Module
 *
 * World Info/Lorebooks system for keyword-triggered content injection.
 * Enables dynamic context injection based on triggers with sticky behavior,
 * recursion control, and timer resets.
 *
 * @module
 */

// Types
export type {
  CreateLorebookData,
  CreateLorebookEntryData,
  EvaluatedEntry,
  EvaluationOptions,
  EvaluationResult,
  Lorebook,
  LorebookEntry,
  LorebookState,
  StickyEntryState,
  TriggerMode,
  UpdateLorebookData,
  UpdateLorebookEntryData,
} from "./types.ts";

// Trigger matching
export {
  checkTriggers,
  matchTrigger,
  scanForTriggers,
  scanMultipleForTriggers,
} from "./trigger-matcher.ts";

// Evaluation
export { evaluateLorebook, getLorebookContext } from "./evaluator.ts";

// Context building
export {
  type BuildContextOptions,
  buildLorebookContext,
  calculateTotalTokens,
  estimateTokens,
} from "./context-builder.ts";

// State management
export {
  cleanupExpiredState,
  clearState,
  getConversationsWithState,
  loadState,
  saveState,
} from "./state-manager.ts";

// High-level API
export { LorebookManager } from "./manager.ts";
