// Adapter test: the bundled plugin's `play`/`stop` tools driven directly
// with a fake ToolContext — real local MUSH, scripted brain, temp data root
// with identity + LLM settings. Skips without a local MUSH.

import { assert } from "@std/assert";
import plugin from "../../psycheros/bundled-plugins/entity-shell/psycheros.ts";
import type { ToolContext } from "../../psycheros/src/tools/types.ts";
import type { Message } from "../../psycheros/src/types.ts";

const MUSH_PORT = 4201;
const MUSH_PASSWORD = Deno.env.get("ENTITY_SHELL_TEST_PASSWORD") ?? "";

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

Deno.test("play/stop tools run a session end to end", async () => {
  if (MUSH_PASSWORD === "") {
    console.log("skipping: ENTITY_SHELL_TEST_PASSWORD not set");
    return;
  }
  try {
    const probe = await Deno.connect({
      hostname: "127.0.0.1",
      port: MUSH_PORT,
    });
    probe.close();
  } catch {
    console.log("skipping: no MUSH listening on 127.0.0.1:4201");
    return;
  }

  let llmTurn = 0;
  const llm = Deno.serve({ port: 0 }, (request) =>
    request.json().then(() => {
      llmTurn++;
      const stream = llmTurn === 1
        ? sseBody([
          toolCallDelta(
            "call-1",
            "look",
            "{}",
          ),
          finish("tool_calls"),
        ])
        : sseBody([textDelta("(I take it in quietly.)"), finish("stop")]);
      return new Response(stream, {
        headers: { "content-type": "text/event-stream" },
      });
    }));

  const dataRoot = await Deno.makeTempDir();
  await Deno.mkdir(`${dataRoot}/.psycheros`, { recursive: true });
  await Deno.mkdir(`${dataRoot}/identity`, { recursive: true });
  await Deno.writeTextFile(
    `${dataRoot}/.psycheros/llm-settings.json`,
    JSON.stringify({
      baseUrl: `http://127.0.0.1:${llm.addr.port}/v1`,
      apiKey: "test-key",
      model: "mock-model",
      workerModel: "mock-model",
      temperature: 0.7,
    }),
  );
  await Deno.writeTextFile(
    `${dataRoot}/identity/self.md`,
    "I am a wanderer of quiet places.",
  );

  Deno.env.set("PSYCHEROS_PLUGIN_ENTITY_SHELL_USER", "Pilgrim");
  Deno.env.set("PSYCHEROS_PLUGIN_ENTITY_SHELL_PASSWORD", MUSH_PASSWORD);

  const history: Message[] = [{
    id: "m1",
    conversationId: "c1",
    role: "user",
    content: "Hey, want to check out that MUSH?",
    createdAt: new Date(),
    toolCallId: null,
    toolCalls: null,
    reasoningContent: null,
    isVoice: false,
  }] as unknown as Message[];

  const ctx = {
    toolCallId: "t1",
    conversationId: "c1",
    db: { getMessages: (_id: string) => history },
    config: { dataRoot },
  } as unknown as ToolContext;

  const play = plugin.tools.find((t) => t.definition.function.name === "play")!;

  try {
    const started = await play.execute({}, ctx);
    assert(!started.isError, started.content);
    assert(started.content.includes("I'm in"), started.content);
    assert(started.content.includes("Cathedral Nave"), started.content);

    const again = await play.execute({}, ctx);
    assert(again.content.includes("already playing"), again.content);

    await new Promise((r) => setTimeout(r, 2_000));

    const ended = await play.execute({ action: "stop" }, ctx);
    assert(!ended.isError, ended.content);
    assert(ended.content.length > 0, "empty summary");

    const after = await play.execute({ action: "stop" }, ctx);
    assert(after.content.includes("not in the game"), after.content);
  } finally {
    Deno.env.delete("PSYCHEROS_PLUGIN_ENTITY_SHELL_USER");
    Deno.env.delete("PSYCHEROS_PLUGIN_ENTITY_SHELL_PASSWORD");
    await plugin.stop!();
    await llm.shutdown();
    await Deno.remove(dataRoot, { recursive: true });
  }
});
