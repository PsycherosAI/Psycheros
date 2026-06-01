# Trusted Local Plugins

Plugins extend my Psycheros embodiment and my canonical entity-core without
forking source. They live under:

```text
<dataRoot>/.psycheros/plugins/<id>/
```

Plugins are trusted local code. They can access my filesystem, network,
database-facing services, and local secrets. Installing or restoring a plugin is
equivalent to installing executable code. I load plugins only during startup, so
changes require a daemon restart.

## Secrets And Environment

My plugin credentials live outside the executable plugin tree:

```text
<dataRoot>/.psycheros/plugin-secrets/<id>.env
```

For an ElevenLabs speech plugin:

```dotenv
PSYCHEROS_PLUGIN_SPEECH_ELEVENLABS_API_KEY=...
PSYCHEROS_PLUGIN_SPEECH_ELEVENLABS_VOICE_ID=...
```

Both of my hosts apply this file before importing the matching entrypoint. My
plugin can use `Deno.env.get(...)` directly or the accessor passed to callbacks:

```ts
export default {
  start({ env }) {
    env.require("PSYCHEROS_PLUGIN_SPEECH_ELEVENLABS_API_KEY");
  },
  routes: [{
    method: "POST",
    path: "/speak",
    async handler(request, { env }) {
      const apiKey = env.require(
        "PSYCHEROS_PLUGIN_SPEECH_ELEVENLABS_API_KEY",
      );
      return synthesize(await request.text(), apiKey);
    },
  }],
};
```

My trusted plugins share a process environment, so names should start with
`PSYCHEROS_PLUGIN_<ID>_`. Portable entity exports include plugin code and
`state/`, but never include `plugin-secrets/`. Conventional credential files
such as `.env`, `secrets.env`, and `secrets.json` are also omitted if they are
accidentally placed inside my plugin directory. My plugin state may still
contain sensitive provider data, so I should keep credentials in
`plugin-secrets/`.

## Manifest

Each directory contains `plugin.json` and optional host entrypoints:

```json
{
  "id": "artifact-search",
  "name": "Artifact Search",
  "version": "1.0.0",
  "apiVersion": 1,
  "enabled": true,
  "entrypoints": {
    "psycheros": "./psycheros.ts",
    "entityCore": "./entity-core.ts"
  },
  "browser": {
    "scripts": ["./web/index.js"],
    "styles": ["./web/index.css"]
  }
}
```

My directory name must match `id`. Manifest paths are relative, start with `./`,
and cannot escape the plugin directory.

## Psycheros Entrypoint

`psycheros.ts` exports a default object with optional `tools`, `promptHooks`,
`routes`, `start`, and `stop` fields. Tools use the existing Psycheros `Tool`
interface. Routes are mounted under `/api/plugins/<id>/`; browser files are
served under `/plugins/<id>/`.

```ts
export default {
  promptHooks: [{
    name: "artifact-search",
    priority: 10,
    async run(ctx) {
      const workerSummary = await ctx.completeWorker(
        `Summarize useful artifacts for: ${ctx.userMessage}`,
      );
      return `My retrieved artifacts:\n${workerSummary}`;
    },
  }],
};
```

Each prompt hook defaults to a 15-second timeout and a 12,000-character output
limit. A failed hook is skipped and I receive a sanitized system note so I can
mention the degraded integration naturally.

## Entity-Core Entrypoint

`entity-core.ts` exports optional `tools`, `resultDecorators`, `start`, and
`stop` fields. Decorators add fields to selected MCP results after core logic
completes. They cannot replace existing fields.

```ts
export default {
  resultDecorators: [{
    tool: "memory_search",
    name: "artifact-links",
    async decorate(result) {
      return { artifact_links: await lookupLinks(result) };
    },
  }],
};
```

## Media Patterns

A video-call plugin can inject browser JavaScript, request webcam permission,
stream frames through its namespaced route, and return avatar state through a
prompt hook. An audio plugin can use the same route and browser-asset surface
for microphone capture, speech recognition, synthesis, and playback. These are
plugin responsibilities; the core harness does not ship a webcam or audio
provider.

## Testing

My plugins are ordinary Deno modules. I can keep tests beside my plugin and run:

```powershell
deno test -A
```

Before restarting after a manual install, I can validate my manifest and every
declared entrypoint or browser asset from the workspace:

```powershell
deno task --cwd packages/plugin-api validate <dataRoot>/.psycheros/plugins/speech
```

`@psycheros/plugin-api/testing` exposes `createPluginFixture()` for isolated
startup tests with sibling `plugins/` and `plugin-secrets/` directories:

```ts
import { assertEquals } from "@std/assert";
import { createPluginFixture } from "@psycheros/plugin-api/testing";
import { PluginManager } from "<psycheros>/src/plugins/mod.ts";

Deno.test("my speech route uses my configured provider", async () => {
  const fixture = await createPluginFixture(
    {
      id: "speech",
      name: "Speech",
      version: "1.0.0",
      apiVersion: 1,
      entrypoints: { psycheros: "./psycheros.ts" },
    },
    {
      "psycheros.ts": `export default {
        routes: [{ path: "/status", handler(_request, { env }) {
          return Response.json({ configured: env.has("PSYCHEROS_PLUGIN_SPEECH_API_KEY") });
        }}]
      };`,
    },
    { PSYCHEROS_PLUGIN_SPEECH_API_KEY: "test-only" },
  );

  const manager = new PluginManager(fixture.root, () => fakeLlm);
  await manager.load();
  try {
    const response = await manager.handleApiRoute(
      "speech",
      "/status",
      new Request("http://localhost/api/plugins/speech/status"),
    );
    assertEquals(await response.json(), { configured: true });
  } finally {
    await manager.stop();
  }
});
```

My host tests should cover startup failure isolation, lifecycle cleanup, prompt
timeouts and truncation, sanitized fallbacks, tool registration, route
namespacing, asset containment, browser tags, MCP decorator collisions, and
credential restoration after shutdown.

## Existing Custom Tools

The older `custom-tools/` directory remains supported for single-file
LLM-callable tools. Existing custom tools do not need migration.

All prompt text, tool descriptions, comments, and entity-facing copy follow my
first-person convention.
