/**
 * FluxSession window-selection tests. Pins the conversation-hosted
 * window: dialogue rows come from the host's messages table (the
 * record); the session's own user/ego/system rows are structural
 * copies and are SKIPPED; briefings and tool_use rows are retained;
 * everything timestamp-merges oldest-first and caps at windowSize.
 */

import { assertEquals } from "@std/assert";
import { Database } from "@db/sqlite";
import { FluxSession } from "../src/flux/flux-session.ts";
import type { LLMClient } from "../src/llm/mod.ts";
import type { ChatMessage } from "../src/llm/types.ts";
import type { StreamChunk } from "../src/llm/types.ts";

/** A stub client that never generates (we only exercise the window). */
function stubClient(): LLMClient {
  return {
    chatStream: (_msgs: ChatMessage[], _tools?: unknown) =>
      (async function* (): AsyncGenerator<StreamChunk> {})(),
  } as unknown as LLMClient;
}

type SessionOpts = ConstructorParameters<typeof FluxSession>[2];

function makeSession(opts: Partial<SessionOpts> = {}): FluxSession {
  const db = new Database(":memory:");
  const full: SessionOpts = {
    buildSystemPrefix: async () => "prefix",
    buildLateBlock: async () => null,
    renderMood: () => "",
    windowSize: 10,
    ...opts,
  };
  return new FluxSession(db, stubClient(), full);
}

Deno.test("window: legacy — assembles from session entries verbatim", async () => {
  const s = makeSession();
  await s.appendUserMessage("hello");
  s.appendBriefing("something surfaced", "musing", false);
  const msgs = (s as unknown as { windowMessages(): ChatMessage[] })
    .windowMessages();
  assertEquals(msgs.length, 2);
  assertEquals(msgs[0].role, "user");
  // User rows are stamped at build (classic mechanism).
  assertEquals(/^<t>[^<]+<\/t> hello$/.test(msgs[0].content as string), true);
  assertEquals(msgs[1].role, "system");
  assertEquals(
    (msgs[1].content as string).includes('<thought from="musing">'),
    true,
  );
  assertEquals(
    (msgs[1].content as string).includes("something surfaced"),
    true,
  );
});

Deno.test("window: hosted — dialogue from hook, copies skipped", async () => {
  let askedLimit = -1;
  const s = makeSession({
    getDialogueMessages: (limit) => {
      askedLimit = limit;
      return [
        {
          role: "user",
          content: "record: hello",
          createdAt: "2026-09-14T10:00:00.000Z",
        },
        {
          role: "assistant",
          content: "record: hi back",
          createdAt: "2026-09-14T10:00:05.000Z",
        },
      ];
    },
  });
  // Session-entry copies of the SAME dialogue + one real briefing:
  await s.appendUserMessage("record: hello");
  s.appendBriefing("a musing thread", "musing", false);
  const msgs = (s as unknown as { windowMessages(): ChatMessage[] })
    .windowMessages();
  // The copy is skipped (structural dedup); dialogue + briefing remain.
  assertEquals(
    msgs.filter((m) => m.role === "user").length,
    1,
    "user dialogue appears once (record, not the copy)",
  );
  assertEquals(
    msgs.filter((m) => (m.content as string).endsWith("record: hello")).length,
    1,
  );
  assertEquals(
    msgs.some((m) => (m.content as string).includes("a musing thread")),
    true,
    "briefings retained in hosted mode",
  );
  assertEquals(askedLimit > 0, true, "hook receives a positive limit");
});

Deno.test("window: hosted — timestamp interleave order", async () => {
  const s = makeSession({
    getDialogueMessages: () => [
      {
        role: "user",
        content: "first",
        createdAt: "2026-09-14T10:00:00.000Z",
      },
      {
        role: "assistant",
        content: "third",
        createdAt: "2026-09-14T10:00:20.000Z",
      },
    ],
  });
  s.appendBriefing("second", "musing", false);
  // backdate the briefing between the dialogue rows
  const entries =
    (s as unknown as { entries: { timestamp: string }[] }).entries;
  entries[entries.length - 1].timestamp = "2026-09-14T10:00:10.000Z";
  const msgs = (s as unknown as { windowMessages(): ChatMessage[] })
    .windowMessages();
  assertEquals(
    msgs.map((m) =>
      (m.content as string).endsWith("first")
        ? "first"
        : (m.content as string).includes("second")
        ? "second"
        : "third"
    ),
    [
      "first",
      "second",
      "third",
    ],
  );
});

Deno.test("window: hosted — full history, no count cap (budget decides)", async () => {
  // Classic-parity: the hosted window returns the FULL dialogue and the
  // context budget (applyContextBudget, at assembly) decides what fits —
  // windowSize is legacy-only and must not silently truncate dialogue.
  const s = makeSession({
    getDialogueMessages: () =>
      Array.from({ length: 30 }, (_, i) => ({
        role: "user" as const,
        content: `msg ${i}`,
        createdAt: new Date(1_000_000_000_000 + i * 1000).toISOString(),
      })),
  });
  const msgs = (s as unknown as { windowMessages(): ChatMessage[] })
    .windowMessages();
  assertEquals(msgs.length, 30, "no entry-count cap on hosted dialogue");
  assertEquals(
    (msgs[0].content as string).endsWith("msg 0"),
    true,
    "oldest row survives — trimming is the budget's job",
  );
});

Deno.test("window: hosted — recent reasoning threads back, older does not", async () => {
  // Pins PARITY with classic's selectReasoningEligibleHistory walk
  // (loop.ts): walking back, user turns increment the counter, the
  // break fires at the boundary — so n=1 threads the last TWO
  // assistants (classic's exact semantics) and nothing older.
  const s = makeSession({
    persistentReasoningInterTurns: 1,
    getDialogueMessages: () => [
      {
        role: "user",
        content: "q1",
        createdAt: "2026-09-15T10:00:00.000Z",
      },
      {
        role: "assistant",
        content: "a1",
        createdAt: "2026-09-15T10:00:05.000Z",
        thinking: "chain one",
      },
      {
        role: "user",
        content: "q2",
        createdAt: "2026-09-15T10:01:00.000Z",
      },
      {
        role: "assistant",
        content: "a2",
        createdAt: "2026-09-15T10:01:05.000Z",
        thinking: "chain two",
      },
      {
        role: "user",
        content: "q3",
        createdAt: "2026-09-15T10:02:00.000Z",
      },
      {
        role: "assistant",
        content: "a3",
        createdAt: "2026-09-15T10:02:05.000Z",
        thinking: "chain three",
      },
    ],
  });
  const msgs = (s as unknown as { windowMessages(): ChatMessage[] })
    .windowMessages();
  const a1 = msgs.find((m) => (m.content as string).endsWith("a1"));
  const a2 = msgs.find((m) => (m.content as string).endsWith("a2"));
  const a3 = msgs.find((m) => (m.content as string).endsWith("a3"));
  assertEquals(a3?.reasoning_content, "chain three");
  assertEquals(a2?.reasoning_content, "chain two");
  assertEquals(a1?.reasoning_content, undefined);
});
