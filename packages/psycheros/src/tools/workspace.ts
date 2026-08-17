/**
 * Workspace Tool (Entity-facing omni-tool)
 *
 * Single tool with an `action` parameter — keeps the entity's tool list
 * uncrowded while supporting the full workspace lifecycle. The entity is
 * the user of the workspace; the workspace is framed as a faculty of the
 * entity, not a separate agent.
 */

import type {
  ToolResult,
  WorkspaceBriefing,
  WorkspaceIsolation,
  WorkspaceMode,
  WorkspaceSession,
} from "../types.ts";
import type { Tool, ToolContext } from "./types.ts";
import type { SkillFile } from "../workspace/skills.ts";
import { getWorkspaceSupervisor } from "../workspace/mod.ts";
import { distillSummary } from "../workspace/mod.ts";
import { readProjectsPath } from "../workspace/mod.ts";
import { createWorkerClient } from "../llm/mod.ts";

// ---------------------------------------------------------------------------
// Tool definition — what the LLM sees
// ---------------------------------------------------------------------------

export const workspaceTool: Tool = {
  definition: {
    type: "function",
    function: {
      name: "workspace",
      description:
        "My hands on this computer. Spawns an OpenCode session to carry out work " +
        "end-to-end; a summary returns (inline for sync, via Pulse for async/engaged).",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: [
              "open",
              "resume",
              "respond",
              "status",
              "history",
              "cancel",
              "propose_install",
              "export_project",
              "end_session",
              "extend_iterations",
              "ask_origin_conversation",
              "pin",
              "unpin",
            ],
            description:
              "open=new session, resume=continue existing, status=list/check sessions, " +
              "history=find past sessions by keyword, cancel=stop one, " +
              "respond=answer a workspace query, propose_install=install artifact from sandbox, " +
              "export_project=copy a finished artifact (document, script, project dir — anything) " +
              "to the user's projects folder (approval toast) — use when work is done and worth " +
              "keeping: sandboxes are eventually cleaned, so nothing should live only there. " +
              "end_session=signal I'm satisfied with the engaged-mode outcome (exits the loop cleanly), " +
              "ask_origin_conversation=escalate a question to the user from inside an engaged " +
              "workspace (toast; their answer returns to you), pin=exempt a session's sandbox " +
              "from cleanup so it stays resumable — use for long-running projects I'll pick " +
              "back up, unpin=remove that exemption.",
          },
          mode: {
            type: "string",
            enum: ["sync", "async", "engaged"],
            description:
              "sync=blocks this turn until done (short tasks only, <1 min). " +
              "async=returns immediately, work runs in background, Pulse delivers summary next turn. " +
              "engaged=like async, but a parallel instance of me actively collaborates with OpenCode " +
              "inside the workspace (back-and-forth turns, my judgment per turn). Use for tasks needing " +
              "my participation (build, refactor, design).",
          },
          isolation: {
            type: "string",
            enum: ["sandboxed", "feral"],
            description:
              "For open: 'sandboxed' (default) = OS-level sandbox; use for work that " +
              "stays in the workspace and ALWAYS for entity-data operations " +
              "(write_entity_data). 'feral' = OpenCode runs directly on the host for " +
              "'help me with my computer' workflows (real files, SSH) — never use for " +
              "entity data; shell writes there bypass the approval gate. " +
              "Falls back to per-entity default if unset.",
          },
          goal: {
            type: "string",
            description:
              "For open: what to accomplish (first user message to workspace).",
          },
          context: {
            type: "string",
            description:
              "For open: optional background. No auto-summary — I write what's relevant.",
          },
          workdir: {
            type: "string",
            description:
              "For open: an existing folder to work on in place (e.g. reorganizing " +
              "an existing project). Kernel-scoped to that folder — everything else " +
              "stays invisible. The user approves the bind before the session starts.",
          },
          include_messages: {
            type: "array",
            items: { type: "string" },
            description:
              "For open: message IDs to quote verbatim in the briefing.",
          },
          skills: {
            type: "array",
            items: { type: "string" },
            description:
              "For open: names of my skills to bundle into the workspace so it " +
              'follows the same procedures (see "My skills" in my context). ' +
              "Names must match exactly.",
          },
          session_id: {
            type: "string",
            description:
              "For status/cancel/respond/resume/extend_iterations/pin/unpin: which session.",
          },
          additional: {
            type: "number",
            description:
              "For extend_iterations: how many more iterations to add to the cap (max 20 per call, 40 total per session).",
          },
          answer: {
            type: "string",
            description: "For respond: answer to a workspace query.",
          },
          question: {
            type: "string",
            description:
              "For ask_origin_conversation: the question to ask the user.",
          },
          new_instruction: {
            type: "string",
            description:
              "For resume: new instruction to send to the existing session.",
          },
          path: {
            type: "string",
            description:
              "For propose_install/export_project: sandbox path to the artifact.",
          },
          type: {
            type: "string",
            description:
              "For propose_install: artifact type (plugin, tool, extension).",
          },
          name: {
            type: "string",
            description:
              "For propose_install/export_project: name to install/export as.",
          },
        },
        required: ["action"],
      },
    },
  },

  execute: async (
    args: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<ToolResult> => {
    const wrap = (content: string, isError = false): ToolResult => ({
      toolCallId: ctx.toolCallId,
      content,
      isError,
    });

    const supervisor = getWorkspaceSupervisor();
    if (!supervisor) {
      return wrap(
        "The workspace faculty isn't available right now — the supervisor isn't initialized. " +
          "This usually means OpenCode isn't installed or the feature is disabled in settings.",
      );
    }

    const action = String(args.action ?? "");
    switch (action) {
      case "open":
        return await handleOpen(args, ctx, wrap);
      case "status":
        return handleStatus(args, wrap);
      case "history":
        return handleHistory(args, wrap);
      case "cancel":
        return await handleCancel(args, wrap);
      case "respond":
        return await handleRespond(args, wrap);
      case "resume":
        return await handleResume(args, wrap);
      case "propose_install":
        return await handleProposeInstall(args, ctx, wrap);
      case "export_project":
        return await handleExportProject(args, wrap);
      case "end_session":
        return await handleEndSession(args, wrap);
      case "extend_iterations":
        return handleExtendIterations(args, wrap);
      case "ask_origin_conversation":
        return await handleAskOrigin(args, wrap);
      case "pin":
        return handlePin(args, wrap, true);
      case "unpin":
        return handlePin(args, wrap, false);
      default:
        return wrap(
          `Unknown workspace action: "${action}". Supported: open, resume, respond, status, cancel, propose_install, end_session, extend_iterations, ask_origin_conversation, pin, unpin.`,
          true,
        );
    }
  },
};

// ---------------------------------------------------------------------------
// Action handlers — each takes a `wrap` to build ToolResults with toolCallId
// ---------------------------------------------------------------------------

/**
 * Resolve a session by ID, accepting primary ID, conversation ID, or 8-char
 * prefix. Entity in workspace context naturally knows the conversation ID
 * (that's the conversation they're responding in); they may only see the
 * short form (e.g. "dad90003") in status output. Be forgiving across all
 * handlers that take session_id.
 *
 * Per §13a post-mortem: end_session originally failed because entity passed
 * the workspace conversation ID instead of the session ID. Same forgiveness
 * pattern applies to cancel, respond, resume, end_session.
 */
function resolveSession(
  supervisor: ReturnType<typeof getWorkspaceSupervisor>,
  sessionId: string,
): WorkspaceSession | null {
  if (!supervisor) return null;
  // Primary ID or conversation ID.
  let session = supervisor.getSession(sessionId) ??
    supervisor.getSessionByConversation(sessionId);
  if (!session) {
    // 8-char prefix match — entity may have seen "dad90003" in status.
    const all = supervisor.listActiveSessions();
    session = all.find((s) => s.id.startsWith(sessionId)) ?? null;
  }
  return session;
}

async function handleOpen(
  args: Record<string, unknown>,
  ctx: ToolContext,
  wrap: (content: string, isError?: boolean) => ToolResult,
): Promise<ToolResult> {
  const supervisor = getWorkspaceSupervisor()!;
  const goal = String(args.goal ?? "").trim();
  if (!goal) {
    return wrap("Missing required `goal` for workspace open.", true);
  }

  const mode = (args.mode as WorkspaceMode | undefined) ?? "async";

  const contextText = args.context !== undefined
    ? String(args.context)
    : undefined;
  const pinned = Array.isArray(args.include_messages)
    ? (args.include_messages as unknown[]).map((s) => String(s))
    : undefined;

  // Entity skills to bundle into the sandbox — validated and loaded before
  // spawn so a bad name can't orphan a session row.
  let skillFiles: SkillFile[] | undefined;
  let bundledSkills: string[] | undefined;
  if (Array.isArray(args.skills) && args.skills.length > 0) {
    const requested = (args.skills as unknown[]).map((s) => String(s));
    const { loadSkillFiles, listSkills } = await import("../skills/mod.ts");
    const { WORKSPACE_SKILLS } = await import("../workspace/skills.ts");
    const collisions = requested.filter((name) =>
      WORKSPACE_SKILLS.some((b) => b.name === name)
    );
    if (collisions.length > 0) {
      return wrap(
        `Skill name(s) already used by built-in workspace skills: ${
          collisions.join(", ")
        }. ` +
          `Pick different names — the workspace already bundles those built-ins.`,
        true,
      );
    }
    const { found, missing } = await loadSkillFiles(
      supervisor.config_.dataRoot,
      requested,
    );
    if (missing.length > 0) {
      const available = await listSkills(supervisor.config_.dataRoot);
      return wrap(
        `No skill(s) named: ${missing.join(", ")}. Available: ${
          available.map((s) => s.name).join(", ") || "(none)"
        }.`,
        true,
      );
    }
    skillFiles = found;
    bundledSkills = found.map((f) => f.name);
  }

  const briefing: WorkspaceBriefing = {
    goal,
    context: contextText,
    pinnedMessageIds: pinned,
    originConversationId: ctx.conversationId,
    timeoutMs: typeof args.timeout_ms === "number"
      ? Number(args.timeout_ms)
      : undefined,
    bundledSkills,
  };

  try {
    const isolation = (args.isolation as WorkspaceIsolation | undefined) ??
      await readDefaultIsolation(supervisor.config_.dataRoot);
    const { session, run } = await supervisor.openSession({
      mode,
      briefing,
      // Partyhard disabled: --auto unreliable in headless mode (opencode
      // #13851, #16367); no use case for bypassing entity-data approval.
      // partyhard: args.partyhard !== undefined
      //   ? Boolean(args.partyhard)
      //   : await readPartyhardDefault(supervisor.config_.dataRoot),
      partyhard: false,
      isolation,
      ...(args.workdir ? { workdir: String(args.workdir) } : {}),
      ...(skillFiles ? { skillFiles } : {}),
    });

    // Async mode: session is running in the background. Return immediately
    // without a summary — a Pulse will fire on completion and the entity
    // picks up the summary in a later turn.
    if (mode === "async") {
      return wrap(
        `Workspace session started in background (id: ${session.id}).\n\n` +
          `Goal: ${goal}\n\n` +
          `I'll get a Pulse with the summary when it completes.`,
      );
    }

    // Sync mode: check if OpenCode asked a question mid-session (per §14
    // suspend model). If so, the session is now `suspended`. Tell the entity
    // — its turn can end naturally; the workspace will resume automatically
    // when the user answers via the FAB `!` badge. The completion summary
    // arrives in a later turn.
    const { getQueryQueue } = await import("../workspace/mod.ts");
    const pendingQuery = getQueryQueue().getPendingForSession(session.id);
    if (pendingQuery) {
      return wrap(
        `Workspace session ${session.id} is suspended — OpenCode needs user input.\n\n` +
          `Question: ${pendingQuery.question}\n\n` +
          `Goal: ${goal}\n\n` +
          `The workspace resumes automatically when the user answers via the workspace ` +
          `indicator. No further action needed from this turn — the completion summary ` +
          `arrives in a later turn once the user has answered.`,
      );
    }

    // No pending question — distill a summary for main context.
    let llm = null;
    try {
      llm = createWorkerClient();
    } catch {
      // Worker LLM unavailable — distillSummary falls back to finalText
    }
    const summary = await distillSummary(run, llm);

    return wrap(
      `Workspace session ${session.status} (id: ${session.id}).\n\n` +
        `Goal: ${goal}\n\n` +
        `Summary:\n${summary}` +
        (run.ok
          ? ""
          : `\n\n(Note: workspace reported non-success: ${
            run.error ?? "unknown error"
          })`),
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return wrap(`Workspace open failed: ${message}`, true);
  }
}

function handleStatus(
  args: Record<string, unknown>,
  wrap: (content: string, isError?: boolean) => ToolResult,
): ToolResult {
  const supervisor = getWorkspaceSupervisor()!;
  const sessionId = args.session_id !== undefined
    ? String(args.session_id)
    : undefined;

  if (sessionId) {
    const session = resolveSession(supervisor, sessionId);
    if (!session) {
      return wrap(
        `No workspace session with id: ${sessionId}. Tried primary ID, conversation ID, and 8-char prefix match.`,
      );
    }
    return wrap(formatSessionDetail(session));
  }

  const active: WorkspaceSession[] = supervisor.listActiveSessions();
  if (active.length === 0) {
    return wrap("No active workspace sessions.");
  }
  return wrap(
    `Active workspace sessions (${active.length}):\n` +
      active.map((s: WorkspaceSession) => `  - ${formatSessionLine(s)}`).join(
        "\n",
      ),
  );
}

/**
 * history — searches past workspace sessions by keyword. Returns session IDs,
 * goals, statuses, summary previews, and whether the sandbox still exists.
 * This is how the entity rediscovers past work that has fallen off the
 * context window (ChatRAG surfaces the conversation but not the session ID).
 */
function handleHistory(
  args: Record<string, unknown>,
  wrap: (content: string, isError?: boolean) => ToolResult,
): ToolResult {
  const supervisor = getWorkspaceSupervisor()!;
  const query = args.query !== undefined
    ? String(args.query).toLowerCase().trim()
    : undefined;
  const limit = typeof args.limit === "number"
    ? Math.min(Number(args.limit), 50)
    : 20;

  const allSessions = supervisor.config_.db.listWorkspaceSessions({});

  let sessions = allSessions;
  if (query) {
    sessions = allSessions.filter((s) =>
      s.briefing.goal.toLowerCase().includes(query) ||
      (s.summary ?? "").toLowerCase().includes(query) ||
      s.briefing.context?.toLowerCase().includes(query)
    );
  }

  sessions = sessions.slice(0, limit);

  if (sessions.length === 0) {
    return wrap(
      query
        ? `No workspace sessions found matching "${query}".`
        : "No workspace sessions found.",
    );
  }

  const lines = sessions.map((s) => {
    const goal = s.briefing.goal.length > 80
      ? s.briefing.goal.slice(0, 77) + "..."
      : s.briefing.goal;
    const summary = s.summary
      ? s.summary.length > 120 ? s.summary.slice(0, 117) + "..." : s.summary
      : "(no summary)";
    return `  [${
      s.id.slice(0, 8)
    }] ${s.status} (${s.mode}) — ${goal}\n    summary: ${summary}\n    created: ${s.createdAt}`;
  });

  return wrap(
    `Workspace sessions (${sessions.length}${
      query ? ` matching "${query}"` : ""
    }):\n` +
      lines.join("\n"),
  );
}

async function handleCancel(
  args: Record<string, unknown>,
  wrap: (content: string, isError?: boolean) => ToolResult,
): Promise<ToolResult> {
  const supervisor = getWorkspaceSupervisor()!;
  const sessionId = args.session_id !== undefined
    ? String(args.session_id)
    : undefined;
  if (!sessionId) {
    return wrap("Missing required `session_id` for workspace cancel.", true);
  }

  const session = resolveSession(supervisor, sessionId);
  if (!session) {
    return wrap(
      `No workspace session with id: ${sessionId}. Tried primary ID, conversation ID, and 8-char prefix match.`,
    );
  }

  if (
    session.status === "complete" ||
    session.status === "failed" ||
    session.status === "cancelled"
  ) {
    return wrap(
      `Session ${sessionId} is already in terminal state: ${session.status}.`,
    );
  }

  // Mark cancelled in DB + clean up any pending queries/approvals so
  // orphaned toasts don't linger.
  supervisor.config_.db.updateWorkspaceSessionStatus(session.id, "cancelled");
  const { getQueryQueue, getApprovalQueue } = await import(
    "../workspace/mod.ts"
  );
  const cancelled = getQueryQueue().cancelAllForSession(session.id);
  const pendingApprovals = getApprovalQueue().listPending(session.id);
  for (const p of pendingApprovals) {
    getApprovalQueue().deny(p.id, "system", "session cancelled");
  }
  return wrap(
    `Workspace session ${session.id} cancelled.${
      cancelled > 0 || pendingApprovals.length > 0
        ? ` (${cancelled} queries, ${pendingApprovals.length} approvals dismissed)`
        : ""
    }`,
  );
}

/**
 * respond — answer a query the workspace escalated via ask_origin_conversation
 * (sync/async) or that the entity asked via ask_user (engaged).
 *
 * When workspace calls ask_origin_conversation, the coordination layer enqueues
 * a query and broadcasts a toast. The entity (in main chat) sees the toast
 * and calls this action with the answer. The answer flows back to the
 * workspace — it was `suspended` waiting, and resumeSession picks up with
 * the answer via --continue.
 */
async function handleRespond(
  args: Record<string, unknown>,
  wrap: (content: string, isError?: boolean) => ToolResult,
): Promise<ToolResult> {
  const sessionId = String(args.session_id ?? "");
  const answer = String(args.answer ?? "");
  if (!sessionId) {
    return wrap("Missing required `session_id` for workspace respond.", true);
  }
  if (!answer.trim()) {
    return wrap(
      "Missing required `answer` for workspace respond. What should I tell the workspace?",
      true,
    );
  }
  // Resolve to primary session ID — query queue stores by primary ID, but the
  // entity may have passed the workspace conversation ID or 8-char prefix.
  const supervisor = getWorkspaceSupervisor();
  const session = supervisor ? resolveSession(supervisor, sessionId) : null;
  if (!session) {
    return wrap(
      `No workspace session with id: ${sessionId}. Tried primary ID, conversation ID, and 8-char prefix match.`,
      true,
    );
  }
  const { getQueryQueue } = await import("../workspace/mod.ts");
  const queue = getQueryQueue();
  const query = queue.getPendingForSession(session.id);
  if (!query) {
    return wrap(
      `No pending query for session ${session.id}. The workspace may have already completed, timed out, or never asked.`,
    );
  }
  // Resolve the query — the workspace was suspended waiting for this
  // answer. resumeSession continues the workspace with the answer as the
  // new instruction via --continue.
  queue.answer(query.id, answer);

  // Engaged mode: the engaged-runner already exited cleanly with
  // suspended:true. resumeSession re-invokes runEngagedSession with
  // `resumeFrom` set — the runner picks up at iteration 1 in --continue
  // mode using the answer. Same code path as sync/async below.
  // Sync/async: the opencode process already exited (it got the
  // "Question captured" response and finished). The answer needs to be fed
  // back via a new opencode run with --continue.
  if (session.opencodeSessionId) {
    try {
      await supervisor!.resumeSession(session.id, answer);
      return wrap(
        `Answer delivered + workspace continued (session ${session.id}). The workspace resumed with: ${
          answer.slice(0, 200)
        }${answer.length > 200 ? "…" : ""}`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return wrap(
        `Answer resolved in queue, but resume failed: ${msg}`,
        true,
      );
    }
  }
  return wrap(
    `Answer delivered to workspace session ${session.id}, but the session has no opencodeSessionId — can't resume automatically. The workspace may need to be manually resumed.`,
    true,
  );
}

/**
 * end_session — entity signals that it's satisfied with the workspace outcome
 * and the engaged-mode turn-based loop should exit cleanly.
 *
 * Done-detection is entity-driven rather than heuristic ("no tool_use"
 * was wrong — the entity may be having a text-only clarifying conversation
 * with OpenCode). Engaged-runner polls `endRequested` after each entity
 * turn.
 *
 * No-op for sync/async (delegation) modes — those don't have an entity in
 * the loop to call this. The action still succeeds (returns graceful
 * confirmation) so the entity doesn't see an error if it tries.
 */
async function handleEndSession(
  args: Record<string, unknown>,
  wrap: (content: string, isError?: boolean) => ToolResult,
): Promise<ToolResult> {
  const supervisor = getWorkspaceSupervisor()!;
  const sessionId = String(args.session_id ?? "");
  if (!sessionId) {
    return wrap(
      "Missing required `session_id` for workspace end_session.",
      true,
    );
  }
  const session = resolveSession(supervisor, sessionId);
  if (!session) {
    return wrap(
      `Session not found: ${sessionId}. Tried primary ID, conversation ID, and 8-char prefix match.`,
      true,
    );
  }
  supervisor.config_.db.markWorkspaceSessionEndRequested(session.id);
  return wrap(
    `End-of-session signal recorded for workspace ${session.id}. ` +
      (session.mode === "engaged"
        ? "The engaged loop will exit cleanly after this turn."
        : `Note: session mode is ${session.mode}, not engaged — this signal has no effect (delegation modes exit on their own).`),
  );
}

/**
 * extend_iterations — add to the iteration cap of an engaged session.
 *
 * Default cap is 10. The entity calls this when work isn't done yet and
 * it needs more turns. Hard ceiling at 40 extensions per session (cap of 50
 * total) — a misbehaving entity that keeps extending should hit the ceiling,
 * not loop forever. Per-call max is 20 to force deliberate requests rather
 * than "give me a million."
 *
 * No-op (graceful) for non-engaged sessions — sync/async don't loop, so the
 * cap doesn't apply.
 */
function handleExtendIterations(
  args: Record<string, unknown>,
  wrap: (content: string, isError?: boolean) => ToolResult,
): ToolResult {
  const supervisor = getWorkspaceSupervisor()!;
  const sessionId = String(args.session_id ?? "");
  if (!sessionId) {
    return wrap(
      "Missing required `session_id` for workspace extend_iterations.",
      true,
    );
  }
  const additional = Number(args.additional ?? 0);
  if (!Number.isFinite(additional) || additional <= 0) {
    return wrap(
      "Missing or invalid `additional` for workspace extend_iterations. Must be a positive number.",
      true,
    );
  }
  const session = resolveSession(supervisor, sessionId);
  if (!session) {
    return wrap(
      `Session not found: ${sessionId}. Tried primary ID, conversation ID, and 8-char prefix match.`,
      true,
    );
  }
  if (session.mode !== "engaged") {
    return wrap(
      `Session ${session.id} is mode=${session.mode}, not engaged — iteration cap doesn't apply. Sync/async exit on their own; no extension needed.`,
    );
  }
  const result = supervisor.extendIterations(session.id, additional);
  if (!result.ok) {
    return wrap(
      `extend_iterations failed: ${result.error}`,
      true,
    );
  }
  const newCap = result.newCap ?? 10;
  return wrap(
    `Iteration cap extended by ${additional}. New cap: ${newCap} total (10 base + ${
      newCap - 10
    } extensions). Hard ceiling at 50 total.`,
  );
}

/**
 * pin/unpin — mark a session as a long-running project exempt from sandbox
 * retention. The sandbox (working files + OpenCode session context) survives
 * cleanup so the project can be resumed later regardless of idle time.
 */
function handlePin(
  args: Record<string, unknown>,
  wrap: (content: string, isError?: boolean) => ToolResult,
  pinned: boolean,
): ToolResult {
  const supervisor = getWorkspaceSupervisor()!;
  const sessionId = String(args.session_id ?? "");
  if (!sessionId) {
    return wrap(
      `Missing required \`session_id\` for workspace ${
        pinned ? "pin" : "unpin"
      }.`,
      true,
    );
  }

  const session = resolveSession(supervisor, sessionId);
  if (!session) {
    return wrap(
      `Session not found: ${sessionId}. Tried primary ID, conversation ID, and 8-char prefix match.`,
      true,
    );
  }

  supervisor.config_.db.setWorkspaceSessionPinned(session.id, pinned);
  const goal = session.briefing.goal.length > 60
    ? session.briefing.goal.slice(0, 57) + "..."
    : session.briefing.goal;
  return wrap(
    pinned
      ? `Session ${session.id} pinned — its sandbox is exempt from cleanup and can be resumed any time. (${goal})`
      : `Session ${session.id} unpinned — it will be cleaned up per the normal retention window.`,
  );
}

/**
 * ask_origin_conversation (entity-side) — escalate a question to the user
 * from engaged workspace context. Routes to main chat as a toast; user
 * answers via /api/workspace/sessions/:id/respond; answer flows back here
 * and into the entity's workspace-context turn.
 *
 * Per the §8 + §13a design: OpenCode never talks to the user directly.
 * In engaged mode, OpenCode asks in conversation text → workspace-context
 * entity handles it. If the entity specifically needs USER input (not just
 * OpenCode's), it calls THIS action.
 *
 * No-op (graceful error) in sync/async modes — those don't have an entity
 * in workspace-context to call this. Sync returns OpenCode's questions as
 * tool results directly; async fires Pulses. Engaged is the only mode where
 * this action is meaningful.
 */
async function handleAskOrigin(
  args: Record<string, unknown>,
  wrap: (content: string, isError?: boolean) => ToolResult,
): Promise<ToolResult> {
  const supervisor = getWorkspaceSupervisor()!;
  const sessionId = String(args.session_id ?? "");
  const question = String(args.question ?? "").trim();
  if (!sessionId) {
    return wrap(
      "Missing required `session_id` for workspace ask_origin_conversation.",
      true,
    );
  }
  if (!question) {
    return wrap(
      "Missing required `question` for workspace ask_origin_conversation. What do you want to ask the user?",
      true,
    );
  }
  const session = resolveSession(supervisor, sessionId);
  if (!session) {
    return wrap(
      `Session not found: ${sessionId}. Tried primary ID, conversation ID, and 8-char prefix match.`,
      true,
    );
  }
  if (session.mode !== "engaged") {
    return wrap(
      `ask_origin_conversation is only meaningful in engaged mode (where you, the workspace-context entity, are mediating between OpenCode and the user). ` +
        `This session is mode=${session.mode}. In sync/async, OpenCode-side questions route through the workspace tool result (sync) or Pulse (async) — no escalation needed.`,
    );
  }
  // Enqueue + return immediately. The engaged-runner detects the pending
  // query after this turn ends and suspends the loop. The user answers via
  // /api/workspace/sessions/:id/respond — the new turn delivers the answer.
  const { getQueryQueue } = await import("../workspace/mod.ts");
  const queue = getQueryQueue();
  queue.enqueue({
    sessionId: session.id,
    conversationId: session.conversationId,
    originConversationId: session.originConversationId ?? null,
    question,
  });
  return wrap(
    `Question sent to user. Workspace will resume when they answer. ` +
      `(session ${session.id})`,
  );
}

/**
 * resume — continues an existing workspace session with a new instruction.
 * Uses OpenCode's --session <id> --continue to append a message to the
 * existing conversation history. The session must have completed (or been
 * cancelled) previously and have an opencodeSessionId captured.
 */
async function handleResume(
  args: Record<string, unknown>,
  wrap: (content: string, isError?: boolean) => ToolResult,
): Promise<ToolResult> {
  const supervisor = getWorkspaceSupervisor()!;
  const sessionId = String(args.session_id ?? "").trim();
  const newInstruction = String(args.new_instruction ?? args.goal ?? "").trim();

  if (!sessionId) {
    return wrap("Missing required `session_id` for workspace resume.", true);
  }
  if (!newInstruction) {
    return wrap(
      "Missing required `new_instruction` for workspace resume. What should the workspace do next?",
      true,
    );
  }

  // Resolve to primary session ID — resumeSession looks up by primary ID.
  const resolved = resolveSession(supervisor, sessionId);
  if (!resolved) {
    return wrap(
      `No workspace session with id: ${sessionId}. Tried primary ID, conversation ID, and 8-char prefix match.`,
      true,
    );
  }

  try {
    const { session, run } = await supervisor.resumeSession(
      resolved.id,
      newInstruction,
    );

    let llm = null;
    try {
      llm = createWorkerClient();
    } catch {
      // Worker LLM unavailable
    }
    const summary = await distillSummary(run, llm);

    return wrap(
      `Workspace session resumed (id: ${session.id}).\n\n` +
        `New instruction: ${newInstruction}\n\n` +
        `Summary:\n${summary}` +
        (run.ok ? "" : `\n\n(Note: ${run.error ?? "unknown error"})`),
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return wrap(`Workspace resume failed: ${message}`, true);
  }
}

/**
 * Find the session + absolute source path for a sandbox-relative artifact
 * path. The session can be active OR completed — sandbox files persist on
 * disk. Strategy: use session_id if provided, else scan all sessions and
 * take the most recent whose sandbox contains the path.
 */
async function findArtifactSource(
  supervisor: NonNullable<ReturnType<typeof getWorkspaceSupervisor>>,
  cleanPath: string,
  sessionIdArg: string,
): Promise<
  | { ok: true; session: WorkspaceSession; sourcePath: string }
  | { ok: false; message: string }
> {
  let session: WorkspaceSession | null = null;
  let sourcePath: string | null = null;

  if (sessionIdArg) {
    session = resolveSession(supervisor, sessionIdArg);
    if (session) {
      sourcePath = await resolveSandboxPath(session.sandboxPath, cleanPath);
    }
  }

  if (!session || !sourcePath) {
    const allSessions = supervisor.config_.db.listWorkspaceSessions({});
    const matches: Array<{ session: WorkspaceSession; path: string }> = [];
    for (const s of allSessions) {
      const resolved = await resolveSandboxPath(s.sandboxPath, cleanPath);
      if (resolved) {
        matches.push({ session: s, path: resolved });
      }
    }
    if (matches.length >= 1) {
      // Most recent session wins — latest iteration of the work is almost
      // always what's wanted. Pass session_id explicitly for an older one.
      matches.sort((a, b) =>
        b.session.createdAt.localeCompare(a.session.createdAt)
      );
      session = matches[0].session;
      sourcePath = matches[0].path;
    }
  }

  if (!session || !sourcePath) {
    const allSessions = supervisor.config_.db.listWorkspaceSessions({});
    const sessionList = allSessions.length > 0
      ? allSessions.map((s) =>
        `  ${s.id.slice(0, 8)}... (status: ${s.status}) goal: ${
          s.briefing.goal.slice(0, 60)
        }`
      ).join("\n")
      : "(no sessions found)";
    return {
      ok: false,
      message: `Path "${cleanPath}" not found in any session sandbox.\n` +
        `Available sessions:\n${sessionList}`,
    };
  }

  return { ok: true, session, sourcePath };
}

/**
 * propose_install — moves an artifact authored in the sandbox (plugin, tool,
 * extension) into the active plugins directory. Routes through the approval
 * queue so the user reviews before install lands.
 *
 * Validates plugin.json exists for plugins, surfaces diff (path + type),
 * copies directory to <dataRoot>/.psycheros/plugins/<name>/ on approval.
 */
async function handleProposeInstall(
  args: Record<string, unknown>,
  _ctx: ToolContext,
  wrap: (content: string, isError?: boolean) => ToolResult,
): Promise<ToolResult> {
  const supervisor = getWorkspaceSupervisor()!;
  const path = String(args.path ?? "").trim();
  const type = String(args.type ?? "plugin");
  const name = String(args.name ?? "").trim();

  if (!path || !name) {
    return wrap(
      "propose_install requires `path` (sandbox path) and `name`.",
      true,
    );
  }

  // Strip leading slashes — common mistake that breaks relative resolution.
  const cleanPath = path.replace(/^\/+/, "");

  const found = await findArtifactSource(
    supervisor,
    cleanPath,
    String(args.session_id ?? "").trim(),
  );
  if (!found.ok) return wrap(found.message, true);
  const { session, sourcePath } = found;

  // For plugin type, validate plugin.json exists.
  if (type === "plugin") {
    try {
      await Deno.stat(`${sourcePath}/plugin.json`);
    } catch {
      return wrap(
        `Plugin source has no plugin.json — can't install. (Path: ${sourcePath})`,
        true,
      );
    }
  }

  // Enqueue an approval proposal — user reviews via toast.
  const { getApprovalQueue } = await import("../workspace/mod.ts");
  const queue = getApprovalQueue();
  const proposal = queue.enqueue({
    sessionId: session.id,
    conversationId: session.conversationId,
    originConversationId: session.originConversationId ?? null,
    type: "custom",
    targetId: `install:${type}:${name}`,
    changes: { sourcePath, type, name, action: "install" },
    justification: `Install ${type} "${name}" from ${path}`,
    diffPreview: {
      summary: `Install ${type} "${name}" from sandbox`,
      after: `Source: ${sourcePath}\nType: ${type}\nTarget: <plugins>/${name}/`,
    },
  });

  const resolved = await queue.waitForResolution(proposal.id);

  if (resolved.status !== "approved") {
    return wrap(
      `[propose_install ${resolved.status}${
        resolved.decisionReason ? `: ${resolved.decisionReason}` : ""
      }]`,
    );
  }

  // Apply the install — copy directory into plugins dir.
  const targetPath =
    `${supervisor.config_.dataRoot}/.psycheros/plugins/${name}`;
  try {
    await copyDir(sourcePath, targetPath);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return wrap(`Install approved but copy failed: ${message}`, true);
  }

  return wrap(
    `[propose_install approved. ${type} "${name}" installed at ${targetPath}. ` +
      `Plugin activates on next Psycheros restart.]`,
  );
}

/**
 * export_project — copy a finished artifact (document, script, whole
 * project directory — anything the workspace produced) out of the sandbox
 * to the user's projects folder on the host. Approval toast gates the
 * copy; the sandbox original is kept so the entity can keep iterating.
 * Refuses to overwrite existing files/folders in the projects folder.
 */
async function handleExportProject(
  args: Record<string, unknown>,
  wrap: (content: string, isError?: boolean) => ToolResult,
): Promise<ToolResult> {
  const supervisor = getWorkspaceSupervisor()!;
  const path = String(args.path ?? "").trim();
  const name = String(args.name ?? "").trim();

  if (!path || !name) {
    return wrap(
      "export_project requires `path` (sandbox path) and `name`.",
      true,
    );
  }

  const cleanPath = path.replace(/^\/+/, "");
  const found = await findArtifactSource(
    supervisor,
    cleanPath,
    String(args.session_id ?? "").trim(),
  );
  if (!found.ok) return wrap(found.message, true);
  const { session, sourcePath } = found;

  const projectsPath = await readProjectsPath(supervisor.config_.dataRoot);
  const { join } = await import("@std/path");
  const targetPath = join(projectsPath, name);

  const stat = await Deno.stat(sourcePath);
  const kind = stat.isDirectory ? "directory" : "file";

  // The projects folder is user-visible — never overwrite silently.
  try {
    await Deno.stat(targetPath);
    return wrap(
      `"${name}" already exists at ${projectsPath}. Choose a different ` +
        `name, or the user can move the existing one first.`,
      true,
    );
  } catch {
    // Not present — good to proceed.
  }

  const { getApprovalQueue } = await import("../workspace/mod.ts");
  const queue = getApprovalQueue();
  const proposal = queue.enqueue({
    sessionId: session.id,
    conversationId: session.conversationId,
    originConversationId: session.originConversationId ?? null,
    type: "custom",
    targetId: `export:${name}`,
    changes: { sourcePath, name, action: "export" },
    justification: `Export ${kind} "${name}" from workspace sandbox`,
    diffPreview: {
      summary: `Export ${kind} "${name}" to the projects folder`,
      after: `Source: ${sourcePath}\nTarget: ${targetPath}`,
    },
  });

  const resolved = await queue.waitForResolution(proposal.id);

  if (resolved.status !== "approved") {
    return wrap(
      `[export_project ${resolved.status}${
        resolved.decisionReason ? `: ${resolved.decisionReason}` : ""
      }]`,
    );
  }

  try {
    await Deno.mkdir(projectsPath, { recursive: true });
    if (stat.isDirectory) {
      await copyDir(sourcePath, targetPath);
    } else {
      await Deno.copyFile(sourcePath, targetPath);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return wrap(`Export approved but copy failed: ${message}`, true);
  }

  return wrap(
    `[export_project approved. ${kind} "${name}" exported to ${targetPath}. ` +
      `The sandbox original remains for further iteration.]`,
  );
}

/**
 * Resolve a path inside the sandbox. Returns the absolute resolved path if
 * it's inside sandboxRoot, or null if it escapes (path traversal attempt).
 */
async function resolveSandboxPath(
  sandboxRoot: string,
  requested: string,
): Promise<string | null> {
  const { isAbsolute, resolve: resolvePath } = await import("@std/path");
  const abs = isAbsolute(requested)
    ? resolvePath(requested)
    : resolvePath(resolvePath(sandboxRoot, requested));
  if (!abs.startsWith(resolvePath(sandboxRoot))) return null;
  try {
    await Deno.stat(abs);
    return abs;
  } catch {
    return null;
  }
}

/**
 * Copy a directory recursively. Deno's `Deno.rename` would be faster but
 * we want to keep the sandbox copy so the entity can keep iterating.
 */
async function copyDir(source: string, target: string): Promise<void> {
  await Deno.mkdir(target, { recursive: true });
  for await (const entry of Deno.readDir(source)) {
    const srcPath = `${source}/${entry.name}`;
    const tgtPath = `${target}/${entry.name}`;
    if (entry.isDirectory) {
      await copyDir(srcPath, tgtPath);
    } else if (entry.isFile) {
      await Deno.copyFile(srcPath, tgtPath);
    }
  }
}

/**
 * Read partyhardDefault from workspace-settings.json. Falls back to false
 * if the file is missing or the field is unset.
 *
 * DISABLED — partyhard mode is off (see supervisor.ts for rationale). Kept
 * for potential re-enablement with a custom OpenCode fork that fixes
 * headless ask mode. The caller hardcodes partyhard:false so this is never
 * invoked; deno check is satisfied via the `void` no-op below.
 */
// async function readPartyhardDefault(dataRoot: string): Promise<boolean> {
//   try {
//     const text = await Deno.readTextFile(
//       `${dataRoot}/.psycheros/workspace-settings.json`,
//     );
//     const settings = JSON.parse(text) as { partyhardDefault?: boolean };
//     return settings.partyhardDefault === true;
//   } catch {
//     return false;
//   }
// }
void undefined;

/**
 * Read defaultIsolation from workspace-settings.json. Falls back to "sandboxed"
 * (the safer default) when unset or invalid.
 */
async function readDefaultIsolation(
  dataRoot: string,
): Promise<WorkspaceIsolation> {
  try {
    const text = await Deno.readTextFile(
      `${dataRoot}/.psycheros/workspace-settings.json`,
    );
    const settings = JSON.parse(text) as { defaultIsolation?: string };
    return settings.defaultIsolation === "feral" ? "feral" : "sandboxed";
  } catch {
    return "sandboxed";
  }
}

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

function formatSessionLine(
  s: {
    id: string;
    status: string;
    mode: string;
    pinned?: boolean;
    briefing: { goal: string };
  },
): string {
  const goal = s.briefing.goal.length > 60
    ? s.briefing.goal.slice(0, 57) + "..."
    : s.briefing.goal;
  return `[${s.id.slice(0, 8)}] ${s.status}${
    s.pinned ? " 📌" : ""
  } (${s.mode}) — ${goal}`;
}

function formatSessionDetail(s: {
  id: string;
  status: string;
  mode: string;
  partyhard: boolean;
  pinned?: boolean;
  workdir?: string;
  briefing: { goal: string; context?: string };
  summary?: string;
  tokenUsage: number;
  createdAt: string;
}): string {
  const lines = [
    `Session: ${s.id}`,
    `Status: ${s.status}${s.pinned ? " (pinned — exempt from cleanup)" : ""}`,
    `Mode: ${s.mode}${s.partyhard ? " (partyhard)" : ""}`,
    `Created: ${s.createdAt}`,
    `Tokens used: ${s.tokenUsage}`,
    `Goal: ${s.briefing.goal}`,
  ];
  if (s.workdir) lines.push(`Workdir: ${s.workdir}`);
  if (s.briefing.context) lines.push(`Context: ${s.briefing.context}`);
  if (s.summary) lines.push(`Summary: ${s.summary}`);
  return lines.join("\n");
}
