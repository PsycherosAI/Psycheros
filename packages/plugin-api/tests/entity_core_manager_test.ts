import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import type { EmbeddingCache } from "../../entity-core/src/embeddings/mod.ts";
import type { GraphStore } from "../../entity-core/src/graph/mod.ts";
import { EntityCorePluginManager } from "../../entity-core/src/plugins/mod.ts";
import type { FileStore } from "../../entity-core/src/storage/mod.ts";

Deno.test("entity-core decorators add fields and preserve core fields on collision", async () => {
  const root = await Deno.makeTempDir();
  const directory = join(root, "rag-fields");
  await Deno.mkdir(directory, { recursive: true });
  await Deno.writeTextFile(
    join(directory, "plugin.json"),
    JSON.stringify({
      id: "rag-fields",
      name: "RAG Fields",
      version: "1.0.0",
      apiVersion: 1,
      entrypoints: { entityCore: "./entity-core.ts" },
    }),
  );
  await Deno.writeTextFile(
    join(directory, "entity-core.ts"),
    `export default { resultDecorators: [
      { tool: "memory_search", name: "links", async decorate() { return { artifact_links: ["one"] }; } },
      { tool: "memory_search", name: "collision", async decorate() { return { results: [] }; } },
      { tool: "memory_search", name: "secret", async decorate(_result, services) { return { provider_key: services.env.require("PSYCHEROS_PLUGIN_RAG_API_KEY") }; } }
    ],
    tools: [{ name: "rag_status", description: "I use this to inspect my retrieval integration.", schema: {}, handler(_args, services) { return { configured: services.env.has("PSYCHEROS_PLUGIN_RAG_API_KEY") }; } }]
    };`,
  );
  await Deno.mkdir(join(root, "..", "plugin-secrets"), { recursive: true });
  await Deno.writeTextFile(
    join(root, "..", "plugin-secrets", "rag-fields.env"),
    "PSYCHEROS_PLUGIN_RAG_API_KEY=provider-secret",
  );

  const fake = {} as unknown;
  const manager = new EntityCorePluginManager(root, {
    dataDir: root,
    store: fake as FileStore,
    graphStore: fake as GraphStore,
    embeddingCache: fake as EmbeddingCache,
    log: () => {},
  });
  await manager.load();
  try {
    const result = await manager.decorate("memory_search", {
      results: ["core"],
    });

    assertEquals(result.results, ["core"]);
    assertEquals(result.artifact_links, ["one"]);
    assertEquals(result.provider_key, "provider-secret");
    assertEquals(result.plugin_failures, [{
      plugin: "rag-fields",
      decorator: "collision",
    }]);
    const [{ plugin, tool }] = manager.getTools();
    assertEquals(
      await tool.handler({}, {
        dataDir: root,
        statePath: join(plugin.directory, "state"),
        env: {
          get: (name) => Deno.env.get(name),
          has: (name) => Deno.env.has(name),
          require: (name) => Deno.env.get(name) ?? "",
        },
        store: fake as FileStore,
        graphStore: fake as GraphStore,
        embeddingCache: fake as EmbeddingCache,
        log: () => {},
      }),
      { configured: true },
    );
  } finally {
    await manager.stop();
  }
  assertEquals(Deno.env.has("PSYCHEROS_PLUGIN_RAG_API_KEY"), false);
});
