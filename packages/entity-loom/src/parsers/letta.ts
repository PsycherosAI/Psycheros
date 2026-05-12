/**
 * Entity Loom — Letta Parser
 *
 * Parses Letta agent chat log exports (JSON format).
 *
 * Letta exports are JSON files containing a single agent's full message history.
 * Messages include user, assistant, reasoning, system, and tool types.
 * Reasoning messages share the same ID as their corresponding assistant message
 * and contain a "reasoning" field with the thinking chain text.
 */

import type { PlatformParser } from "./interface.ts";
import type {
  ImportedConversation,
  ImportedMessage,
  PlatformType,
} from "../types.ts";

interface LettaMessage {
  id: string;
  date: string;
  name: string | null;
  message_type: string;
  content?: string;
  reasoning?: string;
  otid: string | null;
  sender_id: string | null;
  step_id: string | null;
  is_err: boolean | null;
  seq_id: number | null;
  run_id: string | null;
}

interface LettaExport {
  agent_id: string;
  instance: string;
  exported_at: string;
  message_count: number;
  messages: LettaMessage[];
}

export class LettaParser implements PlatformParser {
  readonly platform: PlatformType = "letta";

  async detect(filePath: string): Promise<boolean> {
    try {
      const stat = await Deno.stat(filePath);
      if (!stat.isFile) return false;
      if (!filePath.endsWith(".json")) return false;

      // Read first 2KB and check for Letta export structure
      const file = await Deno.open(filePath);
      const buf = new Uint8Array(2048);
      const n = await file.read(buf) ?? 0;
      file.close();

      const head = new TextDecoder().decode(buf.slice(0, n));
      // Letta exports have "agent_id", "instance", and "messages" with "message_type"
      return head.includes('"agent_id"') &&
        head.includes('"instance"') &&
        head.includes('"message_type"');
    } catch {
      return false;
    }
  }

  async parse(filePath: string): Promise<ImportedConversation[]> {
    const stat = await Deno.stat(filePath);

    // Single file = single conversation
    if (stat.isFile) {
      const conv = await this.parseExportFile(filePath);
      return conv.messages.length > 0 ? [conv] : [];
    }

    // Directory = multiple export files
    if (stat.isDirectory) {
      const conversations: ImportedConversation[] = [];
      for await (const entry of Deno.readDir(filePath)) {
        if (!entry.isFile || !entry.name.endsWith(".json")) continue;
        const conv = await this.parseExportFile(`${filePath}/${entry.name}`);
        if (conv.messages.length > 0) {
          conversations.push(conv);
        }
      }
      return conversations;
    }

    throw new Error(`Not a file or directory: ${filePath}`);
  }

  private async parseExportFile(
    filePath: string,
  ): Promise<ImportedConversation> {
    const raw = await Deno.readTextFile(filePath);
    const data = JSON.parse(raw) as LettaExport;

    const messages: ImportedMessage[] = [];
    const systemPrompts: string[] = [];

    // First pass: collect reasoning by message ID.
    // reasoning_messages share the same id as their corresponding assistant_message.
    const reasoningMap = new Map<string, string>();
    for (const msg of data.messages) {
      if (msg.message_type === "reasoning_message" && msg.reasoning) {
        reasoningMap.set(msg.id, msg.reasoning);
      }
    }

    // Second pass: build messages from user and assistant messages only
    for (const msg of data.messages) {
      switch (msg.message_type) {
        case "user_message": {
          if (!msg.content?.trim()) continue;
          messages.push({
            id: `letta-${msg.otid || msg.id}`,
            role: "user",
            content: msg.content,
            createdAt: new Date(msg.date),
          });
          break;
        }

        case "assistant_message": {
          if (!msg.content?.trim()) continue;
          const reasoning = reasoningMap.get(msg.id);
          messages.push({
            id: `letta-${msg.otid || msg.id}`,
            role: "assistant",
            content: msg.content,
            createdAt: new Date(msg.date),
            reasoning: reasoning || undefined,
          });
          break;
        }

        case "system_message": {
          // Extract the first system message as a system prompt (agent instructions)
          if (systemPrompts.length === 0 && msg.content?.trim()) {
            systemPrompts.push(msg.content);
          }
          break;
        }

          // Skip reasoning_message, tool_call_message, tool_return_message
      }
    }

    // Sort by timestamp (should already be sorted, but ensure it)
    messages.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

    const instanceName = data.instance ||
      filePath.split("/").pop()?.replace(".json", "") || "unknown";

    return {
      id: data.agent_id || `letta-${Date.now()}`,
      title: `[letta] ${instanceName}`,
      createdAt: messages.length > 0
        ? messages[0].createdAt
        : new Date(data.exported_at),
      updatedAt: messages.length > 0
        ? messages[messages.length - 1].createdAt
        : new Date(data.exported_at),
      messages,
      platform: "letta",
      systemPrompts,
      metadata: {
        agentName: data.instance || "unknown",
      },
    };
  }
}
