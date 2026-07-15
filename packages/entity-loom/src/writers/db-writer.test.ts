/**
 * Tests for DBWriter — schema detection (#16) and replace-on-reimport with
 * timestamp preservation (#14).
 *
 * The two bugs cluster here:
 *   - #16: post-finalize, conversations.platform is gone. Writes that
 *     unconditionally reference the column crash. Fix: detect via
 *     PRAGMA table_info, branch the upsert.
 *   - #14: a reimport of an already-stored thread (same ID, new messages)
 *     must REPLACE the prior message list, not append or silently keep
 *     the stale snapshot. Message timestamps must round-trip exactly —
 *     daily-memory grouping depends on them.
 */

import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { Database } from "@db/sqlite";
import { DBWriter } from "./db-writer.ts";
import type { ImportedConversation } from "../types.ts";

async function withTempDb<T>(
  fn: (writer: DBWriter, dbPath: string) => Promise<T>,
): Promise<T> {
  const dir = await Deno.makeTempDir({
    prefix: "entity-loom-dbwriter-test-",
  });
  const dbPath = join(dir, "chats.db");
  const writer = new DBWriter(dbPath);
  writer.init();
  try {
    return await fn(writer, dbPath);
  } finally {
    writer.close();
  }
}

function makeConversation(
  id: string,
  messages: Array<{
    id: string;
    role: "user" | "assistant";
    content: string;
    createdAt: Date;
  }>,
): ImportedConversation {
  const earliest = messages.reduce(
    (min, m) => (m.createdAt < min ? m.createdAt : min),
    messages[0].createdAt,
  );
  const latest = messages.reduce(
    (max, m) => (m.createdAt > max ? m.createdAt : max),
    messages[0].createdAt,
  );
  return {
    id,
    title: `Conv ${id}`,
    platform: "chatgpt",
    createdAt: earliest,
    updatedAt: latest,
    systemPrompts: [],
    messages: messages.map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      createdAt: m.createdAt,
    })),
  };
}

/** Side-channel read of message timestamps to verify preservation. */
function readMessageTimestamps(
  dbPath: string,
  conversationId: string,
): string[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    const rows = db.prepare(
      "SELECT created_at FROM messages WHERE conversation_id = ? ORDER BY created_at",
    ).all(conversationId) as Array<{ created_at: string }>;
    return rows.map((r) => r.created_at);
  } finally {
    db.close();
  }
}

function readConversationCount(dbPath: string): number {
  const db = new Database(dbPath, { readonly: true });
  try {
    const row = db.prepare("SELECT COUNT(*) as n FROM conversations").get() as {
      n: number;
    };
    return row.n;
  } finally {
    db.close();
  }
}

// ─── #14: replace-on-reimport with timestamp preservation ─────────────

Deno.test({
  name:
    "reimporting a conversation with new messages replaces the old message list (not append, not skip)",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    await withTempDb(async (_writer, dbPath) => {
      const convId = "conv-reimport";
      const t1 = new Date("2026-01-01T10:00:00.000Z");
      const t2 = new Date("2026-01-01T11:00:00.000Z");
      const t3 = new Date("2026-01-01T12:00:00.000Z");
      const t4 = new Date("2026-01-01T13:00:00.000Z");
      const t5 = new Date("2026-01-01T14:00:00.000Z");

      // First import: 1 message at T1.
      const w1 = new DBWriter(dbPath);
      w1.init();
      const firstCount = w1.writeConversation(
        makeConversation(convId, [
          { id: "m1", role: "user", content: "first", createdAt: t1 },
        ]),
      );
      w1.close();
      assertEquals(firstCount, 1);

      // Reimport: 5 messages at T1..T5. T1 is the same original message;
      // T2..T5 are new ones accrued on the source platform since.
      const w2 = new DBWriter(dbPath);
      w2.init();
      const reCount = w2.writeConversation(
        makeConversation(convId, [
          { id: "m1", role: "user", content: "first", createdAt: t1 },
          { id: "m2", role: "assistant", content: "second", createdAt: t2 },
          { id: "m3", role: "user", content: "third", createdAt: t3 },
          { id: "m4", role: "assistant", content: "fourth", createdAt: t4 },
          { id: "m5", role: "user", content: "fifth", createdAt: t5 },
        ]),
      );
      w2.close();
      assertEquals(reCount, 5);

      // Exactly one conversation, exactly 5 messages, each with the exact
      // timestamp the import supplied. Not 6 (no duplicate of m1), not 1
      // (no silent skip from INSERT OR IGNORE).
      assertEquals(readConversationCount(dbPath), 1);
      assertEquals(readMessageTimestamps(dbPath, convId), [
        t1.toISOString(),
        t2.toISOString(),
        t3.toISOString(),
        t4.toISOString(),
        t5.toISOString(),
      ]);
    });
  },
});

Deno.test({
  name: "reimporting with the same message set also works (idempotent replace)",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    await withTempDb(async (_writer, dbPath) => {
      const convId = "conv-idem";
      const t1 = new Date("2026-02-01T09:00:00.000Z");
      const t2 = new Date("2026-02-01T09:30:00.000Z");

      const conv = makeConversation(convId, [
        { id: "x1", role: "user", content: "a", createdAt: t1 },
        { id: "x2", role: "assistant", content: "b", createdAt: t2 },
      ]);

      const w1 = new DBWriter(dbPath);
      w1.init();
      w1.writeConversation(conv);
      w1.close();

      const w2 = new DBWriter(dbPath);
      w2.init();
      w2.writeConversation(conv);
      w2.close();

      assertEquals(readConversationCount(dbPath), 1);
      assertEquals(readMessageTimestamps(dbPath, convId), [
        t1.toISOString(),
        t2.toISOString(),
      ]);
    });
  },
});

// ─── #16: schema detection for platform column ────────────────────────

Deno.test({
  name:
    "writeConversation succeeds on a post-finalize DB (platform column already stripped)",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    await withTempDb(async (writer, dbPath) => {
      // First write creates the row with platform column intact.
      writer.writeConversation(
        makeConversation("conv-finalize", [
          {
            id: "fm1",
            role: "user",
            content: "before finalize",
            createdAt: new Date("2026-03-01T08:00:00.000Z"),
          },
        ]),
      );
      // Finalize the package — strips the platform column.
      writer.stripPlatformColumn();

      // Reimporting into the finalized DB must not crash on the missing
      // column. This is the #16 bug.
      writer.writeConversation(
        makeConversation("conv-finalize", [
          {
            id: "fm1",
            role: "user",
            content: "before finalize",
            createdAt: new Date("2026-03-01T08:00:00.000Z"),
          },
          {
            id: "fm2",
            role: "assistant",
            content: "after",
            createdAt: new Date("2026-03-01T09:00:00.000Z"),
          },
        ]),
      );

      assertEquals(readConversationCount(dbPath), 1);
      assertEquals(readMessageTimestamps(dbPath, "conv-finalize").length, 2);
    });
  },
});

Deno.test({
  name:
    "stripPlatformColumn is a no-op when the column is already gone (double-finalize safety)",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    await withTempDb(async (writer, dbPath) => {
      writer.writeConversation(
        makeConversation("c", [
          {
            id: "m",
            role: "user",
            content: "x",
            createdAt: new Date("2026-04-01T00:00:00.000Z"),
          },
        ]),
      );
      writer.stripPlatformColumn();
      // Calling again on an already-stripped DB should not throw.
      writer.stripPlatformColumn();

      assertEquals(readConversationCount(dbPath), 1);
    });
  },
});

Deno.test({
  name: "getConversationPlatform returns null on a post-finalize DB (no crash)",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    await withTempDb(async (writer) => {
      writer.writeConversation(
        makeConversation("conv-plat", [
          {
            id: "pm",
            role: "user",
            content: "x",
            createdAt: new Date("2026-05-01T00:00:00.000Z"),
          },
        ]),
      );
      // Pre-finalize: platform is present.
      assertEquals(writer.getConversationPlatform("conv-plat"), "chatgpt");
      writer.stripPlatformColumn();
      // Post-finalize: column gone — return null instead of throwing.
      assertEquals(writer.getConversationPlatform("conv-plat"), null);
    });
  },
});
