/**
 * Tests for upload dedup in convert-stage.
 *
 * Two related bugs in one:
 *   1. Re-uploading a file with the same filename appended a second manifest
 *      entry instead of replacing the first, inflating the upload count.
 *   2. Two genuinely different files sharing a name (e.g. dual ChatGPT
 *      accounts both exporting `conversations.json`) silently clobbered
 *      each other on disk because the second upload overwrote the first
 *      file by path.
 *
 * The fix dedupes by (filename, contentHash). Same name + same hash is a
 * true reupload → replace the entry in place. Same name + different hash
 * is a different file → disambiguate the stored filename so both coexist.
 */

import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import type { UploadEntry } from "../types.ts";
import { convertRoutes } from "./convert-stage.ts";
import { setActivePackageDir } from "./setup-stage.ts";

async function withTempPackage<T>(
  fn: (dir: string) => Promise<T>,
): Promise<T> {
  const dir = await Deno.makeTempDir({
    prefix: "entity-loom-upload-test-",
  });
  await Deno.mkdir(join(dir, "raw"), { recursive: true });
  setActivePackageDir(dir);
  try {
    return await fn(dir);
  } finally {
    setActivePackageDir(null);
  }
}

async function uploadFile(
  filename: string,
  content: string,
  platform = "chatgpt",
): Promise<{ status: number; entry: UploadEntry }> {
  const routes = convertRoutes();
  const route = routes.find(
    (r) => r.method === "POST" && r.pattern === "/api/convert/upload",
  );
  if (!route) throw new Error("Upload route not found");

  const form = new FormData();
  form.append(
    "file",
    new Blob([content], { type: "application/json" }),
    filename,
  );
  form.append("platform", platform);

  const req = new Request("http://localhost/api/convert/upload", {
    method: "POST",
    body: form,
  });
  const res = await route.handler(req, { params: {} });
  const body = await res.json() as { success: boolean; entry: UploadEntry };
  return { status: res.status, entry: body.entry };
}

async function listManifest(): Promise<UploadEntry[]> {
  const routes = convertRoutes();
  const route = routes.find(
    (r) => r.method === "GET" && r.pattern === "/api/convert/uploads",
  );
  if (!route) throw new Error("List uploads route not found");
  const res = await route.handler(
    new Request("http://localhost/api/convert/uploads"),
    { params: {} },
  );
  const body = await res.json() as { entries: UploadEntry[] };
  return body.entries;
}

Deno.test({
  name:
    "re-uploading the same file (same name + same content) replaces the manifest entry",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    await withTempPackage(async (dir) => {
      const content = '{"conversations":[]}';

      const r1 = await uploadFile("conversations.json", content);
      assertEquals(r1.status, 200);

      const r2 = await uploadFile("conversations.json", content);
      assertEquals(r2.status, 200);

      const manifest = await listManifest();
      assertEquals(manifest.length, 1);
      assertEquals(manifest[0].filename, "conversations.json");
      assertEquals(manifest[0].contentHash !== undefined, true);

      // Only one conversations file on disk — no clobbering duplicate.
      // (uploads.json is the manifest itself and always present.)
      const files: string[] = [];
      for await (const e of Deno.readDir(join(dir, "raw"))) {
        if (e.isFile && e.name !== "uploads.json") files.push(e.name);
      }
      assertEquals(files.length, 1);
      assertEquals(files[0], "conversations.json");
    });
  },
});

Deno.test({
  name:
    "two different files sharing a name (dual-account case) both land on disk with disambiguated names",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    await withTempPackage(async (dir) => {
      const accountA = '{"account":"A","conversations":[]}';
      const accountB = '{"account":"B","conversations":[]}';

      const r1 = await uploadFile("conversations.json", accountA);
      assertEquals(r1.status, 200);
      assertEquals(r1.entry.filename, "conversations.json");

      const r2 = await uploadFile("conversations.json", accountB);
      assertEquals(r2.status, 200);
      // Second account's content was stored under a disambiguated name.
      assertEquals(r2.entry.filename, "conversations.1.json");

      const manifest = await listManifest();
      assertEquals(manifest.length, 2);
      assertEquals(manifest[0].filename, "conversations.json");
      assertEquals(manifest[1].filename, "conversations.1.json");
      assertEquals(manifest[0].contentHash !== manifest[1].contentHash, true);

      // Both files exist on disk — neither was clobbered.
      const accountABytes = await Deno.readTextFile(
        join(dir, "raw", "conversations.json"),
      );
      const accountBBytes = await Deno.readTextFile(
        join(dir, "raw", "conversations.1.json"),
      );
      assertEquals(accountABytes, accountA);
      assertEquals(accountBBytes, accountB);
    });
  },
});

Deno.test({
  name:
    "uploading different content with a different filename creates a new entry, no disambiguation",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    await withTempPackage(async () => {
      await uploadFile("first.json", '{"a":1}');
      await uploadFile("second.json", '{"a":2}');

      const manifest = await listManifest();
      assertEquals(manifest.length, 2);
      assertEquals(manifest[0].filename, "first.json");
      assertEquals(manifest[1].filename, "second.json");
    });
  },
});

Deno.test({
  name:
    "third same-name-different-content upload gets .2 suffix, not .1 (which is taken)",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    await withTempPackage(async () => {
      await uploadFile("conversations.json", '{"a":1}');
      await uploadFile("conversations.json", '{"a":2}');
      await uploadFile("conversations.json", '{"a":3}');

      const manifest = await listManifest();
      assertEquals(manifest.length, 3);
      assertEquals(manifest[0].filename, "conversations.json");
      assertEquals(manifest[1].filename, "conversations.1.json");
      assertEquals(manifest[2].filename, "conversations.2.json");
    });
  },
});
