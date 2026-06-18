/**
 * Regression test for orphaned tool calls on client disconnect.
 *
 * Background: when an async generator yields, the consumer's `break` triggers
 * generator.return(), which jumps to finally blocks but skips any code
 * scheduled after the current yield. In EntityTurn's tool-results loop,
 * `db.addMessage({ role: "tool" })` runs AFTER the yield — so a client
 * disconnect at that yield point skips the persist, leaving an orphan
 * assistant(tool_calls) row with no matching tool result.
 *
 * Fix: in `routes.ts` (chat + retry handlers) AND `voice/pipeline.ts`, any
 * `if (signal.aborted) break` becomes `if (signal.aborted) continue`. The
 * generator keeps draining to completion; post-yield persistence runs
 * normally. Voice mode also stops flushing TTS after disconnect (gated
 * separately), so audio behavior is unchanged.
 *
 * Stop button exception: when the user clicks Stop, the client POSTs to
 * `/api/chat/stop` first. The chat handler's `cancel()` consumes that flag
 * and aborts with `reason: { name: "StopRequested" }`. The for-await then
 * breaks instead of draining — Stop must halt glitched generations and tool
 * misuse, even at the cost of orphaning (the user explicitly chose to abort).
 *
 * This test reproduces the EntityTurn yield-then-persist pattern in isolation
 * and verifies that the break pattern orphans while the continue pattern
 * doesn't. Doesn't import EntityTurn directly — that pulls in the full
 * MCP/push/voice dependency tree (see tool_mutex_test.ts for the same
 * isolation pattern).
 */

import { assertEquals } from "@std/assert";

// ---------------------------------------------------------------------------
// Reproduce the EntityTurn tool-results yield/persist pattern
// ---------------------------------------------------------------------------

type MockMessage =
  | { role: "assistant"; tool_calls: Array<{ id: string; name: string }> }
  | { role: "tool"; tool_call_id: string; content: string };

type Chunk =
  | { type: "tool_call"; toolCall: { id: string; name: string } }
  | { type: "tool_result"; result: { toolCallId: string; content: string } };

/**
 * Mimics the relevant slice of EntityTurn.process():
 *   - assistant message persisted BEFORE any yield (current behavior)
 *   - tool_result yielded BEFORE the tool-result DB persist (the bug surface)
 * Mirrors loop.ts ~line 1220 (assistant persist) and ~line 1300-1360
 * (yield-then-persist in the tool-results for-of loop).
 */
async function* mockTurn(
  db: Map<string, MockMessage>,
  assistantKey: string,
  toolCallId: string,
): AsyncGenerator<Chunk, void, unknown> {
  // Assistant message with tool_calls — persisted first, before any yield.
  db.set(assistantKey, {
    role: "assistant",
    tool_calls: [{ id: toolCallId, name: "mock_tool" }],
  });

  // Simulate tool execution latency
  await new Promise((r) => setTimeout(r, 20));

  // Yield the tool result — suspension point where a consumer break
  // skips the persist below.
  yield {
    type: "tool_result",
    result: { toolCallId, content: "mock tool output" },
  };

  // Persist the tool result — runs only if consumer continues past the yield.
  db.set(`tool:${toolCallId}`, {
    role: "tool",
    tool_call_id: toolCallId,
    content: "mock tool output",
  });
}

/**
 * Drives `turn` with an abort that fires at `abortAfterMs`. Returns the db
 * and the list of forwarded chunks. Uses the consumer pattern passed in
 * `onChunk` — either "break" (old) or "continue" (new).
 */
async function driveTurn(
  mode: "break" | "continue",
  assistantKey: string,
  toolCallId: string,
  abortAfterMs: number,
): Promise<{
  db: Map<string, MockMessage>;
  forwarded: Chunk[];
  abortedAt: number;
}> {
  const db = new Map<string, MockMessage>();
  const forwarded: Chunk[] = [];
  const controller = new AbortController();
  const start = performance.now();

  const timer = setTimeout(() => controller.abort(), abortAfterMs);

  for await (const chunk of mockTurn(db, assistantKey, toolCallId)) {
    if (controller.signal.aborted) {
      if (mode === "break") break;
      continue;
    }
    forwarded.push(chunk);
  }

  clearTimeout(timer);
  return { db, forwarded, abortedAt: performance.now() - start };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

Deno.test({
  name: "OLD behavior (break on disconnect) orphans the tool result",
  // Reproduces the bug: assistant(tool_calls) is persisted, tool result is not.
  async fn() {
    // Abort at 5ms — before the yield at 20ms. When the yield suspends,
    // signal.aborted is already true; the OLD break pattern then triggers
    // generator.return() and the post-yield persist is skipped.
    const { db } = await driveTurn("break", "asst-1", "call_1", 5);

    assertEquals(
      db.has("asst-1"),
      true,
      "assistant message with tool_calls should be persisted",
    );
    assertEquals(
      db.has("tool:call_1"),
      false,
      "OLD behavior orphans the tool result (bug reproduced)",
    );
  },
});

Deno.test({
  name: "NEW behavior (continue on disconnect) does NOT orphan",
  // Verifies the fix: tool result persists because the generator drains.
  async fn() {
    const { db } = await driveTurn("continue", "asst-2", "call_2", 5);

    assertEquals(
      db.has("asst-2"),
      true,
      "assistant message with tool_calls should be persisted",
    );
    assertEquals(
      db.has("tool:call_2"),
      true,
      "NEW behavior persists the tool result — no orphan",
    );
  },
});

Deno.test({
  name: "NEW behavior: no chunks forwarded to disconnected client",
  // Confirms we're not just shipping chunks to a gone client.
  async fn() {
    const { forwarded, db } = await driveTurn(
      "continue",
      "asst-3",
      "call_3",
      5,
    );

    assertEquals(
      forwarded.length,
      0,
      "no chunks should be forwarded after disconnect",
    );
    assertEquals(
      db.has("tool:call_3"),
      true,
      "tool result should still persist",
    );
  },
});

Deno.test({
  name: "Stop button (reason='StopRequested') halts the turn",
  // The Stop button must actually stop glitched generations and tool misuse.
  // Differentiated from network disconnect via signal.reason — the chat
  // handler's cancel() sets reason name "StopRequested" when the client
  // POSTed to /api/chat/stop before disconnecting.
  async fn() {
    const db = new Map<string, MockMessage>();
    const controller = new AbortController();
    const forwarded: Chunk[] = [];

    const timer = setTimeout(() => {
      controller.abort(
        new DOMException("User requested stop", "StopRequested"),
      );
    }, 5);

    for await (const chunk of mockTurn(db, "asst-4", "call_4")) {
      if (controller.signal.aborted) {
        // Same branching as routes.ts: break on StopRequested, drain otherwise.
        if (controller.signal.reason?.name === "StopRequested") break;
        continue;
      }
      forwarded.push(chunk);
    }

    clearTimeout(timer);

    assertEquals(
      db.has("asst-4"),
      true,
      "assistant message with tool_calls was persisted before the disconnect",
    );
    assertEquals(
      db.has("tool:call_4"),
      false,
      "Stop must halt the turn — tool result should NOT persist",
    );
    assertEquals(
      forwarded.length,
      0,
      "no chunks forwarded after Stop",
    );
  },
});
