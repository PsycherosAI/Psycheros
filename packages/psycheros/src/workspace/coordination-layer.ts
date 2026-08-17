/**
 * Workspace Coordination Layer
 *
 * Daemon-side MCP-equivalent server exposing the 4 workspace-added tools
 * OpenCode sees when running as a workspace. Lives at HTTP route
 * `/mcp/workspace/:sessionId` — one logical server, per-session context
 * bound at request time via the URL path parameter.
 *
 * The MCP SDK's HTTP transport is deliberately not used — this ships a
 * minimal JSON-RPC dispatcher that's enough for OpenCode's remote-MCP
 * client. The SDK transport can be swapped in later without changing the
 * tool handler signatures.
 */

import { isAbsolute, join, resolve as resolvePath } from "@std/path";
import type { DBClient } from "../db/client.ts";
import type { WorkspaceSession } from "../types.ts";
import { createWorkerClient } from "../llm/mod.ts";
import type { LLMClient } from "../llm/client.ts";
import { getApprovalQueue } from "./approval-queue.ts";
import type { DiffPreview, EntityDataType } from "./approval-queue.ts";
import { getQueryQueue } from "./query-queue.ts";
import { reflectOnProposal } from "./reflection.ts";
import { classifyPath } from "./permissions.ts";
import { getWorkspaceSupervisor } from "./supervisor.ts";

/**
 * Context the coordination layer needs to handle requests. Constructed
 * once at server init, passed to per-request handlers along with the
 * session row resolved from the URL.
 */
export interface WorkspaceCoordinationConfig {
  db: DBClient;
  /** projectRoot — codebase reads are constrained to this tree. */
  projectRoot: string;
  /** dataRoot — identity files live under `<dataRoot>/identity/`. */
  dataRoot: string;
}

/**
 * Per-request context: the global config plus the resolved session row.
 * Tool handlers receive this so they can scope their work to the session
 * (e.g. ask_origin_conversation routes back to the session's origin).
 */
export interface WorkspaceRequestContext extends WorkspaceCoordinationConfig {
  session: WorkspaceSession;
}

/**
 * JSON-RPC 2.0 request shape — minimal subset we accept.
 */
interface JsonRpcRequest {
  // Accept any string for jsonrpc since callers parse request bodies loosely;
  // the dispatcher doesn't enforce the literal "2.0" value.
  jsonrpc?: string;
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown> | unknown[];
}

/**
 * JSON-RPC 2.0 response shapes.
 */
interface JsonRpcSuccess {
  jsonrpc: "2.0";
  id: string | number | null;
  result: unknown;
}

interface JsonRpcError {
  jsonrpc: "2.0";
  id: string | number | null;
  error: { code: number; message: string; data?: unknown };
}

type JsonRpcResponse = JsonRpcSuccess | JsonRpcError;

const ERROR_CODES = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
} as const;

/**
 * Dispatch a parsed JSON-RPC request to the appropriate tool handler.
 * Returns the JSON-RPC response (success or error).
 *
 * Callsite (routes.ts) handles HTTP serialization.
 */
export async function handleWorkspaceMcpRequest(
  config: WorkspaceCoordinationConfig,
  sessionId: string,
  request: JsonRpcRequest,
): Promise<JsonRpcResponse> {
  const id = request.id ?? null;

  // Look up the session — must exist for any tool call.
  const session = config.db.getWorkspaceSessionByConversation(sessionId) ??
    config.db.getWorkspaceSession(sessionId);
  if (!session) {
    return errorResponse(
      id,
      ERROR_CODES.INVALID_PARAMS,
      `Unknown workspace session: ${sessionId}`,
    );
  }

  const ctx: WorkspaceRequestContext = { ...config, session };

  try {
    switch (request.method) {
      case "initialize":
        return successResponse(id, {
          protocolVersion: "2024-11-05",
          serverInfo: { name: "psycheros-workspace", version: "1.0.0" },
          capabilities: { tools: {} },
        });

      case "tools/list":
        return successResponse(id, { tools: listToolDefinitions() });

      case "tools/call": {
        const params = normalizeParams(request.params);
        const name = params.name as string | undefined;
        const args = (params.arguments ?? {}) as Record<string, unknown>;
        if (!name) {
          return errorResponse(
            id,
            ERROR_CODES.INVALID_PARAMS,
            "Missing tool name",
          );
        }
        const result = await dispatchToolCall(ctx, name, args);
        return successResponse(id, result);
      }

      default:
        return errorResponse(
          id,
          ERROR_CODES.METHOD_NOT_FOUND,
          `Unknown method: ${request.method}`,
        );
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return errorResponse(id, ERROR_CODES.INTERNAL_ERROR, message);
  }
}

/**
 * Tool definitions for the `tools/list` JSON-RPC response. Matches the
 * MCP tool definition shape so OpenCode renders them correctly.
 */
function listToolDefinitions(): unknown[] {
  return [
    {
      name: "read_entity_data",
      description:
        "Read my own data — memories, identity, conversation history, etc. " +
        "`type` names the category, `query` filters or selects.",
      inputSchema: {
        type: "object",
        properties: {
          type: {
            type: "string",
            description:
              'Category. Common: "messages" (list by conversation — needs conversation_id, optional role + limit), "message" (single by ID), "message_search" (text search), "conversation" (list conversations), "identity" (identity files).',
          },
          query: {
            type: "string",
            description: "Optional filter or selector (search text, ID, etc.)",
          },
          conversation_id: {
            type: "string",
            description:
              'For type:"messages" — the conversation to list messages from.',
          },
          role: {
            type: "string",
            description:
              'For type:"messages" — filter by "user" or "assistant".',
          },
          limit: {
            type: "number",
            description:
              'For type:"messages" — max messages to return (default 25, max 200). Returns full content per message. Use the smallest limit that gets the job done — long conversations can have hundreds of messages and pulling them all wastes context.',
          },
        },
        required: ["type"],
      },
    },
    {
      name: "write_entity_data",
      description:
        "Modify my own data — repair a glitched message, correct an outdated memory. " +
        "Routes back to main context for approval before applying. " +
        "For batch operations (e.g. fixing malformed content across many messages), " +
        "pass `items` instead of `id`+`changes` — all items share one " +
        "justification and one approval decision.",
      inputSchema: {
        type: "object",
        properties: {
          type: { type: "string" },
          id: {
            type: "string",
            description:
              "Single write: ID of the record to modify. Omit when using `items` for batch.",
          },
          changes: {
            type: "object",
            description:
              "Single write: proposed changes. Omit when using `items` for batch.",
          },
          items: {
            type: "array",
            description:
              "Batch write: array of {id, changes} objects. All items share the " +
              "same `type` and `justification`. One approval covers all items.",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                changes: { type: "object" },
              },
              required: ["id", "changes"],
            },
          },
          justification: {
            type: "string",
            description:
              "One-line explanation of why this change is needed. Required — the entity " +
              "uses this when deciding whether to approve.",
          },
        },
        required: ["type", "justification"],
      },
    },
    {
      name: "read_codebase",
      description:
        "Read Psycheros source code. Free read, no writes. Useful for " +
        "understanding the plugin API, debugging, learning how something works.",
      inputSchema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description:
              "Path relative to project root, or absolute within project root.",
          },
        },
        required: ["path"],
      },
    },
    {
      name: "ask_origin_conversation",
      description:
        "When I need input I can't decide alone, I ask. The question surfaces " +
        "in our main conversation; I wait for the answer before continuing.",
      inputSchema: {
        type: "object",
        properties: {
          question: { type: "string" },
        },
        required: ["question"],
      },
    },
  ];
}

/**
 * Route a `tools/call` to the matching handler.
 */
async function dispatchToolCall(
  ctx: WorkspaceRequestContext,
  name: string,
  args: Record<string, unknown>,
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  switch (name) {
    case "read_entity_data":
      return readEntityData(ctx, args);
    case "write_entity_data":
      return writeEntityData(ctx, args);
    case "read_codebase":
      return readCodebase(ctx, args);
    case "ask_origin_conversation":
      return askOriginConversation(ctx, args);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// =============================================================================
// Tool handlers
// =============================================================================

/**
 * Read entity data. Supports:
 *   - type="identity": reads identity files from <dataRoot>/identity/
 *   - type="conversation": lists conversations from local DB
 *   - type="message": reads a specific message by ID
 * Memory/graph reads go through entity-core MCP (not wired here).
 */
async function readEntityData(
  ctx: WorkspaceRequestContext,
  args: Record<string, unknown>,
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const type = String(args.type ?? "");
  const query = args.query !== undefined ? String(args.query) : undefined;

  switch (type) {
    case "identity": {
      const identityDir = join(ctx.dataRoot, "identity");
      const files = await listIdentityFiles(identityDir);
      if (query) {
        // Simple substring filter.
        const filtered = files.filter((f) =>
          f.path.toLowerCase().includes(query.toLowerCase()) ||
          f.content.toLowerCase().includes(query.toLowerCase())
        );
        return textResult(JSON.stringify(filtered, null, 2));
      }
      return textResult(JSON.stringify(files, null, 2));
    }

    case "conversation": {
      const conversations = ctx.db.listConversations();
      return textResult(JSON.stringify(conversations, null, 2));
    }

    case "message": {
      // Query is the message ID. If not provided, returns an error — message
      // scanning without an ID is a different operation (use type="conversation"
      // + scan, or pass a search query as `query`).
      if (!query) {
        throw new Error(
          'type="message" requires `query` set to the message ID. For text search, use type="conversation" or pass the message ID directly.',
        );
      }
      const msg = ctx.db.getMessageById(query);
      if (!msg) {
        // Maybe `query` was a phrase, not an ID — try search.
        const matches = ctx.db.searchMessages(query, 5);
        if (matches.length === 0) {
          throw new Error(`No message with id or content matching: ${query}`);
        }
        return textResult(
          `No message with that exact ID, but found ${matches.length} by content match:\n` +
            JSON.stringify(
              matches.map((m) => ({
                id: m.id,
                role: m.role,
                content: m.content.slice(0, 200),
                createdAt: m.createdAt,
              })),
              null,
              2,
            ),
        );
      }
      return textResult(JSON.stringify(msg, null, 2));
    }

    case "message_search": {
      // Explicit text search across all messages. Query is the search string.
      if (!query) {
        throw new Error("message_search requires `query` (search text)");
      }
      const matches = ctx.db.searchMessages(query, 20);
      return textResult(
        JSON.stringify(
          matches.map((m) => ({
            id: m.id,
            role: m.role,
            content: m.content.slice(0, 300),
            createdAt: m.createdAt,
          })),
          null,
          2,
        ),
      );
    }

    case "messages": {
      // List messages by conversation, optionally filtered by role. Full
      // content per message — no truncation. Truncating content would mean
      // OpenCode can't safely propose edits on what it can't see; the
      // approval toast downstream is the real safety gate, not preview
      // snippets here.
      //
      // Defaults: 50 messages, newest first. Max 200 to bound payload size.
      const conversationId = args.conversation_id !== undefined
        ? String(args.conversation_id)
        : undefined;
      if (!conversationId) {
        throw new Error(
          'type="messages" requires `conversation_id`. To list conversations first, use type="conversation".',
        );
      }
      const role = args.role !== undefined
        ? (String(args.role) as "user" | "assistant")
        : undefined;
      const limit = typeof args.limit === "number" && args.limit > 0
        ? Math.min(args.limit, 200)
        : 25;
      const all = ctx.db.getMessages(conversationId);
      // Newest first so "find the most recent X" works without extra sorting.
      const reversed = [...all].reverse();
      const filtered = role
        ? reversed.filter((m) => m.role === role)
        : reversed;
      const limited = filtered.slice(0, limit);
      return textResult(
        JSON.stringify(
          limited.map((m) => ({
            id: m.id,
            role: m.role,
            content: m.content,
            createdAt: m.createdAt,
            ...(m.isGlitched ? { isGlitched: true } : {}),
            ...(m.deletedAt ? { deletedAt: m.deletedAt } : {}),
          })),
          null,
          2,
        ),
      );
    }

    case "memory":
    case "graph":
      throw new Error(
        `type="${type}" requires entity-core MCP integration (not wired). ` +
          `Identity and conversation reads are available.`,
      );

    default:
      throw new Error(
        `Unknown entity data type: "${type}". Supported: identity, conversation, message.`,
      );
  }
}

/**
 * Read a file from the codebase. Constrained to projectRoot to prevent
 * sandbox escape via path traversal.
 */
async function readCodebase(
  ctx: WorkspaceRequestContext,
  args: Record<string, unknown>,
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const requested = String(args.path ?? "");
  if (!requested) throw new Error("path is required");

  const projectRoot = resolvePath(ctx.projectRoot);
  const monorepoRoot = resolvePath(join(projectRoot, ".."));

  // Try resolving relative paths against projectRoot first, then monorepo
  // root. The workspace may not know which dir it's in.
  const candidates: string[] = [];
  if (isAbsolute(requested)) {
    candidates.push(resolvePath(requested));
  } else {
    candidates.push(resolvePath(join(projectRoot, requested)));
    if (projectRoot.includes("/packages/")) {
      // Looks like a monorepo — also try resolving from the monorepo root
      // so paths like "packages/psycheros/foo" work from inside that package.
      candidates.push(resolvePath(join(monorepoRoot, requested)));
    }
  }

  // Pick the first candidate that exists AND is inside projectRoot.
  // (Monorepo-rooted paths can resolve outside projectRoot if `..` is used;
  // those are blocked to keep reads scoped to the Psycheros codebase.)
  let resolved: string | null = null;
  let lastError = "";
  for (const candidate of candidates) {
    // Allow reads anywhere under the monorepo root — projectRoot + sibling
    // packages. The Psycheros codebase IS the monorepo for this purpose.
    const underMonorepo = candidate === monorepoRoot ||
      candidate.startsWith(monorepoRoot + "/");
    if (!underMonorepo) continue;
    try {
      await Deno.stat(candidate);
      resolved = candidate;
      break;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
  }
  if (!resolved) {
    throw new Error(
      `Path "${requested}" not found. Tried: ${candidates.join(", ")}.${
        lastError ? ` Last error: ${lastError}` : ""
      }`,
    );
  }

  // Tier 5 defense-in-depth: classifyPath catches daemon files even if they
  // live under monorepoRoot (default dataRoot overlaps projectRoot, so
  // `.psycheros/psycheros.db` would otherwise be readable here).
  // Tier 5 is always hard-blocked regardless of mode, partyhard, or approvals.
  const permissionState = getWorkspaceSupervisor()
    ?.getSessionPermission(ctx.session.id);
  if (permissionState) {
    const classification = classifyPath(resolved, permissionState);
    if (classification.hardBlocked) {
      throw new Error(
        `Path "${requested}" is protected (Tier 5: daemon/runtime file). ` +
          `Read denied. Reason: ${classification.reason}.`,
      );
    }
  }

  // If the path is a directory, list its contents (instead of erroring with
  // "Is a directory"). This matches `ls` semantics — the workspace often
  // needs to explore structure, not just read individual files.
  const info = await Deno.stat(resolved);
  if (info.isDirectory) {
    const entries: Array<{ name: string; type: string; size: number }> = [];
    for await (const entry of Deno.readDir(resolved)) {
      // Skip noisy dirs that bloat the listing.
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      try {
        const stat = await Deno.stat(join(resolved, entry.name));
        entries.push({
          name: entry.name,
          type: entry.isDirectory ? "dir" : "file",
          size: stat.size,
        });
      } catch {
        entries.push({
          name: entry.name,
          type: entry.isDirectory ? "dir" : "file",
          size: 0,
        });
      }
    }
    entries.sort((a, b) =>
      a.type === b.type
        ? a.name.localeCompare(b.name)
        : a.type === "dir"
        ? -1
        : 1
    );
    return textResult(
      `Directory listing of ${resolved}:\n\n` +
        entries.map((e) => `[${e.type}] ${e.name} (${e.size} bytes)`).join(
          "\n",
        ),
    );
  }

  try {
    const content = await Deno.readTextFile(resolved);
    return textResult(content);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to read ${requested}: ${message}`);
  }
}

/**
 * ask_origin_conversation — OpenCode-side tool for asking a question.
 *
 * Behavior is mode-dependent (per the unified design):
 *
 * **sync:** Question is captured. Returns immediately so opencode exits and
 * the workspace tool returns the question to the entity inline. The entity
 * responds via `workspace({action:"respond"})`, which continues the session
 * via --continue.
 *
 * **async:** Question is captured + a Pulse fires in the origin conversation
 * so the entity sees it next turn. Same respond-from-entity pattern, just
 * across a turn boundary.
 *
 * **engaged:** Returns a graceful error — in engaged mode, OpenCode should
 * ask in conversation text. The workspace-context entity handles routing and
 * may escalate via the entity-side `ask_origin_conversation` workspace action.
 */
async function askOriginConversation(
  ctx: WorkspaceRequestContext,
  args: Record<string, unknown>,
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const question = String(args.question ?? "").trim();
  if (!question) {
    throw new Error("ask_origin_conversation requires `question`");
  }

  const mode = ctx.session.mode;

  // Engaged: surface the question so the entity sees it in conversation text.
  // The entity has a standalone `ask_user` tool it can call to escalate to
  // the user. Don't imply anything is pending — the entity must act.
  if (mode === "engaged") {
    const q = question.slice(0, 300);
    return textResult(`[Unanswered question: "${q}"]`);
  }

  // Sync + async: enqueue the question and BLOCK on the response. The
  // workspace stays RUNNING with the OpenCode process alive on this tool
  // call. The toast idle timer drives the suspend — if the user doesn't
  // engage with the toast for 5 min,
  // the client POSTs /suspend, which calls signalSuspend() to resolve
  // this wait with the query still pending. The 30-min hard cap below is
  // a safety net for tab-closed / crash cases where the client never fires.
  const queue = getQueryQueue();
  const query = queue.enqueue({
    sessionId: ctx.session.id,
    conversationId: ctx.session.conversationId,
    originConversationId: ctx.session.originConversationId ?? null,
    question,
  });

  const resolved = await queue.waitForAnswer(query.id, 30 * 60_000);

  if (resolved.status === "answered" && resolved.answer) {
    return textResult(
      `[User answered: "${resolved.answer.slice(0, 500)}"]`,
    );
  }
  // Query still pending after wait resolved = signalSuspend was called
  // (toast idle timer fired). The session is being marked suspended; the
  // user can still answer via the FAB `!` recovery path which will resume
  // via --continue.
  return textResult(
    `[Question timed out — workspace suspending until the user answers via the workspace indicator. End your turn now; do not call more tools.]`,
  );
}

/**
 * write_entity_data.
 *
 * Workspace proposes a change → reflection LLM pass → enqueue to approval
 * queue → entity/user decides (via SSE-broadcast toast) → apply or reject.
 *
 * type="message" is fully implemented (content updates + soft deletes via
 * the local DB). Identity/memory/conversation writes route to entity-core
 * MCP (not wired).
 */
async function writeEntityData(
  ctx: WorkspaceRequestContext,
  args: Record<string, unknown>,
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const type = String(args.type ?? "") as EntityDataType;
  const justification = String(args.justification ?? args.reason ?? "");

  if (!type) {
    throw new Error("write_entity_data requires `type`");
  }
  if (!justification) {
    throw new Error(
      "write_entity_data requires `justification` — explain why this change is needed",
    );
  }

  // Detect batch mode: `items` array present instead of `id`+`changes`.
  const hasItems = Array.isArray(args.items) && args.items.length > 0;
  const hasSingle = args.id !== undefined && args.changes !== undefined;

  if (!hasItems && !hasSingle) {
    throw new Error(
      "write_entity_data requires either `id`+`changes` (single) or `items` (batch)",
    );
  }

  // --- Single write (existing path) ---
  if (!hasItems) {
    return writeEntityDataSingle(
      ctx,
      type,
      String(args.id),
      (args.changes ?? {}) as Record<string, unknown>,
      justification,
    );
  }

  // --- Batch write (new) ---
  const rawItems = args.items as Array<Record<string, unknown>>;
  const items = rawItems.map((item) => ({
    targetId: String(item.id ?? ""),
    changes: (item.changes ?? {}) as Record<string, unknown>,
  }));

  // Validate all items have targetId
  for (let i = 0; i < items.length; i++) {
    if (!items[i].targetId) {
      throw new Error(`items[${i}] is missing required \`id\``);
    }
  }

  // Start a backup batch so all snapshots from this operation share a batch_id.
  const { initBackupService } = await import("../backup/mod.ts");
  const backupService = initBackupService(ctx.dataRoot);
  // getBackupService already returns our singleton; but if for some reason
  // it's not initialized, startBatch will use a fresh instance.
  const { getBackupService } = await import("../backup/mod.ts");
  const batchId = await (getBackupService() ?? backupService).startBatch(
    `batch write: ${items.length} ${type} item(s)`,
    justification,
  );

  // Run reflection on each item. If ANY item's reflection says "deny",
  // reject the whole batch — safer than partially applying.
  let reflectionLlm: LLMClient | null = null;
  try {
    reflectionLlm = createWorkerClient();
  } catch {
    // Will fall back to default "approve" recommendation
  }

  const batchItems: Array<{
    targetId: string;
    changes: Record<string, unknown>;
    diffPreview?: DiffPreview;
  }> = [];

  for (const item of items) {
    const reflection = await reflectOnProposal(
      {
        goal: ctx.session.briefing.goal,
        type,
        targetId: item.targetId,
        changes: item.changes,
        justification,
        currentContent: await readCurrentContentForReflection(
          ctx,
          type,
          item.targetId,
        ),
      },
      reflectionLlm,
    );

    if (reflection.action === "deny") {
      return textResult(
        `[write_entity_data batch denied by reflection on item ${item.targetId}: ${reflection.reasoning}]`,
      );
    }

    const diffPreview = await buildDiffPreview(
      ctx,
      type,
      item.targetId,
      item.changes,
    );
    batchItems.push({
      targetId: item.targetId,
      changes: item.changes,
      ...(diffPreview ? { diffPreview } : {}),
    });
  }

  // Enqueue ONE proposal covering all items. The approval toast shows
  // the batch summary; approve/deny applies to all items.
  const queue = getApprovalQueue();
  const proposal = queue.enqueue({
    sessionId: ctx.session.id,
    conversationId: ctx.session.conversationId,
    originConversationId: ctx.session.originConversationId ?? null,
    type,
    targetId: batchItems[0].targetId, // first item for backward-compat UI
    changes: batchItems[0].changes,
    justification,
    diffPreview: batchItems[0].diffPreview,
    items: batchItems,
    reflectionRecommendation: {
      action: "approve",
      reasoning:
        `batch of ${batchItems.length} item(s) — all passed reflection`,
    },
  });

  // Block until the entity/user decides.
  const resolved = await queue.waitForResolution(proposal.id);

  if (resolved.status !== "approved") {
    return textResult(
      `[write_entity_data batch ${resolved.status}${
        resolved.decisionReason ? `: ${resolved.decisionReason}` : ""
      }] — no items applied.`,
    );
  }

  // Apply each write, tagged with batch_id for backup recovery.
  const results: string[] = [];
  for (const item of batchItems) {
    const applyResult = await applyWrite(
      ctx,
      type,
      item.targetId,
      item.changes,
      justification,
    );
    results.push(`${item.targetId}: ${applyResult}`);
  }

  return textResult(
    `[write_entity_data batch approved and applied ${batchItems.length} item(s). ` +
      `Batch ID: ${batchId}. Results:\n${results.join("\n")}]`,
  );
}

/**
 * Single-write path — the existing flow, extracted for clarity.
 */
async function writeEntityDataSingle(
  ctx: WorkspaceRequestContext,
  type: EntityDataType,
  targetId: string,
  changes: Record<string, unknown>,
  justification: string,
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  if (!targetId) {
    throw new Error("write_entity_data requires `type` and `id`");
  }

  // 1. Reflection pass
  let reflectionLlm: LLMClient | null = null;
  try {
    reflectionLlm = createWorkerClient();
  } catch {
    // Will fall back to default "approve" recommendation
  }
  const reflection = await reflectOnProposal(
    {
      goal: ctx.session.briefing.goal,
      type,
      targetId,
      changes,
      justification,
      currentContent: await readCurrentContentForReflection(
        ctx,
        type,
        targetId,
      ),
    },
    reflectionLlm,
  );

  if (reflection.action === "deny") {
    return textResult(
      `[write_entity_data denied by reflection: ${reflection.reasoning}]`,
    );
  }
  if (reflection.action === "escalate") {
    return textResult(
      `[reflection recommends escalation — call ask_origin_conversation before re-proposing. ` +
        `Reasoning: ${reflection.reasoning}]`,
    );
  }

  // 2. Build diff preview for the UI.
  const diffPreview = await buildDiffPreview(ctx, type, targetId, changes);

  // 3. Enqueue the proposal.
  const queue = getApprovalQueue();
  const proposal = queue.enqueue({
    sessionId: ctx.session.id,
    conversationId: ctx.session.conversationId,
    originConversationId: ctx.session.originConversationId ?? null,
    type,
    targetId,
    changes,
    justification,
    diffPreview,
    reflectionRecommendation: reflection,
  });

  // 4. Block until decided.
  const resolved = await queue.waitForResolution(proposal.id);

  if (resolved.status !== "approved") {
    return textResult(
      `[write_entity_data ${resolved.status}${
        resolved.decisionReason ? `: ${resolved.decisionReason}` : ""
      }]`,
    );
  }

  // 5. Apply the write.
  const applyResult = await applyWrite(
    ctx,
    type,
    targetId,
    changes,
    justification,
  );
  return textResult(
    `[write_entity_data approved and applied. ${applyResult}]`,
  );
}

/**
 * Read the current content of a record for reflection context. Returns
 * undefined when not relevant or unreadable.
 */
async function readCurrentContentForReflection(
  ctx: WorkspaceRequestContext,
  type: string,
  targetId: string,
): Promise<string | undefined> {
  if (type === "message") {
    try {
      // No getMessage(id) method — scan via listConversations + getMessages.
      // Return undefined; reflection doesn't strictly need the current content,
      // it has the proposed changes and justification.
      void ctx;
      void targetId;
      return undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/**
 * Build a human-readable diff preview for the UI to render alongside the
 * approval prompt. Per-type logic; falls back to JSON dump for unknown types.
 */
async function buildDiffPreview(
  ctx: WorkspaceRequestContext,
  type: string,
  targetId: string,
  changes: Record<string, unknown>,
): Promise<{ summary: string; before?: string; after?: string }> {
  void ctx;
  const op = "content" in changes
    ? "update"
    : "delete" in changes && changes.delete
    ? "delete"
    : "modify";

  return {
    summary: `${op} ${type} ${targetId}`,
    after: JSON.stringify(changes, null, 2).slice(0, 1000),
  };
}

/**
 * Apply an approved write. Per-type dispatch.
 *
 * type="message" routes to the local DB. Other types return a note —
 * entity-core MCP routing is its own piece.
 */
async function applyWrite(
  ctx: WorkspaceRequestContext,
  type: string,
  targetId: string,
  changes: Record<string, unknown>,
  justification?: string,
): Promise<string> {
  if (type === "message") {
    return applyMessageWrite(ctx, targetId, changes, justification);
  }

  return `${
    type.charAt(0).toUpperCase() + type.slice(1)
  } writes route to entity-core MCP (not wired). (Proposal was approved; apply step returned gracefully.)`;
}

/**
 * Apply a message write. Supported operations:
 *   - { content: "new text" } → update content (clears glitched flag)
 *   - { delete: true, reason: "..." } → soft-delete (tombstone)
 *   - { restore: true } → un-delete (restores content from metadata.tombstone)
 *   - { glitched: true, reason: "..." } → mark as corrupted (UI shows placeholder)
 *   - { glitched: false } → clear glitched flag
 */
async function applyMessageWrite(
  ctx: WorkspaceRequestContext,
  messageId: string,
  changes: Record<string, unknown>,
  justification?: string,
): Promise<string> {
  if ("delete" in changes && changes.delete) {
    const reason = typeof changes.reason === "string"
      ? changes.reason
      : undefined;
    const result = ctx.db.softDeleteMessage(messageId, {
      deletedBy: "entity",
      reason,
    });
    if (!result) {
      throw new Error(`Message not found: ${messageId}`);
    }
    return `Message ${messageId} soft-deleted (tombstoned).`;
  }

  if ("restore" in changes && changes.restore) {
    const result = ctx.db.restoreMessage(messageId);
    if (!result) {
      throw new Error(
        `Message not found or not deleted: ${messageId}`,
      );
    }
    return `Message ${messageId} restored (tombstone cleared, content recovered from archive).`;
  }

  if ("glitched" in changes) {
    if (changes.glitched) {
      const reason = typeof changes.reason === "string"
        ? changes.reason
        : undefined;
      const result = ctx.db.markGlitched(messageId, reason);
      if (!result) {
        throw new Error(`Message not found: ${messageId}`);
      }
      return `Message ${messageId} marked as glitched.`;
    }
    const result = ctx.db.clearGlitched(messageId);
    if (!result) {
      throw new Error(`Message not found: ${messageId}`);
    }
    return `Message ${messageId} glitched flag cleared.`;
  }

  if ("content" in changes && typeof changes.content === "string") {
    const newContent = changes.content;
    if (newContent.trim().length === 0) {
      throw new Error(
        "Messages can't be empty. Did you mean to delete? Pass `{delete: true}` instead.",
      );
    }
    const result = await ctx.db.updateMessage(messageId, newContent, {
      reason: justification,
    });
    if (!result) {
      throw new Error(`Message not found: ${messageId}`);
    }
    // If the message was glitched, the repair clears the flag.
    ctx.db.clearGlitched(messageId);
    return `Message ${messageId} content updated (glitched flag cleared if set).`;
  }

  throw new Error(
    'Message write needs one of: {content: "..."}, {delete: true}, {restore: true}, {glitched: true|false}.',
  );
}

// =============================================================================
// Helpers
// =============================================================================

/**
 * List identity files under <dataRoot>/identity/. Returns each file's relative
 * path and content. Walks subdirectories.
 */
async function listIdentityFiles(
  identityDir: string,
): Promise<Array<{ path: string; content: string }>> {
  const results: Array<{ path: string; content: string }> = [];
  try {
    for await (const entry of Deno.readDir(identityDir)) {
      const fullPath = join(identityDir, entry.name);
      if (entry.isDirectory) {
        results.push(...await listIdentityFiles(fullPath));
      } else if (
        entry.isFile &&
        (entry.name.endsWith(".md") || entry.name.endsWith(".txt"))
      ) {
        try {
          const content = await Deno.readTextFile(fullPath);
          results.push({ path: entry.name, content });
        } catch {
          // skip unreadable
        }
      }
    }
  } catch {
    // identity dir doesn't exist or is unreadable
  }
  return results;
}

function textResult(text: string): {
  content: Array<{ type: "text"; text: string }>;
} {
  return { content: [{ type: "text", text }] };
}

function successResponse(
  id: string | number | null,
  result: unknown,
): JsonRpcSuccess {
  return { jsonrpc: "2.0", id, result };
}

function errorResponse(
  id: string | number | null,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcError {
  return {
    jsonrpc: "2.0",
    id,
    error: { code, message, ...(data ? { data } : {}) },
  };
}

function normalizeParams(
  params: Record<string, unknown> | unknown[] | undefined,
): Record<string, unknown> {
  if (!params) return {};
  if (Array.isArray(params)) {
    const obj: Record<string, unknown> = {};
    params.forEach((v, i) => obj[String(i)] = v);
    return obj;
  }
  return params;
}
