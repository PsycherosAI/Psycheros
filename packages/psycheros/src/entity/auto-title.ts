/**
 * Auto-Title Generation
 *
 * Uses a lightweight worker model to automatically generate conversation
 * titles based on the user's first message. Broadcasts updates via the
 * persistent SSE channel.
 */

import { createClientFromProfile, createWorkerClient } from "../llm/mod.ts";
import type { LLMClient, LLMConnectionProfile } from "../llm/mod.ts";
import type { DBClient } from "../db/mod.ts";
import { updateConversationTitle } from "../server/state-changes.ts";
import { getBroadcaster } from "../server/broadcaster.ts";
import { generateUIUpdates } from "../server/ui-updates.ts";

/**
 * System prompt for the title generation task.
 */
const TITLE_GENERATION_PROMPT =
  `Generate a short, descriptive title (3-6 words) for a conversation that starts with the user message below. Return ONLY the title text, nothing else. No quotes, no explanation.`;

/**
 * Generate a title for a conversation based on the first user message.
 *
 * Broadcasts the title update via the persistent SSE channel so clients
 * receive the update regardless of whether the chat stream is still open.
 */
export async function generateAndSetTitle(
  conversationId: string,
  userMessage: string,
  db: DBClient,
  options?: { workerClient?: LLMClient; activeProfile?: LLMConnectionProfile },
): Promise<{ success: boolean; title?: string }> {
  try {
    const workerClient = options?.workerClient ??
      (options?.activeProfile
        ? createClientFromProfile(options.activeProfile, {
          useWorker: true,
          thinkingEnabled: false,
        })
        : createWorkerClient());

    let generatedTitle = "";
    for await (
      const chunk of workerClient.chatStream([
        { role: "system", content: TITLE_GENERATION_PROMPT },
        { role: "user", content: userMessage },
      ])
    ) {
      if (chunk.type === "content") {
        generatedTitle += chunk.content;
      }
    }

    // Clean up the title
    generatedTitle = generatedTitle.trim();

    // Remove surrounding quotes if present
    if (
      (generatedTitle.startsWith('"') && generatedTitle.endsWith('"')) ||
      (generatedTitle.startsWith("'") && generatedTitle.endsWith("'"))
    ) {
      generatedTitle = generatedTitle.slice(1, -1);
    }

    if (!generatedTitle || generatedTitle.length < 2) {
      console.warn("Auto-title: Generated title too short, skipping");
      return { success: false };
    }

    // Truncate if too long
    if (generatedTitle.length > 30) {
      generatedTitle = generatedTitle.substring(0, 27) + "...";
    }

    const result = updateConversationTitle(db, conversationId, generatedTitle);

    if (!result.success) {
      console.error("Auto-title: Failed to update title:", result.error);
      return { success: false };
    }

    console.log(`Auto-title: Set "${generatedTitle}"`);

    // Broadcast updates via persistent SSE channel
    if (result.affectedRegions.length > 0) {
      const updates = generateUIUpdates(
        result.affectedRegions,
        db,
        conversationId,
      );
      getBroadcaster().broadcastUpdates(updates, conversationId);
    }

    return {
      success: true,
      title: generatedTitle,
    };
  } catch (error) {
    console.error(
      "Auto-title: Error:",
      error instanceof Error ? error.message : String(error),
    );
    return { success: false };
  }
}
