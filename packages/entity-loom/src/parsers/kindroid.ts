/**
 * Entity Loom — Kindroid Parser
 *
 * Parses Kindroid chat logs exported via the KinLog Chrome extension (JSON format).
 *
 * KinLog exports are JSON files with a "chat" array of [name, content] tuples.
 * There are no explicit role markers, timestamps, or message IDs.
 *
 * Role detection heuristic: the most frequent sender is assumed to be the
 * AI character (the kintroid). All other names are treated as user messages.
 * This works well for typical Kindroid conversations where the AI sends more
 * messages (multi-paragraph responses split across entries).
 *
 * Timestamps: KinLog does not include timestamps. All messages are assigned
 * the file's modification time as a fallback. This means all messages from
 * a single file will appear on the same date in the database.
 */

import type { PlatformParser } from "./interface.ts";
import type {
  ImportedConversation,
  ImportedMessage,
  PlatformType,
} from "../types.ts";
import { sha256Hex } from "../dedup/content-hash.ts";

interface KindroidExport {
  about?: string[];
  meta?: {
    source: string;
    version: string;
  };
  chat: [string, string][];
}

export class KindroidParser implements PlatformParser {
  readonly platform: PlatformType = "kindroid";

  async detect(filePath: string): Promise<boolean> {
    try {
      const stat = await Deno.stat(filePath);
      if (!stat.isFile) return false;
      if (!filePath.endsWith(".json")) return false;

      // Read first 2KB and check for KinLog export structure
      const file = await Deno.open(filePath);
      const buf = new Uint8Array(2048);
      const n = await file.read(buf) ?? 0;
      file.close();

      const head = new TextDecoder().decode(buf.slice(0, n));
      // KinLog exports have "about" with "Kindroid" and a "chat" array of tuples
      return head.includes('"KinLog"') && head.includes('"chat"');
    } catch {
      return false;
    }
  }

  async parse(filePath: string): Promise<ImportedConversation[]> {
    const stat = await Deno.stat(filePath);

    // Single file = single conversation
    if (stat.isFile) {
      const conv = await this.parseExportFile(
        filePath,
        stat.mtime ?? new Date(),
      );
      return conv.messages.length > 0 ? [conv] : [];
    }

    // Directory = multiple export files
    if (stat.isDirectory) {
      const conversations: ImportedConversation[] = [];
      for await (const entry of Deno.readDir(filePath)) {
        if (!entry.isFile || !entry.name.endsWith(".json")) continue;
        const entryStat = await Deno.stat(`${filePath}/${entry.name}`);
        const conv = await this.parseExportFile(
          `${filePath}/${entry.name}`,
          entryStat.mtime ?? new Date(),
        );
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
    fileMtime: Date,
  ): Promise<ImportedConversation> {
    const raw = await Deno.readTextFile(filePath);
    const data = JSON.parse(raw) as KindroidExport;

    if (!Array.isArray(data.chat) || data.chat.length === 0) {
      throw new Error(`Empty or invalid Kindroid chat in: ${filePath}`);
    }

    // Determine AI character: the most frequent sender in the chat.
    // In typical Kindroid conversations, the kintroid sends more messages.
    const nameCounts = new Map<string, number>();
    for (const [name] of data.chat) {
      nameCounts.set(name, (nameCounts.get(name) || 0) + 1);
    }
    let aiName = "";
    let maxCount = 0;
    for (const [name, count] of nameCounts) {
      if (count > maxCount) {
        maxCount = count;
        aiName = name;
      }
    }

    const messages: ImportedMessage[] = [];

    for (let i = 0; i < data.chat.length; i++) {
      const [name, content] = data.chat[i];
      if (!content?.trim()) continue;

      const role = name === aiName ? "assistant" : "user";
      const id = await sha256Hex(`kindroid:${name}:${i}:${content}`);

      messages.push({
        id: `kd-msg-${id.slice(0, 16)}`,
        role,
        content,
        createdAt: new Date(fileMtime),
      });
    }

    // Generate a stable conversation ID from file content
    const fileHash = await sha256Hex(raw);
    const conversationId = formatAsUuid(fileHash);

    const title = aiName || filePath.split("/").pop()?.replace(".json", "") ||
      "unknown";

    return {
      id: conversationId,
      title: `[kindroid] ${title}`,
      createdAt: messages.length > 0
        ? messages[0].createdAt
        : new Date(fileMtime),
      updatedAt: messages.length > 0
        ? messages[messages.length - 1].createdAt
        : new Date(fileMtime),
      messages,
      platform: "kindroid",
      systemPrompts: [],
      metadata: {
        characterName: aiName,
      },
    };
  }
}

/**
 * Format a hex hash as a UUID string (xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx).
 */
function formatAsUuid(hexHash: string): string {
  const h = hexHash.slice(0, 32);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${
    h.slice(16, 20)
  }-${h.slice(20, 32)}`;
}
