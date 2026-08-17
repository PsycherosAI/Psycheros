/**
 * Workspace Transcript — Live Streaming (SSE, ephemeral)
 *
 * As OpenCode runs, each meaningful event in its stdout stream is broadcast
 * via the Psycheros SSE channel (`/api/events`) to any open workspace window.
 * The user can click the `>_` FAB and watch the entity↔OpenCode exchange
 * unfold in real time, instead of seeing it appear all at once after the
 * session completes.
 *
 * Ephemeral principle: workspace transcript is NOT stored in the `messages`
 * table. Events go to live SSE only. The load-bearing artifacts (briefing,
 * summary, status) live in `workspace_sessions`.
 *
 * Per-event scope:
 *   - `text` events → one assistant message each
 *   - `tool_use` events → one assistant message with tool name + args + status
 *   - `tool_result` events → one assistant message with the result
 *   - `error` events → one assistant message with the error text
 *   - `step_start` / `step_finish` / others → skipped (noise)
 */

import { getBroadcaster } from "../server/broadcaster.ts";
import type { OpenCodeEvent } from "./session.ts";

/**
 * Convert a single OpenCode event into a message to write to the workspace
 * conversation, or null if the event should be skipped (noise like
 * step_start/step_finish).
 */
export function streamEventToMessage(
  event: OpenCodeEvent,
): { role: "assistant"; content: string } | null {
  const type = event.type;
  const part = (event as { part?: Record<string, unknown> }).part;

  if (type === "text") {
    const text = (part as { text?: string } | undefined)?.text ??
      (event as { text?: string }).text;
    if (typeof text === "string" && text.trim()) {
      return { role: "assistant", content: text };
    }
    return null;
  }

  if (type === "tool_use" || type === "tool_call" || type === "tool-call") {
    const toolName = (part as { tool?: string } | undefined)?.tool ??
      (part as { name?: string } | undefined)?.name ??
      (event as { name?: string }).name;
    const state = (part as {
      state?: { status?: string; input?: unknown; error?: string };
    } | undefined)?.state;
    const args = state?.input ??
      (part as { args?: unknown } | undefined)?.args ??
      (event as { args?: unknown }).args;
    const argsStr = typeof args === "object"
      ? JSON.stringify(args ?? {}).slice(0, 200)
      : String(args ?? "").slice(0, 200);
    const status = state?.status;
    const err = state?.error;
    if (status === "error") {
      return {
        role: "assistant",
        content: `[tool ${toolName ?? "unknown"} FAILED: ${
          err ?? "unknown error"
        }]`,
      };
    }
    return {
      role: "assistant",
      content: `[tool ${toolName ?? "unknown"}(${argsStr})]`,
    };
  }

  if (type === "tool_result" || type === "tool-result") {
    const result = (part as { result?: unknown } | undefined)?.result ??
      (event as { result?: unknown }).result;
    const resultStr = typeof result === "string"
      ? result
      : JSON.stringify(result ?? "").slice(0, 300);
    return {
      role: "assistant",
      content: `[tool result: ${resultStr}]`,
    };
  }

  if (type === "error") {
    const err = (event as { error?: { data?: { message?: string } } }).error;
    const msg = err?.data?.message ?? JSON.stringify(event.error ?? "");
    return {
      role: "assistant",
      content: `[error: ${msg}]`,
    };
  }

  return null;
}

/**
 * Build the terminal status marker message written at the end of a workspace
 * session. Only written for non-complete or errored sessions — successful
 * completion is implicit from the session status badge in the UI.
 */
export function terminalStatusMessage(
  status: "complete" | "failed" | "cancelled",
  error?: string,
): { role: "assistant"; content: string } | null {
  if (status === "complete" && !error) return null;
  return {
    role: "assistant",
    content: `[workspace ${status}${error ? `: ${error}` : ""}]`,
  };
}

/**
 * Convert a single OpenCode event into a terminal-line descriptor for the
 * live terminal view, or null if the event should be skipped (noise).
 *
 * `kind` drives the client-side rendering:
 *   - text        → streaming output line
 *   - tool        → dim tool-invocation line (`$ tool args`)
 *   - tool_result → indented dim output block
 *   - error       → red error line
 */
export function streamEventToTerminalLine(
  event: OpenCodeEvent,
): {
  kind: "text" | "tool" | "tool_result" | "error";
  tool?: string;
  content: string;
} | null {
  const type = event.type;
  const part = (event as { part?: Record<string, unknown> }).part;

  if (type === "text") {
    const text = (part as { text?: string } | undefined)?.text ??
      (event as { text?: string }).text;
    if (typeof text === "string" && text.trim()) {
      return { kind: "text", content: text };
    }
    return null;
  }

  if (type === "tool_use" || type === "tool_call" || type === "tool-call") {
    const toolName = (part as { tool?: string } | undefined)?.tool ??
      (part as { name?: string } | undefined)?.name ??
      (event as { name?: string }).name;
    const state = (part as {
      state?: { status?: string; input?: unknown; error?: string };
    } | undefined)?.state;
    const args = state?.input ??
      (part as { args?: unknown } | undefined)?.args ??
      (event as { args?: unknown }).args;
    const argsStr = typeof args === "object"
      ? JSON.stringify(args ?? {}).slice(0, 200)
      : String(args ?? "").slice(0, 200);
    if (state?.status === "error") {
      return {
        kind: "error",
        tool: toolName,
        content: `tool ${toolName ?? "unknown"} FAILED: ${
          state.error ?? "unknown error"
        }`,
      };
    }
    return { kind: "tool", tool: toolName, content: argsStr };
  }

  if (type === "tool_result" || type === "tool-result") {
    const result = (part as { result?: unknown } | undefined)?.result ??
      (event as { result?: unknown }).result;
    const resultStr = typeof result === "string"
      ? result
      : JSON.stringify(result ?? "").slice(0, 300);
    return { kind: "tool_result", content: resultStr };
  }

  if (type === "error") {
    const err = (event as { error?: { data?: { message?: string } } }).error;
    const msg = err?.data?.message ?? JSON.stringify(event.error ?? "");
    return { kind: "error", content: msg };
  }

  return null;
}

/**
 * Broadcast the entity's engaged-mode turn to the terminal view. The entity
 * is OpenCode's user, so its turns render as input lines — with the entity's
 * name in the accent color so it's easy to tell when the entity itself is
 * acting versus when OpenCode is grinding.
 */
export function broadcastWorkspaceEntityTurn(
  conversationId: string,
  entityName: string,
  text: string,
): void {
  if (!text.trim()) return;
  try {
    getBroadcaster().broadcastEvent(
      "workspace_event",
      {
        conversationId,
        kind: "entity",
        entityName,
        content: text.trim(),
      },
      conversationId,
    );
  } catch (err) {
    console.error("[workspace] SSE broadcast failed (entity turn):", err);
  }
}

/**
 * Broadcast a single workspace event to any open workspace window via SSE.
 *
 * Formats the event into a message payload (or returns early if the event
 * should be skipped), then sends a `workspace_event` SSE event scoped to the
 * workspace conversation. The client-side workspace.js listens for these and
 * renders them as live transcript DOM additions when the window is open.
 *
 * Per the ephemeral principle: nothing is written to the DB. The event lives
 * only in the SSE stream — once broadcast, it's gone (unless the client is
 * actively capturing it in the DOM).
 */
export function broadcastWorkspaceEvent(
  conversationId: string,
  event: OpenCodeEvent,
): void {
  const msg = streamEventToMessage(event);
  if (!msg) return;
  // Terminal-line descriptor rides alongside the legacy role/content shape so
  // the terminal view can render tool lines, results, and errors distinctly.
  const line = streamEventToTerminalLine(event);
  try {
    getBroadcaster().broadcastEvent(
      "workspace_event",
      {
        conversationId,
        role: msg.role,
        content: msg.content,
        ...(line
          ? { kind: line.kind, ...(line.tool ? { tool: line.tool } : {}) }
          : {}),
      },
      conversationId,
    );
  } catch (err) {
    console.error("[workspace] SSE broadcast failed:", err);
  }
}

/**
 * Broadcast a stall transition. Fired by the supervisor's heartbeat watchdog
 * when an active session has emitted no JSON events for the stall threshold
 * (~90s) and isn't waiting on a user query or approval. Surfaces in the UI as
 * the FAB switching to its stalled state; clears via `broadcastWorkspaceResumed`
 * when events flow again.
 */
export function broadcastWorkspaceStalled(
  conversationId: string,
  sessionId: string,
): void {
  try {
    getBroadcaster().broadcastEvent(
      "workspace_stalled",
      { conversationId, sessionId },
      conversationId,
    );
  } catch (err) {
    console.error("[workspace] SSE broadcast failed (stalled):", err);
  }
}

/**
 * Broadcast that a previously-stalled session is producing events again.
 */
export function broadcastWorkspaceResumed(
  conversationId: string,
  sessionId: string,
): void {
  try {
    getBroadcaster().broadcastEvent(
      "workspace_resumed",
      { conversationId, sessionId },
      conversationId,
    );
  } catch (err) {
    console.error("[workspace] SSE broadcast failed (resumed):", err);
  }
}

/**
 * Broadcast a terminal status marker (complete/failed/cancelled) to the
 * workspace window. Same ephemeral treatment as event broadcasting.
 */
export function broadcastWorkspaceTerminal(
  conversationId: string,
  status: "complete" | "failed" | "cancelled",
  error?: string,
): void {
  const msg = terminalStatusMessage(status, error);
  if (!msg) return;
  try {
    getBroadcaster().broadcastEvent(
      "workspace_event",
      {
        conversationId,
        role: msg.role,
        content: msg.content,
        terminal: true,
        kind: "status",
        status,
      },
      conversationId,
    );
  } catch (err) {
    console.error("[workspace] terminal SSE broadcast failed:", err);
  }
}

/**
 * Smart truncation for delivering workspace output to entity context.
 *
 * Respects paragraph boundaries (double newline) before character cap, so the
 * entity doesn't see mid-sentence cuts. If the output exceeds the cap, a
 * marker is appended noting that the full text is in the workspace session.
 *
 * Default cap: 2000 chars (~4-10 paragraphs). Anything bigger wants
 * worker-LLM distillation.
 */
export function truncateForEntityContext(
  text: string,
  cap = 2000,
): string {
  if (text.length <= cap) return text;

  // Walk paragraph boundaries from the start, accumulating until we'd exceed
  // the cap. Stop at the last clean boundary before the cap.
  const paragraphs = text.split(/(\n\n+)/);
  let result = "";
  for (const para of paragraphs) {
    if ((result + para).length > cap) break;
    result += para;
  }

  // If even the first paragraph exceeds the cap, fall back to sentence boundary.
  if (!result.trim()) {
    const sentences = text.split(/(?<=[.!?])\s+/);
    for (const s of sentences) {
      if ((result + s + " ").length > cap) break;
      result += s + " ";
    }
  }

  // Last resort: hard cut at cap.
  if (!result.trim()) {
    result = text.slice(0, cap);
  }

  const trimmed = result.trimEnd();
  const marker = "\n\n[… truncated — full output in workspace session …]";
  return trimmed + marker;
}
