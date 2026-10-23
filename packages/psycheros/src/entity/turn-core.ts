/**
 * Turn core — the ONE agent-loop engine.
 *
 * The step both EntityTurn (episodic chat) and FluxSession (persistent
 * rolling context) drive: call model → execute tools → feed results →
 * continue, until the caller's policy says stop or the iteration budget
 * runs out. Loop-level behavior lives HERE once — retry on transient
 * provider errors, recovery for misrouted responses, the iteration
 * summary log — so the two surfaces can never drift apart again. Every
 * loop bug fixed once (the session's 8-budget, its one-shot LLM calls,
 * its missing misroute recovery) stays fixed for both.
 *
 * What the core deliberately does NOT know (the episodic-vs-persistent
 * split is architectural and stays at the callers' context layer):
 * - context assembly (turn builder / session window + parks)
 * - persistence (per-generation rows / one Ego row + session entries)
 * - presentation (SSE event shapes / timeline callbacks)
 *
 * PROVIDER-AGNOSTIC BY CONSTRUCTION: recovery is signature-based —
 * "finished tool_calls but nothing parsed," "no content but reasoning
 * present" — never model- or vendor-keyed. Any OpenAI-compatible
 * provider exhibiting a signature gets the same handling.
 *
 * First migration target: FluxSession (smaller, gains the most).
 * EntityTurn follows after the session run validates the core.
 */

import type { LLMClient } from "../llm/mod.ts";
import type { ChatMessage } from "../llm/types.ts";
import type { ToolCall, ToolDefinition } from "../types.ts";

// =============================================================================
// Types
// =============================================================================

/** One executed tool result, as the core sees it. metadata and
 * affectedRegions ride through opaquely — classic's tool results carry
 * image sidecars and UI-region hints the core stays ignorant of. */
export interface TurnCoreToolResult {
  toolCallId: string;
  content: string;
  isError?: boolean;
  metadata?: unknown;
  affectedRegions?: string[];
}

/** What one generation produced. */
export interface TurnCoreGeneration {
  content: string;
  thinking: string;
  toolCalls: ToolCall[];
  finishReason: string;
}

/** Per-chunk callbacks — presentation stays at the caller. */
export interface TurnCoreChunkHandlers {
  onThinking?(fragment: string): void;
  onContent?(fragment: string): void;
  onToolCall?(call: ToolCall): void;
}

/**
 * Message shaping — how the caller flavors the transcript the model
 * sees. Defaults are plain OpenAI shapes; classic passes timestamp
 * prefixes + reasoning threading, the session its own.
 */
export interface TurnCoreMessageShapers {
  /** The assistant turn-message pushed after each generation. */
  shapeAssistantMessage(
    gen: TurnCoreGeneration,
  ): ChatMessage;
  /** The tool-result message pushed per executed call. */
  shapeToolMessage(
    call: ToolCall,
    result: TurnCoreToolResult,
  ): ChatMessage;
}

export function plainAssistantMessage(gen: TurnCoreGeneration): ChatMessage {
  return {
    role: "assistant",
    content: gen.content.trim() || "",
    ...(gen.toolCalls.length > 0 ? { tool_calls: gen.toolCalls } : {}),
  };
}

export function plainToolMessage(
  _call: ToolCall,
  result: TurnCoreToolResult,
): ChatMessage {
  return {
    role: "tool",
    tool_call_id: result.toolCallId,
    content: result.content,
  };
}

/** The core's outcome for the caller's post-loop policies. */
export interface TurnCoreOutcome {
  /** All spoken content, iteration fragments joined by blank lines. */
  spoke: string;
  /** All reasoning, concatenated. */
  thought: string;
  /** Every executed call this turn (in execution order). */
  toolCalls: ToolCall[];
  /** True when the iteration budget ran out (vs. a policy break). */
  exhausted: boolean;
  /** True when the loop guard ended the turn: a tool call with identical
   *  arguments failed 3× consecutively (schema/validation mismatch the
   *  model couldn't self-correct). */
  loopGuard?: boolean;
  /** How many generations ran. */
  iterations: number;
  /** The error that killed the final generation attempt, when every
   * retry failed (classic re-throws after persisting what it had). */
  lastError?: Error;
}

export interface TurnCoreConfig {
  client: LLMClient;
  /** Iteration budget (classic's DEFAULT_MAX_TOOL_ITERATIONS parity). */
  maxIterations: number;
  /** Tool definitions, re-resolved each iteration (skills index etc.). */
  toolDefs: () =>
    | ToolDefinition[]
    | Promise<ToolDefinition[] | undefined>
    | undefined;
  /**
   * Execute one batch of calls. The core appends the assistant message
   * and each result to `messages`; the caller does its own persistence
   * and presentation inside its handlers/policies.
   */
  executeTools: (
    calls: ToolCall[],
  ) => Promise<TurnCoreToolResult[]>;
  /** Transient-error retry (provider hiccups). Classic parity: 3×3s.
   * `expectedFinishReasons` + `onRetry` carry classic's retry-on-bad-
   * finish behavior: an unexpected finish with NOTHING produced retries
   * (the "Upstream connection lost" path); onRetry surfaces each retry
   * so classic can emit its status event. */
  retry?: {
    maxAttempts: number;
    delayMs: number;
    expectedFinishReasons?: Set<string>;
    onRetry?: (attempt: number, maxAttempts: number, reason: string) => void;
  };
  /** Per-iteration chatStream options — classic passes its metrics
   * collector; the core stays ignorant of what's inside. */
  chatOptions?: () => Record<string, unknown>;
  /** Misroute recovery promoted reasoning to content — classic emits
   * thinking_corrected so the live UI resets its thinking section. */
  onReasoningPromoted?: (thinking: string, content: string) => void;
  /**
   * Signature-based misroute recovery, per generation:
   * - "finished tool_calls, nothing parsed, nothing said" → retry the
   *   generation once (a second empty in a row is honest silence).
   * - "finish=stop, no content, no tool calls, reasoning present" →
   *   promote the reasoning to content on the final boundary marker
   *   (recovery semantics from EntityTurn; provider-agnostic by
   *   construction). Thinking + tool_calls + no content is NOT this —
   *   it is the normal mid-tool-turn shape and must never be promoted.
   */
  misroute?: { maxRetries: number };
  chunkHandlers?: TurnCoreChunkHandlers;
  /** Flavor the transcript messages (defaults: plain OpenAI shapes). */
  shapers?: TurnCoreMessageShapers;
  /**
   * Intra-turn persistent reasoning, as ONE shared implementation:
   * when true, the
   * default assistant shaper attaches each generation's thinking to its
   * tool_calls message so the model's chain continues across tool
   * results. Callers pass the LLM client's resolved
   * persistentReasoningIntraTurn — providers that reject
   * reasoning_content on assistant messages get it omitted, exactly as
   * classic's EntityTurn handles the same tri-state. Custom shapers
   * override this entirely.
   */
  threadReasoning?: boolean;
  /**
   * The caller's policy voice, called after each generation with the
   * generation's result. Return "break" to end the loop (the caller
   * has already done its side effects), "continue" to proceed to tool
   * execution. Called BEFORE tool execution so the caller can intercept
   * calls (the session's sleep park) — intercepted calls must be
   * filtered out of `gen.toolCalls` in place if they must not execute.
   */
  afterGeneration?: (
    iter: number,
    gen: TurnCoreGeneration,
  ) => "break" | "continue";
  /** Result of a tool batch — e.g. classic's held-skills context splice. */
  afterToolBatch?: (results: TurnCoreToolResult[]) => void;
  /** One clean summary line per iteration (replaces the old TRACE flood). */
  onIterationSummary?(
    iter: number,
    gen: TurnCoreGeneration,
    executedCount: number,
  ): void;
}

// =============================================================================
// The engine
// =============================================================================

const DEFAULT_SHAPERS: TurnCoreMessageShapers = {
  shapeAssistantMessage: plainAssistantMessage,
  shapeToolMessage: plainToolMessage,
};

/** Sleep helper for retry delays. */
const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Boundary markers for reasoning-to-content promotion (any provider's
 * convention — split at the LAST one so late content survives). */
const REASONING_BOUNDARIES = [
  "</thinking>",
  "</thought>",
  "</reasoning>",
  "</antml:thinking>",
];

/**
 * Signature: the response routed everything into the reasoning field
 * and delivered no content. Recovery: keep the final marker's tail as
 * content; if no marker, the whole reasoning becomes content (the
 * caller decides whether that is speech — often it is the reply).
 */
export function recoverMisroutedContent(
  thinking: string,
  content: string,
): string | null {
  if (content.trim() || !thinking.trim()) return null;
  for (const marker of REASONING_BOUNDARIES) {
    const idx = thinking.lastIndexOf(marker);
    if (idx !== -1) {
      const tail = thinking.slice(idx + marker.length).trim();
      if (tail) return tail;
    }
  }
  return thinking.trim();
}

/**
 * Classic-parity misroute split (EntityTurn's recovery, verbatim
 * semantics): a reasoning-only response with boundary markers splits at
 * the LAST marker — thinking part stays thinking, the reply tail
 * promotes to content. No marker + finish=stop promotes the whole
 * reasoning. Anything else returns null (stay thinking).
 */
export function splitMisroutedResponse(
  thinking: string,
  finishReason: string,
): { thinking: string; content: string } | null {
  for (const marker of REASONING_BOUNDARIES) {
    const idx = thinking.lastIndexOf(marker);
    if (idx !== -1) {
      const content = thinking.slice(idx + marker.length);
      if (content.trim()) {
        return { thinking: thinking.slice(0, idx + marker.length), content };
      }
      // Marker but no reply after it — nothing to recover.
      return null;
    }
  }
  if (finishReason === "stop") {
    return { thinking: "", content: thinking };
  }
  return null;
}

/**
 * Run the shared agent loop. `messages` is mutated in place — the
 * caller keeps the transcript for its endgame/parks after the loop.
 */
export async function runAgentLoop(
  messages: ChatMessage[],
  config: TurnCoreConfig,
): Promise<TurnCoreOutcome> {
  const {
    client,
    maxIterations,
    toolDefs,
    executeTools,
    retry = { maxAttempts: 3, delayMs: 3000 },
    chatOptions,
    onReasoningPromoted,
    misroute = { maxRetries: 1 },
    chunkHandlers = {},
    shapers = DEFAULT_SHAPERS,
    threadReasoning = false,
    afterGeneration,
    afterToolBatch,
    onIterationSummary,
  } = config;
  const customShapers = config.shapers !== undefined;

  let spoke = "";
  let thought = "";
  const executedCalls: ToolCall[] = [];
  let policyBroke = false;
  let iter = 0;
  let misrouteStreak = 0;
  let fatal: Error | null = null;

  // Repeated-failure loop guard: when
  // a tool's schema never told the model what's required, the model
  // retries the IDENTICAL failing call verbatim — same context + same
  // error = same "fix," forever, until the user aborts. Three
  // consecutive identical failing calls ends the turn with an
  // explanation instead.
  const failStreakByKey = new Map<string, number>();
  let loopGuard = false;

  while (iter < maxIterations) {
    let gen: TurnCoreGeneration | null = null;
    let lastError: Error | null = null;

    // -- One generation, with transient-error retry -------------------
    const expectedFinishes = retry.expectedFinishReasons ??
      new Set(["stop", "tool_calls", "length"]);
    for (let attempt = 1; attempt <= retry.maxAttempts; attempt++) {
      const g: TurnCoreGeneration = {
        content: "",
        thinking: "",
        toolCalls: [],
        finishReason: "stop",
      };
      try {
        const defs = await toolDefs();
        for await (
          const chunk of client.chatStream(
            messages,
            defs,
            chatOptions?.() as never,
          )
        ) {
          if (chunk.type === "thinking") {
            g.thinking += chunk.content;
            chunkHandlers.onThinking?.(chunk.content);
          } else if (chunk.type === "content") {
            g.content += chunk.content;
            chunkHandlers.onContent?.(chunk.content);
          } else if (chunk.type === "tool_call") {
            g.toolCalls.push(chunk.toolCall);
            // The chunk-level handler fires as the call streams — the
            // event adapter surfaces it live (classic's tool card never
            // rendered without this).
            chunkHandlers.onToolCall?.(chunk.toolCall);
          } else if (chunk.type === "done") {
            g.finishReason = chunk.finishReason;
          }
        }
        // Fall through to the finish-reason check below — do NOT break
        // here: an early `gen = g; break;` in the try block makes the
        // retryable-finish recovery unreachable (empty unexpected
        // finishes never retried).
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (attempt < retry.maxAttempts) {
          retry.onRetry?.(attempt, retry.maxAttempts, "stream_error");
          await delay(retry.delayMs);
        }
        continue;
      }
      // Retryable finish: unexpected finish_reason with NOTHING produced
      // (classic's "upstream connection lost" retry).
      const producedNothing = !g.content.trim() && g.toolCalls.length === 0 &&
        !g.thinking.trim();
      if (
        !expectedFinishes.has(g.finishReason) && producedNothing &&
        attempt < retry.maxAttempts
      ) {
        retry.onRetry?.(
          attempt,
          retry.maxAttempts,
          `finish_reason=${g.finishReason}`,
        );
        await delay(retry.delayMs);
        continue;
      }
      gen = g;
      break;
    }

    if (!gen) {
      // Every attempt failed — the caller's no-speech policies apply.
      console.warn(
        `[TurnCore] generation failed after ${retry.maxAttempts} attempts: ${
          lastError?.message ?? "unknown"
        }`,
      );
      fatal = lastError;
      break;
    }

    // -- Misroute signature 1: finished tool_calls, nothing parsed -----
    if (
      gen.toolCalls.length === 0 && !gen.content.trim() &&
      gen.finishReason === "tool_calls" && misrouteStreak < misroute.maxRetries
    ) {
      misrouteStreak++;
      console.warn(
        `[TurnCore] iter=${iter}: tool_calls finish with nothing parsed (misroute signature) — retrying generation`,
      );
      continue; // re-run the generation; messages unchanged
    }
    if (gen.toolCalls.length > 0 || gen.content.trim()) misrouteStreak = 0;

    // A completed generation counts now — break paths below keep it.
    iter++;

    // -- Misroute signature 2: reasoning-only response -----------------
    // STRICTLY a finish=stop generation with NO content and NO tool
    // calls — the reply routed entirely into the reasoning field. A
    // thinking + tool_calls generation with no content is the NORMAL
    // mid-tool-turn shape for reasoning-native models: its thinking
    // stays thinking (promoting it verbatim into speech leaks the whole
    // reasoning block into the message).
    if (
      gen.toolCalls.length === 0 && !gen.content.trim() && gen.thinking.trim()
    ) {
      // Classic's full recovery semantics: boundary-split keeps the
      // thinking part as thinking and promotes only the reply; no marker
      // + stop finish promotes the whole reasoning (thinking may be
      // mixed in); any other finish keeps everything as thinking —
      // promoting partial thinking would invent a reply.
      const split = splitMisroutedResponse(gen.thinking, gen.finishReason);
      if (split) {
        gen.content = split.content;
        gen.thinking = split.thinking;
        chunkHandlers.onContent?.(split.content);
        onReasoningPromoted?.(gen.thinking, gen.content);
      }
    }

    thought += gen.thinking;
    if (gen.content.trim()) {
      spoke += (spoke ? "\n\n" : "") + gen.content.trim();
    }

    onIterationSummary?.(iter - 1, gen, gen.toolCalls.length);

    // -- The caller's policy voice (sleep parks, end_flux, silence) ---
    if (afterGeneration?.(iter - 1, gen) === "break") {
      policyBroke = true;
      break;
    }

    if (gen.toolCalls.length === 0) {
      policyBroke = true;
      break; // natural end — the model said its piece
    }

    // -- Tool batch -----------------------------------------------------
    messages.push(
      threadReasoning && !customShapers
        ? {
          role: "assistant" as const,
          content: gen.content.trim() || "",
          tool_calls: gen.toolCalls,
          // The chain continues across the tool result — thinking rides
          // the message that made the call (shared implementation of
          // classic's intra-turn persistent reasoning).
          ...(gen.thinking.trim() ? { reasoning_content: gen.thinking } : {}),
        }
        : shapers.shapeAssistantMessage(gen),
    );
    const results = await executeTools(gen.toolCalls);
    for (let i = 0; i < gen.toolCalls.length; i++) {
      const call = gen.toolCalls[i];
      const r = results.find((x) => x.toolCallId === call.id) ??
        { toolCallId: call.id, content: "(tool unavailable)" };
      messages.push(shapers.shapeToolMessage(call, r));
      executedCalls.push(call);

      // Loop-guard streak: same call (name + exact arguments) failing
      // consecutively. Success or any variation resets the key.
      const key = `${call.function.name}|${call.function.arguments}`;
      if ((r as { isError?: boolean }).isError) {
        const streak = (failStreakByKey.get(key) ?? 0) + 1;
        failStreakByKey.set(key, streak);
        if (streak >= 3) {
          console.warn(
            `[TurnCore] loop guard: ${call.function.name} failed ${streak}× ` +
              `with identical arguments — ending the turn`,
          );
          messages.push({
            role: "system",
            content:
              `[Tool loop guard] The call to ${call.function.name} with ` +
              `identical arguments failed ${streak} times this turn — I am ` +
              `stopping my retries here rather than repeat the mistake.`,
          });
          loopGuard = true;
        }
      } else {
        failStreakByKey.delete(key);
      }
    }
    afterToolBatch?.(results);
    if (loopGuard) break;
  }

  // Exhausted = the budget ran out naturally. A policy break on the
  // very last iteration must not read as exhaustion (the caller's
  // no-speech endgame is for budget death, not chosen stops).
  const exhausted = iter >= maxIterations && !policyBroke;

  return {
    spoke,
    thought,
    toolCalls: executedCalls,
    exhausted,
    iterations: iter,
    ...(loopGuard ? { loopGuard: true } : {}),
    ...(fatal ? { lastError: fatal } : {}),
  };
}

// =============================================================================
// Event adapter — the generator surface
// =============================================================================

/** Everything the loop can emit, as a stream. Classic's generator yields
 * these straight through (SSE parity with its old inline loop); the
 * session maps them onto its callbacks. One engine, two consumption
 * styles. */
export type TurnCoreEvent =
  | { type: "thinking"; content: string }
  | { type: "content"; content: string }
  | { type: "tool_call"; toolCall: ToolCall }
  | { type: "retry"; attempt: number; maxAttempts: number; reason: string }
  | {
    type: "reasoning_promoted";
    thinking: string;
    content: string;
  }
  /** A settled generation, BEFORE its tool batch executes — classic
   * persists its row, finalizes metrics, and emits done here. */
  | { type: "generation"; gen: TurnCoreGeneration }
  /** A tool batch executed — results pair with the generation's calls. */
  | { type: "tool_results"; results: TurnCoreToolResult[] }
  | { type: "outcome"; outcome: TurnCoreOutcome };

/**
 * Drive the core as an async generator. Events stream as they happen
 * (the run continues while the consumer processes each yield); the
 * final event carries the outcome. Caller chunkHandlers/retry
 * callbacks are composed in — events flow regardless.
 */
export async function* runAgentLoopEvents(
  messages: ChatMessage[],
  config: TurnCoreConfig,
): AsyncGenerator<TurnCoreEvent> {
  const queue: TurnCoreEvent[] = [];
  let notify: (() => void) | null = null;
  let closed = false;
  const push = (ev: TurnCoreEvent) => {
    queue.push(ev);
    notify?.();
    notify = null;
  };

  const userChunks = config.chunkHandlers ?? {};
  const userRetry = config.retry;
  const userAfterGen = config.afterGeneration;

  void runAgentLoop(messages, {
    ...config,
    chunkHandlers: {
      onThinking: (c) => {
        push({ type: "thinking", content: c });
        userChunks.onThinking?.(c);
      },
      onContent: (c) => {
        push({ type: "content", content: c });
        userChunks.onContent?.(c);
      },
      onToolCall: (call) => {
        push({ type: "tool_call", toolCall: call });
        userChunks.onToolCall?.(call);
      },
    },
    retry: userRetry
      ? {
        ...userRetry,
        onRetry: (attempt, maxAttempts, reason) => {
          push({ type: "retry", attempt, maxAttempts, reason });
          userRetry.onRetry?.(attempt, maxAttempts, reason);
        },
      }
      : undefined,
    onReasoningPromoted: (thinking, content) => {
      push({ type: "reasoning_promoted", thinking, content });
      config.onReasoningPromoted?.(thinking, content);
    },
    afterGeneration: (i, gen) => {
      push({ type: "generation", gen });
      return userAfterGen?.(i, gen) ?? "continue";
    },
    afterToolBatch: (results) => {
      push({ type: "tool_results", results });
      config.afterToolBatch?.(results);
    },
  }).then((outcome) => {
    push({ type: "outcome", outcome });
    closed = true;
    notify?.();
    notify = null;
  }).catch((error) => {
    // The core catches per-generation errors; reaching here means a
    // caller hook threw. Surface as a failed outcome.
    push({
      type: "outcome",
      outcome: {
        spoke: "",
        thought: "",
        toolCalls: [],
        exhausted: false,
        iterations: 0,
        lastError: error instanceof Error ? error : new Error(String(error)),
      },
    });
    closed = true;
    notify?.();
    notify = null;
  });

  while (true) {
    while (queue.length > 0) {
      yield queue.shift()!;
    }
    if (closed) return;
    await new Promise<void>((resolve) => {
      notify = resolve;
    });
  }
}
