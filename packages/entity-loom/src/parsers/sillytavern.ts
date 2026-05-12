/**
 * Entity Loom — SillyTavern Parser
 *
 * Parses SillyTavern chat files (JSONL format, one file per chat).
 *
 * Each JSONL file represents a single chat. The first line is a header with
 * chat_metadata, user_name, and character_name. Subsequent lines are messages.
 */

import type { PlatformParser } from "./interface.ts";
import type {
  ImportedConversation,
  ImportedMessage,
  PlatformType,
} from "../types.ts";
import { sha256Hex } from "../dedup/content-hash.ts";
import { buildTitle } from "./title-utils.ts";

interface STHeader {
  chat_metadata: Record<string, unknown>;
  user_name: string;
  character_name: string;
  create_date?: string;
}

interface STMessage {
  name: string;
  is_user: boolean;
  send_date: string;
  mes: string;
  extra?: Record<string, unknown>;
  swipes?: string[];
  swipe_id?: number;
  force_avatar?: string;
  gen_started?: string;
  gen_finished?: string;
}

export class SillyTavernParser implements PlatformParser {
  readonly platform: PlatformType = "sillytavern";

  async detect(filePath: string): Promise<boolean> {
    try {
      const stat = await Deno.stat(filePath);
      if (!stat.isFile) return false;
      if (!filePath.endsWith(".jsonl")) return false;

      // Read first line and check for SillyTavern header structure
      const file = await Deno.open(filePath);
      const buf = new Uint8Array(1024);
      const n = await file.read(buf) ?? 0;
      file.close();

      const head = new TextDecoder().decode(buf.slice(0, n));
      const firstLine = head.split("\n")[0];
      if (!firstLine) return false;

      const parsed = JSON.parse(firstLine);
      // SillyTavern headers have chat_metadata, user_name, character_name
      return "chat_metadata" in parsed &&
        "user_name" in parsed &&
        "character_name" in parsed;
    } catch {
      return false;
    }
  }

  async parse(filePath: string): Promise<ImportedConversation[]> {
    const stat = await Deno.stat(filePath);

    // Single file = single chat
    if (stat.isFile) {
      const conv = await this.parseChatFile(filePath);
      return conv.messages.length > 0 ? [conv] : [];
    }

    // Directory = multiple chat files
    if (stat.isDirectory) {
      const conversations: ImportedConversation[] = [];
      for await (const entry of Deno.readDir(filePath)) {
        if (!entry.isFile || !entry.name.endsWith(".jsonl")) continue;
        const conv = await this.parseChatFile(`${filePath}/${entry.name}`);
        if (conv.messages.length > 0) {
          conversations.push(conv);
        }
      }
      return conversations;
    }

    throw new Error(`Not a file or directory: ${filePath}`);
  }

  private async parseChatFile(filePath: string): Promise<ImportedConversation> {
    const text = await Deno.readTextFile(filePath);
    const lines = text.split("\n").filter((line) => line.trim());

    if (lines.length === 0) {
      throw new Error(`Empty chat file: ${filePath}`);
    }

    // Parse header (first line)
    const header = JSON.parse(lines[0]) as STHeader;
    const messages: ImportedMessage[] = [];

    // Generate deterministic conversation ID from file content (SHA-256 → UUID format)
    // This ensures the same file always gets the same ID on re-import.
    const fileHash = await sha256Hex(text);
    const conversationId = formatAsUuid(fileHash);

    for (let i = 1; i < lines.length; i++) {
      try {
        const msg = JSON.parse(lines[i]) as STMessage;
        if (!msg.mes?.trim()) continue;

        // Generate stable message ID from timestamp + content hash
        const id = await this.generateMessageId(msg, i);

        const role = msg.is_user ? "user" : "assistant";

        // Replace image references with [image was here]
        const content = this.cleanContent(msg.mes);

        // Extract reasoning from SillyTavern's extra field
        let reasoning: string | undefined;
        if (msg.extra) {
          reasoning =
            (msg.extra as Record<string, unknown>).thinking as string ||
            (msg.extra as Record<string, unknown>).reasoning as string ||
            undefined;
        }

        const createdAt = parseSTDate(msg.send_date);
        if (!createdAt) continue;

        messages.push({
          id,
          role,
          content,
          createdAt,
          reasoning,
        });
      } catch {
        // Skip malformed message lines
        continue;
      }
    }

    // Sort by timestamp
    messages.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

    // SillyTavern doesn't store a chat title in the JSONL — the filename IS the title
    const chatName = filePath.split("/").pop()?.replace(".jsonl", "") ||
      undefined;

    return {
      id: conversationId,
      title: buildTitle(
        "sillytavern",
        chatName,
        messages[0]?.createdAt,
        messages[messages.length - 1]?.createdAt,
      ),
      createdAt: messages.length > 0 ? messages[0].createdAt : new Date(),
      updatedAt: messages.length > 0
        ? messages[messages.length - 1].createdAt
        : new Date(),
      messages,
      platform: "sillytavern",
      systemPrompts: [], // SillyTavern doesn't export system prompts in chat files
      metadata: {
        characterName: header.character_name,
        userName: header.user_name,
      },
    };
  }

  /**
   * Generate a stable message ID from the message content and position.
   */
  private async generateMessageId(
    msg: STMessage,
    index: number,
  ): Promise<string> {
    const content = msg.mes || "";
    const timestamp = msg.send_date || "";
    const hash = await sha256Hex(`${timestamp}:${index}:${content}`);
    return `st-msg-${hash.slice(0, 16)}`;
  }

  /**
   * Clean message content, replacing image references with placeholder.
   */
  private cleanContent(content: string): string {
    // Replace markdown image syntax
    let cleaned = content.replace(/!\[[^\]]*\]\([^)]+\)/g, "[image was here]");
    // Replace HTML img tags
    cleaned = cleaned.replace(/<img[^>]*>/gi, "[image was here]");
    // Replace ST-specific image embedding format
    cleaned = cleaned.replace(
      /\[img\b[^\]]*\][^\[]*?\[\/img\]/gi,
      "[image was here]",
    );
    return cleaned;
  }
}

/**
 * Parse a SillyTavern send_date string into a Date.
 * Handles both ISO format ("2025-12-13T05:03:02.083Z") and the older
 * human-readable format ("2025-04-25 @18h 13m 51s 526ms").
 * Returns null if the date cannot be parsed.
 */
function parseSTDate(sendDate: string): Date | null {
  if (!sendDate) return null;

  // Try standard ISO/JS parsing first
  const d = new Date(sendDate);
  if (!isNaN(d.getTime())) return d;

  // Try older SillyTavern format: "2025-04-25 @18h 13m 51s 526ms"
  const match = sendDate.match(
    /^(\d{4})-(\d{2})-(\d{2})\s+@(\d{1,2})h\s+(\d{1,2})m\s+(\d{1,2})s\s+(\d{1,3})ms$/,
  );
  if (match) {
    const [, year, month, day, hour, min, sec, ms] = match;
    return new Date(
      `${year}-${month}-${day}T${hour.padStart(2, "0")}:${
        min.padStart(2, "0")
      }:${sec.padStart(2, "0")}.${ms.padStart(3, "0")}Z`,
    );
  }

  // Try human-readable format: "August 19, 2025 1:46am" or "August 17, 2025 8:16pm"
  const humanMatch = sendDate.match(
    /^([A-Za-z]+)\s+(\d{1,2}),\s+(\d{4})\s+(\d{1,2}):(\d{2})(am|pm)$/i,
  );
  if (humanMatch) {
    const [, monthName, day, year, hour, min, ampm] = humanMatch;
    let h = parseInt(hour, 10);
    if (ampm.toLowerCase() === "am" && h === 12) h = 0;
    if (ampm.toLowerCase() === "pm" && h !== 12) h += 12;
    const dateStr = `${year}-${monthName}-${day} ${h}:${min}:00`;
    const parsed = new Date(dateStr);
    if (!isNaN(parsed.getTime())) return parsed;
  }

  return null;
}

/**
 * Format a hex hash as a UUID string (xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx).
 * Takes the first 32 hex chars and inserts hyphens at standard UUID positions.
 * The result is deterministic and compatible with Psycheros's UUID-based chat ID system.
 */
function formatAsUuid(hexHash: string): string {
  const h = hexHash.slice(0, 32);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${
    h.slice(16, 20)
  }-${h.slice(20, 32)}`;
}
