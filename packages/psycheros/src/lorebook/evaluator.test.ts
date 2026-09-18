import { assertEquals } from "@std/assert";
import { evaluateLorebook } from "./evaluator.ts";
import { buildLorebookContext } from "./context-builder.ts";
import type { LorebookEntry, LorebookState } from "./types.ts";

/**
 * Regression tests for sticky-entry bookkeeping in the lorebook evaluator.
 *
 * Bug (2026-09-14, production): entries added from sticky state were pushed to
 * `activeEntries` but never registered in `triggeredEntryIds`. The recursion
 * pass then scanned all active entry content — including that same sticky
 * entry's own full prompt — and matched its trigger word inside its own body,
 * re-adding it a second time. One entry with a self-referential trigger word
 * produced a duplicate block in context every turn; several facet entries
 * naming each other cascaded into all four loading simultaneously.
 */

function makeEntry(
  overrides: Partial<LorebookEntry> & { id: string; name: string },
): LorebookEntry {
  return {
    bookId: "book-1",
    content: `Content for ${overrides.name}.`,
    triggers: [overrides.name],
    triggerMode: "substring",
    caseSensitive: false,
    sticky: false,
    stickyDuration: 0,
    nonRecursable: false,
    preventRecursion: false,
    reTriggerResetsTimer: false,
    enabled: true,
    priority: 0,
    scanDepth: 1,
    maxTokens: 0,
    createdAt: "",
    updatedAt: "",
    ...overrides,
  } as LorebookEntry;
}

Deno.test("sticky entry is not re-added by the recursion pass (duplicate context bug)", () => {
  // Entry whose content contains its own trigger word ("fair" appears in its
  // own body) — exactly the shape that duplicated in production.
  const fest = makeEntry({
    id: "fest",
    name: "Harborfest",
    triggers: ["HF", "festival"],
    sticky: true,
    stickyDuration: 5,
    content:
      "Harborfest runs every summer; the festival grounds open at dawn.",
  });

  const state: LorebookState = {
    activeEntries: new Map([["fest", {
      entryId: "fest",
      turnsRemaining: 4,
      triggeredAtMessage: 1,
      triggeredAt: new Date().toISOString(),
    }]]),
    currentMessageIndex: 2,
    conversationId: "conv",
  };

  const result = evaluateLorebook(
    [fest],
    {
      userMessage: "hello",
      history: [{ role: "user", content: "hello" }],
      conversationId: "conv",
    },
    state,
  );

  assertEquals(
    result.entries.length,
    1,
    `expected 1 active entry, got ${result.entries.length}`,
  );
  const ctx = buildLorebookContext(result.entries);
  const headers = [...ctx.matchAll(/^\[([^\]]+)\]$/gm)].map((m) => m[1]);
  assertEquals(
    headers,
    ["Harborfest"],
    `duplicate headers in context: ${headers}`,
  );
});

Deno.test("facet entries: sticky entries do not trigger each other via their own prompt bodies", () => {
  // Several sticky entries whose full-prompt bodies mention each other by
  // name — the four-facet cascade shape. With none freshly triggered, all
  // should ride along from sticky exactly once and nothing new should fire.
  const mk = (id: string, name: string, body: string) =>
    makeEntry({
      id,
      name,
      triggers: [name],
      sticky: true,
      stickyDuration: 10,
      content: body,
    });

  const entries = [
    mk("onyx", "Onyx", "Onyx prompt mentioning Aster and Rune."),
    mk("aster", "Aster", "Aster prompt mentioning Pike."),
    mk("rune", "Rune", "Rune prompt mentioning Onyx."),
    mk("pike", "Pike", "Pike prompt mentioning Aster and Onyx."),
  ];

  const state: LorebookState = {
    activeEntries: new Map(entries.map((e) => [e.id, {
      entryId: e.id,
      turnsRemaining: 8,
      triggeredAtMessage: 1,
      triggeredAt: new Date().toISOString(),
    }])),
    currentMessageIndex: 2,
    conversationId: "conv",
  };

  const result = evaluateLorebook(
    entries,
    {
      userMessage: "hey",
      history: [{ role: "user", content: "hey" }],
      conversationId: "conv",
    },
    state,
  );

  assertEquals(
    result.entries.length,
    4,
    `expected exactly the 4 sticky entries, got ${result.entries.length}`,
  );
  for (const e of result.entries) {
    assertEquals(
      e.recursiveTrigger,
      false,
      `${e.entry.name} should not be recursion-derived`,
    );
  }
});

Deno.test("legitimate recursion still works: user mention pulls in a non-sticky companion entry", () => {
  const hero = makeEntry({
    id: "hero",
    name: "Hero",
    sticky: true,
    stickyDuration: 5,
    content: "The Hero of the story, sworn companion of the Sage.",
  });
  const sage = makeEntry({
    id: "sage",
    name: "Sage",
    content: "The Sage, keeper of lore.",
  });

  const result = evaluateLorebook(
    [hero, sage],
    {
      userMessage: "tell me about the Hero",
      history: [],
      conversationId: "conv",
    },
    undefined,
  );

  const names = result.entries.map((e) => e.entry.name).sort();
  assertEquals(
    names,
    ["Hero", "Sage"],
    "recursion should still pull companion entries via user-message text",
  );
});
