/**
 * Flux host-state — the single cheap read for "which conversation is the
 * Ego living in right now?" (conversation-hosted consciousness).
 *
 * A leaf module by design: the tool `visibleIn` predicates call
 * `getFluxHostConversationId()` on EVERY tool-visibility resolution, so it
 * must be a module read — no DB hit, no imports, no cycle questions.
 * `flux/mod.ts` is the only writer; predicates and the session API read.
 *
 * The value is the RESOLVED host in both modes: the conversation Flux was
 * started from, or (legacy mode) the resolved "Flux Space" conversation.
 * Null when flux is stopped or paused — predicates then answer false,
 * which is correct: no Ego turns process while paused.
 */

let currentHostConversationId: string | null = null;

/** Bind the live flux host conversation (called by flux/mod.ts). */
export function setFluxHostConversationId(id: string | null): void {
  currentHostConversationId = id;
}

/**
 * The live flux host conversation id, or null when flux is stopped/paused.
 * Cheap module read — safe per-request.
 */
export function getFluxHostConversationId(): string | null {
  return currentHostConversationId;
}
