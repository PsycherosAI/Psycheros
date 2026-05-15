/**
 * Entity Loom — ChatGPT Official Export Parser
 *
 * Parses native OpenAI data exports. Supports two formats:
 * - **Array format** (newer): `ChatGPTConversation[]` — a flat array of
 *   conversation objects, each with its own `id` field.
 * - **Object format** (legacy): `Record<string, ChatGPTConversation>` where
 *   each key is a conversation UUID.
 *
 * Both formats contain the same per-conversation structure: a `mapping` field
 * with a tree supporting branching (regeneration), and a `current_node` pointer.
 * We follow `current_node` to get the canonical conversation thread.
 */

import type { ImportedConversation, ImportedMessage } from "../types.ts";
import type { ChatGPTConversation } from "./chatgpt-shared.ts";
import {
  clampTimestamp,
  extractSystemPromptText,
  extractText,
  extractThinking,
  walkTree,
} from "./chatgpt-shared.ts";
import { buildTitle } from "./title-utils.ts";

export class ChatGPTOfficialParser {
  /**
   * Parse an already-loaded JSON value from an official ChatGPT export.
   *
   * @param parsed - The parsed JSON (array or UUID-keyed object)
   * @param filePath - Original file path (used for error messages only)
   */
  parse(
    parsed: unknown,
    _filePath: string,
  ): ImportedConversation[] {
    let entries: Array<[string, ChatGPTConversation]>;

    if (Array.isArray(parsed)) {
      entries = parsed.map(
        (conv: ChatGPTConversation) =>
          [conv.id || conv.conversation_id || "unknown", conv] as [
            string,
            ChatGPTConversation,
          ],
      );
    } else {
      entries = Object.entries(
        parsed as Record<string, ChatGPTConversation>,
      );
    }

    const conversations: ImportedConversation[] = [];
    const errors: string[] = [];

    for (const [convId, conv] of entries) {
      try {
        const imported = this.parseConversation(convId, conv);
        if (imported.messages.length > 0) {
          conversations.push(imported);
        }
      } catch (error) {
        errors.push(
          `Conversation ${convId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    if (errors.length > 0) {
      console.warn(
        `[ChatGPT/Official] ${errors.length} conversations had parse errors (skipped)`,
      );
    }

    return conversations;
  }

  private parseConversation(
    convId: string,
    conv: ChatGPTConversation,
  ): ImportedConversation {
    const nodes = walkTree(conv.mapping, conv.current_node);

    const messages: ImportedMessage[] = [];
    const systemPrompts: string[] = [];

    for (const node of nodes) {
      if (!node.message) continue;

      const msg = node.message;

      // Extract system prompts / custom instructions
      if (msg.metadata?.is_user_system_message === true) {
        const text = extractSystemPromptText(msg);
        if (text) systemPrompts.push(text);
        continue;
      }

      // Skip null-content system messages (structural nodes)
      if (msg.author.role === "system") continue;

      // Skip tool messages
      if (msg.author.role === "tool") continue;

      // Skip visually hidden messages (regenerated branches, scaffolding)
      if (msg.metadata?.is_visually_hidden_from_conversation === true) {
        continue;
      }

      const role = msg.author.role === "user" ? "user" : "assistant";
      const content = extractText(msg);

      if (!content.trim()) continue;

      const reasoning = extractThinking(msg);

      messages.push({
        id: msg.id,
        role,
        content,
        createdAt: new Date(clampTimestamp(msg.create_time ?? 0) * 1000),
        model: msg.metadata?.model_slug || msg.metadata?.resolved_model_slug,
        reasoning: reasoning || undefined,
      });
    }

    return {
      id: conv.conversation_id || conv.id || convId,
      title: buildTitle(
        "chatgpt",
        conv.title,
        messages[0]?.createdAt,
        messages[messages.length - 1]?.createdAt,
      ),
      createdAt: new Date(clampTimestamp(conv.create_time) * 1000),
      updatedAt: new Date(clampTimestamp(conv.update_time) * 1000),
      messages,
      platform: "chatgpt",
      systemPrompts,
    };
  }
}
