/**
 * Workspace Supervisor
 *
 * Manages workspace sessions — per-session OpenCode invocations against a
 * sandbox dir, with the daemon-side coordination layer (MCP server) bridging
 * entity data. Each session spawns an `opencode run --format json` subprocess;
 * Tier 5 protected paths are enforced via classifyPath gating.
 */

import type { DBClient } from "../db/client.ts";
import type { CreateWorkspaceInput, WorkspaceSession } from "../types.ts";
import { deriveSessionTitle } from "./briefing.ts";
import type {
  OpenCodeEvent,
  OpenCodeRunResult,
  WorkspaceCapabilities,
} from "./session.ts";
import {
  buildSandboxArgv,
  ensureSandbox,
  writeAgentsMd,
  writeOpenCodeConfig,
} from "./sandbox.ts";
import { renderAgentFile } from "./agent-template.ts";
import { runEngagedSession } from "./engaged-runner.ts";
import {
  broadcastWorkspaceEvent,
  broadcastWorkspaceResumed,
  broadcastWorkspaceStalled,
  broadcastWorkspaceTerminal,
} from "./transcript.ts";
import { getApprovalQueue } from "./approval-queue.ts";
import { getQueryQueue } from "./query-queue.ts";
import { classifyPath } from "./permissions.ts";
import type { SessionPermissionState } from "./permissions.ts";

/**
 * Configuration for the supervisor. Constructed by the server at init time.
 */
export interface WorkspaceSupervisorConfig {
  /** Path to the workspace root dir: <dataRoot>/.psycheros/workspace. */
  workspaceRoot: string;
  /** HTTP origin of this psycheros daemon, e.g. "http://localhost:3000". */
  selfOrigin: string;
  /** DB client for session persistence. */
  db: DBClient;
  /** projectRoot — codebase reads are constrained to this tree. */
  projectRoot: string;
  /** dataRoot — identity files live under `<dataRoot>/identity/`. */
  dataRoot: string;
  /** Optional override for the opencode binary path. If unset, $PATH lookup. */
  opencodePathOverride?: string;
  /**
   * Optional callback returning the LLM profile to forward to OpenCode at
   * spawn time. The profile's baseUrl + model get written into the sandbox's
   * opencode.json as a custom provider; the API key is passed via env var.
   * If the callback returns undefined or is not provided, OpenCode runs with
   * whatever default provider it has configured (typically none — sessions
   * will fail with an auth error until the user sets up a profile).
   */
  getWorkspaceLlmProfile?: () => Promise<
    | { baseUrl: string; apiKey: string; model: string }
    | undefined
  >;
  /**
   * Optional callback fired when an async workspace completes. The server
   * wires this to fire a Pulse so the entity picks up the summary on its
   * next turn. Sync sessions don't fire this — they return directly.
   */
  onAsyncComplete?: (
    sessionId: string,
    conversationId: string,
    ok: boolean,
    summary?: string,
  ) => void;
  /**
   * Run an entity turn in a given conversation. Used by engaged mode to
   * alternate entity↔OpenCode turns inside the workspace conversation. The
   * server constructs an EntityTurn with full context (identity, RAG,
   * memories, lorebook, vault) and returns the response text. If unset,
   * engaged mode fails with a configuration error.
   */
  runEntityTurn?: (
    conversationId: string,
    userMessage: string,
    options?: { pendingQuestion?: string },
  ) => Promise<string>;
  /** The entity's display name, for agent-file substitution. */
  entityName: string;
  /** Standing context block inlined into the agent file. */
  contextBlock: string;
}

/**
 * Result of opening a session — surfaces both the persisted row and the
 * OpenCode run result so callers can extract summary text and tokens.
 */
export interface OpenSessionResult {
  session: WorkspaceSession;
  run: OpenCodeRunResult;
}

/**
 * Hard ceiling on total iteration extensions per engaged session. A
 * misbehaving entity that keeps calling `extend_iterations` should hit
 * this and stop, not loop forever. 50 = 10 (base) + 40 (extensions),
 * enough for serious long-form work without being a runaway.
 */
const EXTEND_ITERATIONS_HARD_CAP = 40;

export class WorkspaceSupervisor {
  /** Active child processes keyed by session ID — used by cancelSession to kill running OpenCode. */
  private activeChildren = new Map<string, Deno.ChildProcess>();
  /**
   * Per-session permission state — tracks approvedPaths (path prefixes the
   * user/entity has approved for the session) so subsequent accesses within
   * those prefixes don't re-prompt. Initialized when a session starts;
   * cleared when the session reaches a terminal state.
   */
  private sessionPermissions = new Map<string, SessionPermissionState>();

  /**
   * Per-session iteration extensions granted by the entity via the workspace
   * `extend_iterations` action. Keyed by session ID, value is the additional
   * iterations on top of the default cap. Volatile — lost on restart, which
   * is fine since orphan cleanup marks engaged sessions failed anyway.
   * Hard ceiling at EXTEND_ITERATIONS_HARD_CAP to prevent runaways.
   */
  private iterationExtensions = new Map<string, number>();

  /**
   * Per-session heartbeat state for stall detection. An entry exists only
   * while an `invokeOpenCode` call is in flight for that session; the entry
   * is removed in the finally block when the call returns (success or
   * failure). The watchdog (heartbeatTick timer) reads this map — sessions
   * not in the map aren't checked, so the entity turn between engaged
   * iterations doesn't trip a false stall.
   *
   * `stalled` is a runtime overlay flag, not a DB status. It transitions
   * true when no event has fired within STALL_THRESHOLD_MS and the session
   * isn't waiting on a user query or approval. SSE broadcasts fire on each
   * transition so the FAB can render the stalled state.
   */
  private heartbeats = new Map<
    string,
    { lastEventAt: number; stalled: boolean }
  >();
  private heartbeatTimer?: ReturnType<typeof setInterval>;
  /** No-events threshold before marking a session stalled. */
  static readonly STALL_THRESHOLD_MS = 90_000;
  /** How often the watchdog ticks. */
  static readonly HEARTBEAT_TICK_MS = 15_000;

  constructor(private config: WorkspaceSupervisorConfig) {
    this.heartbeatTimer = setInterval(
      () => this.checkStalls(),
      WorkspaceSupervisor.HEARTBEAT_TICK_MS,
    );
  }

  /**
   * Stop the heartbeat watchdog. Called when the supervisor is being torn
   * down (currently only via test scaffolding — Server.stop doesn't dispose
   * the supervisor, but the timer is a no-op once the process exits).
   */
  dispose(): void {
    if (this.heartbeatTimer !== undefined) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
  }

  /**
   * Register a heartbeat entry for a session. Called immediately before
   * `invokeOpenCode`. The entry exists for the lifetime of that single
   * subprocess call — removed by `unregisterHeartbeat` in the finally block.
   */
  registerHeartbeat(sessionId: string): void {
    this.heartbeats.set(sessionId, {
      lastEventAt: Date.now(),
      stalled: false,
    });
  }

  /**
   * Remove a heartbeat entry. Idempotent — safe to call from a finally block
   * even if register was never called.
   */
  unregisterHeartbeat(sessionId: string): void {
    const hb = this.heartbeats.get(sessionId);
    if (hb?.stalled) {
      // If the session was stalled, broadcast resume so the UI clears the
      // indicator — but only if the session is still alive in the DB.
      const session = this.config.db.getWorkspaceSession(sessionId);
      if (session) {
        broadcastWorkspaceResumed(session.conversationId, sessionId);
      }
    }
    this.heartbeats.delete(sessionId);
  }

  /**
   * Mark activity on a session — called on every parsed OpenCode event.
   * Clears the stalled flag (and broadcasts resume) if it was set.
   */
  markSessionActivity(sessionId: string): void {
    const hb = this.heartbeats.get(sessionId);
    if (!hb) return;
    hb.lastEventAt = Date.now();
    if (hb.stalled) {
      hb.stalled = false;
      const session = this.config.db.getWorkspaceSession(sessionId);
      if (session) {
        broadcastWorkspaceResumed(session.conversationId, sessionId);
      }
    }
  }

  /**
   * Read the stalled flag for a session. Used by /api/workspace/status to
   * surface the indicator in the FAB dropdown (SSE is the primary channel;
   * this is the polling fallback).
   */
  isStalled(sessionId: string): boolean {
    return this.heartbeats.get(sessionId)?.stalled ?? false;
  }

  /**
   * Watchdog tick. Iterates active heartbeats and marks stalled any session
   * whose last event exceeds the threshold. Skips:
   *   - Sessions not in DB status "running" (suspended, complete, etc.)
   *   - Sessions with a pending query or approval (blocked on user, not stuck)
   *
   * Runs in a try/catch — an uncaught throw inside setInterval would kill
   * the daemon. Mirrors the Discord gateway watchdog pattern.
   */
  private checkStalls(): void {
    try {
      const now = Date.now();
      const approvalQueue = getApprovalQueue();
      const queryQueue = getQueryQueue();
      for (const [sessionId, hb] of this.heartbeats) {
        if (hb.stalled) continue;
        if ((now - hb.lastEventAt) < WorkspaceSupervisor.STALL_THRESHOLD_MS) {
          continue;
        }
        const session = this.config.db.getWorkspaceSession(sessionId);
        if (!session || session.status !== "running") continue;
        if (queryQueue.getPendingForSession(sessionId)) continue;
        if (approvalQueue.listPending(sessionId).length > 0) continue;
        hb.stalled = true;
        broadcastWorkspaceStalled(session.conversationId, sessionId);
      }
    } catch (err) {
      console.error("[workspace] heartbeat watchdog error:", err);
    }
  }

  /**
   * Read-only access to the config the supervisor was constructed with.
   * Used by the coordination layer to resolve projectRoot/dataRoot.
   */
  get config_(): WorkspaceSupervisorConfig {
    return this.config;
  }

  /**
   * Detect local capabilities. Called by /api/workspace/status.
   */
  async detectCapabilities(): Promise<WorkspaceCapabilities> {
    const opencodePath = (await readOpencodeBinaryPath(this.config.dataRoot)) ??
      this.config.opencodePathOverride ??
      await findOnPath("opencode");

    let opencodeVersion: string | undefined;
    if (opencodePath) {
      try {
        const result = await runCommand(opencodePath, ["--version"]);
        // Output looks like "1.18.8\n" or "opencode 1.18.8\n"
        opencodeVersion = result.stdout.trim().split(/\s+/).pop();
      } catch {
        // ignore — binary exists but errored on --version
      }
    }

    const bwrapPath = await findOnPath("bwrap");

    return {
      opencodeInstalled: Boolean(opencodePath),
      opencodePath: opencodePath,
      opencodeVersion,
      bwrapInstalled: Boolean(bwrapPath),
    };
  }

  /**
   * Open a new workspace session. The DB row is created up front so even if
   * OpenCode crashes the session is still discoverable.
   */
  async openSession(input: CreateWorkspaceInput): Promise<OpenSessionResult> {
    // 1. Create the workspace conversation row.
    const conversation = this.config.db.createConversation(
      deriveSessionTitle(input.briefing),
      { sourceType: "workspace" },
    );

    // 2. Create sandbox dir + write OpenCode config.
    const sandboxRoot = this.config.workspaceRoot;
    const paths = await ensureSandbox(
      sandboxRoot,
      conversation.id,
      input.skillFiles,
    );

    // Look up the LLM profile to forward. Profile data goes into opencode.json
    // as a custom provider; the API key is held in-process and passed via env
    // var to the OpenCode subprocess at spawn time.
    // forwardLlmProfile: false → user has OpenCode configured separately
    // and wants Psycheros to use it as-is. Skip the profile lookup entirely;
    // downstream code already handles undefined llmProfile (no provider
    // section in opencode.json, no --model arg, no env var).
    const forwardLlmProfile = await readForwardLlmProfile(this.config.dataRoot);
    const llmProfile = forwardLlmProfile && this.config.getWorkspaceLlmProfile
      ? await this.config.getWorkspaceLlmProfile()
      : undefined;

    await writeAgentsMd(paths);
    await writeOpenCodeConfig(paths, {
      mcpHttpOrigin: this.config.selfOrigin,
      sessionId: conversation.id,
      partyhard: input.partyhard ?? false,
      ...(llmProfile
        ? {
          llmProfile: { baseUrl: llmProfile.baseUrl, model: llmProfile.model },
        }
        : {}),
    });
    // House rules from workspace-settings.json — standing instructions
    // in the agent file.
    const houseRules = await readHouseRules(this.config.dataRoot);
    await Deno.writeTextFile(
      paths.agentFile,
      renderAgentFile({
        entityName: this.config.entityName,
        contextBlock: this.config.contextBlock,
        mcpServerUrl:
          `${this.config.selfOrigin}/api/workspace/mcp/${conversation.id}`,
        isolation: input.isolation,
        ...(houseRules ? { houseRules } : {}),
      }),
    );

    // 3. Create the workspace_sessions row.
    const session = this.config.db.createWorkspaceSession({
      conversationId: conversation.id,
      originConversationId: input.briefing.originConversationId,
      sandboxPath: paths.root,
      mode: input.mode,
      briefing: input.briefing,
      partyhard: input.partyhard,
      isolation: input.isolation ?? "sandboxed",
    });

    // Initialize per-session permission state for classifyPath / approvePath.
    // Tracks user-approved path prefixes so subsequent accesses within those
    // prefixes don't re-prompt. Always-ask paths from workspace-settings.json
    // override approvals — they always prompt.
    const alwaysAskPaths = await readAlwaysAskPaths(this.config.dataRoot);
    this.sessionPermissions.set(session.id, {
      approvedPaths: [],
      sandboxPath: paths.root,
      dataRoot: this.config.dataRoot,
      projectRoot: this.config.projectRoot,
      partyhard: input.partyhard ?? false,
      alwaysAskPaths,
    });

    // Workdir: an existing host folder the session works on in place.
    // Validate + classify before anything spawns — Tier 5 paths are refused
    // outright; everything else goes through a bind approval toast so the
    // user always sees (and gates) which folder the entity gets rw access to.
    let workdirReal: string | undefined;
    if (input.workdir?.trim()) {
      const home = Deno.env.get("HOME") ?? Deno.env.get("USERPROFILE") ?? "";
      const expanded = input.workdir.trim().replace(/^~(?=\/|$)/, home);
      let resolved: string;
      try {
        resolved = await Deno.realPath(expanded);
        const stat = await Deno.stat(resolved);
        if (!stat.isDirectory) throw new Error("not a directory");
      } catch {
        const error =
          `Workdir "${input.workdir}" not found or not a directory (resolved: ${expanded}).`;
        this.config.db.updateWorkspaceSessionStatus(session.id, "failed", {
          error,
        });
        return {
          session: this.config.db.getWorkspaceSession(session.id)!,
          run: { sessionId: session.id, ok: false, error, rawEvents: [] },
        };
      }

      const permState = this.sessionPermissions.get(session.id)!;
      const classification = classifyPath(resolved, permState);
      if (classification.hardBlocked) {
        const error =
          `Workdir "${resolved}" is a protected path (Tier 5) — refusing to bind.`;
        this.config.db.updateWorkspaceSessionStatus(session.id, "failed", {
          error,
        });
        return {
          session: this.config.db.getWorkspaceSession(session.id)!,
          run: { sessionId: session.id, ok: false, error, rawEvents: [] },
        };
      }

      // bwrap mounts a tmpfs over /tmp — a bind there would be silently
      // shadowed and the workdir would vanish from the namespace.
      if (
        Deno.build.os === "linux" && resolved.startsWith("/tmp/")
      ) {
        const error =
          `Workdir "${resolved}" is under /tmp — bwrap's tmpfs shadows binds there, so the folder would be invisible to the session. Use a folder outside /tmp.`;
        this.config.db.updateWorkspaceSessionStatus(session.id, "failed", {
          error,
        });
        return {
          session: this.config.db.getWorkspaceSession(session.id)!,
          run: { sessionId: session.id, ok: false, error, rawEvents: [] },
        };
      }

      // Bind approval toast. Always-ask paths flow through here too — the
      // toast IS the prompt their name promises.
      const proposal = getApprovalQueue().enqueue({
        sessionId: session.id,
        conversationId: conversation.id,
        originConversationId: input.briefing.originConversationId ?? null,
        type: "custom",
        targetId: `bind:${resolved}`,
        changes: { action: "bind", workdir: resolved },
        justification:
          `Work directly in "${resolved}" for this session (read-write, ${
            input.isolation === "feral"
              ? "soft enforcement only — Feral mode"
              : "OS-sandbox-scoped to this folder"
          })`,
        diffPreview: {
          summary: `Work in ${resolved}`,
          after:
            `The session gets read-write access to this folder for its lifetime.`,
        },
      });
      const resolvedProposal = await getApprovalQueue().waitForResolution(
        proposal.id,
      );
      if (resolvedProposal.status !== "approved") {
        const error = `Workdir bind ${resolvedProposal.status}${
          resolvedProposal.decisionReason
            ? `: ${resolvedProposal.decisionReason}`
            : ""
        }`;
        this.config.db.updateWorkspaceSessionStatus(session.id, "failed", {
          error,
        });
        return {
          session: this.config.db.getWorkspaceSession(session.id)!,
          run: { sessionId: session.id, ok: false, error, rawEvents: [] },
        };
      }
      // Remember for resume — the wrap is rebuilt there with the same bind.
      this.config.db.setWorkspaceSessionWorkdir(session.id, resolved);
      workdirReal = resolved;
    }

    // 4. Mark as running and resolve OpenCode binary.
    this.config.db.updateWorkspaceSessionStatus(session.id, "running");

    const opencodePath = (await readOpencodeBinaryPath(this.config.dataRoot)) ??
      this.config.opencodePathOverride ??
      (await findOnPath("opencode"));
    if (!opencodePath) {
      const error =
        "opencode binary not found on PATH. Install from https://opencode.ai";
      this.config.db.updateWorkspaceSessionStatus(session.id, "failed", {
        error,
      });
      return {
        session: this.config.db.getWorkspaceSession(session.id)!,
        run: { sessionId: session.id, ok: false, error, rawEvents: [] },
      };
    }

    const briefingText = input.briefing.goal +
      (input.briefing.context ? `\n\nContext: ${input.briefing.context}` : "") +
      (input.briefing.bundledSkills?.length
        ? `\n\nBundled skills (load with your skill tool): ${
          input.briefing.bundledSkills.join(", ")
        }`
        : "");

    // 30 min default — generous because ask_origin_conversation + approval
    // flows block waiting for user response. User may not be watching the
    // screen when the query fires.
    const timeoutMs = input.briefing.timeoutMs ?? 30 * 60_000;
    const args = buildOpenCodeRunArgs({
      agent: "psycheros-workspace",
      sandboxDir: paths.root,
      partyhard: input.partyhard ?? false,
      message: briefingText,
      // If we forwarded a profile, instruct OpenCode to use it via the
      // psycheros-forwarded/<model> model specifier.
      ...(llmProfile
        ? { model: `psycheros-forwarded/${llmProfile.model}` }
        : {}),
    });
    // API key passed via env var so it never lands in the config file.
    const opencodeEnv: Record<string, string> = {};
    if (llmProfile) {
      opencodeEnv.PSYCHEROS_OPENCODE_KEY = llmProfile.apiKey;
    }

    // Compute the OS sandbox wrap (bwrap on Linux, sandbox-exec on macOS).
    // When no wrap is available (Windows, or sandbox binary missing), returns
    // null and OpenCode runs directly — soft enforcement via classifyPath +
    // OpenCode permission config still applies. Feral mode explicitly skips
    // the OS sandbox — user opted into host access.
    const isolation = input.isolation ?? "sandboxed";
    const sandboxWrap = isolation === "feral" ? null : await buildSandboxArgv({
      sandboxPath: paths.root,
      projectRoot: this.config.projectRoot,
      dataRoot: this.config.dataRoot,
      ...(workdirReal ? { workdir: workdirReal } : {}),
      binary: opencodePath,
      args,
    });
    if (isolation === "feral") {
      console.log(
        `[workspace] Feral mode — no OS sandbox, OpenCode runs directly on host. Tier 5 still enforced via classifyPath.`,
      );
    } else if (sandboxWrap) {
      console.log(
        `[workspace] OS sandbox active: ${sandboxWrap.binary} (platform=${Deno.build.os})`,
      );
    } else {
      console.log(
        `[workspace] No OS sandbox available on platform=${Deno.build.os} — soft enforcement only`,
      );
    }

    // Async + engaged modes: kick off OpenCode in the background and return
    // immediately. The completion handler updates the DB and fires the
    // onAsyncComplete callback (server wires that to a Pulse).
    //
    // Async uses one-shot `invokeOpenCode`. Engaged uses the turn-based
    // `runEngagedSession`.
    if (input.mode === "async" || input.mode === "engaged") {
      const sessionId = session.id;
      // The Pulse needs to fire in the ORIGIN conversation (where the entity
      // is waiting), not the workspace conversation. If originConversationId
      // is missing for some reason, fall back to the workspace conversation.
      const originConversationId = input.briefing.originConversationId ??
        conversation.id;
      const db = this.config.db;
      const onAsyncComplete = this.config.onAsyncComplete;
      const runEntityTurn = this.config.runEntityTurn;

      // Engaged mode without a runEntityTurn callback can't actually do the
      // back-and-forth — bail with a clear error before spawning.
      if (input.mode === "engaged" && !runEntityTurn) {
        const error =
          "Engaged mode requires runEntityTurn callback to be wired (server config). Cannot proceed.";
        db.updateWorkspaceSessionStatus(sessionId, "failed", { error });
        return {
          session: db.getWorkspaceSession(sessionId)!,
          run: { sessionId, ok: false, error, rawEvents: [] },
        };
      }

      // Build the per-mode runner promise. Both resolve to OpenCodeRunResult.
      this.registerHeartbeat(sessionId);
      const runPromise = input.mode === "engaged" && runEntityTurn
        ? runEngagedSession({
          db: this.config.db,
          sessionId: session.id,
          conversationId: conversation.id,
          sandboxPath: paths.root,
          briefing: briefingText,
          opencodePath,
          llmProfile,
          sandboxWrap,
          opencodeEnv,
          partyhard: input.partyhard ?? false,
          entityName: this.config.entityName,
          runEntityTurn,
          getExtensionIterations: () =>
            this.iterationExtensions.get(session.id) ?? 0,
        })
        : invokeOpenCode(
          opencodePath,
          args,
          timeoutMs,
          (child) => {
            this.activeChildren.set(sessionId, child);
          },
          (event) => {
            this.markSessionActivity(sessionId);
            broadcastWorkspaceEvent(conversation.id, event);
          },
          opencodeEnv,
          sandboxWrap ?? undefined,
        );

      // Fire-and-forget — the entity's turn ends, the run continues.
      // Events stream live to any open workspace window via SSE.
      runPromise
        .then(async (run) => {
          if (run.tokensUsed) {
            db.incrementWorkspaceSessionTokens(sessionId, run.tokensUsed);
          }

          // Suspend model: if the engaged-runner detected a pending
          // ask_user / ask_origin_conversation, it returns with
          // `suspended: true`. Mark the session `suspended`; the user's
          // answer resumes via /respond → resumeSession. No Pulse and no
          // terminal broadcast — the FAB `!` badge is the recovery path.
          if (run.suspended) {
            db.updateWorkspaceSessionStatus(sessionId, "suspended", {
              opencodeSessionId: run.sessionId,
            });
            if (run.finalText) {
              db.setWorkspaceSessionSummary(sessionId, run.finalText);
            }
            this.activeChildren.delete(sessionId);
            return;
          }

          // Async path: OpenCode-side ask_origin_conversation enqueues a
          // query directly via the coordination layer. If a pending query is
          // found after the run, mark `suspended`. No Pulse — `!` badge is
          // the recovery path.
          const pendingQuery = getQueryQueue().getPendingForSession(sessionId);
          if (pendingQuery) {
            db.updateWorkspaceSessionStatus(sessionId, "suspended", {
              opencodeSessionId: run.sessionId,
            });
            if (run.finalText) {
              db.setWorkspaceSessionSummary(sessionId, run.finalText);
            }
            this.activeChildren.delete(sessionId);
            return;
          }

          // Broadcast terminal status marker to the workspace window.
          broadcastWorkspaceTerminal(
            conversation.id,
            run.ok ? "complete" : "failed",
            run.error,
          );

          if (run.ok) {
            db.updateWorkspaceSessionStatus(sessionId, "complete", {
              opencodeSessionId: run.sessionId,
            });
          } else {
            db.updateWorkspaceSessionStatus(sessionId, "failed", {
              error: run.error,
              opencodeSessionId: run.sessionId,
            });
          }

          // Stash the full finalText as summary — no truncation at storage
          // time. The entity-facing context budget is enforced downstream
          // (handleWorkspaceAsyncComplete) via smart paragraph-boundary
          // truncation. Storing full preserves the canonical record for the
          // history view and future reference.
          if (run.finalText) {
            db.setWorkspaceSessionSummary(sessionId, run.finalText);
          }
          onAsyncComplete?.(
            sessionId,
            originConversationId,
            run.ok,
            run.finalText,
          );
          // Cancel orphaned queries/approvals — workspace ended.
          this.activeChildren.delete(sessionId);
          cleanupSessionPending(sessionId);
        })
        .catch((err) => {
          const error = err instanceof Error ? err.message : String(err);
          db.updateWorkspaceSessionStatus(sessionId, "failed", { error });
          onAsyncComplete?.(sessionId, originConversationId, false, undefined);
          this.activeChildren.delete(sessionId);
          cleanupSessionPending(sessionId);
        })
        .finally(() => {
          this.unregisterHeartbeat(sessionId);
        });

      return {
        session: db.getWorkspaceSession(sessionId)!,
        run: {
          sessionId,
          ok: true,
          rawEvents: [],
        },
      };
    }

    // Sync/collaborative mode: await the result inline.
    // Events stream live to any open workspace window via SSE.
    let run: OpenCodeRunResult;
    this.registerHeartbeat(session.id);
    try {
      run = await invokeOpenCode(
        opencodePath,
        args,
        timeoutMs,
        (child) => {
          this.activeChildren.set(session.id, child);
        },
        (event) => {
          this.markSessionActivity(session.id);
          broadcastWorkspaceEvent(conversation.id, event);
        },
        opencodeEnv,
        sandboxWrap ?? undefined,
      );
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      run = { sessionId: session.id, ok: false, error, rawEvents: [] };
    } finally {
      this.unregisterHeartbeat(session.id);
    }

    // Check for pending queries (ask_origin_conversation fired during sync —
    // per §8 unified design + §14 suspend model). If found, mark session as
    // `suspended` and DON'T clean up. The workspace tool (handleOpen) returns
    // the suspend message to the entity; the entity's agent loop ends. When
    // the user answers via /respond → resumeSession, the workspace continues.
    const pendingQuery = getQueryQueue().getPendingForSession(session.id);
    if (pendingQuery) {
      this.config.db.updateWorkspaceSessionStatus(
        session.id,
        "suspended",
        { opencodeSessionId: run.sessionId },
      );
      // Don't broadcast terminal — "suspended" isn't terminal. The query queue
      // already broadcast a toast when the query was enqueued. The workspace
      // tool result will surface the question to the entity.
      this.activeChildren.delete(session.id);
      // NOTE: don't call cleanupSessionPending — the query is still pending!
    } else {
      // Broadcast terminal status marker to the workspace window.
      broadcastWorkspaceTerminal(
        conversation.id,
        run.ok ? "complete" : "failed",
        run.error,
      );

      // Update session with outcome.
      if (run.ok) {
        this.config.db.updateWorkspaceSessionStatus(session.id, "complete", {
          opencodeSessionId: run.sessionId,
        });
      } else {
        this.config.db.updateWorkspaceSessionStatus(session.id, "failed", {
          error: run.error,
          opencodeSessionId: run.sessionId,
        });
      }

      // Cancel any pending queries/approvals for this session — the
      // workspace has ended and won't be waiting for answers anymore.
      // Without this, orphaned toasts would linger for 25 minutes.
      this.activeChildren.delete(session.id);
      cleanupSessionPending(session.id);
    }

    if (run.tokensUsed) {
      this.config.db.incrementWorkspaceSessionTokens(
        session.id,
        run.tokensUsed,
      );
    }

    return {
      session: this.config.db.getWorkspaceSession(session.id)!,
      run,
    };
  }

  /**
   * Total iteration cap for a session, including any extensions the entity
   * granted via the workspace `extend_iterations` action. Read by the
   * engaged-runner on every iteration check.
   */
  getIterationCap(sessionId: string, base = 10): number {
    return base + (this.iterationExtensions.get(sessionId) ?? 0);
  }

  /**
   * Add iterations to a session's cap. Called by the workspace tool's
   * `extend_iterations` action. Returns the new total cap (base + extensions).
   *
   * Hard-capped at EXTEND_ITERATIONS_HARD_CAP (50) per session — a
   * misbehaving entity that keeps extending should hit the ceiling and
   * stop, not loop forever. Entity should call `end_session` when work is
   * done; this is for "I need more turns than I thought" cases.
   */
  extendIterations(sessionId: string, additional: number): {
    ok: boolean;
    newCap?: number;
    error?: string;
  } {
    if (additional <= 0) {
      return { ok: false, error: "additional must be > 0" };
    }
    if (additional > 20) {
      return {
        ok: false,
        error:
          "can't add more than 20 iterations per call (use multiple calls)",
      };
    }
    const current = this.iterationExtensions.get(sessionId) ?? 0;
    const newTotal = current + additional;
    if (newTotal > EXTEND_ITERATIONS_HARD_CAP) {
      return {
        ok: false,
        error:
          `hard ceiling is ${EXTEND_ITERATIONS_HARD_CAP} total extensions per session (currently at ${current})`,
      };
    }
    this.iterationExtensions.set(sessionId, newTotal);
    console.log(
      `[workspace] session ${sessionId} extended by ${additional} → total extension ${newTotal} (cap now ${
        10 + newTotal
      })`,
    );
    return { ok: true, newCap: 10 + newTotal };
  }

  /**
   * Look up a session by ID. Returns null if not found.
   */
  getSession(id: string): WorkspaceSession | null {
    return this.config.db.getWorkspaceSession(id);
  }

  /**
   * Get the per-session permission state for classifyPath / approvePath.
   * Returns null if session doesn't exist or hasn't been initialized.
   *
   * Used by the coordination layer to gate filesystem-touching MCP tool
   * calls consistently with the user's per-session approvals.
   */
  getSessionPermission(id: string): SessionPermissionState | null {
    return this.sessionPermissions.get(id) ?? null;
  }

  /**
   * Look up the workspace session associated with a workspace-type conversation.
   */
  getSessionByConversation(conversationId: string): WorkspaceSession | null {
    return this.config.db.getWorkspaceSessionByConversation(conversationId);
  }

  /**
   * List active sessions — for the workspace icon badge count and the active
   * session list view.
   */
  listActiveSessions(): WorkspaceSession[] {
    return this.config.db.listActiveWorkspaceSessions();
  }

  /**
   * List sessions originating from a given conversation — for the "previous
   * workspaces spawned from this chat" view.
   */
  listSessionsForOriginConversation(
    originConversationId: string,
  ): WorkspaceSession[] {
    return this.config.db.listWorkspaceSessions({ originConversationId });
  }

  /**
   * Kill a running OpenCode subprocess for a session. Sends SIGTERM — whether
   * OpenCode handles this gracefully (saves session state for --continue) is
   * UNTESTED. The DB row is marked cancelled regardless.
   *
   * Also cleans up pending queries/approvals so orphaned toasts dismiss.
   */
  killSession(sessionId: string): boolean {
    const child = this.activeChildren.get(sessionId);
    if (child) {
      try {
        child.kill("SIGTERM");
      } catch {
        // Process may already be dead — ignore.
      }
      this.activeChildren.delete(sessionId);
    }
    this.config.db.updateWorkspaceSessionStatus(sessionId, "cancelled");
    cleanupSessionPending(sessionId);
    return Boolean(child);
  }

  /**
   * Resume an existing session with a new instruction. Used by:
   *   - The workspace `resume` action (entity manually continues a session)
   *   - The /respond endpoint (user answered a pending query; the answer
   *     becomes the new instruction)
   *
   * For sync/async: uses OpenCode's `--session <id> --continue` to append a
   * message to the existing conversation history.
   *
   * For engaged (e.g. resuming from suspend): re-invokes runEngagedSession
   * with `resumeFrom` set — the runner starts directly at iteration 1 in
   * `--continue` mode using the user's answer.
   *
   * The session must have an opencodeSessionId (set when the original run
   * captured the session ID from OpenCode's event stream).
   */
  async resumeSession(
    sessionId: string,
    newInstruction: string,
  ): Promise<OpenSessionResult> {
    const session = this.config.db.getWorkspaceSession(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    if (!session.opencodeSessionId) {
      throw new Error(
        `Session ${sessionId} has no OpenCode session ID — can't resume. ` +
          `(This happens if the original run didn't capture the session ID from OpenCode's event stream.)`,
      );
    }

    this.config.db.updateWorkspaceSessionStatus(sessionId, "running");

    const opencodePath = (await readOpencodeBinaryPath(this.config.dataRoot)) ??
      this.config.opencodePathOverride ??
      (await findOnPath("opencode"));
    if (!opencodePath) {
      throw new Error("opencode binary not found on PATH.");
    }

    // Reuse the same LLM profile the original session used (looked up fresh —
    // if the user updated the profile since, the new values take effect).
    // forwardLlmProfile: false → user has OpenCode configured separately
    // and wants Psycheros to use it as-is. Skip the profile lookup entirely;
    // downstream code already handles undefined llmProfile (no provider
    // section in opencode.json, no --model arg, no env var).
    const forwardLlmProfile = await readForwardLlmProfile(this.config.dataRoot);
    const llmProfile = forwardLlmProfile && this.config.getWorkspaceLlmProfile
      ? await this.config.getWorkspaceLlmProfile()
      : undefined;
    const opencodeEnv: Record<string, string> = {};
    if (llmProfile) {
      opencodeEnv.PSYCHEROS_OPENCODE_KEY = llmProfile.apiKey;
    }

    // Compute the OS sandbox wrap. Resume honors the original session's
    // isolation — a feral session continues feral, a sandboxed session
    // continues sandboxed. The session row carries the isolation field.
    const isolation = session.isolation ?? "sandboxed";

    // Engaged mode resume: re-invoke runEngagedSession with resumeFrom. The
    // runner picks up at iteration 1 in --continue mode using the answer.
    if (session.mode === "engaged" && this.config.runEntityTurn) {
      const sandboxWrap = isolation === "feral"
        ? null
        : await buildSandboxArgv({
          sandboxPath: session.sandboxPath,
          projectRoot: this.config.projectRoot,
          dataRoot: this.config.dataRoot,
          ...(session.workdir ? { workdir: session.workdir } : {}),
          binary: opencodePath,
          args: [], // rebuilt per-iteration by engaged-runner
        });

      let run: OpenCodeRunResult;
      try {
        run = await runEngagedSession({
          db: this.config.db,
          sessionId: session.id,
          conversationId: session.conversationId,
          sandboxPath: session.sandboxPath,
          briefing: "(resuming engaged session)", // unused on resume
          opencodePath,
          llmProfile,
          sandboxWrap,
          opencodeEnv,
          partyhard: Boolean(session.partyhard),
          entityName: this.config.entityName,
          runEntityTurn: this.config.runEntityTurn,
          getExtensionIterations: () =>
            this.iterationExtensions.get(session.id) ?? 0,
          resumeFrom: {
            answer: newInstruction,
            opencodeSessionId: session.opencodeSessionId,
          },
        });
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        run = {
          sessionId: session.opencodeSessionId,
          ok: false,
          error,
          rawEvents: [],
        };
      }

      // Suspended again (ask_user fired on resume). Re-mark suspended.
      if (run.suspended) {
        this.config.db.updateWorkspaceSessionStatus(sessionId, "suspended", {
          opencodeSessionId: run.sessionId,
        });
        this.activeChildren.delete(sessionId);
        return {
          session: this.config.db.getWorkspaceSession(sessionId)!,
          run,
        };
      }

      broadcastWorkspaceTerminal(
        session.conversationId,
        run.ok ? "complete" : "failed",
        run.error,
      );
      if (run.ok) {
        this.config.db.updateWorkspaceSessionStatus(sessionId, "complete");
      } else {
        this.config.db.updateWorkspaceSessionStatus(sessionId, "failed", {
          error: run.error,
        });
      }
      if (run.tokensUsed) {
        this.config.db.incrementWorkspaceSessionTokens(
          sessionId,
          run.tokensUsed,
        );
      }
      this.activeChildren.delete(sessionId);
      cleanupSessionPending(sessionId);

      // Fire onAsyncComplete so the entity in main chat gets a Pulse with
      // the resumed result. Without this, the resumed engaged workspace
      // completes silently and the entity never learns what happened.
      // (Initial openSession run fires this via runPromise.then; resume
      // doesn't go through that path.)
      if (run.finalText) {
        this.config.db.setWorkspaceSessionSummary(sessionId, run.finalText);
      }
      this.config.onAsyncComplete?.(
        sessionId,
        session.originConversationId ?? session.conversationId,
        run.ok,
        run.finalText,
      );

      return {
        session: this.config.db.getWorkspaceSession(sessionId)!,
        run,
      };
    }

    // Sync/async resume: one-shot invokeOpenCode with --continue.
    const args = [
      "run",
      "--format",
      "json",
      "--agent",
      "psycheros-workspace",
      "--dir",
      session.sandboxPath,
      "--session",
      session.opencodeSessionId,
      "--continue",
      ...(llmProfile
        ? ["--model", `psycheros-forwarded/${llmProfile.model}`]
        : []),
      newInstruction,
    ];

    const sandboxWrap = isolation === "feral" ? null : await buildSandboxArgv({
      sandboxPath: session.sandboxPath,
      projectRoot: this.config.projectRoot,
      dataRoot: this.config.dataRoot,
      ...(session.workdir ? { workdir: session.workdir } : {}),
      binary: opencodePath,
      args,
    });

    const timeoutMs = 30 * 60_000;
    let run: OpenCodeRunResult;
    this.registerHeartbeat(sessionId);
    try {
      run = await invokeOpenCode(
        opencodePath,
        args,
        timeoutMs,
        (child) => {
          this.activeChildren.set(sessionId, child);
        },
        (event) => {
          this.markSessionActivity(sessionId);
          broadcastWorkspaceEvent(session.conversationId, event);
        },
        opencodeEnv,
        sandboxWrap ?? undefined,
      );
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      run = {
        sessionId: session.opencodeSessionId,
        ok: false,
        error,
        rawEvents: [],
      };
    } finally {
      this.unregisterHeartbeat(sessionId);
    }

    // If OpenCode asked another question during the resumed run, suspend
    // again instead of marking complete.
    const pendingQuery = getQueryQueue().getPendingForSession(sessionId);
    if (pendingQuery) {
      this.config.db.updateWorkspaceSessionStatus(sessionId, "suspended", {
        opencodeSessionId: run.sessionId,
      });
      this.activeChildren.delete(sessionId);
      // Don't cleanupSessionPending — query is still pending.
      return {
        session: this.config.db.getWorkspaceSession(sessionId)!,
        run,
      };
    }

    // Broadcast terminal status marker to the workspace window.
    broadcastWorkspaceTerminal(
      session.conversationId,
      run.ok ? "complete" : "failed",
      run.error,
    );

    if (run.ok) {
      this.config.db.updateWorkspaceSessionStatus(sessionId, "complete");
    } else {
      this.config.db.updateWorkspaceSessionStatus(sessionId, "failed", {
        error: run.error,
      });
    }

    if (run.tokensUsed) {
      this.config.db.incrementWorkspaceSessionTokens(sessionId, run.tokensUsed);
    }

    // Stash the summary — same rationale as the initial-run path.
    if (run.finalText) {
      this.config.db.setWorkspaceSessionSummary(sessionId, run.finalText);
    }

    this.activeChildren.delete(sessionId);
    cleanupSessionPending(sessionId);

    // Fire onAsyncComplete so the entity gets a Pulse with the resumed
    // result. Without this, a sync/async workspace that was suspended and
    // then resumed via /respond would complete silently — the entity that
    // originally dispatched it never learns the outcome.
    this.config.onAsyncComplete?.(
      sessionId,
      session.originConversationId ?? session.conversationId,
      run.ok,
      run.finalText,
    );

    return {
      session: this.config.db.getWorkspaceSession(sessionId)!,
      run,
    };
  }
}

// =============================================================================
// Module-level singleton — mirrors getBroadcaster() pattern
// =============================================================================

let activeSupervisor: WorkspaceSupervisor | null = null;

/**
 * Install the workspace supervisor. Called once during Server.init() after
 * the DB client is ready.
 */
export function setWorkspaceSupervisor(supervisor: WorkspaceSupervisor): void {
  activeSupervisor = supervisor;
}

/**
 * Access the workspace supervisor. Returns null if not initialized (e.g.
 * during early startup or if the feature is disabled).
 */
export function getWorkspaceSupervisor(): WorkspaceSupervisor | null {
  return activeSupervisor;
}

/**
 * Free-function heartbeat activity marker. Engaged-runner uses this from its
 * per-event callback so it doesn't need a direct supervisor reference — the
 * supervisor owns register/unregister lifecycle, the runner just refreshes
 * activity as events flow.
 */
export function markWorkspaceActivity(sessionId: string): void {
  activeSupervisor?.markSessionActivity(sessionId);
}

/**
 * Read the entity's display name. Single source of truth: general-settings
 * (`entityName`, the same name used everywhere else in the app — chat
 * headers, seed substitutions). Shared by the server init path and the
 * terminal-view fragment renderer. Falls back to "the entity" if unset.
 */
export async function readWorkspaceEntityName(
  dataRoot: string,
): Promise<string> {
  try {
    const text = await Deno.readTextFile(
      `${dataRoot}/.psycheros/general-settings.json`,
    );
    const settings = JSON.parse(text) as { entityName?: string };
    if (settings.entityName?.trim()) {
      return settings.entityName.trim();
    }
  } catch {
    // No settings file — fall through
  }
  return "the entity";
}

// =============================================================================
// Helpers
// =============================================================================

/**
 * Cancel any pending queries and approvals for a session. Called when the
 * session reaches terminal status — without this, orphaned toasts linger
 * for the 25-min timeout, showing the user prompts the workspace is no
 * longer waiting to receive.
 */
function cleanupSessionPending(sessionId: string): void {
  try {
    const qCancelled = getQueryQueue().cancelAllForSession(sessionId);
    // Approval queue's listPending(sessionId) returns proposals; deny each
    // so the workspace (if it's still around somehow) sees a clean rejection
    // rather than a 25-min expiration.
    const pendingApprovals = getApprovalQueue().listPending(sessionId);
    for (const p of pendingApprovals) {
      getApprovalQueue().deny(
        p.id,
        "system",
        "session ended while proposal pending",
      );
    }
    if (qCancelled > 0 || pendingApprovals.length > 0) {
      console.log(
        `[workspace] cleaned up session ${sessionId}: ${qCancelled} queries, ${pendingApprovals.length} approvals`,
      );
    }
  } catch (err) {
    console.error("[workspace] cleanupSessionPending failed:", err);
  }
}

/**
 * Build the argv for `opencode run`. The agent file lives at
 * <sandbox>/.opencode/agents/psycheros-workspace.md and OpenCode picks it up
 * automatically because we use `--agent psycheros-workspace` (matches filename).
 */
export function buildOpenCodeRunArgs(input: {
  agent: string;
  sandboxDir: string;
  partyhard: boolean;
  message: string;
  model?: string;
}): string[] {
  return [
    "run",
    "--format",
    "json",
    "--agent",
    input.agent,
    "--dir",
    input.sandboxDir,
    ...(input.model ? ["--model", input.model] : []),
    // Partyhard (--auto) disabled — OpenCode's --auto doesn't reliably gate
    // in headless mode (opencode issues #13851, #16367) and bypassing the
    // entity-data write approval has no clear use case.
    // ...(input.partyhard ? ["--auto"] : []),
    input.message,
  ];
}

/**
 * Invoke `opencode` with the given args. Streams stdout line-by-line as JSON
 * events. Resolves when OpenCode exits.
 *
 * `onEvent`, if provided, is fired for each parsed JSON event — used for live
 * streaming the transcript to the workspace conversation as events arrive.
 *
 * `env`, if provided, is merged into the subprocess environment. Used to
 * pass the forwarded LLM profile's API key (PSYCHEROS_OPENCODE_KEY) without
 * writing it to disk.
 */
export async function invokeOpenCode(
  opencodePath: string,
  args: string[],
  timeoutMs: number,
  onChildSpawn?: (child: Deno.ChildProcess) => void,
  onEvent?: (event: OpenCodeEvent) => void,
  env?: Record<string, string>,
  sandboxWrap?: {
    binary: string;
    args: string[];
  },
): Promise<OpenCodeRunResult> {
  // Sandbox wrap (bwrap on Linux, sandbox-exec on macOS) takes precedence —
  // the binary becomes the sandbox runner and the OpenCode command becomes
  // an argument to it. When no wrap is provided (Windows, or sandbox binary
  // missing), run OpenCode directly with soft enforcement (classifyPath +
  // OpenCode permission config).
  const actualBinary = sandboxWrap?.binary ?? opencodePath;
  const actualArgs = sandboxWrap?.args ?? args;
  const command = new Deno.Command(actualBinary, {
    args: actualArgs,
    stdout: "piped",
    stderr: "piped",
    stdin: "null",
    ...(env ? { env: { ...Deno.env.toObject(), ...env } } : {}),
  });

  const child = command.spawn();
  onChildSpawn?.(child);
  const events: OpenCodeEvent[] = [];
  let firstSessionId: string | undefined;
  let finalText: string | undefined;
  let longestText: string | undefined;
  let lastError: string | undefined;

  // Stream stdout as JSON events.
  const decoder = new TextDecoder();
  // Capture stderr — bwrap, opencode, and shell errors go here. Without this,
  // a bwrap bind-path failure or opencode startup crash would silently exit
  // and the supervisor would see "unknown error" with no clue why.
  let stderrText = "";
  const stderrPromise = (async () => {
    const reader = child.stderr.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        stderrText += decoder.decode(value, { stream: true });
      }
    } finally {
      reader.releaseLock();
    }
  })();
  const stdoutPromise = (async () => {
    const reader = child.stdout.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = decoder.decode(value, { stream: true });
        // Process complete lines — events accumulate in `events` for
        // post-run summary distillation; everything else is processed
        // in-flight and not retained.
        for (const line of text.split("\n")) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("{")) continue;
          try {
            const event = JSON.parse(trimmed) as OpenCodeEvent;
            events.push(event);
            // Live-stream each parsed event to the workspace conversation.
            // Failures inside the callback (e.g. DB write error logged inside
            // streamEventToConversation) don't break the stream.
            try {
              onEvent?.(event);
            } catch (err) {
              console.error("[workspace] onEvent callback failed:", err);
            }
            if (event.sessionID && !firstSessionId) {
              firstSessionId = event.sessionID;
            }
            if (event.type === "error") {
              const err = event.error as
                | { data?: { message?: string } }
                | undefined;
              lastError = err?.data?.message ?? JSON.stringify(event.error);
            }
            // OpenCode JSON event schema:
            //   { type: "text", part: { text: "...", ... } }
            // Older schema had event.text directly; both paths covered.
            if (
              event.type === "text" || event.type === "assistant" ||
              event.type === "message"
            ) {
              const partText = (event as { part?: { text?: string } }).part
                ?.text;
              const directText = (event as { text?: string }).text;
              const text = partText ?? directText;
              if (typeof text === "string" && text.trim()) {
                finalText = text;
                // Track the longest text event as a fallback — OpenCode's last
                // text is sometimes a plan/intent rather than the actual work
                // output. The longest text is more likely to be the deliverable.
                if (
                  !longestText ||
                  text.length > longestText.length
                ) {
                  longestText = text;
                }
              }
            }
            // tool_use events carry tool execution outcome — capture errors
            // so we can surface them in the run result.
            if (event.type === "tool_use") {
              const part = (event as {
                part?: { state?: { status?: string; error?: string } };
              }).part;
              if (part?.state?.status === "error" && part.state.error) {
                lastError = part.state.error;
              }
            }
          } catch {
            // Not JSON — ignore. (Could be progress output, etc.)
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  })();

  // Race between completion and timeout.
  const timeout = new Promise<{ timedOut: true }>((resolve) =>
    setTimeout(() => resolve({ timedOut: true }), timeoutMs)
  );

  const status = await Promise.race([
    child.status,
    timeout,
  ]);

  if ("timedOut" in status) {
    try {
      child.kill("SIGTERM");
    } catch {
      // ignore — child may already be dead
    }
    // Grace period for SIGTERM to take effect. If the child is still alive
    // after 5s (bwrap didn't propagate, opencode is hung ignoring signals,
    // or grandchildren are stuck), escalate to SIGKILL. Without this, the
    // supervisor marks the session failed but the subprocess keeps running.
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    try {
      child.kill("SIGKILL");
    } catch {
      // already dead — fine
    }
    await Promise.all([
      stdoutPromise.catch(() => {}),
      stderrPromise.catch(() => {}),
    ]);
    return {
      sessionId: firstSessionId ?? "",
      finalText,
      ok: false,
      error: `Timed out after ${timeoutMs}ms${
        stderrText ? `\nstderr:\n${stderrText.slice(0, 1000)}` : ""
      }`,
      rawEvents: events,
    };
  }

  await Promise.all([
    stdoutPromise.catch(() => {}),
    stderrPromise.catch(() => {}),
  ]);

  // OpenCode's session "succeeded" if the subprocess exited cleanly, even if
  // individual tool_use events errored (those are normal — the LLM recovers
  // from them, learns the boundaries, and continues). lastError is captured
  // for surfacing in the run result but doesn't fail the session.
  // Exception: if the session ended with no useful output AND there was an
  // error, that's a real failure.
  const ok = status.success;
  // Prefer the longest text event over the last one — OpenCode's final text
  // is sometimes a plan/intent rather than the actual deliverable. The longest
  // text is more likely to be the substantive work output.
  const preferredText = longestText ?? finalText;
  // If subprocess failed and we have stderr, surface it — bwrap bind errors,
  // opencode startup crashes, etc. all land here. Without this the entity
  // sees "unknown error" with no diagnostic.
  let error = lastError;
  if (!ok && !error && stderrText.trim()) {
    error = stderrText.trim().slice(0, 1000);
  }
  return {
    sessionId: firstSessionId ?? "",
    finalText: preferredText,
    ok,
    error,
    tokensUsed: extractTokenUsage(events),
    rawEvents: events,
  };
}

/**
 * Pull token usage out of the event stream: step_finish events carry
 * part.tokens.total.
 */
function extractTokenUsage(events: OpenCodeEvent[]): number | undefined {
  for (const event of events) {
    // Verified schema: { type: "step_finish", part: { tokens: { total: N } } }
    const partTokens = (event as { part?: { tokens?: { total?: number } } })
      .part
      ?.tokens?.total;
    if (typeof partTokens === "number") return partTokens;

    // Older fallback: top-level usage.total_tokens
    const usage = (event as { usage?: { total_tokens?: number } }).usage;
    if (usage?.total_tokens && typeof usage.total_tokens === "number") {
      return usage.total_tokens;
    }
  }
  return undefined;
}

/**
 * Run a command and capture stdout/stderr. Returns trimmed output strings.
 */
async function runCommand(
  cmd: string,
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  const command = new Deno.Command(cmd, {
    args,
    stdout: "piped",
    stderr: "piped",
  });
  const { stdout, stderr } = await command.output();
  return {
    stdout: new TextDecoder().decode(stdout),
    stderr: new TextDecoder().decode(stderr),
  };
}

/**
 * Look up a binary on $PATH. Returns undefined if not found.
 *
 * Tries `which` first, then falls back to a list of common locations
 * (including `~/.opencode/bin/` where the curl installer puts OpenCode).
 * The fallback list runs when `which` reports the binary isn't on PATH
 * (success=false) OR when `which` itself is unavailable — either way,
 * callers get a final shot at finding the binary in known locations.
 */
async function findOnPath(name: string): Promise<string | undefined> {
  // Try `which` first.
  try {
    const command = new Deno.Command("which", {
      args: [name],
      stdout: "piped",
      stderr: "piped",
    });
    const { stdout, success } = await command.output();
    if (success) {
      const path = new TextDecoder().decode(stdout).trim().split("\n")[0];
      if (path) return path;
    }
    // success=false → binary not on PATH. Fall through to candidate paths.
  } catch {
    // `which` itself unavailable — fall through to candidate paths.
  }

  // Common locations, including `~/.opencode/bin/` (curl installer default).
  for (
    const candidate of [
      `/usr/bin/${name}`,
      `/usr/local/bin/${name}`,
      `${Deno.env.get("HOME")}/.local/bin/${name}`,
      `${Deno.env.get("HOME")}/.opencode/bin/${name}`,
    ]
  ) {
    try {
      await Deno.stat(candidate);
      return candidate;
    } catch {
      // not present
    }
  }
  return undefined;
}

/**
 * Read user-defined always-ask paths from workspace-settings.json.
 * Each entry is realpath-resolved so classification compares like paths.
 */
async function readAlwaysAskPaths(dataRoot: string): Promise<string[]> {
  try {
    const text = await Deno.readTextFile(
      `${dataRoot}/.psycheros/workspace-settings.json`,
    );
    const settings = JSON.parse(text) as { alwaysAskPaths?: string[] };
    if (!Array.isArray(settings.alwaysAskPaths)) return [];
    const resolved: string[] = [];
    for (const p of settings.alwaysAskPaths) {
      if (typeof p !== "string" || p.trim().length === 0) continue;
      try {
        resolved.push(await Deno.realPath(p));
      } catch {
        // Path doesn't exist yet — fall back to as-is (classifyPath also
        // falls back when realpath fails).
        resolved.push(p);
      }
    }
    return resolved;
  } catch {
    return [];
  }
}

/**
 * Read user-defined house rules from workspace-settings.json.
 * Free-form prose; injected into the agent file AND the entity's
 * workspace-context systemPromptSuffix at session spawn.
 */
async function readHouseRules(dataRoot: string): Promise<string | undefined> {
  try {
    const text = await Deno.readTextFile(
      `${dataRoot}/.psycheros/workspace-settings.json`,
    );
    const settings = JSON.parse(text) as { houseRules?: string };
    if (
      typeof settings.houseRules !== "string" ||
      settings.houseRules.trim().length === 0
    ) {
      return undefined;
    }
    return settings.houseRules;
  } catch {
    return undefined;
  }
}

/**
 * Read user-configured opencode binary path. Some users install OpenCode
 * via npm / brew / scoop / choco / AUR — paths that don't match the
 * `which opencode` + `~/.opencode/bin/opencode` fallback chain. This lets
 * them point at wherever their install lives. Returns undefined if unset
 * (caller falls back to the default search).
 */
async function readOpencodeBinaryPath(
  dataRoot: string,
): Promise<string | undefined> {
  try {
    const text = await Deno.readTextFile(
      `${dataRoot}/.psycheros/workspace-settings.json`,
    );
    const settings = JSON.parse(text) as { opencodeBinaryPath?: string };
    if (
      typeof settings.opencodeBinaryPath !== "string" ||
      settings.opencodeBinaryPath.trim().length === 0
    ) {
      return undefined;
    }
    return settings.opencodeBinaryPath.trim();
  } catch {
    return undefined;
  }
}

/**
 * Read LLM-profile-forwarding preference. Defaults to `true` (forward the
 * Psycheros LLM profile into per-session opencode.json). Set to `false` for
 * users who already have OpenCode configured with their own auth and want
 * Psycheros to use it as-is rather than injecting credentials.
 */
async function readForwardLlmProfile(
  dataRoot: string,
): Promise<boolean> {
  try {
    const text = await Deno.readTextFile(
      `${dataRoot}/.psycheros/workspace-settings.json`,
    );
    const settings = JSON.parse(text) as { forwardLlmProfile?: boolean };
    // Explicit-false: any other value (unset, null, true) keeps default behavior.
    return settings.forwardLlmProfile !== false;
  } catch {
    return true;
  }
}

/**
 * Read the sandbox retention window (days) from workspace-settings.json.
 * Default 7. 0 disables retention entirely.
 */
export async function readSandboxRetentionDays(
  dataRoot: string,
): Promise<number> {
  try {
    const text = await Deno.readTextFile(
      `${dataRoot}/.psycheros/workspace-settings.json`,
    );
    const settings = JSON.parse(text) as { sandboxRetentionDays?: unknown };
    if (typeof settings.sandboxRetentionDays === "number") {
      return Math.max(0, Math.floor(settings.sandboxRetentionDays));
    }
  } catch {
    // No settings file — fall through to default
  }
  return 7;
}

/**
 * Delete sandbox dirs — and their conversations — for terminal sessions older
 * than the retention window. Deleting the conversation cascades the
 * workspace_sessions row (briefing/summary history) and the engaged-turn
 * messages; the workspace scratchpad is ephemeral by design, so past-retention
 * sessions leave nothing behind.
 *
 * Never touches sandboxes of non-terminal sessions (running, suspended —
 * suspended still await user answers and must stay resumable).
 *
 * Also sweeps orphan workspace conversations whose session row is already
 * gone (e.g. conversations deleted-session legacy rows).
 *
 * Each sandbox runs ~63MB (OpenCode bootstraps its own node_modules per
 * project dir), so this is the main disk-cost control for the feature.
 */
export async function runSandboxRetention(
  workspaceRoot: string,
  db: DBClient,
  retentionDays: number,
): Promise<
  { cleaned: number; errors: number; reclaimedBytes: number }
> {
  if (retentionDays <= 0) return { cleaned: 0, errors: 0, reclaimedBytes: 0 };

  // Orphan sweep: workspace conversations with no session row. Their sessions
  // can never come back, so nothing is resumable — pure scratchpad residue.
  const orphanStmt = db.getRawDb().prepare(
    `SELECT id FROM conversations
     WHERE source_type = 'workspace'
       AND id NOT IN (SELECT conversation_id FROM workspace_sessions)`,
  );
  const orphans = orphanStmt.all<{ id: string }>();
  orphanStmt.finalize();
  let orphanCleaned = 0;
  for (const orphan of orphans) {
    try {
      db.deleteConversation(orphan.id);
      orphanCleaned++;
    } catch (err) {
      console.error(
        `[workspace] retention failed to delete orphan conversation ${orphan.id}:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }
  if (orphanCleaned > 0) {
    console.log(
      `[workspace] sandbox retention: removed ${orphanCleaned} orphan workspace conversation(s)`,
    );
  }

  const cutoff = Date.now() - retentionDays * 24 * 60 * 60_000;
  const stmt = db.getRawDb().prepare(
    `SELECT id, sandbox_path, conversation_id FROM workspace_sessions
     WHERE status IN ('complete', 'failed', 'cancelled')
       AND COALESCE(pinned, 0) = 0
       AND COALESCE(ended_at, last_activity_at, created_at) < ?`,
  );
  const rows = stmt.all<
    { id: string; sandbox_path: string; conversation_id: string }
  >(new Date(cutoff).toISOString());
  stmt.finalize();

  let cleaned = 0;
  let errors = 0;
  let reclaimedBytes = 0;
  for (const row of rows) {
    // Defensive: only delete inside the workspace root. A corrupted
    // sandbox_path should never turn into an arbitrary rm -rf.
    const resolved = await Deno.realPath(row.sandbox_path).catch(() => null);

    if (resolved && resolved.startsWith(workspaceRoot)) {
      let size = 0;
      try {
        size = await dirSize(resolved);
      } catch {
        // Already gone — nothing to reclaim, conversation cleanup still runs.
        size = 0;
      }

      try {
        await Deno.remove(resolved, { recursive: true });
        reclaimedBytes += size;
        cleaned++;
      } catch (err) {
        errors++;
        console.error(
          `[workspace] retention failed to remove ${resolved}:`,
          err instanceof Error ? err.message : String(err),
        );
        // Dir removal failed — keep the conversation row so the session stays
        // inspectable and the next retention pass can retry.
        continue;
      }
    } else {
      // Dir already gone (or path invalid) — the session is still past
      // retention, clean up its conversation.
      cleaned++;
    }

    try {
      db.deleteConversation(row.conversation_id);
    } catch (err) {
      errors++;
      console.error(
        `[workspace] retention failed to delete conversation for session ${row.id}:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  if (cleaned > 0 || errors > 0) {
    console.log(
      `[workspace] sandbox retention: cleaned ${cleaned} session(s) ` +
        `(${(reclaimedBytes / 1024 / 1024).toFixed(1)} MB)` +
        (errors > 0 ? `, ${errors} errors` : ""),
    );
  }
  return { cleaned, errors, reclaimedBytes };
}

async function dirSize(path: string): Promise<number> {
  let total = 0;
  const walk = async (dir: string): Promise<void> => {
    for await (const entry of Deno.readDir(dir)) {
      const full = `${dir}/${entry.name}`;
      if (entry.isDirectory) await walk(full);
      else if (entry.isFile) {
        const stat = await Deno.stat(full).catch(() => null);
        if (stat) total += stat.size;
      }
    }
  };
  await walk(path);
  return total;
}

/**
 * Read the projects folder — the export_project destination on the host.
 * Configurable via `projectsPath` in workspace-settings.json; defaults to
 * ~/Projects (per-OS home dir), falling back to <dataRoot>/Projects when
 * no home directory is resolvable.
 */
export async function readProjectsPath(dataRoot: string): Promise<string> {
  try {
    const text = await Deno.readTextFile(
      `${dataRoot}/.psycheros/workspace-settings.json`,
    );
    const settings = JSON.parse(text) as { projectsPath?: string };
    if (settings.projectsPath?.trim()) {
      return settings.projectsPath.trim();
    }
  } catch {
    // No settings file — fall through to default
  }
  const home = Deno.env.get("HOME") ?? Deno.env.get("USERPROFILE");
  return home ? `${home}/Projects` : `${dataRoot}/Projects`;
}
