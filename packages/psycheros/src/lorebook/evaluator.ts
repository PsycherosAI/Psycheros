/**
 * Lorebook Evaluator
 *
 * Handles the full evaluation pipeline for determining which lorebook entries
 * should be injected into context:
 * 1. Scan user message for triggers
 * 2. Scan recent history (respecting scanDepth)
 * 3. Process sticky entries (decrement counters, check re-triggers)
 * 4. Recursion pass (entry content triggering other entries, unless prevented)
 * 5. Sort by priority, return active entries
 */

import type {
  EvaluatedEntry,
  EvaluationOptions,
  EvaluationResult,
  LorebookEntry,
  LorebookState,
} from "./types.ts";
import { checkTriggers } from "./trigger-matcher.ts";

/**
 * Default maximum recursion depth for entry triggering.
 */
const DEFAULT_MAX_RECURSION_DEPTH = 3;

/**
 * Evaluate which lorebook entries should be active for the current turn.
 *
 * @param entries - All available lorebook entries
 * @param options - Evaluation options (user message, history, etc.)
 * @param currentState - Current sticky state (if any)
 * @returns Evaluation result with active entries and new state
 */
export function evaluateLorebook(
  entries: LorebookEntry[],
  options: EvaluationOptions,
  currentState?: LorebookState,
): EvaluationResult {
  const maxRecursionDepth = options.maxRecursionDepth ??
    DEFAULT_MAX_RECURSION_DEPTH;
  const activeEntries: EvaluatedEntry[] = [];
  const triggeredEntryIds = new Set<string>();
  const newState: LorebookState = {
    activeEntries: new Map(),
    currentMessageIndex: (currentState?.currentMessageIndex ?? 0) + 1,
    conversationId: options.conversationId,
  };

  // Get enabled entries only
  const enabledEntries = entries.filter((e) => e.enabled);

  // Step 1: Scan user message for triggers
  const userMessageTriggers = scanForEntries(
    enabledEntries,
    options.userMessage,
  );
  for (const { entry, trigger } of userMessageTriggers) {
    triggeredEntryIds.add(entry.id);
    activeEntries.push({
      entry,
      recursiveTrigger: false,
      matchedTrigger: trigger,
    });
  }

  // Step 2: Scan recent history respecting each entry's scanDepth
  for (const entry of enabledEntries) {
    if (triggeredEntryIds.has(entry.id)) continue;

    // Get relevant history based on scanDepth
    const relevantHistory = options.history.slice(-entry.scanDepth);
    const historyTexts = relevantHistory.map((h) => h.content);

    // Check if any history triggers this entry
    const trigger = checkTriggers(
      entry.triggers,
      historyTexts.join("\n"),
      entry.triggerMode,
      entry.caseSensitive,
    );

    if (trigger) {
      triggeredEntryIds.add(entry.id);
      activeEntries.push({
        entry,
        recursiveTrigger: false,
        matchedTrigger: trigger,
      });
    }
  }

  // Step 3: Process sticky entries from previous state
  if (currentState?.activeEntries) {
    for (const [entryId, stickyState] of currentState.activeEntries) {
      const entry = entries.find((e) => e.id === entryId);
      if (!entry || !entry.enabled) continue;

      // Check if this entry was just triggered (re-trigger)
      const wasJustTriggered = triggeredEntryIds.has(entryId);

      console.log(
        `[Lorebook] Processing sticky entry "${entry.name}": wasJustTriggered=${wasJustTriggered}, reTriggerResetsTimer=${entry.reTriggerResetsTimer}, turnsRemaining=${stickyState.turnsRemaining}`,
      );

      if (wasJustTriggered && entry.reTriggerResetsTimer) {
        // Re-trigger resets the timer
        // Initialize turnsRemaining to stickyDuration - 1 because the trigger turn counts as turn 1
        console.log(
          `[Lorebook] Re-trigger with reset - setting turnsRemaining to ${
            entry.stickyDuration - 1
          }`,
        );
        newState.activeEntries.set(entryId, {
          entryId,
          turnsRemaining: entry.stickyDuration - 1, // -1 because current turn counts
          triggeredAtMessage: newState.currentMessageIndex,
          triggeredAt: new Date().toISOString(),
        });
        // Entry is already in activeEntries from step 1 or 2
      } else if (options.skipStickyDecrement) {
        // Pulse or automated turn — don't consume sticky duration
        console.log(
          `[Lorebook] Skipping sticky decrement (automated turn) for "${entry.name}" — turnsRemaining stays ${stickyState.turnsRemaining}`,
        );
        newState.activeEntries.set(entryId, {
          ...stickyState,
        });

        // Add to active if not already there
        if (!triggeredEntryIds.has(entryId)) {
          console.log(
            `[Lorebook] Adding "${entry.name}" to active entries from sticky (no decrement)`,
          );
          activeEntries.push({
            entry,
            recursiveTrigger: false,
            fromSticky: true,
          });
        }
      } else {
        // Decrement the counter
        const turnsRemaining = stickyState.turnsRemaining - 1;
        console.log(
          `[Lorebook] Decrementing - turnsRemaining now ${turnsRemaining}`,
        );

        if (turnsRemaining > 0) {
          // Entry is still sticky
          newState.activeEntries.set(entryId, {
            ...stickyState,
            turnsRemaining,
          });

          // Add to active if not already there
          if (!triggeredEntryIds.has(entryId)) {
            console.log(
              `[Lorebook] Adding "${entry.name}" to active entries from sticky`,
            );
            activeEntries.push({
              entry,
              recursiveTrigger: false,
              fromSticky: true,
            });
          }
        } else {
          console.log(
            `[Lorebook] Entry "${entry.name}" expired (turnsRemaining <= 0)`,
          );
        }
        // If turnsRemaining <= 0, entry expires and is not added to newState
      }
    }
  }

  // Step 4: Recursion pass - entries can trigger other entries
  // Only do this if we have triggered entries and recursion depth > 0
  if (activeEntries.length > 0 && maxRecursionDepth > 0) {
    const recursionResult = processRecursion(
      enabledEntries,
      activeEntries,
      triggeredEntryIds,
      maxRecursionDepth,
    );

    // Add recursively triggered entries
    for (const evaluated of recursionResult.newEntries) {
      activeEntries.push(evaluated);

      // Update sticky state for newly triggered sticky entries
      // Initialize turnsRemaining to stickyDuration - 1 because the trigger turn counts as turn 1
      const entry = evaluated.entry;
      if (entry.sticky && entry.stickyDuration > 0) {
        newState.activeEntries.set(entry.id, {
          entryId: entry.id,
          turnsRemaining: entry.stickyDuration - 1, // -1 because current turn counts
          triggeredAtMessage: newState.currentMessageIndex,
          triggeredAt: new Date().toISOString(),
        });
      }
    }
  }

  // Update sticky state for directly triggered entries that are sticky
  // Initialize turnsRemaining to stickyDuration - 1 because the trigger turn counts as turn 1
  for (const evaluated of activeEntries) {
    if (
      evaluated.entry.sticky &&
      evaluated.entry.stickyDuration > 0 &&
      !evaluated.fromSticky &&
      !newState.activeEntries.has(evaluated.entry.id)
    ) {
      newState.activeEntries.set(evaluated.entry.id, {
        entryId: evaluated.entry.id,
        turnsRemaining: evaluated.entry.stickyDuration - 1, // -1 because current turn counts
        triggeredAtMessage: newState.currentMessageIndex,
        triggeredAt: new Date().toISOString(),
      });
    }
  }

  // Step 5: Sort by priority (higher first) and calculate tokens
  activeEntries.sort((a, b) => b.entry.priority - a.entry.priority);

  // Calculate approximate token count (4 chars per token)
  const totalTokens = activeEntries.reduce(
    (sum, e) => sum + Math.ceil(e.entry.content.length / 4),
    0,
  );

  return {
    entries: activeEntries,
    newState: newState.activeEntries.size > 0 ? newState : undefined,
    totalTokens,
  };
}

/**
 * Scan text for entries and return matching entries with their triggers.
 */
function scanForEntries(
  entries: LorebookEntry[],
  text: string,
): Array<{ entry: LorebookEntry; trigger: string }> {
  const results: Array<{ entry: LorebookEntry; trigger: string }> = [];

  for (const entry of entries) {
    const trigger = checkTriggers(
      entry.triggers,
      text,
      entry.triggerMode,
      entry.caseSensitive,
    );

    if (trigger) {
      results.push({ entry, trigger });
    }
  }

  return results;
}

/**
 * Process recursive triggering of entries.
 * Entry content can trigger other entries, unless prevented.
 */
function processRecursion(
  entries: LorebookEntry[],
  currentActive: EvaluatedEntry[],
  triggeredIds: Set<string>,
  maxDepth: number,
  currentDepth: number = 1,
): { newEntries: EvaluatedEntry[] } {
  if (currentDepth > maxDepth) {
    return { newEntries: [] };
  }

  const newEntries: EvaluatedEntry[] = [];

  // Get content from entries that don't prevent recursion
  const triggerableContent: Array<{ content: string; source: EvaluatedEntry }> =
    [];
  for (const evaluated of currentActive) {
    if (!evaluated.entry.preventRecursion) {
      triggerableContent.push({
        content: evaluated.entry.content,
        source: evaluated,
      });
    }
  }

  // Scan this content for entries that can be recursively triggered
  for (const entry of entries) {
    // Skip if already triggered
    if (triggeredIds.has(entry.id)) continue;

    // Skip if entry is nonRecursable (can only be triggered by user/history)
    if (entry.nonRecursable) continue;

    // Check if any of the content triggers this entry
    for (const { content } of triggerableContent) {
      const trigger = checkTriggers(
        entry.triggers,
        content,
        entry.triggerMode,
        entry.caseSensitive,
      );

      if (trigger) {
        triggeredIds.add(entry.id);
        const newEvaluated: EvaluatedEntry = {
          entry,
          recursiveTrigger: true,
          matchedTrigger: trigger,
        };
        newEntries.push(newEvaluated);
        break; // Entry matched, no need to check more content
      }
    }
  }

  // If we found new entries and haven't hit max depth, recurse
  if (newEntries.length > 0 && currentDepth < maxDepth) {
    const deeperResult = processRecursion(
      entries,
      newEntries,
      triggeredIds,
      maxDepth,
      currentDepth + 1,
    );
    newEntries.push(...deeperResult.newEntries);
  }

  return { newEntries };
}

/**
 * Get the content of entries that should be injected for a given conversation turn.
 * This is a simplified interface that handles the full evaluation.
 *
 * @param entries - All available lorebook entries
 * @param userMessage - The current user message
 * @param history - Recent conversation history
 * @param conversationId - The conversation ID
 * @param currentState - Current sticky state (if any)
 * @returns Object with entries content and new state
 */
export function getLorebookContext(
  entries: LorebookEntry[],
  userMessage: string,
  history: Array<{ role: string; content: string }>,
  conversationId: string,
  currentState?: LorebookState,
): {
  entries: EvaluatedEntry[];
  newState?: LorebookState;
  totalTokens: number;
} {
  return evaluateLorebook(
    entries,
    {
      userMessage,
      history,
      conversationId,
    },
    currentState,
  );
}
