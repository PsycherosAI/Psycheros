/**
 * Engaged Mode Runner — turn-based entity↔OpenCode collaboration.
 *
 * When entity calls `workspace({action:"open", mode:"engaged"})`, the
 * supervisor hands off to this runner instead of doing a single
 * fire-and-forget opencode invocation. The runner alternates:
 *
 *   1. Spawn OpenCode (initial briefing on iter 1, `--continue` after)
 *   2. Capture OpenCode's response from stdout events
 *   3. Run an entity turn in the workspace conversation with OpenCode's
 *      response as the latest message
 *   4. Capture the entity's response text
 *   5. Poll `session.endRequested` — entity may have called end_session.
 *      If set, exit the loop cleanly.
 *   6. Otherwise, send the entity's response back to OpenCode via `--continue`
 *   7. Repeat until entity signals done, max iterations, or timeout
 *
 * The entity is the *user* of OpenCode in this loop — OpenCode is framed as
 * part of the entity (its executor), not a separate agent. OpenCode sees the
 * entity's responses as user messages; the entity sees OpenCode's responses
 * as assistant messages in the workspace conversation.
 *
 * Scope:
 *   - Max 10 iterations per engaged session (configurable via maxIterations)
 *   - Per-iteration timeout (default 5 min)
 *   - Per-turn tool filtering via `visibleIn` predicates: workspace-only tools
 *     (ask_user, manage_message) are hidden outside workspace contexts; the
 *     `workspace` omni-tool stays visible everywhere.
 *
 * Done-detection is entity-driven: the entity signals done via the workspace
 * `end_session` action, polled after each entity turn. (A "no tool_use =
 * done" heuristic was wrong — the entity may be having a text-only
 * clarifying conversation.) Fallback: max iterations cap.
 */

import type { OpenCodeEvent, OpenCodeRunResult } from "./session.ts";
import type { DBClient } from "../db/client.ts";
import {
  buildOpenCodeRunArgs,
  invokeOpenCode,
  markWorkspaceActivity,
} from "./supervisor.ts";
import {
  broadcastWorkspaceEntityTurn,
  broadcastWorkspaceEvent,
  broadcastWorkspaceTerminal,
} from "./transcript.ts";
import { getQueryQueue } from "./query-queue.ts";

/**
 * Arguments for runEngagedSession. Mirrors the relevant subset of
 * WorkspaceSupervisorConfig plus per-session specifics.
 */
export interface EngagedSessionArgs {
  /** DB client — used to poll `end_requested` after each entity turn (§13a). */
  db: DBClient;
  /** Workspace session ID (workspace_sessions.id) — for end_requested lookup. */
  sessionId: string;
  /** Workspace conversation ID (where the entity↔OpenCode exchange lives). */
  conversationId: string;
  /** Sandbox dir path — passed to opencode as --dir. */
  sandboxPath: string;
  /** Initial briefing text — first user message to OpenCode. */
  briefing: string;
  /** Path to the opencode binary. */
  opencodePath: string;
  /** LLM profile to forward (model + apiKey). */
  llmProfile?: { baseUrl: string; apiKey: string; model: string };
  /** Sandbox wrap (bwrap/sandbox-exec argv) — null for Feral mode. */
  sandboxWrap: { binary: string; args: string[] } | null;
  /** Env vars for the opencode subprocess (includes PSYCHEROS_OPENCODE_KEY). */
  opencodeEnv: Record<string, string>;
  /** Partyhard flag — adds --auto when true. */
  partyhard: boolean;
  /** Entity's display name — labels the entity's turns in the terminal view. */
  entityName?: string;

  /**
   * Run an entity turn in the workspace conversation. Receives OpenCode's
   * response as the userMessage; returns the entity's response text.
   *
   * The server constructs an EntityTurn (mirroring handleChat) with full
   * context — identity, RAG, memories, lorebook, vault. The entity sees the
   * workspace conversation as just another conversation it's responding in.
   * A systemPromptSuffix tells it not to call `workspace` recursively.
   */
  runEntityTurn: (
    conversationId: string,
    userMessage: string,
    options?: {
      pendingQuestion?: string;
      sessionId?: string;
      iteration?: number;
      currentCap?: number;
    },
  ) => Promise<string>;

  /** Max turn-pairs before bailing (default 10). */
  maxIterations?: number;
  /**
   * Dynamic max-iterations getter. If supplied, the loop re-reads this on
   * every iteration check, so changes mid-session take effect immediately.
   * Used by the workspace `extend_iterations` action so the entity can ask
   * for more turns when work isn't done yet. Returns the additional count
   * on top of `maxIterations` (or the default 10).
   */
  getExtensionIterations?: () => number;
  /** Per-iteration timeout in ms (default 5 min). */
  timeoutMs?: number;

  /**
   * Resume-from-suspend input. When set, the runner skips the
   * initial briefing iteration and starts directly at iteration 1 in
   * `--continue` mode using this message — the user's answer to the
   * ask_user / ask_origin_conversation that triggered the suspend.
   * `existingOpencodeSessionId` must also be set.
   */
  resumeFrom?: {
    /** The user's answer (becomes the first --continue message). */
    answer: string;
    /** The opencode session ID from before suspend. */
    opencodeSessionId: string;
  };
}

/**
 * Run an engaged session. Returns the final summary text + outcome metadata.
 *
 * The caller (supervisor.openSession) is responsible for:
 *   - Persisting terminal status to the DB
 *   - Firing the onAsyncComplete callback
 *   - Cleaning up activeChildren
 *
 * This function just runs the loop and returns the result.
 */
export async function runEngagedSession(
  args: EngagedSessionArgs,
): Promise<OpenCodeRunResult> {
  // Base iteration cap. Read once — this is the floor.
  const baseMaxIter = args.maxIterations ?? 10;
  // Live cap function: base + any extension the entity granted mid-run via
  // workspace `extend_iterations`. Re-read each iteration check so an
  // extension takes effect on the next loop iteration after the call.
  const currentMaxIter = () =>
    baseMaxIter + (args.getExtensionIterations?.() ?? 0);
  const timeoutMs = args.timeoutMs ?? 5 * 60_000;

  let opencodeSessionId: string | undefined = args.resumeFrom
    ?.opencodeSessionId;
  let totalTokens = 0;
  let lastError: string | undefined;
  let finalText: string | undefined;
  // On resume, the first iteration's `--continue` message is the user's
  // answer. Otherwise it's the initial briefing text.
  let lastEntityResponse = args.resumeFrom?.answer ?? args.briefing;
  // Accumulate events across iterations so distillSummary has the full
  // transcript to work with. Without this, the entity gets a useless generic
  // fallback summary instead of the actual conversation content.
  const allEvents: OpenCodeEvent[] = [];

  for (let iteration = 1; iteration <= currentMaxIter(); iteration++) {
    // 1. Build opencode argv. Iteration 1 = initial briefing; subsequent
    //    iterations use --session <id> --continue with the entity's response.
    const opencodeArgs = opencodeSessionId
      ? buildContinueArgs({
        sandboxDir: args.sandboxPath,
        sessionId: opencodeSessionId,
        message: lastEntityResponse,
        llmProfile: args.llmProfile,
        partyhard: args.partyhard,
      })
      : buildOpenCodeRunArgs({
        agent: "psycheros-workspace",
        sandboxDir: args.sandboxPath,
        partyhard: args.partyhard,
        message: args.briefing,
        ...(args.llmProfile
          ? { model: `psycheros-forwarded/${args.llmProfile.model}` }
          : {}),
      });

    // The sandbox wrap (bwrap) needs its `--` tail replaced with the new
    // opencode argv each iteration. buildSandboxArgv put [opencodePath,
    // ...opencodeArgs] at the end; we need to swap that.
    const wrapForIter = args.sandboxWrap
      ? rebuildWrapWithNewCommand(
        args.sandboxWrap,
        args.opencodePath,
        opencodeArgs,
      )
      : null;

    // 2. Invoke opencode (with bwrap wrap if Sandboxed, direct if Feral).
    const run = await invokeOpenCode(
      args.opencodePath,
      opencodeArgs,
      timeoutMs,
      undefined, // child registration handled by caller via supervisor
      (event) => {
        allEvents.push(event);
        // Debug: log tool events to diagnose ask_origin detection
        if (
          event.type === "tool_use" || event.type === "tool_call" ||
          event.type === "tool-result"
        ) {
          const part = (event as { part?: Record<string, unknown> }).part;
          console.log(
            `[workspace.engaged] event type=${event.type} ` +
              `tool=${
                part?.tool ?? part?.name ?? (event as { name?: string }).name
              } ` +
              `state=${JSON.stringify(part?.state ?? "").slice(0, 200)}`,
          );
        }
        broadcastWorkspaceEvent(args.conversationId, event);
        markWorkspaceActivity(args.sessionId);
      },
      args.opencodeEnv,
      wrapForIter ?? undefined,
    );

    totalTokens += run.tokensUsed ?? 0;
    // Also fold in any events invokeOpenCode captured that we missed via
    // onEvent (defense-in-depth — they should overlap but rawEvents is the
    // authoritative source).
    if (run.rawEvents.length > 0) {
      for (const e of run.rawEvents) {
        if (!allEvents.includes(e)) allEvents.push(e);
      }
    }
    if (run.sessionId && !opencodeSessionId) {
      opencodeSessionId = run.sessionId;
    }
    if (run.error) lastError = run.error;

    if (!run.ok) {
      broadcastWorkspaceTerminal(args.conversationId, "failed", run.error);
      return {
        sessionId: opencodeSessionId ?? "",
        ok: false,
        error: run.error ?? "OpenCode failed during engaged session",
        tokensUsed: totalTokens,
        rawEvents: allEvents,
      };
    }

    // 3. Run an entity turn in the workspace conversation.
    //    OpenCode's response becomes the latest message the entity sees.
    //    Always run the entity turn — the entity decides when
    //    to end via `end_session` action.
    const opencodeResponseText = run.finalText ??
      "(OpenCode produced no text response)";

    // Detect if OpenCode called ask_origin_conversation during this turn.
    // If so, pass the question to the entity turn via options so it goes
    // into the systemPromptSuffix (not prepended to the user message —
    // that pollutes conversation history).
    const askOriginQuestions: string[] = [];
    for (const e of allEvents) {
      if (e.type !== "tool_use" && e.type !== "tool_call") continue;
      const part = (e as { part?: { tool?: string; name?: string } }).part;
      const toolName = part?.tool ?? part?.name ??
        (e as { name?: string }).name;
      if (
        toolName !== "ask_origin_conversation" &&
        !toolName?.endsWith("_ask_origin_conversation")
      ) continue;
      const input = (e as {
        part?: { state?: { input?: { question?: string } } };
      }).part?.state?.input;
      const q = input?.question;
      if (typeof q === "string" && q.trim()) {
        askOriginQuestions.push(q.trim());
      }
    }

    try {
      const entityResponse = await args.runEntityTurn(
        args.conversationId,
        opencodeResponseText,
        {
          sessionId: args.sessionId,
          iteration,
          currentCap: currentMaxIter(),
          ...(askOriginQuestions.length > 0
            ? { pendingQuestion: askOriginQuestions[0].slice(0, 500) }
            : {}),
        },
      );
      lastEntityResponse = entityResponse ||
        "(no further input from entity — proceeding with best judgment)";
      // Surface the entity's turn in the live terminal view — accent-colored
      // input line so it's visibly the entity acting, not OpenCode grinding.
      if (entityResponse?.trim()) {
        broadcastWorkspaceEntityTurn(
          args.conversationId,
          args.entityName ?? "entity",
          entityResponse,
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      broadcastWorkspaceTerminal(
        args.conversationId,
        "failed",
        `entity turn failed: ${msg}`,
      );
      return {
        sessionId: opencodeSessionId ?? "",
        ok: false,
        error: `entity turn failed: ${msg}`,
        tokensUsed: totalTokens,
        rawEvents: allEvents,
      };
    }

    // Poll endRequested after the entity turn. Entity signals
    // done via workspace `end_session` action. Exit cleanly if set.
    if (args.db.getWorkspaceSession(args.sessionId)?.endRequested) {
      finalText = run.finalText ??
        `(engaged session ended by entity via end_session at iteration ${iteration})`;
      console.log(
        `[workspace.engaged] session ${args.sessionId} ended cleanly by entity at iteration ${iteration}`,
      );
      break;
    }

    // ask_user / ask_origin_conversation return immediately (no blocking
    // waitForAnswer). After the entity turn ends, check for a pending query
    // for this session — if found, suspend the loop. The user's answer
    // resumes via /respond → resumeSession with the answer as the next
    // iteration's `--continue` message. The workspace_query SSE event (fired
    // by queue.enqueue) is the toast; suspend isn't terminal so no terminal
    // broadcast applies.
    const pendingQuery = getQueryQueue().getPendingForSession(args.sessionId);
    if (pendingQuery) {
      console.log(
        `[workspace.engaged] session ${args.sessionId} suspending at iteration ${iteration} ` +
          `(pending query ${pendingQuery.id}: "${
            pendingQuery.question.slice(0, 80)
          }")`,
      );
      return {
        sessionId: opencodeSessionId ?? "",
        ok: true,
        finalText: finalText ?? lastEntityResponse,
        error: lastError,
        tokensUsed: totalTokens,
        rawEvents: allEvents,
        suspended: true,
      };
    }

    // If we just ran the last iteration, we hit the cap — note it.
    if (iteration === currentMaxIter()) {
      console.log(
        `[workspace.engaged] session ${args.sessionId} hit max iterations (${currentMaxIter()}) without entity end_session — exiting with last response`,
      );
      finalText = run.finalText ??
        `(engaged session ended after ${currentMaxIter()} iterations)`;
    }
  }

  broadcastWorkspaceTerminal(args.conversationId, "complete");
  return {
    sessionId: opencodeSessionId ?? "",
    ok: true,
    finalText: finalText ?? lastEntityResponse,
    error: lastError,
    tokensUsed: totalTokens,
    rawEvents: allEvents,
  };
}

/**
 * Build the opencode argv for a --continue iteration. Same shape as the
 * initial run args, but with --session and --continue flags prepended before
 * the message.
 */
function buildContinueArgs(input: {
  sandboxDir: string;
  sessionId: string;
  message: string;
  llmProfile?: { model: string };
  partyhard: boolean;
}): string[] {
  return [
    "run",
    "--format",
    "json",
    "--agent",
    "psycheros-workspace",
    "--dir",
    input.sandboxDir,
    "--session",
    input.sessionId,
    "--continue",
    ...(input.llmProfile
      ? ["--model", `psycheros-forwarded/${input.llmProfile.model}`]
      : []),
    // Partyhard (--auto) disabled. See supervisor.ts for rationale.
    // ...(input.partyhard ? ["--auto"] : []),
    input.message,
  ];
}

/**
 * Rebuild a sandbox wrap's argv with a new opencode command at the tail.
 *
 * buildSandboxArgv produces argv of the form [bwrap-flags, "--", opencodePath,
 * ...opencodeArgs]. When we change the opencode args (per engaged iteration),
 * we need to swap the tail. Find the "--" separator and replace everything
 * after it.
 */
function rebuildWrapWithNewCommand(
  wrap: { binary: string; args: string[] },
  opencodePath: string,
  opencodeArgs: string[],
): { binary: string; args: string[] } {
  const sep = wrap.args.indexOf("--");
  if (sep === -1) {
    // Malformed wrap — bail and run unwrapped (safer than crashing).
    console.warn(
      "[workspace.engaged] sandbox wrap missing '--' separator; running unwrapped",
    );
    return null!;
  }
  const head = wrap.args.slice(0, sep + 1); // includes "--"
  return {
    binary: wrap.binary,
    args: [...head, opencodePath, ...opencodeArgs],
  };
}
