/**
 * Boot-time Deno version guard — pin resolution and mismatch reporting.
 *
 * The guard is warn-only by design; these tests pin down the classification
 * logic (ok / mismatch / no-pin / unreadable) so the banner can never be
 * silently turned into a boot failure by refactor drift.
 */

import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { checkDenoVersion } from "../src/deno-version-guard.ts";

Deno.test("checkDenoVersion reports ok when running version matches the pin", async () => {
  const dir = await Deno.makeTempDir();
  const pinPath = join(dir, ".deno-version");
  await Deno.writeTextFile(pinPath, "2.7.14\n");
  const result = checkDenoVersion({ pinPath, actualVersion: "2.7.14" });
  assertEquals(result.status, "ok");
  assertEquals(result.expected, "2.7.14");
  assertEquals(result.actual, "2.7.14");
  await Deno.remove(dir, { recursive: true });
});

Deno.test("checkDenoVersion reports mismatch when the pin has moved", async () => {
  const dir = await Deno.makeTempDir();
  const pinPath = join(dir, ".deno-version");
  await Deno.writeTextFile(pinPath, "2.7.14\n");
  const result = checkDenoVersion({ pinPath, actualVersion: "2.8.0" });
  assertEquals(result.status, "mismatch");
  assertEquals(result.expected, "2.7.14");
  assertEquals(result.actual, "2.8.0");
  await Deno.remove(dir, { recursive: true });
});

Deno.test("checkDenoVersion tolerates a missing pin file", async () => {
  const dir = await Deno.makeTempDir();
  const result = checkDenoVersion({
    pinPath: join(dir, "does-not-exist"),
    actualVersion: "2.7.14",
  });
  assertEquals(result.status, "no-pin");
  await Deno.remove(dir, { recursive: true });
});

Deno.test("checkDenoVersion treats an empty pin as unreadable", async () => {
  const dir = await Deno.makeTempDir();
  const pinPath = join(dir, ".deno-version");
  await Deno.writeTextFile(pinPath, "   \n");
  const result = checkDenoVersion({ pinPath, actualVersion: "2.7.14" });
  assertEquals(result.status, "unreadable");
  await Deno.remove(dir, { recursive: true });
});
