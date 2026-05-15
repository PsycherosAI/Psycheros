/**
 * Entity Loom — ChatGPT Plugin Export Parser
 *
 * Parses 3rd-party browser plugin exports (e.g., GerTex ChatGPT Exporter
 * Chrome extension) and other non-official ChatGPT data captures.
 *
 * These exports are single-conversation JSON files: a standalone
 * `ChatGPTConversation` object with `mapping` and `current_node` at the
 * top level, typically using `conversation_id` instead of `id`.
 * Custom instructions may use the `user_editable_context` content type.
 *
 * This parser is intentionally separate from the official parser so that
 * fixes to plugin-export quirks cannot break official export parsing.
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

export class ChatGPTPluginParser {
  /**
   * Parse a single-conversation export from a 3rd-party plugin.
   *
   * @param parsed - The parsed JSON (a single ChatGPTConversation object)
   * @param filePath - Original file path (used for error messages only)
   */
  parse(
    parsed: unknown,
    _filePath: string,
  ): ImportedConversation[] {
    const conv = parsed as ChatGPTConversation;
    const convId = conv.conversation_id || conv.id || "unknown";

    const imported = this.parseConversation(convId, conv);
    if (imported.messages.length === 0) return [];

    return [imported];
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

      // Plugin exports may embed custom instructions as user system messages
      if (msg.metadata?.is_user_system_message === true) {
        const text = extractSystemPromptText(msg);
        if (text) systemPrompts.push(text);
        continue;
      }

      // Skip null-content system messages (structural nodes)
      if (msg.author.role === "system") continue;

      // Skip tool messages
      if (msg.author.role === "tool") continue;

      // Skip visually hidden messages
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
