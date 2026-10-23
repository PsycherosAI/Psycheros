// End-to-end session test: a full ShellSession against the real local test
// MUSH (127.0.0.1:4201), with only the brain mocked — a scripted
// OpenAI-compatible endpoint. Proves connect → login → HUD → agent turn →
// game command on the wire → echo back into the next turn → stop → summary.
//
// Skips silently when no local MUSH is running (or no
// ENTITY_SHELL_TEST_PASSWORD is set), so CI on other machines stays green.

import { assert } from "@std/assert";
import { ShellSession } from "../src/sessions/shell-session.ts";
import type { FoldSummary } from "../src/window/mod.ts";

const MUSH_HOST = "127.0.0.1";
const MUSH_PORT = 4201;
const CHARACTER = "Pilgrim";
const PASSWORD = Deno.env.get("ENTITY_SHELL_TEST_PASSWORD") ?? "";

const encoder = new TextEncoder();

function sseBody(chunks: unknown[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`),
        );
      }
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
}
const textDelta = (text: string) => ({
  choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
});
const toolCallDelta = (id: string, name: string, args: string) => ({
  choices: [{
    index: 0,
    delta: {
      tool_calls: [{
        index: 0,
        id,
        type: "function",
        function: { name, arguments: args },
      }],
    },
    finish_reason: null,
  }],
});
const finish = (reason: string) => ({
  choices: [{ index: 0, delta: {}, finish_reason: reason }],
});

async function waitFor(
  check: () => boolean,
  timeoutMs: number,
  what: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check() && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!check()) throw new Error(`timeout waiting for ${what}`);
}

Deno.test("full session against the local MUSH with a mocked brain", async () => {
  if (PASSWORD === "") {
    console.log("skipping: ENTITY_SHELL_TEST_PASSWORD not set");
    return;
  }
  try {
    const probe = await Deno.connect({ hostname: MUSH_HOST, port: MUSH_PORT });
    probe.close();
  } catch {
    console.log("skipping: no MUSH listening on 127.0.0.1:4201");
    return;
  }

  const llmRequests: string[] = [];
  let llmTurn = 0;

  const llm = Deno.serve(
    { port: 0 },
    (request) =>
      request.json().then((body) => {
        llmRequests.push(JSON.stringify(body));
        llmTurn++;
        // Turn 1 (arrival): greet the room via the command tool.
        // Later turns: nothing more to do.
        const stream = llmTurn === 1
          ? sseBody([
            toolCallDelta(
              "call-1",
              "command",
              JSON.stringify({
                command: "say The fountain hums quietly tonight.",
              }),
            ),
            finish("tool_calls"),
          ])
          : sseBody([textDelta("(I watch the room.)"), finish("stop")]);
        return new Response(stream, {
          headers: { "content-type": "text/event-stream" },
        });
      }),
  );

  const foldWriter = (): Promise<FoldSummary> =>
    Promise.resolve({
      rooms: [],
      people: [],
      events: [],
      openThreads: [],
      pinnedQuotes: [],
      narrative: "",
    });

  const session = new ShellSession({
    ports: {
      identity: {
        entityName: CHARACTER,
        identity: "I am a quiet wanderer visiting this world.",
        customInstructions: "I like fountains.",
      },
      model: {
        baseUrl: `http://127.0.0.1:${llm.addr.port}/v1`,
        apiKey: "test-key",
        model: "mock-model",
      },
      sessionContext: {
        load: () =>
          Promise.resolve("Earlier I was testing the shell with my operator."),
      },
    },
    connection: {
      host: MUSH_HOST,
      port: MUSH_PORT,
      tls: false,
      username: CHARACTER,
      password: PASSWORD,
    },
    responsiveness: { debounceMs: 500 },
    foldWriter,
  });

  await session.start();

  try {
    // Turn 1: the arrival trigger fires with the HUD populated.
    await waitFor(
      () => llmRequests.length >= 1,
      15_000,
      "arrival LLM turn",
    );
    const first = llmRequests[0]!;
    assert(
      first.includes("I am a quiet wanderer visiting this world"),
      `identity not in request: ${first.slice(0, 800)}`,
    );
    // Hard rule: identity anchors the system prompt.
    // Identity payload opens the context — nothing synthetic before it.
    assert(
      first.includes("I am a quiet wanderer visiting this world."),
      "identity payload missing",
    );
    const systemStart = first.indexOf("I am a quiet wanderer");
    assert(systemStart !== -1 && systemStart < 200, "identity not opening");
    assert(first.includes("testing the shell"), "session context missing");
    assert(first.includes("Where I am: "), "HUD not in turn context");
    assert(first.includes("Here with me: "), "HUD presence not rendered");
    assert(
      first.includes("I have just connected"),
      "arrival trigger missing",
    );

    // The say tool reached the REAL MUSH: its echo comes back into the
    // window (self-echo never triggers a turn, but it is remembered) and
    // therefore lands in the stop summary.
    await new Promise((r) => setTimeout(r, 1_500));
  } finally {
    const summary = await session.stop();
    assert(summary.includes("You say"), summary);
    assert(summary.includes("The fountain hums quietly tonight."), summary);
    await llm.shutdown();
  }
});
