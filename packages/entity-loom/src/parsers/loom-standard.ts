/**
 * Entity Loom — Loom Standard Parser
 *
 * Reads files in the "Loom Standard Import Format" — a stable JSON format
 * that third-party agents (Codex, Claude Code, etc.) can produce from any
 * platform's raw export. See docs/loom-standard-format.md for the spec.
 *
 * The format is a wrapper object:
 *
 * {
 *   "format": "loom-standard",
 *   "version": 1,
 *   "originPlatform": "ChatGPT",
 *   "conversations": [ { id, title, createdAt, updatedAt, messages: [...] } ]
 * }
 *
 * Detection is unambiguous: the `"format": "loom-standard"` marker has no
 * overlap with any native export format, so this parser is registered first
 * in the detection order.
 */

import type { PlatformParser } from "./interface.ts";
import type {
  ImportedConversation,
  ImportedMessage,
  PlatformType,
} from "../types.ts";
import { buildTitle } from "./title-utils.ts";

// ─── Format types (the on-disk JSON shape) ───────────────────────────

interface LoomStandardMessage {
  id: string;
  role: string;
  content: string;
  createdAt: string;
  model?: string;
  reasoning?: string;
}

interface LoomStandardConversation {
  id: string;
  title?: string;
  createdAt: string;
  updatedAt: string;
  originPlatform?: string;
  messages: LoomStandardMessage[];
}

interface LoomStandardFile {
  format: string;
  version?: number;
  originPlatform?: string;
  conversations: LoomStandardConversation[];
}

const VALID_ROLES = new Set(["user", "assistant", "system", "tool"]);

/** Parse a timestamp that should be an ISO 8601 string. Returns null if invalid. */
function parseTimestamp(value: unknown): Date | null {
  if (typeof value !== "string" || !value) return null;
  const d = new Date(value);
  return isNaN(d.getTime()) ? null : d;
}

export class LoomStandardParser implements PlatformParser {
  readonly platform: PlatformType = "loom-standard";

  async detect(filePath: string): Promise<boolean> {
    try {
      const stat = await Deno.stat(filePath);
      if (!stat.isFile) return false;

      const lower = filePath.toLowerCase();
      if (!lower.endsWith(".json")) return false;

      const file = await Deno.open(filePath);
      const buf = new Uint8Array(4096);
      const n = await file.read(buf) ?? 0;
      file.close();

      const head = new TextDecoder().decode(buf.slice(0, n));
      // Match "format": "loom-standard" with any whitespace/quote variation.
      // A regex is more robust than JSON.parse(partial) here since we're
      // scanning a truncated buffer.
      return /"format"\s*:\s*"loom-standard"/i.test(head);
    } catch {
      return false;
    }
  }

  async parse(filePath: string): Promise<ImportedConversation[]> {
    const raw = await Deno.readTextFile(filePath);
    const parsed = JSON.parse(raw) as LoomStandardFile;

    if (parsed.format !== "loom-standard") {
      console.warn(
        `[LoomStandard] Expected format "loom-standard", got "${
          parsed.format || "missing"
        }" — proceeding anyway`,
      );
    }

    const defaultOrigin = parsed.originPlatform?.trim() || "Unknown";
    const conversations = Array.isArray(parsed.conversations)
      ? parsed.conversations
      : [];
    const results: ImportedConversation[] = [];

    for (let i = 0; i < conversations.length; i++) {
      const conv = conversations[i];
      try {
        const imported = this.parseConversation(conv, defaultOrigin);
        if (imported.messages.length > 0) {
          results.push(imported);
        }
      } catch (error) {
        console.warn(
          `[LoomStandard] Conversation ${i} (${conv?.id || "no id"}): ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    return results;
  }

  private parseConversation(
    conv: LoomStandardConversation,
    defaultOrigin: string,
  ): ImportedConversation {
    if (!conv.id) {
      throw new Error("Conversation is missing required field: id");
    }

    const createdAt = parseTimestamp(conv.createdAt);
    const updatedAt = parseTimestamp(conv.updatedAt);
    if (!createdAt) {
      throw new Error(
        `Conversation ${conv.id}: invalid or missing createdAt timestamp`,
      );
    }
    if (!updatedAt) {
      throw new Error(
        `Conversation ${conv.id}: invalid or missing updatedAt timestamp`,
      );
    }

    const origin = conv.originPlatform?.trim() || defaultOrigin;
    const messages: ImportedMessage[] = [];

    for (const msg of conv.messages) {
      // Skip messages with invalid roles — only user/assistant/system/tool
      // are recognized. The DB writer filters system/tool downstream, but
      // we include them here so content hashing matches the internal model.
      if (!msg.role || !VALID_ROLES.has(msg.role)) {
        continue;
      }

      // Skip messages with empty content — they're silently dropped by
      // the DB writer anyway, and including them would inflate counts.
      const content = (msg.content || "").trim();
      if (!content) continue;

      const msgDate = parseTimestamp(msg.createdAt);
      if (!msgDate) {
        // If a message has no valid timestamp, fall back to the conversation's
        // creation time rather than dropping the message entirely. A missing
        // timestamp shouldn't erase history — but it does mean the message
        // won't sort correctly relative to its siblings.
        console.warn(
          `[LoomStandard] Conversation ${conv.id}: message ${msg.id} has invalid createdAt — falling back to conversation createdAt`,
        );
      }

      messages.push({
        id: msg.id || `msg-${messages.length}`,
        role: msg.role as ImportedMessage["role"],
        content,
        createdAt: msgDate || createdAt,
        model: msg.model,
        reasoning: msg.reasoning,
      });
    }

    const firstDate = messages[0]?.createdAt;
    const lastDate = messages[messages.length - 1]?.createdAt;

    return {
      id: conv.id,
      title: buildTitle(origin, conv.title, firstDate, lastDate),
      createdAt,
      updatedAt,
      messages,
      platform: "loom-standard",
      originPlatform: origin,
      systemPrompts: [],
    };
  }
}
