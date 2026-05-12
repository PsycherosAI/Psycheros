/**
 * Entity Loom — Claude Parser
 *
 * Parses Claude/Anthropic data exports in two formats:
 *
 * 1. **JSONL format**: Each line is a conversation object with a `conversation`
 *    array of messages. Messages have `role` ("human"/"assistant") and `text`.
 *
 * 2. **JSON array format**: A JSON array of conversation objects with
 *    `chat_messages` containing typed content parts. Messages have `sender`
 *    ("human"/"assistant"), `text` (flattened), and optional `thinking` or
 *    `thinking_blocks`.
 */

import type { PlatformParser } from "./interface.ts";
import type {
  ImportedConversation,
  ImportedMessage,
  PlatformType,
} from "../types.ts";
import { buildTitle } from "./title-utils.ts";

// ─── JSONL format types ─────────────────────────────────────────────

interface ClaudeMessageJSONL {
  uuid: string;
  role: "human" | "assistant";
  text: string;
  created_at: string;
  model?: string;
  thinking?: string;
  attachments?: Array<{
    file_name?: string;
    file_type?: string;
    size_bytes?: number;
  }>;
}

interface ClaudeConversationJSONL {
  uuid: string;
  title?: string;
  chat_name?: string;
  created_at: string;
  updated_at: string;
  summary?: string | null;
  conversation: ClaudeMessageJSONL[];
}

// ─── JSON array format types ────────────────────────────────────────

interface ClaudeMessageJSON {
  uuid: string;
  text: string;
  content?: Array<{ type: string; text?: string; thinking?: string }>;
  sender: "human" | "assistant";
  created_at: string;
  updated_at: string;
  attachments?: Array<{ file_name?: string; file_type?: string }>;
  thinking?: string;
  thinking_blocks?: Array<{ thinking: string }>;
}

interface ClaudeConversationJSON {
  uuid: string;
  name?: string;
  summary?: string | null;
  created_at: string;
  updated_at: string;
  chat_messages: ClaudeMessageJSON[];
}

export class ClaudeParser implements PlatformParser {
  readonly platform: PlatformType = "claude";

  async detect(filePath: string): Promise<boolean> {
    try {
      const stat = await Deno.stat(filePath);
      if (!stat.isFile) return false;

      const lower = filePath.toLowerCase();

      // JSONL format: check for "conversation" array with human/assistant roles
      if (lower.endsWith(".jsonl")) {
        const file = await Deno.open(filePath);
        const buf = new Uint8Array(2048);
        const n = await file.read(buf) ?? 0;
        file.close();

        const head = new TextDecoder().decode(buf.slice(0, n));
        const firstLine = head.split("\n")[0];
        if (!firstLine) return false;

        const parsed = JSON.parse(firstLine);
        return Array.isArray(parsed.conversation) &&
          parsed.conversation.length > 0 &&
          (parsed.conversation[0].role === "human" ||
            parsed.conversation[0].role === "assistant");
      }

      // JSON array format: check for "chat_messages" with "sender" field
      if (lower.endsWith(".json")) {
        const file = await Deno.open(filePath);
        const buf = new Uint8Array(2048);
        const n = await file.read(buf) ?? 0;
        file.close();

        const head = new TextDecoder().decode(buf.slice(0, n));
        // Claude JSON exports have "chat_messages" and "sender" fields
        return head.includes('"chat_messages"') && head.includes('"sender"');
      }

      return false;
    } catch {
      return false;
    }
  }

  async parse(filePath: string): Promise<ImportedConversation[]> {
    const raw = await Deno.readTextFile(filePath);
    const lower = filePath.toLowerCase();

    if (lower.endsWith(".jsonl")) {
      return this.parseJSONL(raw);
    }

    // Try JSON array format
    return this.parseJSONArray(raw);
  }

  // ─── JSONL format ─────────────────────────────────────────────────

  private parseJSONL(text: string): ImportedConversation[] {
    const lines = text.split("\n").filter((line) => line.trim());
    const conversations: ImportedConversation[] = [];
    const errors: string[] = [];

    for (let i = 0; i < lines.length; i++) {
      try {
        const conv = JSON.parse(lines[i]) as ClaudeConversationJSONL;
        const imported = this.parseConversationJSONL(conv);
        if (imported.messages.length > 0) {
          conversations.push(imported);
        }
      } catch (error) {
        errors.push(
          `Line ${i + 1}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    if (errors.length > 0) {
      console.warn(
        `[Claude] ${errors.length} lines had parse errors (skipped)`,
      );
    }

    return conversations;
  }

  private parseConversationJSONL(
    conv: ClaudeConversationJSONL,
  ): ImportedConversation {
    const messages: ImportedMessage[] = [];

    for (const msg of conv.conversation) {
      const role = msg.role === "human" ? "user" : "assistant";

      let content = msg.text || "";
      if (msg.attachments && msg.attachments.length > 0) {
        content = "[image was here]\n" + content;
      }

      if (!content.trim()) continue;

      messages.push({
        id: msg.uuid,
        role,
        content,
        createdAt: new Date(msg.created_at),
        model: msg.model,
        reasoning: msg.role === "assistant"
          ? (msg.thinking || undefined)
          : undefined,
      });
    }

    const title = conv.title || conv.chat_name;

    return {
      id: conv.uuid,
      title: buildTitle(
        "claude",
        title,
        messages[0]?.createdAt,
        messages[messages.length - 1]?.createdAt,
      ),
      createdAt: new Date(conv.created_at),
      updatedAt: new Date(conv.updated_at),
      messages,
      platform: "claude",
      systemPrompts: [],
    };
  }

  // ─── JSON array format ───────────────────────────────────────────

  private parseJSONArray(text: string): ImportedConversation[] {
    const parsed = JSON.parse(text);
    const convs = Array.isArray(parsed) ? parsed : [parsed];
    const conversations: ImportedConversation[] = [];

    for (let i = 0; i < convs.length; i++) {
      try {
        const conv = convs[i] as ClaudeConversationJSON;
        const imported = this.parseConversationJSON(conv);
        if (imported.messages.length > 0) {
          conversations.push(imported);
        }
      } catch (error) {
        console.warn(
          `[Claude] Conversation ${i}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    return conversations;
  }

  private parseConversationJSON(
    conv: ClaudeConversationJSON,
  ): ImportedConversation {
    const messages: ImportedMessage[] = [];

    for (const msg of conv.chat_messages) {
      if (msg.sender !== "human" && msg.sender !== "assistant") continue;

      const role = msg.sender === "human" ? "user" : "assistant";

      // Use the pre-flattened text field (contains full text including after tool calls)
      let content = msg.text || "";

      // Check for image attachments
      if (msg.attachments && msg.attachments.length > 0) {
        content = "[image was here]\n" + content;
      }

      if (!content.trim()) continue;

      // Extract reasoning from thinking or thinking_blocks
      let reasoning: string | undefined;
      if (role === "assistant") {
        if (msg.thinking) {
          reasoning = msg.thinking;
        } else if (msg.thinking_blocks && msg.thinking_blocks.length > 0) {
          reasoning = msg.thinking_blocks.map((b) => b.thinking).join("\n");
        }
      }

      messages.push({
        id: msg.uuid,
        role,
        content,
        createdAt: new Date(msg.created_at),
        reasoning: reasoning || undefined,
      });
    }

    const title = conv.name || conv.summary || undefined;

    return {
      id: conv.uuid,
      title: buildTitle(
        "claude",
        title,
        messages[0]?.createdAt,
        messages[messages.length - 1]?.createdAt,
      ),
      createdAt: new Date(conv.created_at),
      updatedAt: new Date(conv.updated_at),
      messages,
      platform: "claude",
      systemPrompts: [],
    };
  }
}
