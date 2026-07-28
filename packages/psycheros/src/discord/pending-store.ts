import type { Database } from "@db/sqlite";
import type { ChannelMode } from "../llm/discord-settings.ts";
import type { AccumulatedMessage } from "./router.ts";

export interface PendingDiscordMessage {
  channelId: string;
  serverId: string | null;
  isDM: boolean;
  mode: ChannelMode;
  directlyAddressed: boolean;
  message: AccumulatedMessage;
}

interface PendingDiscordMessageRow {
  message_id: string;
  channel_id: string;
  server_id: string | null;
  is_dm: number;
  channel_mode: string;
  directly_addressed: number;
  message_json: string;
}

const MAX_RECOVERY_BATCH = 500;
const BASE_RETRY_DELAY_MS = 30_000;
const MAX_RETRY_DELAY_MS = 15 * 60_000;

/** A durable local inbox beneath Discord's in-memory debounce buffers. */
export class DiscordPendingStore {
  constructor(private readonly db: Database) {
    this.reclaimProcessingOnStart();
  }

  enqueue(record: PendingDiscordMessage): void {
    const now = new Date().toISOString();
    this.db.exec(
      `INSERT INTO discord_pending_messages (
         message_id, channel_id, server_id, is_dm, channel_mode,
         directly_addressed, message_json, state, attempt_count,
         next_attempt_at, received_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)
       ON CONFLICT(message_id) DO UPDATE SET
         channel_id = excluded.channel_id,
         server_id = excluded.server_id,
         is_dm = excluded.is_dm,
         channel_mode = excluded.channel_mode,
         directly_addressed = excluded.directly_addressed,
         message_json = excluded.message_json,
         updated_at = excluded.updated_at`,
      [
        record.message.messageId,
        record.channelId,
        record.serverId,
        record.isDM ? 1 : 0,
        record.mode,
        record.directlyAddressed ? 1 : 0,
        JSON.stringify(record.message),
        now,
        record.message.timestamp || now,
        now,
      ],
    );
  }

  claim(messageIds: string[]): void {
    const ids = uniqueIds(messageIds);
    if (ids.length === 0) return;
    const now = new Date().toISOString();
    this.db.exec(
      `UPDATE discord_pending_messages
       SET state = 'processing', attempt_count = attempt_count + 1,
           updated_at = ?
       WHERE message_id IN (${placeholders(ids.length)})`,
      [now, ...ids],
    );
  }

  settle(messageIds: string[]): void {
    const ids = uniqueIds(messageIds);
    if (ids.length === 0) return;
    this.db.exec(
      `DELETE FROM discord_pending_messages
       WHERE message_id IN (${placeholders(ids.length)})`,
      ids,
    );
  }

  release(messageIds: string[]): number {
    const ids = uniqueIds(messageIds);
    if (ids.length === 0) return BASE_RETRY_DELAY_MS;
    const statement = this.db.prepare(
      `SELECT COALESCE(MAX(attempt_count), 1) AS attempts
       FROM discord_pending_messages
       WHERE message_id IN (${placeholders(ids.length)})`,
    );
    const row = statement.get<{ attempts: number }>(...ids);
    statement.finalize();
    const attempts = Math.max(1, Number(row?.attempts ?? 1));
    const delayMs = Math.min(
      BASE_RETRY_DELAY_MS * (2 ** Math.min(attempts - 1, 5)),
      MAX_RETRY_DELAY_MS,
    );
    const now = new Date();
    const nextAttemptAt = new Date(now.getTime() + delayMs).toISOString();
    this.db.exec(
      `UPDATE discord_pending_messages
       SET state = 'pending', next_attempt_at = ?, updated_at = ?
       WHERE message_id IN (${placeholders(ids.length)})`,
      [nextAttemptAt, now.toISOString(), ...ids],
    );
    return delayMs;
  }

  recoverReady(now = new Date()): PendingDiscordMessage[] {
    const statement = this.db.prepare(
      `SELECT message_id, channel_id, server_id, is_dm, channel_mode,
              directly_addressed, message_json
       FROM discord_pending_messages
       WHERE state = 'pending' AND next_attempt_at <= ?
       ORDER BY received_at ASC, message_id ASC
       LIMIT ?`,
    );
    const rows = statement.all<PendingDiscordMessageRow>(
      now.toISOString(),
      MAX_RECOVERY_BATCH,
    );
    statement.finalize();

    const recovered: PendingDiscordMessage[] = [];
    for (const row of rows) {
      try {
        recovered.push({
          channelId: row.channel_id,
          serverId: row.server_id,
          isDM: row.is_dm === 1,
          mode: parseChannelMode(row.channel_mode),
          directlyAddressed: row.directly_addressed === 1,
          message: parseAccumulatedMessage(row.message_json),
        });
      } catch (error) {
        console.warn(
          `[Discord] Could not recover pending message ${row.message_id}:`,
          error instanceof Error ? error.message : String(error),
        );
      }
    }
    return recovered;
  }

  count(): number {
    const statement = this.db.prepare(
      "SELECT COUNT(*) AS count FROM discord_pending_messages",
    );
    const row = statement.get<{ count: number }>();
    statement.finalize();
    return Number(row?.count ?? 0);
  }

  private reclaimProcessingOnStart(): void {
    const now = new Date().toISOString();
    this.db.exec(
      `UPDATE discord_pending_messages
       SET state = 'pending', next_attempt_at = ?, updated_at = ?
       WHERE state = 'processing'`,
      [now, now],
    );
  }
}

function uniqueIds(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

function placeholders(count: number): string {
  return new Array(count).fill("?").join(", ");
}

function parseChannelMode(value: string): ChannelMode {
  if (value === "active" || value === "lurk" || value === "strict") {
    return value;
  }
  throw new Error(`invalid channel mode ${value}`);
}

function parseAccumulatedMessage(value: string): AccumulatedMessage {
  const parsed = JSON.parse(value) as Partial<AccumulatedMessage>;
  if (
    typeof parsed.messageId !== "string" ||
    typeof parsed.authorId !== "string" ||
    typeof parsed.authorUsername !== "string" ||
    typeof parsed.content !== "string" ||
    typeof parsed.timestamp !== "string"
  ) {
    throw new Error("pending message payload is malformed");
  }
  return {
    authorId: parsed.authorId,
    authorUsername: parsed.authorUsername,
    authorBot: parsed.authorBot === true,
    content: parsed.content,
    timestamp: parsed.timestamp,
    messageId: parsed.messageId,
    mentionsBot: parsed.mentionsBot === true,
    replyToBot: parsed.replyToBot === true,
    referenceMessageId: typeof parsed.referenceMessageId === "string"
      ? parsed.referenceMessageId
      : null,
  };
}
