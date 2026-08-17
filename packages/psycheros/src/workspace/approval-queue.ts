/**
 * Workspace Approval Queue
 *
 * In-memory queue of pending entity-data write proposals. When the workspace
 * calls `write_entity_data`, the coordination layer enqueues a proposal here
 * instead of applying the write directly. The proposal is surfaced to the
 * entity/user via SSE broadcast; once approved, the coordination layer
 * applies the write. If denied, the workspace sees a rejection.
 *
 * The queue is per-process (no persistence) — if psycheros restarts mid-
 * approval, pending proposals are lost and the workspace sees an error.
 */

import { getBroadcaster } from "../server/broadcaster.ts";

/**
 * The kind of entity data being modified. Maps to the type registry in
 * coordination-layer.ts.
 */
export type EntityDataType =
  | "memory"
  | "identity"
  | "conversation"
  | "message"
  | "custom";

/**
 * Status of an approval proposal over its lifecycle.
 */
export type ApprovalStatus = "pending" | "approved" | "denied" | "expired";

/**
 * A pending entity-data write proposal from a workspace session.
 */
export interface ApprovalProposal {
  /** Unique ID for this proposal. */
  id: string;
  /** The workspace session that proposed the write. */
  sessionId: string;
  /** The conversation the workspace belongs to (for routing the broadcast). */
  conversationId: string;
  /** Origin conversation — where the entity will see the approval prompt. */
  originConversationId: string | null;
  /** Kind of entity data being modified. */
  type: EntityDataType;
  /** ID of the specific record being modified (memory ID, message ID, etc.). */
  targetId: string;
  /** The proposed changes — shape depends on `type`. */
  changes: Record<string, unknown>;
  /**
   * The workspace's justification for the change — required so the entity
   * can judge intent, not just the mechanical diff.
   */
  justification: string;
  /** Optional diff preview for the UI to render. */
  diffPreview?: DiffPreview;
  /** Reflection recommendation from the LLM reflection step. */
  reflectionRecommendation?: ReflectionRecommendation;
  /**
   * Batch items — when present, this proposal represents multiple changes
   * that share one approval. `targetId` and `changes` above are the first
   * item (for backward-compat with UI that reads single-item proposals);
   * `items` has the full list. Approve/deny applies to ALL items.
   */
  items?: BatchProposalItem[];
  status: ApprovalStatus;
  /** Who decided (entity name, "user", or null if still pending). */
  decidedBy?: string;
  /** Optional reason for the decision (especially denials). */
  decisionReason?: string;
  createdAt: string;
  decidedAt?: string;
}

/**
 * One item in a batch proposal. Each has its own target + changes but
 * shares the type, justification, and approval decision with siblings.
 */
export interface BatchProposalItem {
  targetId: string;
  changes: Record<string, unknown>;
  diffPreview?: DiffPreview;
}

/**
 * A simple unified/added/removed diff for UI rendering. Per-type diff
 * logic lives in the coordination layer; this is the transport shape.
 */
export interface DiffPreview {
  /** Human-readable summary of what would change. */
  summary: string;
  /** Optional before/after fields for the UI to render side-by-side. */
  before?: string;
  after?: string;
}

/**
 * Output of the reflection LLM pass — should we surface this directly,
 * or escalate to ask_origin_conversation first?
 */
export interface ReflectionRecommendation {
  /** "approve" = surface for normal approval; "escalate" = query back first. */
  action: "approve" | "escalate" | "deny";
  /** Brief reasoning the entity sees alongside the proposal. */
  reasoning: string;
}

/**
 * Singleton queue. Process-local — see module comment about persistence.
 */
class WorkspaceApprovalQueue {
  private proposals = new Map<string, ApprovalProposal>();
  private waiters = new Map<string, Array<(p: ApprovalProposal) => void>>();

  /**
   * Enqueue a new proposal. Broadcasts an SSE event so the UI can surface
   * the approval prompt. Returns the proposal with assigned ID.
   */
  enqueue(
    input: Omit<ApprovalProposal, "id" | "status" | "createdAt">,
  ): ApprovalProposal {
    const proposal: ApprovalProposal = {
      ...input,
      id: crypto.randomUUID(),
      status: "pending",
      createdAt: new Date().toISOString(),
    };
    this.proposals.set(proposal.id, proposal);

    getBroadcaster().broadcastEvent(
      "workspace_approval_request",
      proposal,
      // Surface in the origin conversation (where the entity is) if known,
      // else in the workspace conversation (collaborative mode).
      proposal.originConversationId ?? proposal.conversationId,
    );

    return proposal;
  }

  /**
   * Approve a proposal. Resolves any pending waitForResolution() callers
   * and broadcasts the resolution so the UI can dismiss the toast.
   */
  approve(
    id: string,
    decidedBy: string,
    reason?: string,
  ): ApprovalProposal | null {
    const proposal = this.proposals.get(id);
    if (!proposal) return null;
    if (proposal.status !== "pending") return proposal;

    proposal.status = "approved";
    proposal.decidedBy = decidedBy;
    proposal.decisionReason = reason;
    proposal.decidedAt = new Date().toISOString();

    this.notifyWaiters(proposal);
    this.broadcastResolution(proposal);
    return proposal;
  }

  /**
   * Deny a proposal. Same lifecycle as approve but the workspace sees a
   * rejection instead of an applied write.
   */
  deny(
    id: string,
    decidedBy: string,
    reason?: string,
  ): ApprovalProposal | null {
    const proposal = this.proposals.get(id);
    if (!proposal) return null;
    if (proposal.status !== "pending") return proposal;

    proposal.status = "denied";
    proposal.decidedBy = decidedBy;
    proposal.decisionReason = reason;
    proposal.decidedAt = new Date().toISOString();

    this.notifyWaiters(proposal);
    this.broadcastResolution(proposal);
    return proposal;
  }

  /**
   * Look up a proposal by ID.
   */
  get(id: string): ApprovalProposal | null {
    return this.proposals.get(id) ?? null;
  }

  /**
   * List all pending proposals. Optionally filter by session.
   */
  listPending(sessionId?: string): ApprovalProposal[] {
    const all = Array.from(this.proposals.values());
    return all.filter((p) =>
      p.status === "pending" &&
      (!sessionId || p.sessionId === sessionId)
    );
  }

  /**
   * Block until a proposal reaches a terminal state. Used by the coordination
   * layer to wait for entity/user decision before returning to OpenCode.
   * Times out after `timeoutMs` (default 5 min) and returns the proposal
   * with status "expired".
   */
  waitForResolution(
    id: string,
    timeoutMs = 25 * 60_000,
  ): Promise<ApprovalProposal> {
    const existing = this.proposals.get(id);
    if (!existing) {
      return Promise.reject(new Error(`Unknown proposal: ${id}`));
    }
    if (existing.status !== "pending") {
      return Promise.resolve(existing);
    }

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        const p = this.proposals.get(id);
        if (p && p.status === "pending") {
          p.status = "expired";
          p.decidedAt = new Date().toISOString();
          this.notifyWaiters(p);
          this.broadcastResolution(p);
        }
      }, timeoutMs);

      const waiter = (p: ApprovalProposal) => {
        clearTimeout(timeout);
        resolve(p);
      };
      if (!this.waiters.has(id)) this.waiters.set(id, []);
      this.waiters.get(id)!.push(waiter);
    });
  }

  private notifyWaiters(proposal: ApprovalProposal): void {
    const waiters = this.waiters.get(proposal.id);
    if (!waiters) return;
    for (const w of waiters) w(proposal);
    this.waiters.delete(proposal.id);
  }

  private broadcastResolution(proposal: ApprovalProposal): void {
    getBroadcaster().broadcastEvent(
      "workspace_approval_resolved",
      {
        id: proposal.id,
        status: proposal.status,
        decidedBy: proposal.decidedBy,
        decisionReason: proposal.decisionReason,
        sessionId: proposal.sessionId,
      },
      proposal.originConversationId ?? proposal.conversationId,
    );
  }
}

/**
 * Singleton accessor. The queue is process-local; first call creates it.
 */
let activeQueue: WorkspaceApprovalQueue | null = null;

export function getApprovalQueue(): WorkspaceApprovalQueue {
  if (!activeQueue) activeQueue = new WorkspaceApprovalQueue();
  return activeQueue;
}
