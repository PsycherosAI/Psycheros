/**
 * Tests for fixed-temperature provider handling.
 *
 * Some OpenAI-compatible providers reject any request whose temperature
 * isn't an exact provider-pinned value (Moonshot/Kimi on certain models).
 * The LLMClient should:
 *   1. Send the caller's task-specific temperature first.
 *   2. If the provider rejects with a fixed-temperature error, learn the
 *      required value, retry once with it, and remember it for the life of
 *      the instance.
 *   3. On subsequent calls, send the learned value first.
 *
 * Importantly, this preserves per-task temperatures (0.2 for graph JSON,
 * 0.3 for significant memories, 0.7 for daily prose) wherever the provider
 * allows them — the entity's memory generation quality isn't flattened to
 * a single temperature just because one provider is picky.
 */

import { assertEquals, assertExists } from "@std/assert";
import { inferRequiredTemperature, LLMClient } from "./client.ts";

Deno.test({
  name: "inferRequiredTemperature: 'temperature must be 1' → 1",
  fn() {
    assertEquals(inferRequiredTemperature("temperature must be 1"), 1);
  },
});

Deno.test({
  name:
    "inferRequiredTemperature: JSON error body with 'temperature must be 1' → 1",
  fn() {
    assertEquals(
      inferRequiredTemperature(
        JSON.stringify({
          error: { message: "temperature must be 1", type: "invalid_request" },
        }),
      ),
      1,
    );
  },
});

Deno.test({
  name: "inferRequiredTemperature: 'temperature should be 0' → 0",
  fn() {
    assertEquals(inferRequiredTemperature("temperature should be 0"), 0);
  },
});

Deno.test({
  name: "inferRequiredTemperature: 'temperature must be 0.5' → 0.5",
  fn() {
    assertEquals(inferRequiredTemperature("temperature must be 0.5"), 0.5);
  },
});

Deno.test({
  name: "inferRequiredTemperature: 'temperature needs to be 1' → 1",
  fn() {
    assertEquals(inferRequiredTemperature("temperature needs to be 1"), 1);
  },
});

Deno.test({
  name:
    "inferRequiredTemperature: 'temperature must be between 0 and 2' → null (range, don't guess)",
  fn() {
    assertEquals(
      inferRequiredTemperature("temperature must be between 0 and 2"),
      null,
    );
  },
});

Deno.test({
  name:
    "inferRequiredTemperature: 'temperature: expected one of [0, 0.7, 1]' → null (multi-value, ambiguous)",
  fn() {
    assertEquals(
      inferRequiredTemperature("temperature: expected one of [0, 0.7, 1]"),
      null,
    );
  },
});

Deno.test({
  name:
    "inferRequiredTemperature: 'temperature must be a number' → null (no value)",
  fn() {
    assertEquals(
      inferRequiredTemperature("temperature must be a number"),
      null,
    );
  },
});

Deno.test({
  name:
    "inferRequiredTemperature: 'Invalid temperature: provided 0.3' → null (not a requirement, just a complaint)",
  fn() {
    assertEquals(
      inferRequiredTemperature("Invalid temperature: provided 0.3"),
      null,
    );
  },
});

// ─── Round-trip tests via a fake HTTP server ──────────────────────────────

interface RecordedRequest {
  url: string;
  body: Record<string, unknown>;
}

async function withFakeServer(
  handler: (
    req: Request,
    body: Record<string, unknown>,
    callIndex: number,
  ) => Response | Promise<Response>,
  fn: (baseUrl: string, recorded: RecordedRequest[]) => Promise<void>,
): Promise<void> {
  const recorded: RecordedRequest[] = [];
  let callIndex = 0;

  const server = Deno.serve({ port: 0 }, async (req) => {
    const body = await req.json() as Record<string, unknown>;
    recorded.push({ url: req.url, body });
    const response = await handler(req, body, callIndex);
    callIndex++;
    return response;
  });

  try {
    const addr = server.addr as Deno.NetAddr;
    const baseUrl = `http://${addr.hostname}:${addr.port}`;
    await fn(baseUrl, recorded);
  } finally {
    await server.shutdown();
  }
}

Deno.test({
  name:
    "complete() retries with provider-required temperature and remembers it for subsequent calls",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    await withFakeServer(
      (_req, body, idx) => {
        // First call: reject any temperature != 1
        if (idx === 0) {
          const temp = body.temperature;
          if (temp !== undefined && temp !== 1) {
            return new Response(
              JSON.stringify({
                error: { message: `temperature must be 1, got ${temp}` },
              }),
              {
                status: 400,
                headers: { "Content-Type": "application/json" },
              },
            );
          }
        }
        // All other calls: succeed
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: "ok" } }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      },
      async (baseUrl, recorded) => {
        const client = new LLMClient({
          apiKey: "test",
          baseUrl,
          model: "moonshot/kimi-k2",
        });

        // First call: asks for 0.3, server rejects with "must be 1", client
        // retries with 1, succeeds. Two requests in the log.
        const r1 = await client.complete(
          [{ role: "user", content: "hi" }],
          { temperature: 0.3 },
        );
        assertEquals(r1, "ok");
        assertEquals(recorded.length, 2);
        assertEquals(recorded[0].body.temperature, 0.3);
        assertEquals(recorded[1].body.temperature, 1);

        // Second call: client already knows the required value, sends 1
        // first try. No rejection, no retry. One more request in the log.
        const r2 = await client.complete(
          [{ role: "user", content: "hi again" }],
          { temperature: 0.7 },
        );
        assertEquals(r2, "ok");
        assertEquals(recorded.length, 3);
        assertEquals(recorded[2].body.temperature, 1);
      },
    );
  },
});

Deno.test({
  name:
    "complete() does not retry when error is not a fixed-temperature requirement",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    await withFakeServer(
      () => {
        // Range error — not a fixed requirement, don't guess
        return new Response(
          JSON.stringify({
            error: {
              message: "temperature must be between 0 and 2, got 5",
            },
          }),
          { status: 400, headers: { "Content-Type": "application/json" } },
        );
      },
      async (baseUrl, recorded) => {
        const client = new LLMClient({
          apiKey: "test",
          baseUrl,
          model: "test-model",
          maxRetries: 1,
        });

        // The error is a range error, not a fixed-temp requirement. The
        // client should NOT retry with a guessed value. It should throw.
        let caught: Error | null = null;
        try {
          await client.complete(
            [{ role: "user", content: "hi" }],
            { temperature: 5 },
          );
        } catch (e) {
          caught = e instanceof Error ? e : new Error(String(e));
        }
        assertExists(caught);
        if (!caught) return; // narrow for type checker
        if (!caught.message.includes("LLM API error")) {
          throw new Error(`Expected LLM API error, got: ${caught.message}`);
        }

        // Only one request — no retry.
        assertEquals(recorded.length, 1);
      },
    );
  },
});

Deno.test({
  name:
    "complete() with no caller-supplied temperature passes through unchanged",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    await withFakeServer(
      () => {
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: "ok" } }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      },
      async (baseUrl, recorded) => {
        const client = new LLMClient({
          apiKey: "test",
          baseUrl,
          model: "test-model",
        });

        const r = await client.complete([
          { role: "user", content: "hi" },
        ]);
        assertEquals(r, "ok");
        assertEquals(recorded.length, 1);
        assertEquals(recorded[0].body.temperature, undefined);
      },
    );
  },
});
