/**
 * Tests for staged_messages ID scoping in StagingWriter.
 *
 * Source platforms (especially ChatGPT) can reuse the same message_id across
 * different conversations in the same export. If we used the raw ID as
 * staged_messages.id (the global PK), the second conversation would crash
 * with `UNIQUE constraint failed: staged_messages.id` and silently stall
 * the import. The fix scopes IDs as `${conversationId}:${rawId}`.
 */

import { assertEquals } from "@std/assert";
import { Database } from "@db/sqlite";
import { join } from "@std/path";
import { StagingWriter } from "./staging-writer.ts";
import type { ImportedConversation } from "../types.ts";

async function withTempDb<T>(
  fn: (writer: StagingWriter, dbPath: string) => Promise<T>,
): Promise<T> {
  const dir = await Deno.makeTempDir({
    prefix: "entity-loom-staging-test-",
  });
  const dbPath = join(dir, "staging.db");
  const writer = new StagingWriter(dbPath);
  writer.init();
  try {
    return await fn(writer, dbPath);
  } finally {
    writer.close();
  }
}

function makeConversation(
  id: string,
  messages: Array<{ id: string; role: "user" | "assistant"; content: string }>,
): ImportedConversation {
  return {
    id,
    title: `Conv ${id}`,
    platform: "chatgpt",
    createdAt: new Date(2026, 0, 1),
    updatedAt: new Date(2026, 0, 1),
    systemPrompts: [],
    messages: messages.map((m, i) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      createdAt: new Date(2026, 0, 1, 0, 0, i),
    })),
  };
}

/** Open a side-channel read-only connection to inspect the staged IDs. */
function listMessageIds(dbPath: string, conversationId: string): string[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    const rows = db.prepare(
      "SELECT id FROM staged_messages WHERE conversation_id = ? ORDER BY sort_order",
    ).all(conversationId) as Array<{ id: string }>;
    return rows.map((r) => r.id);
  } finally {
    db.close();
  }
}

Deno.test({
  name:
    "two conversations sharing the same source message_id do not collide on staged_messages.id",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    await withTempDb(async (writer, dbPath) => {
      // Both conversations have a message with id "shared-msg-1". This is
      // exactly the ChatGPT cross-conversation ID reuse pattern.
      const convA = makeConversation("conv-a", [
        { id: "shared-msg-1", role: "user", content: "hello from A" },
        { id: "msg-a-2", role: "assistant", content: "hi from A" },
      ]);
      const convB = makeConversation("conv-b", [
        { id: "shared-msg-1", role: "user", content: "hello from B" },
        { id: "msg-b-2", role: "assistant", content: "hi from B" },
      ]);

      // Before the fix, the second call would throw
      // "UNIQUE constraint failed: staged_messages.id".
      const aCount = await writer.writeConversation(convA);
      const bCount = await writer.writeConversation(convB);
      assertEquals(aCount, 2);
      assertEquals(bCount, 2);

      // Scoped IDs are what actually land in the table.
      const ids = listMessageIds(dbPath, "conv-a").concat(
        listMessageIds(dbPath, "conv-b"),
      ).sort();
      assertEquals(ids, [
        "conv-a:msg-a-2",
        "conv-a:shared-msg-1",
        "conv-b:msg-b-2",
        "conv-b:shared-msg-1",
      ]);
    });
  },
});

Deno.test({
  name:
    "missing source message_id falls back to message-{index}, scoped to conversation",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    await withTempDb(async (writer, dbPath) => {
      const conv = makeConversation("conv-c", [
        { id: "", role: "user", content: "no id 1" },
        { id: "", role: "assistant", content: "no id 2" },
      ]);
      await writer.writeConversation(conv);

      const ids = listMessageIds(dbPath, "conv-c").sort();
      assertEquals(ids, ["conv-c:message-0", "conv-c:message-1"]);
    });
  },
});

Deno.test({
  name:
    "re-populating the same conversation produces the same scoped IDs (idempotent)",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    await withTempDb(async (writer, dbPath) => {
      const conv = makeConversation("conv-d", [
        { id: "stable-id", role: "user", content: "stable" },
      ]);
      await writer.writeConversation(conv);
      await writer.writeConversation(conv); // idempotent re-populate

      // Only one message, same scoped ID — not a duplicate row, not a
      // different ID.
      const ids = listMessageIds(dbPath, "conv-d");
      assertEquals(ids, ["conv-d:stable-id"]);
    });
  },
});
