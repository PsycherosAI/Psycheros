import { assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { PluginManager } from "../../src/plugins/mod.ts";

/**
 * buildPromptContent now returns per-hook detail alongside the joined string,
 * so the Context Inspector can show what each prompt hook contributed. These
 * tests pin the shape and the outcome categories (fired / empty / truncated /
 * budget-skipped / degraded) that the UI tags rely on.
 */

async function writePlugin(
  root: string,
  id: string,
  manifest: Record<string, unknown>,
  entrypointSource: string,
): Promise<void> {
  const directory = join(root, id);
  await Deno.mkdir(directory, { recursive: true });
  await Deno.writeTextFile(
    join(directory, "plugin.json"),
    JSON.stringify({ id, apiVersion: 1, ...manifest }),
  );
  await Deno.writeTextFile(join(directory, "psycheros.ts"), entrypointSource);
}

const FAKE_LLM = () => ({}) as never;

const BASE_CONTEXT = {
  conversationId: "conv-test",
  sourceType: "web" as const,
  userMessage: "hello",
  sections: {},
};

Deno.test("buildPromptContent returns hook details for a fired hook", async () => {
  const root = await Deno.makeTempDir({ prefix: "psycheros-test-" });
  await writePlugin(
    root,
    "alpha",
    {
      name: "Alpha",
      version: "1.0.0",
      enabled: true,
      entrypoints: { psycheros: "./psycheros.ts" },
    },
    `export default {
      promptHooks: [{
        name: "alpha-hook",
        priority: 20,
        run: () => "I noticed something worth surfacing.",
      }],
    };`,
  );

  const manager = new PluginManager(root, FAKE_LLM);
  await manager.load();
  try {
    const { content, hooks } = await manager.buildPromptContent(BASE_CONTEXT);
    assertStringIncludes(content ?? "", "I noticed something worth surfacing.");
    assertEquals(hooks.length, 1);
    assertEquals(hooks[0].pluginId, "alpha");
    assertEquals(hooks[0].hookName, "alpha-hook");
    assertEquals(hooks[0].priority, 20);
    assertEquals(hooks[0].degraded, false);
    assertEquals(hooks[0].budgetSkipped, false);
    assertEquals(hooks[0].truncated, false);
    assertEquals(hooks[0].charsUsed > 0, true);
    assertEquals(hooks[0].elapsedMs! >= 0, true);
    assertStringIncludes(hooks[0].output ?? "", "I noticed something");
  } finally {
    await manager.stop();
  }
});

Deno.test("buildPromptContent marks empty-output hooks as silent skips", async () => {
  const root = await Deno.makeTempDir({ prefix: "psycheros-test-" });
  await writePlugin(
    root,
    "empty",
    {
      name: "Empty",
      version: "1.0.0",
      enabled: true,
      entrypoints: { psycheros: "./psycheros.ts" },
    },
    `export default {
      promptHooks: [{
        name: "silent-hook",
        priority: 30,
        run: () => undefined,
      }],
    };`,
  );

  const manager = new PluginManager(root, FAKE_LLM);
  await manager.load();
  try {
    const { content, hooks } = await manager.buildPromptContent(BASE_CONTEXT);
    assertEquals(content, undefined);
    assertEquals(hooks.length, 1);
    assertEquals(hooks[0].charsUsed, 0);
    assertEquals(hooks[0].output, undefined);
    assertEquals(hooks[0].degraded, false);
    assertEquals(hooks[0].budgetSkipped, false);
    assertEquals(hooks[0].truncated, false);
  } finally {
    await manager.stop();
  }
});

Deno.test("buildPromptContent marks failing hooks as degraded", async () => {
  const root = await Deno.makeTempDir({ prefix: "psycheros-test-" });
  await writePlugin(
    root,
    "broken",
    {
      name: "Broken",
      version: "1.0.0",
      enabled: true,
      entrypoints: { psycheros: "./psycheros.ts" },
    },
    `export default {
      promptHooks: [{
        name: "boom",
        priority: 40,
        run: () => { throw new Error("API offline"); },
      }],
    };`,
  );

  const manager = new PluginManager(root, FAKE_LLM);
  await manager.load();
  try {
    const { content, hooks } = await manager.buildPromptContent(BASE_CONTEXT);
    assertStringIncludes(content ?? "", "<plugin_failure");
    assertEquals(hooks.length, 1);
    assertEquals(hooks[0].degraded, true);
    assertEquals(hooks[0].charsUsed > 0, true);
  } finally {
    await manager.stop();
  }
});

Deno.test("buildPromptContent flags budget-skipped hooks", async () => {
  const root = await Deno.makeTempDir({ prefix: "psycheros-test-" });
  // Two plugins — greedy fills the budget, starved arrives with nothing left.
  await writePlugin(
    root,
    "greedy",
    {
      name: "Greedy",
      version: "1.0.0",
      enabled: true,
      entrypoints: { psycheros: "./psycheros.ts" },
    },
    `export default {
      promptHooks: [{
        name: "first",
        priority: 10,
        maxChars: 2000,
        run: () => "x".repeat(1400),
      }],
    };`,
  );
  await writePlugin(
    root,
    "starved",
    {
      name: "Starved",
      version: "1.0.0",
      enabled: true,
      entrypoints: { psycheros: "./psycheros.ts" },
    },
    `export default {
      promptHooks: [{
        name: "second",
        priority: 90,
        run: () => "y".repeat(500),
      }],
    };`,
  );

  const manager = new PluginManager(root, FAKE_LLM);
  await manager.load();
  try {
    // 1500-char budget — greedy consumes ~1460 (1400 + wrapper overhead),
    // leaving <80 chars; starved's aggregateAwareMax falls to ≤0 → skipped.
    const { content, hooks } = await manager.buildPromptContent(
      BASE_CONTEXT,
      { maxTotalChars: 1500 },
    );
    assertEquals(content === undefined, false);
    const greedy = hooks.find((h) => h.pluginId === "greedy");
    const starved = hooks.find((h) => h.pluginId === "starved");
    assertEquals(greedy?.budgetSkipped, false);
    assertEquals((greedy?.charsUsed ?? 0) > 0, true);
    assertEquals(starved?.budgetSkipped, true);
    assertEquals(starved?.charsUsed, 0);
  } finally {
    await manager.stop();
  }
});

Deno.test("buildPromptContent returns empty content+hooks when no plugins have hooks", async () => {
  const root = await Deno.makeTempDir({ prefix: "psycheros-test-" });
  await writePlugin(
    root,
    "noop",
    {
      name: "Noop",
      version: "1.0.0",
      enabled: true,
      entrypoints: { psycheros: "./psycheros.ts" },
    },
    `export default {};`,
  );

  const manager = new PluginManager(root, FAKE_LLM);
  await manager.load();
  try {
    const { content, hooks } = await manager.buildPromptContent(BASE_CONTEXT);
    assertEquals(content, undefined);
    assertEquals(hooks, []);
  } finally {
    await manager.stop();
  }
});
