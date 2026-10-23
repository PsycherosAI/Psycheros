/**
 * FluxSession × turn-core drive tests:
 * the migrated generate() run against a scripted fake client, through
 * every policy path the session owns — plain turns, tool batches with
 * entries + record hooks, the sleep park, the wake-argument dream
 * return, end_flux, and the budget-exhaustion endgame. No real LLM, no
 * provider.
 */

import { Database } from "@db/sqlite";
import { assertEquals } from "@std/assert";
import type { LLMClient } from "../src/llm/mod.ts";
import type { ChatMessage } from "../src/llm/types.ts";
import type { ToolCall } from "../src/types.ts";
import { FluxSession } from "../src/flux/flux-session.ts";

type ScriptChunk =
  | { t: "thinking"; c: string }
  | { t: "content"; c: string }
  | { t: "tool_call"; call: ToolCall }
  | { t: "done"; finish: string };

function call(id: string, name: string, args = "{}"): ToolCall {
  return {
    id,
    type: "function",
    function: { name, arguments: args },
  } as ToolCall;
}

/** Fake client: scripts per LLM call; tool-free requests (the endgame)
 * get script.enterNoTools if present. */
function fakeClient(script: ScriptTurn[], interChunkDelayMs = 0) {
  let n = 0;
  const requests: Array<{ tools: unknown }> = [];
  const client = {
    chatStream(_m: ChatMessage[], tools?: unknown) {
      requests.push({ tools });
      const turn = script[Math.min(n, script.length - 1)];
      n++;
      return (async function* () {
        if ("error" in turn) throw turn.error;
        for (const c of turn.chunks) {
          if (interChunkDelayMs > 0) {
            await new Promise((r) => setTimeout(r, interChunkDelayMs));
          }
          if (c.t === "thinking") yield { type: "thinking", content: c.c };
          else if (c.t === "content") yield { type: "content", content: c.c };
          else if (c.t === "tool_call") {
            yield { type: "tool_call", toolCall: c.call };
          } else yield { type: "done", finishReason: c.finish };
        }
      })();
    },
  } as unknown as LLMClient;
  return {
    client,
    requests,
    calls: () => n,
  };
}
type ScriptTurn = { chunks: ScriptChunk[] } | { error: Error };

interface Harness {
  session: FluxSession;
  executed: string[];
  recorded: Array<
    { content: string; thinking: string | null; toolCalls?: ToolCall[] }
  >;
  toolRows: string[];
  sleepEntered: number;
  sleepWakes: number;
  endFlux: number;
  entries: () => Array<
    {
      kind: string;
      source: string | null;
      content: string;
      thinking: string | null;
      timestamp: string;
    }
  >;
  park: () => Array<{ content: string }>;
}

function makeSession(
  script: ScriptTurn[],
  extra?: { isSleeping?: () => boolean; interChunkDelayMs?: number },
): Harness {
  const { client } = fakeClient(script, extra?.interChunkDelayMs ?? 0);
  const db = new Database(":memory:");
  const executed: string[] = [];
  const recorded: Harness["recorded"] = [];
  const toolRows: string[] = [];
  let sleepEntered = 0;
  let sleepWakes = 0;
  let endFlux = 0;
  let sleeping = false;
  const session = new FluxSession(db, client, {
    buildSystemPrefix: async () => "system prefix",
    buildLateBlock: async () => "late block",
    renderMood: () => "",
    tools: () => [],
    executeTools: async (calls) => {
      executed.push(...calls.map((c) => c.id));
      return calls.map((c) => ({
        toolCallId: c.id,
        content: `result:${c.id}`,
      }));
    },
    recordEgoMessage: (content, thinking, toolCalls) => {
      recorded.push({ content, thinking, toolCalls });
    },
    recordToolResult: (id) => {
      toolRows.push(id);
    },
    onSleepEnter: () => {
      sleepEntered++;
      sleeping = true; // the real host flips posture here
    },
    onSleepWake: async () => {
      sleepWakes++;
      sleeping = false;
      return "dream briefing";
    },
    onEndFluxState: () => {
      endFlux++;
    },
    isSleeping: extra?.isSleeping ?? (() => sleeping),
  });
  return {
    session,
    executed,
    recorded,
    toolRows,
    get sleepEntered() {
      return sleepEntered;
    },
    get sleepWakes() {
      return sleepWakes;
    },
    get endFlux() {
      return endFlux;
    },
    entries: () =>
      db.prepare(
        "SELECT kind, source, content, thinking, timestamp FROM flux_session_entries WHERE kind != 'system' ORDER BY rowid",
      ).all() as Array<
        {
          kind: string;
          source: string | null;
          content: string;
          thinking: string | null;
          timestamp: string;
        }
      >,
    // Parks write raw SQL (not the in-memory list) — read the row.
    park: () =>
      db.prepare(
        "SELECT content FROM flux_session_entries WHERE id IN ('existing-open','sleep-open')",
      ).all() as Array<{ content: string }>,
  };
}

Deno.test("session core-drive: plain turn records + parks existing", async () => {
  const h = makeSession([{
    chunks: [
      { t: "content", c: "hello <t>stamp</t>friend" },
      { t: "done", finish: "stop" },
    ],
  }]);
  const spoke = await h.session.generate({ source: "user", content: "hi" });
  assertEquals(spoke.content, "hello <t>stamp</t>friend"); // raw return — stamps strip at record (unchanged behavior)
  assertEquals(h.recorded.length, 1);
  assertEquals(h.recorded[0].content, "hello friend");
  // The park: existing-open row.
  assertEquals(h.park().length, 1);
  assertEquals(h.park()[0].content.includes('"kind":"existing"'), true);
});

Deno.test("session core-drive: tool batch executes, entries pair, record carries calls", async () => {
  const h = makeSession([
    {
      chunks: [
        { t: "content", c: "checking" },
        { t: "tool_call", call: call("c1", "memory_recall") },
        { t: "done", finish: "tool_calls" },
      ],
    },
    {
      chunks: [
        { t: "content", c: "found it" },
        { t: "done", finish: "stop" },
      ],
    },
  ]);
  const spoke = await h.session.generate({ source: "user", content: "q" });
  assertEquals(h.executed, ["c1"]);
  assertEquals(spoke.content.includes("found it"), true);
  // tool_use + tool_result entries landed, paired by id convention.
  const kinds = h.entries().map((e) => `${e.kind}:${e.source}`);
  assertEquals(kinds.includes("tool_use:memory_recall"), true);
  assertEquals(kinds.includes("tool_result:memory_recall"), true);
  // The record row carries the turn's calls; the tool row persisted.
  assertEquals(h.recorded[0].toolCalls?.length, 1);
  assertEquals(h.toolRows, ["c1"]);
});

Deno.test("session core-drive: plain sleep parks sleep-open, nothing executes", async () => {
  const h = makeSession([{
    chunks: [
      { t: "tool_call", call: call("s1", "sleep") },
      { t: "done", finish: "tool_calls" },
    ],
  }]);
  const spoke = await h.session.generate({ source: "user", content: "night" });
  assertEquals(spoke.content, "");
  assertEquals(h.sleepEntered, 1);
  assertEquals(h.executed.length, 0);
  assertEquals(h.park().length, 1);
  assertEquals(h.park()[0].content.includes('"kind":"sleep"'), true);
});

Deno.test("session core-drive: wake-argument sleep resolves the briefing and the waking words follow", async () => {
  const h = makeSession([
    {
      chunks: [
        { t: "tool_call", call: call("s1", "sleep", '{"wake": true}') },
        { t: "done", finish: "tool_calls" },
      ],
    },
    {
      chunks: [
        { t: "content", c: "I'm awake now." },
        { t: "done", finish: "stop" },
      ],
    },
  ]);
  const spoke = await h.session.generate({
    source: "user",
    content: "morning",
  });
  assertEquals(spoke.content, "I'm awake now.");
  // The sleep tool_use entry logged "wake"; no registry execution, no record row.
  const sleepEntry = h.entries().find((e) => e.kind === "tool_use");
  assertEquals(sleepEntry?.source, "sleep");
  assertEquals(sleepEntry?.content, "wake");
  assertEquals(h.executed.length, 0);
  assertEquals(h.toolRows.length, 0);
  assertEquals(h.recorded[0].toolCalls, undefined);
});

Deno.test("session core-drive: end_flux breaks, fires teardown, no execution", async () => {
  const h = makeSession([{
    chunks: [
      { t: "content", c: "enough" },
      { t: "tool_call", call: call("e1", "end_flux_state") },
      { t: "done", finish: "tool_calls" },
    ],
  }]);
  const spoke = await h.session.generate({ source: "user", content: "bye" });
  assertEquals(spoke.content, "enough");
  assertEquals(h.endFlux, 1);
  assertEquals(h.executed.length, 0);
});

Deno.test("session core-drive: budget exhaustion forces the final answer", async () => {
  // Every generation emits one tool call — only the no-tools endgame
  // generation can produce speech.
  const h = makeSession([
    {
      chunks: [
        { t: "tool_call", call: call("c1", "memory_recall") },
        { t: "done", finish: "tool_calls" },
      ],
    },
    {
      chunks: [
        { t: "content", c: "here is what I have" },
        { t: "done", finish: "stop" },
      ],
    },
  ]);
  // Drive with a small budget by exhausting the default 25: script
  // repeats the tool call (fakeClient repeats the last turn), then the
  // endgame generation (no tools advertised) hits script[1].
  const toolTurns = Array.from({ length: 24 }, () => ({
    chunks: [
      {
        t: "tool_call" as const,
        call: call(`c${Math.random()}`, "memory_recall"),
      },
      { t: "done" as const, finish: "tool_calls" },
    ],
  }));
  const h2 = makeSession([
    ...toolTurns,
    {
      chunks: [
        { t: "content", c: "final answer anyway" },
        { t: "done", finish: "stop" },
      ],
    },
  ]);
  const spoke = await h2.session.generate({ source: "user", content: "hard" });
  assertEquals(spoke.content, "final answer anyway");
  assertEquals(h2.recorded.length, 1);
  void h;
});

Deno.test("session core-drive: thinking persists on a tool-only turn (sleep call, no words)", async () => {
  const h = makeSession([{
    chunks: [
      { t: "thinking", c: "It's late. I'll let myself sleep now." },
      { t: "tool_call", call: call("s1", "sleep") },
      { t: "done", finish: "tool_calls" },
    ],
  }]);
  const spoke = await h.session.generate({ source: "user", content: "night" });
  assertEquals(spoke.content, "");
  // No words — the thinking block is still recorded: never lose a
  // thinking block.
  assertEquals(h.recorded.length, 1);
  assertEquals(h.recorded[0].content, "");
  assertEquals(
    (h.recorded[0].thinking || "").includes("let myself sleep"),
    true,
  );
  // The session entry carries it too (timeline renders thinking-only).
  const ego = h.entries().find((e) => e.kind === "ego");
  assertEquals(ego?.content, "");
  assertEquals((ego?.thinking || "").includes("let myself sleep"), true);
  // And the sleep park happened.
  assertEquals(h.sleepEntered, 1);
  assertEquals(h.park()[0].content.includes('"kind":"sleep"'), true);
});

Deno.test("session core-drive: true silence (no words, no thought) records nothing", async () => {
  const h = makeSession([{
    chunks: [
      { t: "tool_call", call: call("s1", "sleep") },
      { t: "done", finish: "tool_calls" },
    ],
  }]);
  await h.session.generate({ source: "user", content: "night" });
  assertEquals(h.recorded.length, 0);
  const ego = h.entries().filter((e) => e.kind === "ego");
  assertEquals(ego.length, 0);
});

Deno.test("session core-drive: tool-using turns split thinking — timeline reads in turn order", async () => {
  const h = makeSession([
    {
      chunks: [
        { t: "thinking", c: "She wants me to sleep. I'll go." },
        { t: "tool_call", call: call("s1", "sleep") },
        { t: "done", finish: "tool_calls" },
      ],
    },
  ]);
  await h.session.generate({ source: "user", content: "sleep please" });
  // One ego entry: thinking-only (timestamped at thinking time, BEFORE
  // the sleep tool_use) — the empty message entry is skipped. The turn
  // reads: thinking → sleep call.
  const egos = h.entries().filter((e) => e.kind === "ego");
  assertEquals(egos.length, 1);
  assertEquals(egos[0].content, "");
  assertEquals((egos[0].thinking || "").includes("wants me to sleep"), true);
  const sleepCall = h.entries().find((e) => e.kind === "tool_use");
  // <= : scripted turns run sub-millisecond — equal timestamps render in
  // insertion order (thinking appended first), which is the reading order.
  assertEquals(egos[0].timestamp <= (sleepCall?.timestamp || ""), true);
});

Deno.test("session core-drive: tool-free turn keeps one combined entry", async () => {
  const h = makeSession([{
    chunks: [
      { t: "thinking", c: "just thinking" },
      { t: "content", c: "just speaking" },
      { t: "done", finish: "stop" },
    ],
  }]);
  await h.session.generate({ source: "user", content: "hi" });
  const egos = h.entries().filter((e) => e.kind === "ego");
  assertEquals(egos.length, 1);
  assertEquals(egos[0].content, "just speaking");
  assertEquals((egos[0].thinking || "").includes("just thinking"), true);
});

Deno.test("session core-drive: speak-then-call — words precede the call card", async () => {
  const h = makeSession([
    {
      chunks: [
        { t: "content", c: "let me check the vault, love" },
        { t: "tool_call", call: call("c1", "vault") },
        { t: "done", finish: "tool_calls" },
      ],
    },
    {
      chunks: [
        { t: "content", c: "here's what I found" },
        { t: "done", finish: "stop" },
      ],
    },
  ]);
  await h.session.generate({ source: "user", content: "check the vault" });
  const seq = h.entries().map((e) =>
    `${e.kind}:${(e.content || " ").slice(0, 12)}`
  );
  // Order: intermediate speech → tool_use → tool_result → final speech.
  assertEquals(seq[0].startsWith("ego:let me check"), true);
  assertEquals(seq[1].startsWith("tool_use:"), true);
  assertEquals(seq[2].startsWith("tool_result:"), true);
  assertEquals(seq[3].startsWith("ego:here's what"), true);
  // The RECORD row carries the whole turn joined (classic one-bubble).
  assertEquals(
    (h.recorded[0].content || "").includes("let me check") &&
      (h.recorded[0].content || "").includes("here's what"),
    true,
  );
});

Deno.test("session core-drive: classic interleaving — each piece lands when it happens", async () => {
  // Inter-chunk delay mirrors real streaming: thinking precedes the
  // tool append by real time, not the fake's same-millisecond ties.
  const h = makeSession(
    [
      {
        chunks: [
          { t: "thinking", c: "checking the vault for her" },
          { t: "tool_call", call: call("c1", "vault") },
          { t: "done", finish: "tool_calls" },
        ],
      },
      {
        chunks: [
          { t: "content", c: "here's what I found" },
          { t: "done", finish: "stop" },
        ],
      },
    ],
    { interChunkDelayMs: 3 },
  );
  await h.session.generate({ source: "user", content: "check the vault" });
  // The timeline sorts by TIMESTAMP (rowid is write-order); assert on
  // the sorted view — the reading the timeline renders.
  const sorted = [...h.entries()].sort((a, b) =>
    a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0
  );
  const seq = sorted.map((e) => e.kind);
  // Classic order for think → call → answer: thinking first, the calls
  // where they fired, the final message last.
  assertEquals(seq, ["ego", "tool_use", "tool_result", "ego"]);
  const egos = h.entries().filter((e) => e.kind === "ego");
  assertEquals(egos.length, 2); // thinking entry + message entry
  assertEquals(egos[0].thinking !== null && egos[1].thinking === null, true);
});

Deno.test("session core-drive: split entries are tagged for the timeline", async () => {
  const h = makeSession([
    {
      chunks: [
        { t: "thinking", c: "she wants a vault call" },
        { t: "tool_call", call: call("c1", "vault") },
        { t: "done", finish: "tool_calls" },
      ],
    },
    {
      chunks: [
        { t: "content", c: "ok I did it" },
        { t: "done", finish: "stop" },
      ],
    },
  ]);
  await h.session.generate({
    source: "user",
    content: "please call the vault tool",
  });
  const egos = h.entries().filter((e) => e.kind === "ego");
  // Timeline shape: [thinking] [speech] [card] [speech] — the split
  // entries carry the tags the timeline renders by.
  assertEquals(egos[0].source, "turn-thinking");
  assertEquals(egos[1].source, "turn-speech");
});
