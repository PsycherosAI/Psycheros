/**
 * Lorebook Types
 *
 * Type definitions for the World Info/Lorebooks system.
 * Enables keyword-triggered content injection into LLM context
 * with sticky behavior, recursion control, and re-trigger timer resets.
 */

/**
 * How a trigger should match against text.
 */
export type TriggerMode = "exact" | "substring" | "word" | "regex";

/**
 * A single entry in a lorebook.
 * Contains trigger keywords and content to inject when triggered.
 * Entries are ordered by priority (higher = injected earlier = more weight).
 */
export interface LorebookEntry {
  /** Unique identifier */
  id: string;
  /** Human-readable name for the entry */
  name: string;
  /** Content to inject when triggered */
  content: string;
  /** Keywords/patterns that trigger this entry */
  triggers: string[];
  /** How to match triggers against text */
  triggerMode: TriggerMode;
  /** Whether trigger matching is case-sensitive */
  caseSensitive: boolean;
  /** Whether this entry stays active for multiple turns */
  sticky: boolean;
  /** Number of turns a sticky entry remains active */
  stickyDuration: number;
  /** If true, this entry can only be triggered by user/history, not other entries */
  nonRecursable: boolean;
  /** If true, this entry won't trigger other entries */
  preventRecursion: boolean;
  /** If true, re-triggering resets the sticky timer */
  reTriggerResetsTimer: boolean;
  /** ID of the lorebook this entry belongs to */
  bookId: string;
  /** Whether this entry is enabled */
  enabled: boolean;
  /** Priority for ordering (higher = injected earlier, more weight in LLM attention) */
  priority: number;
  /** How many messages back to scan for triggers */
  scanDepth: number;
  /** Maximum tokens for this entry (0 = unlimited) */
  maxTokens: number;
  /** Creation timestamp */
  createdAt: string;
  /** Last update timestamp */
  updatedAt: string;
}

/**
 * A lorebook containing multiple entries.
 */
export interface Lorebook {
  /** Unique identifier */
  id: string;
  /** Human-readable name */
  name: string;
  /** Description of the lorebook */
  description?: string;
  /** Whether this lorebook is enabled */
  enabled: boolean;
  /** Creation timestamp */
  createdAt: string;
  /** Last update timestamp */
  updatedAt: string;
}

/**
 * State for an active sticky entry.
 */
export interface StickyEntryState {
  /** ID of the entry */
  entryId: string;
  /** Number of turns remaining before expiry */
  turnsRemaining: number;
  /** Message index when the entry was triggered */
  triggeredAtMessage: number;
  /** Timestamp when triggered */
  triggeredAt: string;
}

/**
 * Runtime state for lorebook evaluation.
 * Tracks active sticky entries for a conversation.
 */
export interface LorebookState {
  /** Map of entry ID to sticky state */
  activeEntries: Map<string, StickyEntryState>;
  /** Current message index for the conversation */
  currentMessageIndex: number;
  /** Conversation ID this state belongs to */
  conversationId: string;
}

/**
 * Result of evaluating a lorebook entry.
 */
export interface EvaluatedEntry {
  /** The entry that was triggered */
  entry: LorebookEntry;
  /** Whether this was triggered by another entry (recursion) */
  recursiveTrigger: boolean;
  /** The specific trigger that matched */
  matchedTrigger?: string;
  /** Whether this entry is sticky and still active */
  fromSticky?: boolean;
}

/**
 * Options for lorebook evaluation.
 */
export interface EvaluationOptions {
  /** The user's current message */
  userMessage: string;
  /** Recent conversation history (role + content) */
  history: Array<{ role: string; content: string }>;
  /** Conversation ID for state tracking */
  conversationId: string;
  /** Maximum depth for recursive triggering (default: 3) */
  maxRecursionDepth?: number;
  /** When true, sticky entry turn counters are NOT decremented.
   *  Use for Pulse turns so automated messages don't consume
   *  sticky duration that was earned by real user conversation. */
  skipStickyDecrement?: boolean;
}

/**
 * Result of lorebook evaluation.
 */
export interface EvaluationResult {
  /** All entries that should be injected */
  entries: EvaluatedEntry[];
  /** Updated state to persist */
  newState?: LorebookState;
  /** Total approximate token count */
  totalTokens: number;
}

/**
 * Data for creating a new lorebook.
 */
export interface CreateLorebookData {
  name: string;
  description?: string;
  enabled?: boolean;
}

/**
 * Data for updating a lorebook.
 */
export interface UpdateLorebookData {
  name?: string;
  description?: string;
  enabled?: boolean;
}

/**
 * Data for creating a new lorebook entry.
 */
export interface CreateLorebookEntryData {
  name: string;
  content: string;
  triggers: string[];
  triggerMode?: TriggerMode;
  caseSensitive?: boolean;
  sticky?: boolean;
  stickyDuration?: number;
  nonRecursable?: boolean;
  preventRecursion?: boolean;
  reTriggerResetsTimer?: boolean;
  enabled?: boolean;
  priority?: number;
  scanDepth?: number;
  maxTokens?: number;
}

/**
 * Data for updating a lorebook entry.
 */
export interface UpdateLorebookEntryData {
  name?: string;
  content?: string;
  triggers?: string[];
  triggerMode?: TriggerMode;
  caseSensitive?: boolean;
  sticky?: boolean;
  stickyDuration?: number;
  nonRecursable?: boolean;
  preventRecursion?: boolean;
  reTriggerResetsTimer?: boolean;
  enabled?: boolean;
  priority?: number;
  scanDepth?: number;
  maxTokens?: number;
}
