/**
 * Tests for token-budget.ts — context window trimming, with focus on the
 * two-pass reasoning-strip algorithm.
 *
 * The two-pass trim is the load-bearing change: when a message with
 * `reasoning_content` doesn't fit as-is, we retry without its reasoning
 * before dropping the message outright. These tests verify each branch of
 * that walk plus the post-sanitization recompute of `reasoningStripped`
 * and `reasoningRetained`.
 *
 * Token math uses CHARS_PER_TOKEN = 3.5 and MESSAGE_OVERHEAD_TOKENS = 4
 * (both from token-budget.ts). Budget formula:
 *   availableBudget = contextLength - maxTokens - floor(contextLength * 0.05) - systemTokens - toolTokens
 */

import { assert, assertEquals } from "@std/assert";
import { applyContextBudget } from "../src/entity/token-budget.ts";
import type { ChatMessage } from "../src/llm/types.ts";
import type { ToolCall, ToolDefinition } from "../src/types.ts";

const NO_TOOLS: ToolDefinition[] = [];

/** Build an N-char padding string for predictable token estimates. */
function pad(n: number): string {
  return "x".repeat(n);
}

function user(content: string): ChatMessage {
  return { role: "user", content };
}

function assistant(
  content: string,
  opts?: { reasoning?: string; toolCalls?: ToolCall[] },
): ChatMessage {
  const msg: ChatMessage = { role: "assistant", content };
  if (opts?.reasoning !== undefined) msg.reasoning_content = opts.reasoning;
  if (opts?.toolCalls) msg.tool_calls = opts.toolCalls;
  return msg;
}

function tool(content: string, toolCallId: string): ChatMessage {
  return { role: "tool", content, tool_call_id: toolCallId };
}

function system(content = "system"): ChatMessage {
  return { role: "system", content };
}

// =============================================================================
// Happy path — no budget pressure
// =============================================================================

Deno.test("token budget: all reasoning retained when budget fits", () => {
  const messages: ChatMessage[] = [
    system(),
    user("hello"),
    assistant("hi there", { reasoning: pad(700) }),
    user("goodbye"),
  ];

  const result = applyContextBudget(messages, NO_TOOLS, 100000, 1000);

  assertEquals(result.reasoningStripped, 0);
  assertEquals(result.reasoningRetained, 1);
  assertEquals(result.messages.length, 4);
  const kept = result.messages.find((m) => m.role === "assistant")!;
  assertEquals(kept.reasoning_content, pad(700));
});

// =============================================================================
// Two-pass trim — single message stripped, message retained
// =============================================================================

Deno.test("token budget: strips reasoning from one message to fit budget", () => {
  // Budget math:
  //   user "hi"           = 5 tokens (2 chars / 3.5 + 4 overhead)
  //   assistant content   = 5 tokens (1 char + overhead)
  //   assistant reasoning = pad(700) = ceil(700/3.5) = 200 tokens
  //   assistant full      = 205, stripped = 5
  //
  //   availableBudget = 15:
  //     contextLength=100, maxTokens=74, safetyMargin=5, systemTokens=6
  //     → 100 - 74 - 5 - 6 = 15
  //
  // Walk newest→oldest:
  //   user2 (last): always kept → historyTokens=5
  //   assistant full=205 > 15-5=10 → doesn't fit. Try stripped=5: 5+5=10 ≤ 15 → strip & keep.
  //   user1: 10+5=15 ≤ 15 → keep.
  const messages: ChatMessage[] = [
    system(),
    user("hi"),
    assistant("x", { reasoning: pad(700) }),
    user("hi"),
  ];

  const result = applyContextBudget(messages, NO_TOOLS, 100, 74);

  assertEquals(result.reasoningStripped, 1);
  assertEquals(result.reasoningRetained, 0);
  assertEquals(result.messages.length, 4);
  const kept = result.messages.find((m) => m.role === "assistant")!;
  assertEquals(kept.reasoning_content, undefined);
  assertEquals(kept.content, "x");
});

// =============================================================================
// Two-pass trim — message dropped when stripped still doesn't fit
// =============================================================================

Deno.test("token budget: drops message when stripped still doesn't fit", () => {
  // availableBudget = 3 (less than stripped assistant cost of 5):
  //   contextLength=100, maxTokens=86, safetyMargin=5, systemTokens=6
  //   → 100 - 86 - 5 - 6 = 3
  //
  // Walk:
  //   user2 (last): kept. historyTokens=5.
  //   assistant stripped=5 > 3 - 5 < 0 → doesn't fit even stripped → break.
  const messages: ChatMessage[] = [
    system(),
    user("hi"),
    assistant("x", { reasoning: pad(700) }),
    user("hi"),
  ];

  const result = applyContextBudget(messages, NO_TOOLS, 100, 86);

  assertEquals(result.reasoningStripped, 0);
  assertEquals(result.reasoningRetained, 0);
  assertEquals(result.messages.length, 2);
  assertEquals(result.messages[0].role, "system");
  assertEquals(result.messages[1].role, "user");
});

// =============================================================================
// Two-pass trim — tool-call cascade survived
// =============================================================================

Deno.test("token budget: tool chain intact when assistant stripped not dropped", () => {
  // Without two-pass, dropping an assistant-with-tool_calls orphans the
  // tool result and the preceding user message via sanitization. With
  // two-pass, the assistant survives (just without reasoning) so the
  // tool chain stays intact.
  const toolCall: ToolCall = {
    id: "c1",
    type: "function",
    function: { name: "get_weather", arguments: '{"city":"sf"}' },
  };

  const messages: ChatMessage[] = [
    system(),
    user("weather?"),
    assistant("checking", { reasoning: pad(700), toolCalls: [toolCall] }),
    tool('{"temp":"60f"}', "c1"),
    user("thanks"),
  ];

  // Budget: availableBudget = 60
  //   contextLength=100, maxTokens=29, safetyMargin=5, systemTokens=6
  //   → 100 - 29 - 5 - 6 = 60
  //
  // Walking newest→oldest on [user1, assistant, tool_result, user2]:
  //   user2 (last, always kept): 6 tokens
  //   tool_result: ~9 tokens → 15 total
  //   assistant full = 3 (content) + 200 (reasoning) + 23 (tool_calls JSON) + 4 = 230
  //     15 + 230 = 245 > 60 → doesn't fit. Try stripped = 30: 15+30=45 ≤ 60 → strip & keep.
  //   user1 "weather?" = 7 tokens: 45+7=52 ≤ 60 → keep.
  const result = applyContextBudget(messages, NO_TOOLS, 100, 29);

  // Tool chain survived: user1, assistant, tool, user2 all in the output.
  assertEquals(result.messages.length, 5);
  assertEquals(result.messages[2].role, "assistant");
  assertEquals(result.messages[3].role, "tool");
  assertEquals(result.messages[4].role, "user");
  assertEquals(result.messages[2].reasoning_content, undefined);
  assert(result.messages[2].tool_calls !== undefined);
  assertEquals(result.reasoningStripped, 1);
});

// =============================================================================
// Edge case — empty reasoning_content is a no-op
// =============================================================================

Deno.test("token budget: empty reasoning_content is treated as no reasoning", () => {
  const messages: ChatMessage[] = [
    system(),
    user("hi"),
    assistant("hello", { reasoning: "" }),
    user("bye"),
  ];

  const result = applyContextBudget(messages, NO_TOOLS, 100000, 1000);

  // Empty reasoning: never stripped (falsy guard), never retained (falsy).
  assertEquals(result.reasoningStripped, 0);
  assertEquals(result.reasoningRetained, 0);
});

// =============================================================================
// Recompute — stripped message dropped by cleanup isn't counted
// =============================================================================

Deno.test("token budget: stripped message dropped by cleanup isn't counted", () => {
  // Construct a case where the walk strips an assistant message but the
  // cleanup loop (drop leading non-user messages) then shifts it out
  // because its preceding user was FIFO'd.
  //
  // Walk: user2 kept, tool kept, assistant kept (stripped), user1 doesn't fit.
  // trimmedHistory = [assistant(stripped), tool, user2].
  // Cleanup drops leading non-user → drops assistant, drops tool, stops at user2.
  // Final: [system, user2].
  //
  // reasoningStripped must be 0 — the stripped ref isn't in the final
  // output. This validates the post-sanitization recompute.
  const toolCall: ToolCall = {
    id: "c1",
    type: "function",
    function: { name: "f", arguments: "{}" },
  };
  const messages: ChatMessage[] = [
    system(),
    user(pad(500)),
    assistant("x", { reasoning: pad(700), toolCalls: [toolCall] }),
    tool("r", "c1"),
    user("hi"),
  ];

  // Budget tuned so user2 + tool + stripped_assistant fit, but user1 doesn't.
  // availableBudget = 56: contextLength=100, maxTokens=33, safetyMargin=5,
  // systemTokens=6 → 100 - 33 - 5 - 6 = 56.
  //
  // user1 = pad(500) = 143 tokens + 4 overhead = 147. After walk through
  // user2 (5) + tool (6) + stripped assistant (~20) = 31, adding user1's
  // 147 gives 178 > 56 → break. user1 FIFO'd. Cleanup then drops the
  // stripped assistant and the tool because they're now leading non-user
  // messages. The stripped ref is no longer in the final output, so
  // reasoningStripped must be 0.
  const result = applyContextBudget(messages, NO_TOOLS, 100, 33);

  assertEquals(
    result.reasoningStripped,
    0,
    "stripped-but-dropped shouldn't count",
  );
  assertEquals(result.reasoningRetained, 0);
  assertEquals(result.messages.length, 2);
  assertEquals(result.messages[1].role, "user");
  assertEquals(result.messages[1].content, "hi");
});

// =============================================================================
// Zero budget — early return
// =============================================================================

Deno.test("token budget: zero budget returns system + last user only", () => {
  // availableBudget = -6 (≤ 0):
  //   contextLength=100, maxTokens=95, safetyMargin=5, systemTokens=6
  //   → 100 - 95 - 5 - 6 = -6
  const messages: ChatMessage[] = [
    system(),
    user("hi"),
    assistant("hello", { reasoning: pad(700) }),
    user("bye"),
  ];

  const result = applyContextBudget(messages, NO_TOOLS, 100, 95);

  assertEquals(result.messages.length, 2);
  assertEquals(result.messages[0].role, "system");
  assertEquals(result.messages[1].role, "user");
  assertEquals(result.messages[1].content, "bye");
  assertEquals(result.reasoningStripped, 0);
  assertEquals(result.reasoningRetained, 0);
});
