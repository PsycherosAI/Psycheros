/**
 * Entity Loom — ChatGPT Parser
 *
 * Parses ChatGPT data exports (conversations.json) and single-conversation exports
 * from the GerTex ChatGPT Exporter Chrome extension.
 *
 * ChatGPT exports come in three formats:
 * - **Object format** (legacy): `Record<string, ChatGPTConversation>` where each
 *   key is a conversation UUID.
 * - **Array format** (newer): `ChatGPTConversation[]` — a flat array of conversation
 *   objects, each containing its own `id` field.
 * - **Single-conversation format** (GerTex exporter): A single `ChatGPTConversation`
 *   object with `mapping` and `current_node` at the top level, using `conversation_id`
 *   instead of `id`. Custom instructions use `user_editable_context` content type.
 *
 * All formats contain the same per-conversation structure: a `mapping` field with
 * a tree supporting branching (regeneration), and a `current_node` pointer.
 * We follow `current_node` to get the canonical conversation thread.
 */

import type { PlatformParser } from "./interface.ts";
import type {
  ImportedConversation,
  ImportedMessage,
  PlatformType,
} from "../types.ts";
import { buildTitle } from "./title-utils.ts";

interface ChatGPTContentPart {
  content_type: string;
  text?: string;
  asset_pointer?: string;
  width?: number;
  height?: number;
  size_bytes?: number;
}

interface ChatGPTMessage {
  id: string;
  author: { role: string; name?: string; metadata?: Record<string, unknown> };
  content: {
    content_type: string;
    parts?: Array<string | ChatGPTContentPart>;
    [key: string]: unknown;
  };
  create_time: number | null;
  update_time: number | null;
  metadata?: {
    model_slug?: string;
    resolved_model_slug?: string;
    is_user_system_message?: boolean;
    is_visually_hidden_from_conversation?: boolean;
    conversation_id?: string;
    user_id?: string;
    parent_message_id?: string;
    [key: string]: unknown;
  };
  status?: string;
  end_turn?: boolean | null;
  weight?: number;
}

interface ChatGPTNode {
  id: string;
  message: ChatGPTMessage | null;
  parent: string | null;
  children: string[];
}

interface ChatGPTConversation {
  title?: string;
  create_time: number;
  update_time: number;
  mapping: Record<string, ChatGPTNode>;
  current_node: string;
  conversation_template?: string | null;
  conversation_mode?: Record<string, unknown> | null;
  gizmo_id?: string | null;
  is_archived?: boolean;
  id?: string;
  conversation_id?: string;
  default_model_slug?: string;
}

export class ChatGPTParser implements PlatformParser {
  readonly platform: PlatformType = "chatgpt";

  async detect(filePath: string): Promise<boolean> {
    try {
      const stat = await Deno.stat(filePath);
      if (!stat.isFile) return false;
      if (!filePath.endsWith(".json")) return false;

      // Read first 2KB and check for ChatGPT export structure
      let file = await Deno.open(filePath);
      const buf = new Uint8Array(2048);
      const n = await file.read(buf) ?? 0;
      file.close();

      const head = new TextDecoder().decode(buf.slice(0, n));
      // Object format: { "uuid": { "mapping": ..., "current_node": ... } }
      if (head.includes('"mapping"') && head.includes('"current_node"')) {
        return true;
      }
      // Array format: [ { "id": "...", "title": ..., "create_time": ..., "mapping": ... } ]
      if (
        head.startsWith("[") && head.includes('"create_time"') &&
        head.includes('"mapping"')
      ) return true;
      // Single-conversation format (GerTex exporter): mapping/current_node may be deep
      // in the file. Check tail for "current_node" (always the last field).
      if (head.startsWith("{") && head.includes('"mapping"')) {
        const tailSize = Math.min(2048, stat.size);
        const tailBuf = new Uint8Array(tailSize);
        file = await Deno.open(filePath);
        await file.seek(-tailSize, Deno.SeekMode.End);
        const tn = await file.read(tailBuf) ?? 0;
        file.close();
        const tail = new TextDecoder().decode(tailBuf.slice(0, tn));
        if (tail.includes('"current_node"')) return true;
        return false;
      }
      return false;
    } catch {
      return false;
    }
  }

  async parse(filePath: string): Promise<ImportedConversation[]> {
    const raw = await Deno.readTextFile(filePath);
    const parsed = JSON.parse(raw);

    // ChatGPT exports come in three formats:
    //   - Array (newer): [ { ... }, { ... }, ... ]
    //   - Single-conversation (GerTex exporter): { "mapping": ..., "current_node": ... }
    //   - Object (legacy): { "uuid": { ... }, ... }
    let entries: Array<[string, ChatGPTConversation]>;

    if (Array.isArray(parsed)) {
      entries = parsed.map(
        (conv: ChatGPTConversation) =>
          [conv.id || conv.conversation_id || "unknown", conv] as [
            string,
            ChatGPTConversation,
          ],
      );
    } else if (
      typeof parsed === "object" && parsed !== null &&
      "mapping" in parsed && "current_node" in parsed &&
      typeof (parsed as Record<string, unknown>).mapping === "object" &&
      !Array.isArray((parsed as Record<string, unknown>).mapping)
    ) {
      // Single-conversation format (GerTex exporter, etc.)
      const conv = parsed as ChatGPTConversation;
      const convId = conv.conversation_id || conv.id || "unknown";
      entries = [[convId, conv]];
    } else {
      entries = Object.entries(parsed as Record<string, ChatGPTConversation>);
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
        `[ChatGPT] ${errors.length} conversations had parse errors (skipped)`,
      );
    }

    return conversations;
  }

  /**
   * Clamp a Unix timestamp to a reasonable range (2020–2030).
   * ChatGPT exports can contain corrupt timestamps (e.g., year 57374).
   */
  private clampTimestamp(unixTs: number): number {
    const MIN = 1577836800; // 2020-01-01 UTC
    const MAX = 1893456000; // 2030-01-01 UTC
    return Math.max(MIN, Math.min(MAX, unixTs));
  }

  private parseConversation(
    convId: string,
    conv: ChatGPTConversation,
  ): ImportedConversation {
    // Walk the tree from current_node to get the canonical thread
    const nodes = this.walkTree(conv.mapping, conv.current_node);

    const messages: ImportedMessage[] = [];
    const systemPrompts: string[] = [];

    for (const node of nodes) {
      if (!node.message) continue;

      const msg = node.message;

      // Extract system prompts / custom instructions
      // GerTex format uses role "user" with is_user_system_message for custom instructions
      if (msg.metadata?.is_user_system_message === true) {
        const text = this.extractSystemPromptText(msg);
        if (text) systemPrompts.push(text);
        continue;
      }

      // Skip null-content system messages (structural nodes)
      if (msg.author.role === "system") continue;

      // Skip tool messages
      if (msg.author.role === "tool") continue;

      // Skip visually hidden messages (regenerated branches, scaffolding)
      if (msg.metadata?.is_visually_hidden_from_conversation === true) continue;

      // Map roles
      const role = msg.author.role === "user" ? "user" : "assistant";
      const content = this.extractText(msg);

      // Skip empty messages
      if (!content.trim()) continue;

      const reasoning = this.extractThinking(msg);

      messages.push({
        id: msg.id,
        role,
        content,
        createdAt: new Date(this.clampTimestamp(msg.create_time ?? 0) * 1000),
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
      createdAt: new Date(this.clampTimestamp(conv.create_time) * 1000),
      updatedAt: new Date(this.clampTimestamp(conv.update_time) * 1000),
      messages,
      platform: "chatgpt",
      systemPrompts,
    };
  }

  /**
   * Walk the conversation tree from current_node to root,
   * collecting nodes in chronological order (oldest first).
   */
  private walkTree(
    mapping: Record<string, ChatGPTNode>,
    current_node: string,
  ): ChatGPTNode[] {
    const nodes: ChatGPTNode[] = [];
    let nodeId: string | null = current_node;

    while (nodeId) {
      const node: ChatGPTNode | undefined = mapping[nodeId];
      if (!node) break;
      if (node.message !== null) {
        nodes.unshift(node); // Build oldest-first
      }
      nodeId = node.parent;
    }

    return nodes;
  }

  /**
   * Extract system prompt text from a message.
   * Handles both standard parts-based format and GerTex's user_editable_context.
   */
  private extractSystemPromptText(msg: ChatGPTMessage): string {
    if (msg.content?.content_type === "user_editable_context") {
      const parts: string[] = [];
      const userInstructions = msg.content.user_instructions as
        | string
        | undefined;
      const userProfile = msg.content.user_profile as string | undefined;
      if (userProfile?.trim()) parts.push(userProfile.trim());
      if (userInstructions?.trim()) parts.push(userInstructions.trim());
      return parts.join("\n\n");
    }
    return this.extractText(msg);
  }

  /**
   * Extract text content from a ChatGPT message.
   * Handles multimodal content by replacing images with [image was here].
   */
  private extractText(msg: ChatGPTMessage): string {
    if (!msg.content?.parts) return "";

    const textParts: string[] = [];

    for (const part of msg.content.parts) {
      if (typeof part === "string") {
        textParts.push(part);
      } else if (part.content_type === "text" && part.text) {
        textParts.push(part.text);
      } else if (part.asset_pointer) {
        // Image or other media asset
        textParts.push("[image was here]");
      }
    }

    return textParts.join("\n");
  }

  /**
   * Extract thinking/reasoning content from a ChatGPT message.
   * o1/o3 models store reasoning as parts with content_type "thinking".
   */
  private extractThinking(msg: ChatGPTMessage): string {
    if (!msg.content?.parts) return "";

    const parts: string[] = [];
    for (const part of msg.content.parts) {
      if (
        typeof part !== "string" && part.content_type === "thinking" &&
        part.text
      ) {
        parts.push(part.text);
      }
    }
    return parts.join("\n");
  }
}
