/**
 * Musing tests — the three-state contract (silence / murmur / propose),
 * both-streams input, and the fail-safe degradation: a malformed model
 * response can murmur but never escalate to a proposal.
 */

import { assertEquals } from "@std/assert";
import { createSmallLLMRunner } from "../src/small-llm-runner.ts";
import type { ChatFn } from "../src/runtime.ts";
import type { FluxObservation } from "../src/types.ts";

function obs(id: string, content: string, salience: number): FluxObservation {
  return {
    id,
    timestamp: new Date().toISOString(),
    sourceOrganId: "test-organ",
    content,
    salience,
    tags: [],
    promoted: false,
  };
}

const EXT = [obs("a", "the room went quiet", 0.4)];
const INT = [obs("b", "I keep circling back to Tuesday", 0.5)];

function runnerWith(response: string): ReturnType<
  typeof createSmallLLMRunner
> {
  const chat: ChatFn = () => Promise.resolve(response);
  return createSmallLLMRunner(chat);
}

Deno.test("musing: silence — null response", async () => {
  const r = runnerWith("null");
  assertEquals(await r.muse(EXT, INT), null);
});

Deno.test("musing: silence — explicit contract shape", async () => {
  const r = runnerWith('{"say": null}');
  assertEquals(await r.muse(EXT, INT), null);
});

Deno.test("musing: murmur", async () => {
  const r = runnerWith(
    '{"say": "murmur", "content": "The quiet keeps settling in layers."}',
  );
  assertEquals(await r.muse(EXT, INT), {
    kind: "murmur",
    content: "The quiet keeps settling in layers.",
  });
});

Deno.test("musing: propose", async () => {
  const r = runnerWith(
    '{"say": "propose", "content": "I want to tell my user I noticed them pacing."}',
  );
  assertEquals(await r.muse(EXT, INT), {
    kind: "propose",
    content: "I want to tell my user I noticed them pacing.",
  });
});

Deno.test("musing: unknown say value degrades to murmur, not propose", async () => {
  const r = runnerWith('{"say": "shout", "content": "hello?"}');
  const result = await r.muse(EXT, INT);
  assertEquals(result?.kind, "murmur");
});

Deno.test("musing: unparseable prose degrades to murmur, never propose", async () => {
  const r = runnerWith("I really think something is wrong with my user!");
  const result = await r.muse(EXT, INT);
  assertEquals(result?.kind, "murmur");
  assertEquals(
    result?.content,
    "I really think something is wrong with my user!",
  );
});

Deno.test("musing: missing content is silence", async () => {
  const r = runnerWith('{"say": "murmur"}');
  assertEquals(await r.muse(EXT, INT), null);
});

Deno.test("musing: both streams empty short-circuits without a model call", async () => {
  let called = false;
  const chat: ChatFn = () => {
    called = true;
    return Promise.resolve("null");
  };
  const r = createSmallLLMRunner(chat);
  assertEquals(await r.muse([], []), null);
  assertEquals(called, false);
});

Deno.test("musing: voice layer — past sayings ride the system prompt", async () => {
  let seenSystem = "";
  const chat: ChatFn = (system) => {
    seenSystem = system;
    return Promise.resolve("null");
  };
  const r = createSmallLLMRunner(chat, {
    getRecentVoice: () =>
      "[Thu 09:14 murmur] I wonder what they're up to today.",
  });
  await r.muse(EXT, INT);
  assertEquals(seenSystem.includes("my own voice, carried forward"), true);
  assertEquals(
    seenSystem.includes("I wonder what they're up to today."),
    true,
  );
});

Deno.test("musing: no voice getter — no voice header", async () => {
  let seenSystem = "";
  const chat: ChatFn = (system) => {
    seenSystem = system;
    return Promise.resolve("null");
  };
  const r = createSmallLLMRunner(chat);
  await r.muse(EXT, INT);
  assertEquals(seenSystem.includes("my own voice"), false);
});

Deno.test("reverie: the voice layer never rides reverie passes", async () => {
  let seenSystem = "";
  const chat: ChatFn = (system) => {
    seenSystem = system;
    return Promise.resolve("null");
  };
  const r = createSmallLLMRunner(chat, {
    getRecentVoice: () => "something I said earlier",
  });
  await r.reverie("a thread from today surfaces");
  assertEquals(seenSystem.includes("something I said earlier"), false);
});
