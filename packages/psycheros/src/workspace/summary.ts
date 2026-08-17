/**
 * Workspace Summary Distiller
 *
 * Compresses an OpenCode session transcript into a short summary (≤500 tokens)
 * for the entity's main context. The noisy details stay in the workspace; only
 * the summary flows back.
 *
 * Uses the worker LLM profile (per CLAUDE.md — worker is for lightweight tasks
 * like title generation and now workspace summaries).
 */

import type { ChatMessage } from "../llm/types.ts";
import type { LLMClient } from "../llm/client.ts";
import type { OpenCodeRunResult } from "./session.ts";

const SUMMARY_SYSTEM_PROMPT =
  `You are distilling a workspace session transcript into a short summary.
The entity who spawned this workspace will see only your summary in their main context — the noisy details stay in the workspace.

Produce a summary that lets the entity answer: what was accomplished, what artifacts or files were produced, what's the next step if any.

Format:
- One paragraph (2-4 sentences) of outcome description.
- Optionally a bulleted list of artifacts/files/links produced.
- Optionally a one-line "next step" if there's a clear one.

Keep it under 500 tokens. Be specific and concrete. Don't include chat-style narration of the workspace's process — just the result.`;

/**
 * Distill a workspace session result into a short summary for main context.
 * Falls back to the run's finalText if the LLM is unavailable.
 */
export async function distillSummary(
  run: OpenCodeRunResult,
  llm: LLMClient | null,
): Promise<string> {
  // Build the transcript excerpt we'll ask the LLM to summarize.
  const transcript = buildTranscriptExcerpt(run);

  // Fallback path: no LLM available, use finalText or a generic placeholder.
  if (!llm) {
    if (run.finalText) {
      return run.finalText.slice(0, 1500);
    }
    return run.ok
      ? "Workspace session completed. (Summary distillation unavailable — no worker LLM configured.)"
      : `Workspace session failed: ${run.error ?? "unknown error"}`;
  }

  try {
    const messages: ChatMessage[] = [
      { role: "system", content: SUMMARY_SYSTEM_PROMPT },
      { role: "user", content: transcript },
    ];
    let text = "";
    for await (const chunk of llm.chatStream(messages)) {
      if (chunk.type === "content") {
        text += chunk.content;
      }
    }
    const trimmed = text.trim();
    if (trimmed) return trimmed;
  } catch (err) {
    console.error("[workspace] summary distillation failed:", err);
  }

  // LLM call failed — fall back.
  return run.finalText ??
    (run.ok
      ? "Workspace session completed."
      : `Workspace session failed: ${run.error ?? "unknown error"}`);
}

/**
 * Build the transcript excerpt the LLM summarizes from. We don't pass the
 * entire raw event stream — that could be huge. Instead we extract the
 * meaningful narrative: assistant messages and tool-call summaries.
 */
function buildTranscriptExcerpt(run: OpenCodeRunResult): string {
  const lines: string[] = [];

  for (const event of run.rawEvents) {
    const text = extractEventText(event);
    if (text) {
      lines.push(text);
    }
  }

  if (lines.length === 0) {
    return run.finalText
      ? `(No structured events; final message):\n${run.finalText}`
      : "(Workspace produced no extractable output.)";
  }

  return lines.join("\n\n");
}

/**
 * Extract a human-readable text representation from an OpenCode event —
 * assistant text chunks, tool calls, tool results.
 */
function extractEventText(
  event: { type: string; [k: string]: unknown },
): string | null {
  switch (event.type) {
    // text events have part.text
    case "text":
    case "assistant":
    case "message": {
      const partText = (event as { part?: { text?: string } }).part?.text;
      const directText = (event as { text?: string }).text;
      const text = partText ?? directText;
      if (typeof text === "string" && text.trim()) return text;
      return null;
    }
    case "tool_call": {
      // Schema: { type: "tool_call", part: { name, args } } or top-level
      const part = (event as { part?: { name?: string; args?: unknown } }).part;
      const name = part?.name ?? (event as { name?: string }).name;
      const args = part?.args ?? (event as { args?: unknown }).args;
      return `[tool call: ${name ?? "unknown"}(${
        JSON.stringify(args ?? {}).slice(0, 200)
      })]`;
    }
    case "tool_result": {
      const part = (event as { part?: { result?: unknown } }).part;
      const result = part?.result ?? (event as { result?: unknown }).result;
      const text = typeof result === "string"
        ? result
        : JSON.stringify(result ?? "").slice(0, 300);
      return `[tool result: ${text}]`;
    }
    case "error": {
      const err = (event as { error?: { data?: { message?: string } } }).error;
      const msg = err?.data?.message;
      return msg ? `[error: ${msg}]` : null;
    }
    default:
      return null;
  }
}
