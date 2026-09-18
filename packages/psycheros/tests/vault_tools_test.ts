/**
 * Integration tests for the vault tool duplicate-title guards.
 *
 * Regression context (2026-09 AU-document restore): an entity repeatedly
 * re-wrote one document under shifting titles; `write` happily created
 * forks and `append`/`rewrite` missed the target because lookups were
 * exact-match. These tests pin the new behavior: `write` refuses
 * near-duplicate titles; `append`/`rewrite` resolve them onto the
 * existing document.
 *
 * Uses a real VaultManager over a temp schema-initialized DB. Content
 * writes go through indexContent -> embedder, so the first run downloads
 * the MiniLM model into the temp data root - subsequent runs are offline.
 */

import { assert, assertStringIncludes } from "@std/assert";
import { Database } from "@db/sqlite";
import { initializeSchema } from "../src/db/schema.ts";
import { DBClient } from "../src/db/client.ts";
import { VaultManager } from "../src/vault/manager.ts";
import { vaultTool } from "../src/tools/vault-tools.ts";
import type { ToolContext } from "../src/tools/types.ts";

function makeFixture(): {
  manager: VaultManager;
  ctx: ToolContext;
  cleanup: () => void;
} {
  const dbPath = Deno.makeTempFileSync({
    prefix: "psycheros-vault-tools-test-",
    suffix: ".db",
  });
  const raw = new Database(dbPath);
  initializeSchema(raw);
  raw.close();
  const client = new DBClient(dbPath);
  const dataRoot = Deno.makeTempDirSync({
    prefix: "psycheros-vault-tools-data-",
  });
  const manager = new VaultManager(client, dataRoot, dataRoot);
  const ctx = {
    toolCallId: "test-call",
    conversationId: "conv-1",
    config: { vaultManager: manager },
  } as unknown as ToolContext;
  const cleanup = () => {
    client.close();
    try {
      Deno.removeSync(dbPath);
    } catch { /* gone */ }
    try {
      Deno.removeSync(dataRoot, { recursive: true });
    } catch { /* gone */ }
  };
  return { manager, ctx, cleanup };
}

function run(ctx: ToolContext, args: Record<string, unknown>) {
  return vaultTool.execute!(args, ctx);
}

Deno.test("write refuses a near-duplicate title", async () => {
  const { manager, ctx, cleanup } = makeFixture();
  try {
    const first = await run(ctx, {
      operation: "write",
      title: "Dystopian AU - Marlowe Pickpocket Scenario (started 4/3/2026)",
      content: "# Original\n\nSome content here.",
    });
    assert(!first.isError, "first write should succeed: " + first.content);

    const second = await run(ctx, {
      operation: "write",
      title: "Dystopian AU - Marlowe Pickpocket Scenario (updated 4/5)",
      content: "# Fork attempt",
    });
    assert(second.isError, "near-duplicate write must be refused");
    assertStringIncludes(second.content, "already covers this title");

    const docs = manager.listDocuments({ scope: "all" });
    assert(docs.length === 1, `expected 1 doc, got ${docs.length}`);
  } finally {
    cleanup();
  }
});

Deno.test("append resolves a near-duplicate title onto the existing doc", async () => {
  const { manager, ctx, cleanup } = makeFixture();
  try {
    await run(ctx, {
      operation: "write",
      title: "Scenario Continuity (started 4/3)",
      content: "# Start",
    });
    const res = await run(ctx, {
      operation: "append",
      title: "Scenario Continuity (updated 4/8)",
      content: "More plot beats.",
    });
    assert(!res.isError, "append should succeed: " + res.content);
    assertStringIncludes(res.content, "Scenario Continuity (started 4/3)");
    const docs = manager.listDocuments({ scope: "all" });
    assert(docs.length === 1, `expected 1 doc, got ${docs.length}`);
  } finally {
    cleanup();
  }
});

Deno.test("rewrite under a near-duplicate title replaces the existing doc", async () => {
  const { manager, ctx, cleanup } = makeFixture();
  try {
    await run(ctx, {
      operation: "write",
      title: "Scene Notes - Session One",
      content: "# Draft one",
    });
    const res = await run(ctx, {
      operation: "rewrite",
      title: "Scene Notes - Session One (final)",
      content: "# Final",
    });
    assert(!res.isError, "rewrite should succeed: " + res.content);
    const docs = manager.listDocuments({ scope: "all" });
    assert(docs.length === 1, `expected 1 doc, got ${docs.length}`);
    assertStringIncludes(docs[0].title, "Scene Notes - Session One (final)");
  } finally {
    cleanup();
  }
});

Deno.test("updateDocument keeps file_size in sync with the rewritten file", async () => {
  const { manager, ctx, cleanup } = makeFixture();
  try {
    await run(ctx, {
      operation: "write",
      title: "Size Tracking Doc",
      content: "x".repeat(500),
    });
    const doc = manager.listDocuments({ scope: "all" })[0];
    const createdSize = doc.fileSize;
    const res = await run(ctx, {
      operation: "rewrite",
      title: "Size Tracking Doc",
      content: "y".repeat(300),
    });
    assert(!res.isError, "rewrite should succeed: " + res.content);
    const after = manager.getDocument(doc.id)!;
    const onDisk = (await Deno.readTextFile(after.filePath)).length;
    assert(
      after.fileSize === onDisk,
      `fileSize ${after.fileSize} != on-disk ${onDisk} bytes`,
    );
    assert(createdSize !== after.fileSize);
  } finally {
    cleanup();
  }
});
