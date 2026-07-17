import { assertEquals, assertExists } from "@std/assert";
import {
  type ResolvablePlugin,
  resolveDependencies,
} from "../src/plugins/dependency-resolver.ts";

const plug = (
  id: string,
  version: string,
  dependencies?: Record<string, string>,
): ResolvablePlugin => ({ id, version, dependencies });

Deno.test("resolver returns alphabetical order when no plugin declares deps", () => {
  const result = resolveDependencies([
    plug("zeta", "1.0.0"),
    plug("alpha", "1.0.0"),
    plug("mid", "1.0.0"),
  ]);
  assertEquals(result.failures, {});
  assertEquals(result.order, ["alpha", "mid", "zeta"]);
});

Deno.test("resolver loads deps before dependents", () => {
  // a depends on b; b depends on c.
  const result = resolveDependencies([
    plug("a", "1.0.0", { b: "^1.0.0" }),
    plug("b", "1.0.0", { c: "^1.0.0" }),
    plug("c", "1.0.0"),
  ]);
  assertEquals(result.failures, {});
  assertEquals(result.order, ["c", "b", "a"]);
});

Deno.test("resolver reports a missing dep with the missing id in the reason", () => {
  const result = resolveDependencies([
    plug("a", "1.0.0", { ghost: "^1.0.0" }),
    plug("b", "1.0.0"),
  ]);
  // a fails; b loads.
  assertEquals(result.order, ["b"]);
  assertExists(result.failures.a);
  assertEquals(result.failures.a.includes("ghost"), true);
  assertEquals(result.failures.a.includes("missing"), true);
});

Deno.test("resolver reports a version-range mismatch with both versions in the reason", () => {
  const result = resolveDependencies([
    plug("a", "1.0.0", { b: "^2.0.0" }),
    plug("b", "1.5.0"),
  ]);
  // a can't load (needs b ^2.0.0, b is 1.5.0); b loads.
  assertEquals(result.order, ["b"]);
  assertExists(result.failures.a);
  assertEquals(result.failures.a.includes("^2.0.0"), true);
  assertEquals(result.failures.a.includes("1.5.0"), true);
});

Deno.test("resolver accepts exact-match, caret, tilde, and star ranges", () => {
  const result = resolveDependencies([
    plug("exact", "1.0.0", { core: "1.2.3" }),
    plug("caret", "1.0.0", { core: "^1.0.0" }),
    plug("tilde", "1.0.0", { core: "~1.2.0" }),
    plug("star", "1.0.0", { core: "*" }),
    plug("core", "1.2.3"),
  ]);
  assertEquals(result.failures, {});
  // core must come first; the rest sort alphabetically among themselves.
  assertEquals(result.order[0], "core");
  assertEquals(result.order.slice(1).sort(), [
    "caret",
    "exact",
    "star",
    "tilde",
  ]);
});

Deno.test("resolver rejects an invalid range string with a parse error", () => {
  const result = resolveDependencies([
    plug("a", "1.0.0", { b: "not a range!!" }),
    plug("b", "1.0.0"),
  ]);
  assertEquals(result.order, ["b"]);
  assertExists(result.failures.a);
  assertEquals(result.failures.a.includes("invalid version range"), true);
});

Deno.test("resolver flags every plugin in a cycle, and order omits them", () => {
  // a → b → a (direct cycle), plus c with no deps to confirm healthy plugins still load.
  const result = resolveDependencies([
    plug("a", "1.0.0", { b: "^1.0.0" }),
    plug("b", "1.0.0", { a: "^1.0.0" }),
    plug("c", "1.0.0"),
  ]);
  assertEquals(result.order, ["c"]);
  assertExists(result.failures.a);
  assertExists(result.failures.b);
  assertEquals(result.failures.a.includes("cycle"), true);
  assertEquals(result.failures.b.includes("cycle"), true);
});

Deno.test("resolver handles a three-cycle plus a healthy dependent", () => {
  // a → b → c → a (cycle of 3). d depends on a, so d also can't load.
  const result = resolveDependencies([
    plug("a", "1.0.0", { b: "^1.0.0" }),
    plug("b", "1.0.0", { c: "^1.0.0" }),
    plug("c", "1.0.0", { a: "^1.0.0" }),
    plug("d", "1.0.0", { a: "^1.0.0" }),
    plug("e", "1.0.0"),
  ]);
  // Only e survives.
  assertEquals(result.order, ["e"]);
  for (const id of ["a", "b", "c", "d"]) {
    assertExists(result.failures[id]);
  }
});

Deno.test("resolver's order is stable across call order — sorts by id on ties", () => {
  // Same set of independent plugins, given in different orders — same output.
  const setA = [plug("z", "1.0.0"), plug("y", "1.0.0"), plug("x", "1.0.0")];
  const setB = [plug("x", "1.0.0"), plug("z", "1.0.0"), plug("y", "1.0.0")];
  assertEquals(
    resolveDependencies(setA).order,
    resolveDependencies(setB).order,
  );
});

Deno.test("resolver reports only the first per-plugin failure, not a pile-on", () => {
  // a depends on two missing plugins — only the first encountered should
  // appear in the reason (object iteration order is insertion order for
  // string keys, so "first" is deterministic for any given manifest).
  const result = resolveDependencies([
    plug("a", "1.0.0", { firstMissing: "^1.0.0", secondMissing: "^1.0.0" }),
  ]);
  assertExists(result.failures.a);
  assertEquals(result.failures.a.includes("firstMissing"), true);
  assertEquals(result.failures.a.includes("secondMissing"), false);
});
