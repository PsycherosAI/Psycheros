/**
 * Workspace Query-Back Queue
 *
 * When a workspace calls `ask_origin_conversation`, the coordination layer
 * enqueues the question here. The question surfaces in main chat via SSE
 * broadcast; the response flows back to the workspace.
 *
 * Pending queries are persisted to `<dataRoot>/.psycheros/workspace-pending-queries.json`
 * so they survive server restarts. On startup, the server calls
 * `recoverFromDisk()` to re-enqueue any queries that were pending when the
 * server went down.
 */

import { getBroadcaster } from "../server/broadcaster.ts";

/**
 * A pending query from a workspace session.
 */
export interface WorkspaceQuery {
  /** Unique ID for this query. */
  id: string;
  /** The workspace session that asked. */
  sessionId: string;
  /** The workspace conversation (where the workspace is running). */
  conversationId: string;
  /** Origin conversation — where the entity will see the question. */
  originConversationId: string | null;
  /** The question text. */
  question: string;
  /** Whether the question has been answered. */
  status: "pending" | "answered" | "cancelled" | "expired";
  /** The answer, once received. */
  answer?: string;
  createdAt: string;
  answeredAt?: string;
}

class WorkspaceQueryQueue {
  private queries = new Map<string, WorkspaceQuery>();
  private waiters = new Map<string, Array<(q: WorkspaceQuery) => void>>();
  private dataRoot: string | null = null;

  /**
   * Set the data root for file persistence. Called once during server init.
   * After this, enqueue/answer/cancel persist pending queries to disk.
   */
  initPersistence(dataRoot: string): void {
    this.dataRoot = dataRoot;
  }

  private get filePath(): string {
    return `${this.dataRoot}/.psycheros/workspace-pending-queries.json`;
  }

  /**
   * Persist pending queries to disk. Called after every state change.
   * Non-fatal — if the write fails, the queue still works in-memory.
   */
  private persist(): void {
    if (!this.dataRoot) return;
    try {
      const pending = this.listPending();
      Deno.writeTextFileSync(this.filePath, JSON.stringify(pending, null, 2));
    } catch (err) {
      console.error("[workspace] failed to persist pending queries:", err);
    }
  }

  /**
   * Read persisted queries from disk and re-enqueue them. Called once
   * during server startup, after initPersistence.
   */
  recoverFromDisk(): number {
    if (!this.dataRoot) return 0;
    try {
      const text = Deno.readTextFileSync(this.filePath);
      const queries = JSON.parse(text) as WorkspaceQuery[];
      let recovered = 0;
      for (const q of queries) {
        if (q.status === "pending") {
          this.queries.set(q.id, q);
          // Re-broadcast so the UI picks it up (FAB badge, toast recovery).
          getBroadcaster().broadcastEvent(
            "workspace_query",
            q,
            q.originConversationId ?? q.conversationId,
          );
          recovered++;
        }
      }
      if (recovered > 0) {
        console.log(
          `[workspace] recovered ${recovered} pending query(ies) from disk`,
        );
      }
      return recovered;
    } catch {
      // File doesn't exist or is malformed — clean state.
      return 0;
    }
  }

  /**
   * Enqueue a new question and broadcast it as an SSE event so the UI
   * can surface the query in main chat.
   */
  enqueue(
    input: Omit<WorkspaceQuery, "id" | "status" | "createdAt">,
  ): WorkspaceQuery {
    const query: WorkspaceQuery = {
      ...input,
      id: crypto.randomUUID(),
      status: "pending",
      createdAt: new Date().toISOString(),
    };
    this.queries.set(query.id, query);

    getBroadcaster().broadcastEvent(
      "workspace_query",
      query,
      query.originConversationId ?? query.conversationId,
    );

    this.persist();
    return query;
  }

  /**
   * Provide an answer to a pending query. Updates the query status, fires
   * `workspace_query_resolved` SSE event so the UI can dismiss the toast,
   * and persists state to disk. The workspace is NOT blocking on this — the
   * answer is read by the resume flow (supervisor.resumeSession) when
   * /respond fires.
   */
  answer(id: string, answer: string): WorkspaceQuery | null {
    const query = this.queries.get(id);
    if (!query) return null;
    if (query.status !== "pending") return query;

    query.status = "answered";
    query.answer = answer;
    query.answeredAt = new Date().toISOString();

    const waiters = this.waiters.get(id);
    if (waiters) {
      for (const w of waiters) w(query);
      this.waiters.delete(id);
    }

    getBroadcaster().broadcastEvent(
      "workspace_query_resolved",
      {
        id: query.id,
        status: query.status,
        sessionId: query.sessionId,
      },
      query.originConversationId ?? query.conversationId,
    );

    this.persist();
    return query;
  }

  /**
   * Cancel a pending query (e.g. workspace gave up or was cancelled).
   */
  cancel(id: string): WorkspaceQuery | null {
    const query = this.queries.get(id);
    if (!query) return null;
    if (query.status !== "pending") return query;

    query.status = "cancelled";
    query.answeredAt = new Date().toISOString();

    const waiters = this.waiters.get(id);
    if (waiters) {
      for (const w of waiters) w(query);
      this.waiters.delete(id);
    }

    this.persist();
    return query;
  }

  get(id: string): WorkspaceQuery | null {
    return this.queries.get(id) ?? null;
  }

  /**
   * List all pending queries — used by /api/workspace/queries so the browser
   * can re-render toasts after a refresh (EventSource doesn't replay missed
   * events).
   */
  listPending(): WorkspaceQuery[] {
    return Array.from(this.queries.values()).filter((q) =>
      q.status === "pending"
    );
  }

  /**
   * Cancel all pending queries for a session. Called by the supervisor when
   * a session ends (terminal status) so orphaned queries don't keep showing
   * toasts to the user for 25 minutes waiting for an answer the workspace
   * is no longer waiting to receive.
   */
  cancelAllForSession(sessionId: string): number {
    let cancelled = 0;
    for (const q of this.queries.values()) {
      if (q.sessionId === sessionId && q.status === "pending") {
        this.cancel(q.id);
        cancelled++;
      }
    }
    return cancelled;
  }

  /**
   * Look up the pending query for a session (if any). Used by the
   * /respond endpoint to find what to answer.
   */
  getPendingForSession(sessionId: string): WorkspaceQuery | null {
    for (const q of this.queries.values()) {
      if (q.sessionId === sessionId && q.status === "pending") return q;
    }
    return null;
  }

  /**
   * Signal that the workspace should suspend without an answer. Resolves
   * waitForAnswer callers with the still-pending query (so they can detect
   * "suspend was signaled" by checking `status === "pending"` after the
   * await) but does NOT change the query status — the query stays pending
   * so late answers via /respond still work.
   *
   * The toast idle timer fires this. The workspace stays RUNNING with the
   * OpenCode process blocked on ask_origin_conversation while the toast is
   * up; only after 5 min of user idle does the toast POST /suspend, which
   * calls this method to unblock the tool call so OpenCode can end its turn
   * and the session can transition to `suspended`.
   */
  signalSuspend(id: string): void {
    const query = this.queries.get(id);
    if (!query) return;
    if (query.status !== "pending") return;
    const waiters = this.waiters.get(id);
    if (waiters) {
      for (const w of waiters) w(query);
      this.waiters.delete(id);
    }
  }

  /**
   * Block until the query is answered or expired. Internal callers no
   * longer block — workspaces suspend instead. Kept for compatibility in
   * case external code wants to poll.
   */
  waitForAnswer(id: string, timeoutMs = 25 * 60_000): Promise<WorkspaceQuery> {
    const existing = this.queries.get(id);
    if (!existing) {
      return Promise.reject(new Error(`Unknown query: ${id}`));
    }
    if (existing.status !== "pending") {
      return Promise.resolve(existing);
    }

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        const q = this.queries.get(id);
        if (q && q.status === "pending") {
          q.status = "expired";
          q.answeredAt = new Date().toISOString();
          const waiters = this.waiters.get(id);
          if (waiters) {
            for (const w of waiters) w(q);
            this.waiters.delete(id);
          }
        }
      }, timeoutMs);

      const waiter = (q: WorkspaceQuery) => {
        clearTimeout(timeout);
        resolve(q);
      };
      if (!this.waiters.has(id)) this.waiters.set(id, []);
      this.waiters.get(id)!.push(waiter);
    });
  }
}

let activeQueryQueue: WorkspaceQueryQueue | null = null;

export function getQueryQueue(): WorkspaceQueryQueue {
  if (!activeQueryQueue) activeQueryQueue = new WorkspaceQueryQueue();
  return activeQueryQueue;
}
