/**
 * Entity Loom — ChatGPT Parser (dispatcher)
 *
 * Auto-detects ChatGPT exports and delegates to the appropriate sub-parser:
 * - `ChatGPTOfficialParser` for native OpenAI exports (array + legacy object)
 * - `ChatGPTPluginParser` for 3rd-party plugin exports (GerTex, etc.)
 *
 * Detection is format-agnostic — any ChatGPT-like structure passes. The
 * dispatch decision happens at parse time once the full JSON is available.
 */

import type { PlatformParser } from "./interface.ts";
import type { PlatformType } from "../types.ts";
import { ChatGPTOfficialParser } from "./chatgpt-official.ts";
import { ChatGPTPluginParser } from "./chatgpt-plugin.ts";

export class ChatGPTParser implements PlatformParser {
  readonly platform: PlatformType = "chatgpt";
  #official = new ChatGPTOfficialParser();
  #plugin = new ChatGPTPluginParser();

  async detect(filePath: string): Promise<boolean> {
    try {
      const stat = await Deno.stat(filePath);
      if (!stat.isFile) return false;
      if (!filePath.endsWith(".json")) return false;

      // Read first 2KB
      let file = await Deno.open(filePath);
      const buf = new Uint8Array(2048);
      const n = await file.read(buf) ?? 0;
      file.close();
      const head = new TextDecoder().decode(buf.slice(0, n));

      // Array format: [ { "id": "...", "title": ..., "create_time": ..., "mapping": ... } ]
      if (
        head.startsWith("[") && head.includes('"create_time"') &&
        head.includes('"mapping"')
      ) return true;

      // Object format: { "uuid": { "mapping": ..., "current_node": ... } }
      if (head.includes('"mapping"') && head.includes('"current_node"')) {
        return true;
      }

      // Single-conversation format (plugin exporter): mapping may be deep in the
      // file (large metadata blocks in some GerTex exports push it well past 2KB).
      // Read the tail and look for current_node + a ChatGPT marker in the head.
      if (head.startsWith("{")) {
        const tailSize = Math.min(4096, stat.size);
        const tailBuf = new Uint8Array(tailSize);
        file = await Deno.open(filePath);
        await file.seek(-tailSize, Deno.SeekMode.End);
        const tn = await file.read(tailBuf) ?? 0;
        file.close();
        const tail = new TextDecoder().decode(tailBuf.slice(0, tn));

        if (tail.includes('"current_node"')) {
          if (
            head.includes('"mapping"') ||
            head.includes('"conversation_id"') ||
            head.includes('"create_time"')
          ) {
            return true;
          }
        }
      }
      return false;
    } catch {
      return false;
    }
  }

  async parse(
    filePath: string,
  ): Promise<import("../types.ts").ImportedConversation[]> {
    const raw = await Deno.readTextFile(filePath);
    const parsed = JSON.parse(raw);

    // Determine format and delegate to the appropriate sub-parser.
    //
    // Three cases:
    //   1. Array → official (array format, newer)
    //   2. Top-level mapping + current_node → plugin (single-conversation)
    //   3. UUID-keyed object → official (legacy object format)
    if (Array.isArray(parsed)) {
      return this.#official.parse(parsed, filePath);
    }

    if (
      typeof parsed === "object" && parsed !== null &&
      "mapping" in parsed && "current_node" in parsed &&
      typeof (parsed as Record<string, unknown>).mapping === "object" &&
      !Array.isArray((parsed as Record<string, unknown>).mapping)
    ) {
      return this.#plugin.parse(parsed, filePath);
    }

    return this.#official.parse(parsed, filePath);
  }
}
