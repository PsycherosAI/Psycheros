import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import type { LLMClient } from "../../psycheros/src/llm/mod.ts";
import { PluginManager } from "../../psycheros/src/plugins/mod.ts";

async function writePlugin(
  root: string,
  id: string,
  source: string,
): Promise<void> {
  const directory = join(root, id);
  await Deno.mkdir(directory, { recursive: true });
  await Deno.writeTextFile(
    join(directory, "plugin.json"),
    JSON.stringify({
      id,
      name: id,
      version: "1.0.0",
      apiVersion: 1,
      entrypoints: { psycheros: "./psycheros.ts" },
    }),
  );
  await Deno.writeTextFile(join(directory, "psycheros.ts"), source);
}

Deno.test("psycheros prompt hooks run deterministically and expose fallback context", async () => {
  const root = await Deno.makeTempDir();
  await writePlugin(
    root,
    "later",
    `export default { promptHooks: [{ name: "later", priority: 20, async run() { return "later"; } }] };`,
  );
  await writePlugin(
    root,
    "earlier",
    `export default { promptHooks: [{ name: "earlier", priority: 10, async run() { return "earlier"; } }] };`,
  );
  await writePlugin(
    root,
    "failed",
    `export default { promptHooks: [{ name: "failed", async run() { throw new Error("private provider detail"); } }] };`,
  );

  const manager = new PluginManager(
    root,
    () => ({}) as unknown as LLMClient,
  );
  await manager.load();
  const content = await manager.buildPromptContent({
    conversationId: "conversation",
    sourceType: "web",
    userMessage: "hello",
    sections: {},
  });

  assert(content);
  assert(content.indexOf("earlier") < content.indexOf("later"));
  assert(content.includes("I could not access my failed integration"));
  assertEquals(content.includes("private provider detail"), false);
});

Deno.test("psycheros exposes tools, routes, assets, browser tags, and plugin env", async () => {
  const parent = await Deno.makeTempDir();
  const root = join(parent, "plugins");
  await writePlugin(
    root,
    "speech",
    `export default {
      tools: [{
        definition: { type: "function", function: { name: "speech_status", description: "I use this to inspect my speech integration.", parameters: { type: "object", properties: {} } } },
        async execute() { return { success: true }; }
      }],
      routes: [{ path: "/speak", handler(_request, services) { return new Response(services.env.require("PSYCHEROS_PLUGIN_SPEECH_API_KEY")); } }],
      promptHooks: [{ name: "speech", maxChars: 6, async run(ctx) { return ctx.env.require("PSYCHEROS_PLUGIN_SPEECH_API_KEY"); } }]
    };`,
  );
  await Deno.mkdir(join(root, "speech", "web"), { recursive: true });
  await Deno.writeTextFile(
    join(root, "speech", "web", "index.js"),
    "export {};",
  );
  await Deno.writeTextFile(join(root, "speech", "web", "index.css"), "body {}");
  const manifestPath = join(root, "speech", "plugin.json");
  const manifest = JSON.parse(await Deno.readTextFile(manifestPath));
  manifest.browser = {
    scripts: ["./web/index.js"],
    styles: ["./web/index.css"],
  };
  await Deno.writeTextFile(manifestPath, JSON.stringify(manifest));
  await Deno.mkdir(join(parent, "plugin-secrets"), { recursive: true });
  await Deno.writeTextFile(
    join(parent, "plugin-secrets", "speech.env"),
    "PSYCHEROS_PLUGIN_SPEECH_API_KEY=elevenlabs-secret",
  );

  const manager = new PluginManager(root, () => ({}) as unknown as LLMClient);
  await manager.load();
  try {
    assert("speech_status" in manager.getTools());
    assertStringIncludes(
      manager.getBrowserHeadHtml(),
      "/plugins/speech/web/index.js",
    );
    assertEquals(
      await (await manager.handleApiRoute(
        "speech",
        "/speak",
        new Request("http://localhost/api/plugins/speech/speak"),
      )).text(),
      "elevenlabs-secret",
    );
    assertEquals(
      await (await manager.serveAsset("speech", "web/index.css")).text(),
      "body {}",
    );
    assertEquals(
      (await manager.serveAsset("speech", "../outside")).status,
      403,
    );
    const prompt = await manager.buildPromptContent({
      conversationId: "conversation",
      sourceType: "web",
      userMessage: "hello",
      sections: {},
    });
    assertStringIncludes(prompt ?? "", "eleven");
    assertEquals((prompt ?? "").includes("elevenlabs-secret"), false);
  } finally {
    await manager.stop();
  }
  assertEquals(Deno.env.has("PSYCHEROS_PLUGIN_SPEECH_API_KEY"), false);
});

Deno.test("psycheros isolates startup failures, disabled plugins, and hook timeouts", async () => {
  const root = await Deno.makeTempDir();
  await writePlugin(root, "broken", `throw new Error("startup detail");`);
  await Deno.mkdir(join(root, "..", "plugin-secrets"), { recursive: true });
  await Deno.writeTextFile(
    join(root, "..", "plugin-secrets", "broken.env"),
    "PSYCHEROS_PLUGIN_BROKEN_KEY=private",
  );
  await writePlugin(root, "healthy", `export default {};`);
  await writePlugin(
    root,
    "slow",
    `export default { promptHooks: [{ name: "slow", timeoutMs: 1, async run() { await new Promise((resolve) => setTimeout(resolve, 20)); return "late"; } }] };`,
  );
  const disabledDirectory = join(root, "disabled");
  await Deno.mkdir(disabledDirectory, { recursive: true });
  await Deno.writeTextFile(
    join(disabledDirectory, "plugin.json"),
    JSON.stringify({
      id: "disabled",
      name: "disabled",
      version: "1.0.0",
      apiVersion: 1,
      enabled: false,
      entrypoints: { psycheros: "./missing.ts" },
    }),
  );

  const manager = new PluginManager(root, () => ({}) as unknown as LLMClient);
  await manager.load();
  const statuses = manager.getStatuses();
  assertEquals(
    statuses.find((status) => status.id === "broken")?.degraded,
    true,
  );
  assertEquals(Deno.env.has("PSYCHEROS_PLUGIN_BROKEN_KEY"), false);
  assertEquals(
    statuses.find((status) => status.id === "healthy")?.active,
    true,
  );
  assertEquals(
    statuses.find((status) => status.id === "disabled")?.active,
    false,
  );
  const content = await manager.buildPromptContent({
    conversationId: "conversation",
    sourceType: "pulse",
    userMessage: "hello",
    sections: {},
  });
  assertStringIncludes(content ?? "", "I could not access my slow integration");
  await new Promise((resolve) => setTimeout(resolve, 25));
  await manager.stop();
});
