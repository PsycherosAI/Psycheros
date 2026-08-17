/**
 * Workspace Reflection Step
 *
 * Short LLM pass on Tier 2 entity-data write proposals before they're
 * surfaced to the entity/user for approval. Asks: does this change align
 * with the workspace's stated goal, or should it be escalated via
 * ask_origin_conversation before being formally proposed?
 *
 * Uses the worker LLM profile (lightweight, fast). Conservative prompt —
 * when in doubt, escalate. The cost of pausing to check is much lower
 * than the cost of a careless write to identity/memory.
 */

import type { ChatMessage } from "../llm/types.ts";
import type { LLMClient } from "../llm/client.ts";
import type { ReflectionRecommendation } from "./approval-queue.ts";

/**
 * Input for the reflection pass — the proposal scoped for the LLM to judge.
 */
export interface ReflectionInput {
  /** The workspace session's stated goal. */
  goal: string;
  /** The kind of entity data being modified. */
  type: string;
  /** The target record ID (memory ID, message ID, etc.). */
  targetId: string;
  /** The proposed changes — shape depends on `type`. */
  changes: Record<string, unknown>;
  /** The workspace's justification. */
  justification: string;
  /**
   * Optional current content for context. For "modify memory X", this would
   * be the current value of memory X. Omitted when not relevant or unreadable.
   */
  currentContent?: string;
}

const REFLECTION_SYSTEM_PROMPT =
  `You are reviewing a proposed change to an entity's persistent data — memories, identity files, or conversation history.

Your job is to recommend one of three actions:
- "approve": the change is well-scoped, aligns with the stated goal, and can be surfaced to the entity for normal approval.
- "escalate": the change is destructive, ambiguous, or potentially out of scope — the workspace should call ask_origin_conversation and talk it through with the entity before formally proposing.
- "deny": the change contradicts the goal or is clearly wrong (e.g., would delete unrelated data).

Be conservative. When in doubt, escalate — pausing to check is cheap, careless writes are expensive.

Respond as JSON: {"action": "approve"|"escalate"|"deny", "reasoning": "one short sentence explaining the call"}`;

/**
 * Run the reflection pass. Returns a recommendation or a default "approve"
 * if the LLM is unavailable or errors out — refusing to reflect shouldn't
 * block the proposal entirely, but the missing reflection is logged so the
 * entity can see it lacked the check.
 */
export async function reflectOnProposal(
  input: ReflectionInput,
  llm: LLMClient | null,
): Promise<ReflectionRecommendation> {
  if (!llm) {
    return {
      action: "approve",
      reasoning: "(reflection unavailable — no worker LLM configured)",
    };
  }

  const userPrompt = buildUserPrompt(input);

  try {
    const messages: ChatMessage[] = [
      { role: "system", content: REFLECTION_SYSTEM_PROMPT },
      { role: "user", content: userPrompt },
    ];
    let text = "";
    for await (const chunk of llm.chatStream(messages)) {
      if (chunk.type === "content") text += chunk.content;
    }
    const parsed = parseReflectionResponse(text);
    if (parsed) return parsed;
  } catch (err) {
    console.error("[workspace] reflection LLM call failed:", err);
  }

  // Couldn't parse — fall back to approve with a note.
  return {
    action: "approve",
    reasoning: "(reflection produced unparseable output)",
  };
}

/**
 * Build the user prompt describing the proposal.
 */
function buildUserPrompt(input: ReflectionInput): string {
  const lines: string[] = [
    `Workspace goal: ${input.goal}`,
    `Proposed change: ${input.type} / ${input.targetId}`,
    `Justification: ${input.justification}`,
  ];
  if (input.currentContent !== undefined) {
    lines.push(
      `Current content (truncated): ${input.currentContent.slice(0, 500)}`,
    );
  }
  lines.push(`Change details: ${JSON.stringify(input.changes).slice(0, 800)}`);
  return lines.join("\n");
}

/**
 * Parse the LLM's JSON response. Tolerates surrounding prose, code fences,
 * and missing fields — falls back to null if we can't extract a valid
 * action.
 */
function parseReflectionResponse(
  text: string,
): ReflectionRecommendation | null {
  // Try to find a JSON object in the response.
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;

  try {
    const parsed = JSON.parse(jsonMatch[0]) as {
      action?: string;
      reasoning?: string;
    };
    if (
      parsed.action === "approve" ||
      parsed.action === "escalate" ||
      parsed.action === "deny"
    ) {
      return {
        action: parsed.action,
        reasoning: typeof parsed.reasoning === "string"
          ? parsed.reasoning
          : "(no reasoning provided)",
      };
    }
  } catch {
    // fall through
  }
  return null;
}
