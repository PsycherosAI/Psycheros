/**
 * Workspace Briefing Composition
 *
 * Composes the first user message sent to OpenCode — the entity's active
 * recall of relevant context. There is no auto-summary of origin conversation;
 * the entity explicitly states its goal, context, and any pinned quotes.
 */

import type { Message, WorkspaceBriefing } from "../types.ts";

/**
 * Compose the briefing text the entity writes when opening a workspace session.
 * Becomes the first user message in the OpenCode conversation.
 *
 * Pinned messages, if present, are appended verbatim with attribution so the
 * workspace sees exactly what was said in origin, not a paraphrase.
 */
export function composeBriefing(
  briefing: WorkspaceBriefing,
  pinnedMessages?: Message[],
): string {
  const parts: string[] = [];

  parts.push(briefing.goal);

  if (briefing.context) {
    parts.push("");
    parts.push(`Context: ${briefing.context}`);
  }

  if (briefing.bundledSkills?.length) {
    parts.push("");
    parts.push(
      `Bundled skills (load with your skill tool): ${
        briefing.bundledSkills.join(", ")
      }`,
    );
  }

  if (pinnedMessages && pinnedMessages.length > 0) {
    parts.push("");
    parts.push("Verbatim from our conversation:");
    for (const msg of pinnedMessages) {
      const role = msg.role === "user" ? "human" : msg.role;
      parts.push(`  [${role}] ${msg.content}`);
    }
  }

  return parts.join("\n");
}

/**
 * Title for the workspace conversation, shown in the conversation list.
 * Derived from the goal — first 60 chars, truncated with ellipsis if needed.
 */
export function deriveSessionTitle(briefing: WorkspaceBriefing): string {
  const goal = briefing.goal.trim().replace(/\s+/g, " ");
  if (goal.length <= 60) return goal;
  return goal.slice(0, 57) + "...";
}
