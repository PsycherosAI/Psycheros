/**
 * Regression tests for memory review edit/save flow.
 *
 * Covers the silent-revert bug where Save reloaded the file from disk instead
 * of persisting the textarea content, plus the empty-string rejection that
 * blocked users from clearing a memory to start over.
 *
 * Tests invoke the route handlers directly with a fake Request, with the
 * active package directory pointing at a temp dir. Stage-lock and SSE wiring
 * are not exercised here — only the GET/PUT/DELETE handlers.
 */

import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { dailyRoutes } from "./daily-stage.ts";
import { significantRoutes } from "./significant-stage.ts";
import { setActivePackageDir } from "./setup-stage.ts";

async function withTempPackage<T>(
  fn: (dir: string) => Promise<T>,
): Promise<T> {
  const dir = await Deno.makeTempDir({
    prefix: "entity-loom-memory-edit-test-",
  });
  await Deno.mkdir(join(dir, "memories", "daily"), { recursive: true });
  await Deno.mkdir(join(dir, "memories", "significant"), { recursive: true });
  setActivePackageDir(dir);
  try {
    return await fn(dir);
  } finally {
    setActivePackageDir(null);
  }
}

function findRoute(
  routes: ReturnType<typeof dailyRoutes>,
  method: string,
  path: string,
) {
  const route = routes.find(
    (r) =>
      r.method === method &&
      (typeof r.pattern === "string"
        ? r.pattern === path
        : r.pattern.test(path)),
  );
  if (!route) throw new Error(`Route not found: ${method} ${path}`);
  return route;
}

async function callRoute(
  routes: ReturnType<typeof dailyRoutes>,
  method: string,
  path: string,
  body: unknown | undefined,
) {
  const route = findRoute(routes, method, path);
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(body);
  }
  const req = new Request(`http://localhost${path}`, init);
  const match = path.match(
    typeof route.pattern === "string"
      ? new RegExp(`^${route.pattern}$`)
      : route.pattern,
  );
  const params: Record<string, string> = {};
  if (match) {
    for (let i = 1; i < match.length; i++) {
      params[`param${i}`] = match[i] ?? "";
    }
  }
  const res = await route.handler(req, { params });
  return { status: res.status, body: await res.json() };
}

Deno.test({
  name: "daily PUT persists edited content and GET round-trips the saved value",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    await withTempPackage(async (dir) => {
      const filename = "2026-06-12_entity-loom.md";
      const filePath = join(dir, "memories", "daily", filename);
      await Deno.writeTextFile(filePath, "original content");

      const routes = dailyRoutes();
      const path = `/api/memories/daily/${encodeURIComponent(filename)}`;

      // Read original
      const before = await callRoute(routes, "GET", path, undefined);
      assertEquals(before.status, 200);
      assertEquals(before.body.content, "original content");

      // Save edited content
      const put = await callRoute(routes, "PUT", path, {
        content: "edited from the entity's perspective",
      });
      assertEquals(put.status, 200, `expected 200, got ${put.status}`);
      assertEquals(put.body.success, true);

      // Disk should reflect the edit
      const onDisk = await Deno.readTextFile(filePath);
      assertEquals(onDisk, "edited from the entity's perspective");

      // Subsequent GET should return the saved value
      const after = await callRoute(routes, "GET", path, undefined);
      assertEquals(after.status, 200);
      assertEquals(after.body.content, "edited from the entity's perspective");
    });
  },
});

Deno.test({
  name:
    "daily PUT accepts empty string content (user clearing a memory to start over)",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    await withTempPackage(async (dir) => {
      const filename = "2026-06-13_entity-loom.md";
      const filePath = join(dir, "memories", "daily", filename);
      await Deno.writeTextFile(filePath, "wrong perspective");

      const routes = dailyRoutes();
      const path = `/api/memories/daily/${encodeURIComponent(filename)}`;

      const put = await callRoute(routes, "PUT", path, { content: "" });
      assertEquals(
        put.status,
        200,
        `empty string should be accepted, got ${put.status}: ${
          put.body?.error ?? ""
        }`,
      );

      const onDisk = await Deno.readTextFile(filePath);
      assertEquals(onDisk, "");
    });
  },
});

Deno.test({
  name: "daily PUT rejects missing content field",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    await withTempPackage(async () => {
      const routes = dailyRoutes();
      const path = `/api/memories/daily/${
        encodeURIComponent("2026-06-14_entity-loom.md")
      }`;

      const put = await callRoute(routes, "PUT", path, {});
      assertEquals(put.status, 400);
      assertEquals(typeof put.body.error, "string");
    });
  },
});

Deno.test({
  name: "significant PUT persists edited content and round-trips",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    await withTempPackage(async (dir) => {
      const filename = "2026-06-12_first-meeting.md";
      const filePath = join(dir, "memories", "significant", filename);
      await Deno.writeTextFile(filePath, "original");

      const routes = significantRoutes();
      const path = `/api/memories/significant/${encodeURIComponent(filename)}`;

      const put = await callRoute(routes, "PUT", path, {
        content: "we first met on a clear afternoon",
      });
      assertEquals(put.status, 200);
      assertEquals(put.body.success, true);

      const onDisk = await Deno.readTextFile(filePath);
      assertEquals(onDisk, "we first met on a clear afternoon");

      const after = await callRoute(routes, "GET", path, undefined);
      assertEquals(after.body.content, "we first met on a clear afternoon");
    });
  },
});

Deno.test({
  name: "significant PUT accepts empty string content",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    await withTempPackage(async (dir) => {
      const filename = "2026-06-13_blank-test.md";
      const filePath = join(dir, "memories", "significant", filename);
      await Deno.writeTextFile(filePath, "to be cleared");

      const routes = significantRoutes();
      const path = `/api/memories/significant/${encodeURIComponent(filename)}`;

      const put = await callRoute(routes, "PUT", path, { content: "" });
      assertEquals(put.status, 200);

      const onDisk = await Deno.readTextFile(filePath);
      assertEquals(onDisk, "");
    });
  },
});
