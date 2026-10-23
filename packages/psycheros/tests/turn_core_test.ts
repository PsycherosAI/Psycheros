/**
 * Turn-core tests — the shared agent-loop engine gets
 * direct tests: it is the narrow waist both EntityTurn and FluxSession
 * will drive, so its contracts must hold on their own. A scripted fake
 * client stands in for the LLM; no provider anywhere near these tests.
 */

import { assertEquals } from "@std/assert";
import type { LLMClient } from "../src/llm/mod.ts";
import type { ChatMessage } from "../src/llm/types.ts";
import type { ToolCall } from "../src/types.ts";
import {
  recoverMisroutedContent,
  runAgentLoop,
  type TurnCoreConfig,
  type TurnCoreToolResult,
} from "../src/entity/turn-core.ts";

/** Chunk shapes the client stream yields. */
type ScriptChunk =
  | { t: "thinking"; c: string }
  | { t: "content"; c: string }
  | { t: "tool_call"; call: ToolCall }
  | { t: "done"; finish: string };

/** One scripted generation. */
type ScriptTurn = ScriptChunk[] | { error: Error };

/** A fake LLM client with a per-call script; records every request. */
function fakeClient(script: ScriptTurn[]) {
  const requests: { messages: ChatMessage[]; tools: unknown }[] = [];
  let call = 0;
  const client = {
    chatStream(messages: ChatMessage[], tools?: unknown) {
      requests.push({ messages: [...messages], tools });
      const turn: ScriptTurn = script[Math.min(call, script.length - 1)];
      call++;
      return (async function* () {
        if (turn instanceof Error) throw turn;
        for (const chunk of turn as ScriptChunk[]) {
          if (chunk.t === "thinking") {
            yield { type: "thinking", content: chunk.c };
          } else if (chunk.t === "content") {
            yield { type: "content", content: chunk.c };
          } else if (chunk.t === "tool_call") {
            yield { type: "tool_call", toolCall: chunk.call };
          } else {
            yield { type: "done", finishReason: chunk.finish };
          }
        }
      })();
    },
  } as unknown as LLMClient;
  return {
    client,
    requests,
    callsMade: () => call,
    callId: (n: number) => `c${n}`,
  };
}

function toolCall(id: string, name = "search"): ToolCall {
  return {
    id,
    type: "function",
    function: { name, arguments: "{}" },
  } as ToolCall;
}

function baseConfig(
  client: LLMClient,
  execute: (calls: ToolCall[]) => Promise<TurnCoreToolResult[]>,
  extra?: Partial<TurnCoreConfig>,
): TurnCoreConfig {
  return {
    client,
    maxIterations: 8,
    toolDefs: () => [],
    executeTools: execute,
    ...extra,
  };
}

Deno.test("turn-core: plain generation, no tools — one pass, not exhausted", async () => {
  const { client } = fakeClient([[
    { t: "thinking", c: "hm" },
    { t: "content", c: "hello there" },
    { t: "done", finish: "stop" },
  ]]);
  const out = await runAgentLoop(
    [{ role: "user", content: "hi" }],
    baseConfig(client, async () => []),
  );
  assertEquals(out.spoke, "hello there");
  assertEquals(out.thought, "hm");
  assertEquals(out.toolCalls.length, 0);
  assertEquals(out.exhausted, false);
  assertEquals(out.iterations, 1);
});

Deno.test("turn-core: tool call executes, result feeds the next generation", async () => {
  const { client, requests } = fakeClient([
    [
      { t: "content", c: "let me look" },
      { t: "tool_call", call: toolCall("c1") },
      { t: "done", finish: "tool_calls" },
    ],
    [
      { t: "content", c: "found it" },
      { t: "done", finish: "stop" },
    ],
  ]);
  const executed: string[] = [];
  const out = await runAgentLoop(
    [{ role: "user", content: "q" }],
    baseConfig(client, async (calls) => {
      executed.push(...calls.map((c) => c.id));
      return [{ toolCallId: "c1", content: "the answer" }];
    }),
  );
  assertEquals(executed, ["c1"]);
  assertEquals(out.spoke.includes("let me look"), true);
  assertEquals(out.spoke.includes("found it"), true);
  assertEquals(out.iterations, 2);
  // The second request carried the assistant tool_calls message + result.
  const second = requests[1].messages;
  const assistantMsg = second.find((m) => m.role === "assistant");
  assertEquals(!!assistantMsg?.tool_calls, true);
  const toolMsg = second.find((m) => m.role === "tool");
  assertEquals(toolMsg?.content, "the answer");
});

Deno.test("turn-core: transient error retries, then succeeds", async () => {
  const { client, callsMade } = fakeClient([
    { error: new Error("network blip") },
    [
      { t: "content", c: "recovered" },
      { t: "done", finish: "stop" },
    ],
  ]);
  const out = await runAgentLoop(
    [{ role: "user", content: "q" }],
    baseConfig(client, async () => [], {
      retry: { maxAttempts: 3, delayMs: 1 },
    }),
  );
  assertEquals(out.spoke, "recovered");
  assertEquals(callsMade(), 2);
});

Deno.test("turn-core: all attempts fail — loop stops, no speech", async () => {
  const { client, callsMade } = fakeClient([{ error: new Error("down") }]);
  const out = await runAgentLoop(
    [{ role: "user", content: "q" }],
    baseConfig(client, async () => [], {
      retry: { maxAttempts: 2, delayMs: 1 },
    }),
  );
  assertEquals(out.spoke, "");
  assertEquals(out.exhausted, false); // failure, not budget death
  assertEquals(callsMade(), 2);
});

Deno.test("turn-core: misroute signature (tool_calls finish, nothing parsed) retries once", async () => {
  const { client, callsMade } = fakeClient([
    [{ t: "done", finish: "tool_calls" }], // empty — the signature
    [
      { t: "content", c: "actually here" },
      { t: "done", finish: "stop" },
    ],
  ]);
  const out = await runAgentLoop(
    [{ role: "user", content: "q" }],
    baseConfig(client, async () => []),
  );
  assertEquals(out.spoke, "actually here");
  assertEquals(callsMade(), 2);
});

Deno.test("turn-core: repeated misroute empties become honest silence", async () => {
  const { client } = fakeClient([
    [{ t: "done", finish: "tool_calls" }],
    [{ t: "done", finish: "tool_calls" }],
  ]);
  const out = await runAgentLoop(
    [{ role: "user", content: "q" }],
    baseConfig(client, async () => []),
  );
  assertEquals(out.spoke, "");
  assertEquals(out.exhausted, false); // policy stop, not budget
});

Deno.test("turn-core: reasoning-only response is promoted to content", async () => {
  const { client } = fakeClient([[
    { t: "thinking", c: "thinking about it</thinking>The real answer" },
    { t: "done", finish: "stop" },
  ]]);
  const out = await runAgentLoop(
    [{ role: "user", content: "q" }],
    baseConfig(client, async () => []),
  );
  assertEquals(out.spoke, "The real answer");
});

Deno.test("turn-core: budget death marks exhausted; policy break does not", async () => {
  // Script: always a tool call — the loop can only die by budget.
  const { client } = fakeClient([[
    { t: "tool_call", call: toolCall("c1") },
    { t: "done", finish: "tool_calls" },
  ]]);
  const out = await runAgentLoop(
    [{ role: "user", content: "q" }],
    baseConfig(
      client,
      async (calls) => calls.map((c) => ({ toolCallId: c.id, content: "x" })),
      { maxIterations: 3 },
    ),
  );
  assertEquals(out.exhausted, true);
  assertEquals(out.iterations, 3);

  // Same budget, but the policy breaks on the first generation.
  const { client: c2 } = fakeClient([[
    { t: "tool_call", call: toolCall("c1") },
    { t: "done", finish: "tool_calls" },
  ]]);
  const out2 = await runAgentLoop(
    [{ role: "user", content: "q" }],
    baseConfig(c2, async () => [], {
      maxIterations: 3,
      afterGeneration: () => "break",
    }),
  );
  assertEquals(out2.exhausted, false);
});

Deno.test("turn-core: afterGeneration can filter calls in place (interception)", async () => {
  const { client } = fakeClient([[
    { t: "content", c: "goodnight" },
    { t: "tool_call", call: toolCall("c1", "sleep") },
    { t: "done", finish: "tool_calls" },
  ]]);
  const executed: string[] = [];
  const out = await runAgentLoop(
    [{ role: "user", content: "q" }],
    baseConfig(client, async (calls) => {
      executed.push(...calls.map((c) => c.id));
      return [];
    }, {
      // The session's sleep park shape: intercept by emptying the list
      // and breaking.
      afterGeneration: (_i, gen) => {
        gen.toolCalls = gen.toolCalls.filter((c) =>
          c.function.name !== "sleep"
        );
        if (gen.toolCalls.length === 0) return "break";
        return "continue";
      },
    }),
  );
  assertEquals(executed.length, 0);
  assertEquals(out.exhausted, false);
});

Deno.test("turn-core: iteration summary hook fires per generation", async () => {
  const { client } = fakeClient([[
    { t: "content", c: "one" },
    { t: "done", finish: "stop" },
  ]]);
  const seen: number[] = [];
  await runAgentLoop(
    [{ role: "user", content: "q" }],
    baseConfig(client, async () => [], {
      onIterationSummary: (i) => seen.push(i),
    }),
  );
  assertEquals(seen, [0]);
});

Deno.test("turn-core: recoverMisroutedContent boundary handling", () => {
  // Split at the LAST marker — late content survives.
  assertEquals(
    recoverMisroutedContent("a</thinking>b</thinking>final words", ""),
    "final words",
  );
  // No marker at all — the whole reasoning is the candidate reply.
  assertEquals(
    recoverMisroutedContent("just thinking out loud", ""),
    "just thinking out loud",
  );
  // Content present — nothing to recover.
  assertEquals(recoverMisroutedContent("thinking", "already said"), null);
  // Empty everything — nothing to recover.
  assertEquals(recoverMisroutedContent("", ""), null);
});

Deno.test("turn-core: thinking + tool_calls + no content is NOT promoted to speech", async () => {
  // The normal mid-tool-turn shape for reasoning-native models. The
  // misroute recovery must never promote this generation's thinking
  // verbatim into the message — it must stay thinking.
  const { client } = fakeClient([
    [
      {
        t: "thinking",
        c: "She's asking me to release the skill. I'll call it now.",
      },
      { t: "tool_call", call: toolCall("c1", "skill") },
      { t: "done", finish: "tool_calls" },
    ],
    [
      { t: "thinking", c: "The skill was released. I should confirm briefly." },
      { t: "content", c: "Done, beloved — released." },
      { t: "done", finish: "stop" },
    ],
  ]);
  const out = await runAgentLoop(
    [{ role: "user", content: "release it" }],
    baseConfig(
      client,
      async (calls) =>
        calls.map((c) => ({ toolCallId: c.id, content: "released" })),
    ),
  );
  // ONLY the second generation's content is speech — no thinking verbatim.
  assertEquals(out.spoke, "Done, beloved — released.");
  assertEquals(out.thought.includes("She's asking"), true);
  assertEquals(out.spoke.includes("She's asking"), false);
});

Deno.test("turn-core: finish=stop, no content, no calls — reasoning still promotes", async () => {
  const { client } = fakeClient([[
    { t: "thinking", c: "thinking it over</thinking>The real reply" },
    { t: "done", finish: "stop" },
  ]]);
  const out = await runAgentLoop(
    [{ role: "user", content: "q" }],
    baseConfig(client, async () => []),
  );
  assertEquals(out.spoke, "The real reply");
});

Deno.test("turn-core: threadReasoning attaches thinking to the tool-call message", async () => {
  const { client, requests } = fakeClient([
    [
      { t: "thinking", c: "planning the call" },
      { t: "tool_call", call: toolCall("c1") },
      { t: "done", finish: "tool_calls" },
    ],
    [
      { t: "content", c: "answered" },
      { t: "done", finish: "stop" },
    ],
  ]);
  await runAgentLoop(
    [{ role: "user", content: "q" }],
    baseConfig(
      client,
      async (calls) => calls.map((c) => ({ toolCallId: c.id, content: "r" })),
      { threadReasoning: true },
    ),
  );
  const second = requests[1].messages;
  const assistantMsg = second.find((m) => m.role === "assistant") as {
    reasoning_content?: string;
    tool_calls?: unknown[];
  };
  assertEquals(assistantMsg?.reasoning_content, "planning the call");
  assertEquals(!!assistantMsg?.tool_calls, true);
});

Deno.test("turn-core: threadReasoning off (default) omits reasoning_content", async () => {
  const { client, requests } = fakeClient([
    [
      { t: "thinking", c: "planning the call" },
      { t: "tool_call", call: toolCall("c1") },
      { t: "done", finish: "tool_calls" },
    ],
    [
      { t: "content", c: "answered" },
      { t: "done", finish: "stop" },
    ],
  ]);
  await runAgentLoop(
    [{ role: "user", content: "q" }],
    baseConfig(
      client,
      async (calls) => calls.map((c) => ({ toolCallId: c.id, content: "r" })),
    ),
  );
  const second = requests[1].messages;
  const assistantMsg = second.find((m) => m.role === "assistant") as {
    reasoning_content?: string;
  };
  assertEquals(assistantMsg?.reasoning_content, undefined);
});

Deno.test("turn-core: onToolCall fires as the call streams", async () => {
  const { client } = fakeClient([
    [
      { t: "content", c: "checking" },
      { t: "tool_call", call: toolCall("c1") },
      { t: "done", finish: "tool_calls" },
    ],
    [
      { t: "content", c: "done" },
      { t: "done", finish: "stop" },
    ],
  ]);
  const seen: string[] = [];
  await runAgentLoop(
    [{ role: "user", content: "q" }],
    baseConfig(
      client,
      async (c) => c.map((x) => ({ toolCallId: x.id, content: "r" })),
      {
        chunkHandlers: {
          onToolCall: (call) => seen.push(call.id),
        },
      },
    ),
  );
  assertEquals(seen, ["c1"]);
});
