/**
 * Identity local-sync tests — the diff-first contract of
 * syncIdentityToLocal (2026-10-24): the pull fires every 5 minutes and
 * almost always returns byte-identical content, so each file is written
 * only when the local copy is missing or DIFFERS. An unchanged cycle
 * costs reads, not writes — asserted here by mtime equality (no write,
 * no mtime movement). Drift correction is preserved: a hand-edited
 * local file differs from canonical and is rewritten on the next sync.
 *
 * syncIdentityToLocal is private; reached by cast, same pattern as
 * mcp_restart_mutex_test.
 */

import { assertEquals } from "@std/assert";
import { MCPClient } from "../src/mcp-client/mod.ts";

interface TestFile {
  filename: string;
  content: string;
}

function makeClient(localBasePath: string): MCPClient {
  const client = new MCPClient({
    command: "mock",
    instanceId: "identity-sync-test",
    localBasePath,
  });
  return client;
}

function seedCache(
  client: MCPClient,
  identity: Record<string, TestFile[]>,
): void {
  (client as unknown as { cache: unknown }).cache = {
    identity,
    lastSync: null,
  };
}

async function sync(client: MCPClient): Promise<void> {
  await (client as unknown as {
    syncIdentityToLocal: () => Promise<void>;
  }).syncIdentityToLocal();
}

async function mtimeMs(path: string): Promise<number> {
  const st = await Deno.stat(path);
  return st.mtime?.getTime() ?? 0;
}

Deno.test("identity sync: missing files are written", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const client = makeClient(dir);
    seedCache(client, {
      self: [{ filename: "core.md", content: "I am the entity." }],
      user: [{ filename: "partner.md", content: "My user." }],
    });
    await sync(client);
    const self = await Deno.readTextFile(`${dir}/identity/self/core.md`);
    const user = await Deno.readTextFile(`${dir}/identity/user/partner.md`);
    assertEquals(self, "I am the entity.");
    assertEquals(user, "My user.");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("identity sync: identical files are NOT rewritten (mtime proof)", async () => {
  const dir = await Deno.makeTempDir();
  try {
    // Canonical content already on disk, exactly as a prior sync left it.
    const client = makeClient(dir);
    seedCache(client, {
      self: [
        { filename: "a.md", content: "unchanged" },
        { filename: "b.md", content: "also unchanged" },
      ],
    });
    await sync(client); // creates the files
    const before = await Promise.all([
      mtimeMs(`${dir}/identity/self/a.md`),
      mtimeMs(`${dir}/identity/self/b.md`),
    ]);
    // Let the filesystem clock tick so a spurious write WOULD move the
    // mtime, then sync again over identical content.
    await new Promise((r) => setTimeout(r, 20));
    await sync(client);
    const after = await Promise.all([
      mtimeMs(`${dir}/identity/self/a.md`),
      mtimeMs(`${dir}/identity/self/b.md`),
    ]);
    assertEquals(after, before); // zero writes — the whole point
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("identity sync: drifted local files are corrected to canonical", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const client = makeClient(dir);
    seedCache(client, {
      self: [{ filename: "core.md", content: "canonical words" }],
    });
    await sync(client);
    // Hand edit on disk — the drift the old unconditional rewrite used
    // to silently repair; the diff-first sync must still repair it
    // (content differs → write).
    await Deno.writeTextFile(
      `${dir}/identity/self/core.md`,
      "hand-edited drift",
    );
    await sync(client);
    const repaired = await Deno.readTextFile(`${dir}/identity/self/core.md`);
    assertEquals(repaired, "canonical words");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
