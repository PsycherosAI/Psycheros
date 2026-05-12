/**
 * Lorebook Trigger Matcher
 *
 * Functions for matching triggers against text using various modes:
 * - exact: exact string match
 * - substring: partial string match
 * - word: word boundary match
 * - regex: regular expression match
 */

import type { TriggerMode } from "./types.ts";

/**
 * Match a single trigger against text using the specified mode.
 *
 * @param trigger - The trigger pattern to match
 * @param text - The text to search in
 * @param mode - The matching mode
 * @param caseSensitive - Whether to match case-sensitively
 * @returns True if the trigger matches, false otherwise
 */
export function matchTrigger(
  trigger: string,
  text: string,
  mode: TriggerMode,
  caseSensitive: boolean,
): boolean {
  // Normalize case if not case-sensitive
  const searchTrigger = caseSensitive ? trigger : trigger.toLowerCase();
  const searchText = caseSensitive ? text : text.toLowerCase();

  switch (mode) {
    case "exact":
      return searchText === searchTrigger;

    case "substring":
      return searchText.includes(searchTrigger);

    case "word":
      return matchWordBoundary(searchTrigger, searchText);

    case "regex":
      return matchRegex(trigger, text, caseSensitive);

    default:
      console.warn(`Unknown trigger mode: ${mode}, falling back to substring`);
      return searchText.includes(searchTrigger);
  }
}

/**
 * Match a word with word boundaries.
 * Uses Unicode-aware word boundaries where possible.
 *
 * @param word - The word to match
 * @param text - The text to search in
 * @returns True if the word is found as a complete word
 */
function matchWordBoundary(word: string, text: string): boolean {
  // Create a regex that matches the word with word boundaries
  // Escape special regex characters in the word
  const escapedWord = escapeRegex(word);

  // Use word boundary anchors
  // \b matches between a word character and a non-word character
  const pattern = new RegExp(`\\b${escapedWord}\\b`, "u");
  return pattern.test(text);
}

/**
 * Match using a regular expression pattern.
 *
 * @param pattern - The regex pattern string
 * @param text - The text to search in
 * @param caseSensitive - Whether to match case-sensitively
 * @returns True if the pattern matches
 */
function matchRegex(
  pattern: string,
  text: string,
  caseSensitive: boolean,
): boolean {
  try {
    const flags = caseSensitive ? "u" : "iu";
    const regex = new RegExp(pattern, flags);
    return regex.test(text);
  } catch (error) {
    // Invalid regex pattern - log warning and return false
    console.warn(
      `Invalid regex pattern "${pattern}": ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return false;
  }
}

/**
 * Escape special regex characters in a string.
 *
 * @param str - The string to escape
 * @returns The escaped string safe for use in regex
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Check all triggers for an entry against text.
 * Returns true if any trigger matches.
 *
 * @param triggers - Array of trigger patterns
 * @param text - The text to search in
 * @param mode - The matching mode
 * @param caseSensitive - Whether to match case-sensitively
 * @returns The matching trigger if found, or undefined
 */
export function checkTriggers(
  triggers: string[],
  text: string,
  mode: TriggerMode,
  caseSensitive: boolean,
): string | undefined {
  for (const trigger of triggers) {
    if (matchTrigger(trigger, text, mode, caseSensitive)) {
      return trigger;
    }
  }
  return undefined;
}

/**
 * Scan text for triggers and return matching entry IDs.
 *
 * @param entries - Array of entries with their triggers and settings
 * @param text - The text to scan
 * @returns Array of entry IDs that matched
 */
export function scanForTriggers(
  entries: Array<{
    id: string;
    triggers: string[];
    triggerMode: TriggerMode;
    caseSensitive: boolean;
  }>,
  text: string,
): string[] {
  const matchingIds: string[] = [];

  for (const entry of entries) {
    const matchedTrigger = checkTriggers(
      entry.triggers,
      text,
      entry.triggerMode,
      entry.caseSensitive,
    );

    if (matchedTrigger) {
      matchingIds.push(entry.id);
    }
  }

  return matchingIds;
}

/**
 * Scan multiple texts (e.g., message history) for triggers.
 * Returns all entry IDs that matched in any of the texts.
 *
 * @param entries - Array of entries with their triggers and settings
 * @param texts - Array of texts to scan
 * @returns Array of entry IDs that matched
 */
export function scanMultipleForTriggers(
  entries: Array<{
    id: string;
    triggers: string[];
    triggerMode: TriggerMode;
    caseSensitive: boolean;
  }>,
  texts: string[],
): string[] {
  const matchingIds = new Set<string>();

  for (const text of texts) {
    const matches = scanForTriggers(entries, text);
    for (const id of matches) {
      matchingIds.add(id);
    }
  }

  return Array.from(matchingIds);
}
