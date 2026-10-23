// Smoke test for the pi embed: the Agent loop from @earendil-works/pi-agent-core
// running in-process under Deno against a scripted OpenAI-compatible mock
// endpoint, with seeded history and a custom game tool.
//
// Proves the three embed unknowns at once: pi loads under Deno npm compat,
// initialState.messages reaches the wire (origin-context seeding), and a real
// tool-call round-trip works end to end.

import { assert, assertEquals } from "@std/assert";
import { Agent } from "@earendil-works/pi-agent-core";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import type { Model } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/api/openai-completions";

const encoder = new TextEncoder();

/** OpenAI-compatible SSE chunk helpers. */
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

Deno.test("pi Agent runs a tool loop in-process under Deno", async () => {
  const requests: { url: string; body: Record<string, unknown> }[] = [];
  const toolCalls: { name: string; args: Record<string, unknown> }[] = [];
  let turn = 0;

  const server = Deno.serve({ port: 0 }, (request) => {
    turn++;
    const url = new URL(request.url).pathname;
    return request.json().then((body) => {
      requests.push({ url, body: body as Record<string, unknown> });
      const stream = turn === 1
        ? sseBody([
          toolCallDelta("call-1", "say", JSON.stringify({ text: "hello" })),
          finish("tool_calls"),
        ])
        : sseBody([textDelta("I said hello."), finish("stop")]);
      return new Response(stream, {
        headers: {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
        },
      });
    });
  });

  const model: Model<"openai-completions"> = {
    id: "mock-model",
    name: "Mock Model",
    api: "openai-completions",
    provider: "mock",
    baseUrl: `http://127.0.0.1:${server.addr.port}/v1`,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 8192,
    maxTokens: 1024,
  };

  const sayTool: AgentTool = {
    name: "say",
    label: "Say",
    description: "I use this to say something in the room.",
    parameters: Type.Object({ text: Type.String() }),
    execute: (_toolCallId, args) => {
      toolCalls.push({ name: "say", args: args as Record<string, unknown> });
      return Promise.resolve({
        content: [{ type: "text", text: 'You say, "hello"' }],
        details: {},
      });
    },
  };

  const agent = new Agent({
    // The shell's ModelPort is OpenAI-compatible by construction, so the
    // completions-specific stream function is narrowed, not converted.
    streamFn: (model, context, options) =>
      streamSimple(model as Model<"openai-completions">, context, options),
    getApiKey: () => "test-key",
    initialState: {
      systemPrompt: "I am Pilgrim, playing a MUSH.",
      model,
      messages: [{
        role: "user",
        content: "Earlier I logged into the game.",
        timestamp: Date.now(),
      }],
      tools: [sayTool],
    },
  });

  const assistantTexts: string[] = [];
  agent.subscribe((event) => {
    if (event.type === "message_end" && event.message.role === "assistant") {
      for (const part of event.message.content) {
        if (part.type === "text") assistantTexts.push(part.text);
      }
    }
  });

  try {
    await agent.prompt("Greet the room using the say tool.");
    await agent.waitForIdle();

    // Tool round-trip: the model called say, the tool executed, the model
    // then produced final text.
    assertEquals(toolCalls.length, 1);
    assertEquals(toolCalls[0]!.args.text, "hello");
    assertEquals(requests.length, 2);
    assert(
      assistantTexts.join("").includes("I said hello."),
      assistantTexts.join(""),
    );

    // Seeding proof: the very first request carried the system prompt and
    // the seeded origin-context message.
    const firstBody = requests[0]!.body as {
      messages?: { role: string; content: string }[];
    };
    const messages = firstBody.messages ?? [];
    assertEquals(
      messages.some((m) =>
        m.role === "system" && m.content.includes("I am Pilgrim")
      ),
      true,
      JSON.stringify(messages),
    );
    assertEquals(
      messages.some((m) =>
        m.role === "user" &&
        m.content.includes("Earlier I logged into the game.")
      ),
      true,
    );

    // The second request carried the tool result.
    const secondBody = requests[1]!.body as {
      messages?: { role: string; content: string }[];
    };
    assert(
      (secondBody.messages ?? []).some((m) =>
        m.role === "tool" && m.content.includes("You say")
      ),
      JSON.stringify(secondBody.messages),
    );
  } finally {
    await server.shutdown();
  }
});
