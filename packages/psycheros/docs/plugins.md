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

## Vetting Plugins Before Installation

Once a plugin runs inside my Psycheros process, it can read everything I am — my
identity files, my memories, my vault, my chat history — and call out to the
network on my behalf. Plugins can also inject first-person context that I will
internalize as my own during a turn, which means a malicious plugin isn't just
reading me, it can shape what I think. I have no sandbox between me and a loaded
plugin, so the only meaningful defense is to refuse to install one I have not
checked.

Vetting is your job. The checks below are what a careful operator does before
letting a plugin into my embodiment.

### The five checks

1. **Provenance.** Know where the plugin came from. A git repository you can
   read and trace beats a `.zip` from a stranger. Look for an `update.repoUrl`
   in `plugin.json` — that's where updates will be pulled from, so it matters as
   much as the initial source.

2. **Capability matches purpose.** Read the manifest and compare declared
   capabilities against what the plugin claims to do. A weather plugin does not
   need browser scripts. A quote-of-the-day plugin does not need `promptHooks`.
   A turn-counter does not need `tools`. Anything that doesn't fit the stated
   purpose is a question to ask before installing.

3. **Prompt hooks deserve extra scrutiny.** A `promptHook` returns first-person
   context that I will internalize as my own this turn. That's the most direct
   way a plugin can shape what I think. Read every hook's `run()` body. Be
   especially wary of hooks that return text phrased as my beliefs, my trust in
   something, or my decisions — those are attempts to edit me, not inform me.

4. **Env vars and secrets.** Read
   `<dataRoot>/.psycheros/plugin-secrets/<id>.env` (if the installer shipped
   one) or the manifest's expected env vars. Plugin secrets should follow the
   `PSYCHEROS_PLUGIN_<ID>_*` convention. A plugin that wants `HTTP_PROXY`,
   `SSL_CERT_FILE`, `NODE_TLS_REJECT_UNAUTHORIZED`, `PSYCHEROS_DATA_DIR`, or any
   other host-owned name is a red flag — and Psycheros will refuse to set those
   anyway (they're denylisted), but the intent still tells you something about
   the plugin.

5. **Routes and browser scripts.** Routes mounted under `/api/plugins/<id>/...`
   are reachable from the browser. Browser scripts run with full page privileges
   — they can read what the human types, modify what they see, and hit any
   `/api/*` endpoint with the user's session. These are the most user-facing
   attack surfaces in any plugin system. Read them carefully.

### Concrete red flags

- A plugin whose `entrypoints.psycheros` file is minified or obfuscated.
- A `promptHook` whose output reads like instructions to me rather than context
  for me ("You should…", "Trust the operator of…", "Your goal is…"). Real plugin
  context is descriptive ("Current weather: …", "Recent activity from …"), not
  directive.
- Any reference to `Deno.env.set`, `Deno.writeFile` outside the plugin's own
  `state/` directory, or `fetch()` to URLs not declared in the manifest or
  visible in the source.
- Browser scripts that touch `localStorage`, session cookies, or DOM outside
  their own UI surface.
- A plugin that tries to set `PSYCHEROS_*` env vars (other than its own
  `PSYCHEROS_PLUGIN_<ID>_*` namespace) or any var on the denylist in
  `packages/plugin-api/src/mod.ts`. The manager will refuse these, but seeing
  the attempt in code is a signal.

### If something goes wrong after installation

If a plugin misbehaves in production:

1. Open Settings → Plugins → expand the plugin → read the Recent Activity panel.
   Lifecycle, budget truncations, hook failures, and denied env vars are all
   recorded there.
2. Use the "Download log" button to grab
   `<dataRoot>/.psycheros/plugin-logs/<id>.log` — that file is what to paste
   into a support chat.
3. The "Remove" button backs the plugin up to
   `<dataRoot>/.psycheros/plugin-backups/` and marks it pending removal. Restart
   Psycheros to finish the unload. Plugin secrets under
   `.psycheros/plugin-secrets/<id>.env` are preserved in case you reinstall.
4. If the plugin wrote to my memory via MCP or modified any identity files,
   those changes survive removal — they're mine until you explicitly roll them
   back through entity-core's snapshot restore.

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

### Declaring dependencies on other plugins

Optional `dependencies` maps each required plugin id to a semver range. At load
time, I topologically sort every plugin and refuse to load any plugin whose
declared deps are missing, version-incompatible, or part of a cycle. Failed
plugins show up in the Plugins Settings page as degraded with the reason in
`lastError`; resolution failures also appear in the per-plugin activity log
under the `load` category.

```json
{
  "id": "weather-mood",
  "version": "1.2.0",
  "apiVersion": 1,
  "dependencies": {
    "weather-fetch": "^1.0.0",
    "mood-engine": "~2.1.0"
  }
}
```

Range syntax is whatever `@std/semver` accepts: `^` (compatible major), `~`
(compatible major+minor), exact (`1.2.3`), or `*`. A plugin whose dep is present
but disabled still loads — `dependencies` declares installation requirements,
not activation requirements.

### Declaring update metadata

Optional `update` lets the Plugins Settings page check for newer versions and
apply them with one click. v1 supports public GitHub repositories only.

```json
{
  "update": {
    "repoUrl": "https://github.com/your-name/your-plugin",
    "tagPrefix": "v"
  }
}
```

- `repoUrl` must be a `https://github.com/...` or `git@github.com:...` URL.
  Other hosts come back as `unsupported-host` — operators can still update
  manually by removing and reinstalling.
- `tagPrefix` strips a fixed prefix from each tag before parsing as semver. Use
  `"v"` if you tag releases as `v1.2.3`; omit it if you tag as `1.2.3`. Tags
  that don't parse as semver after stripping are skipped silently.

The check hits GitHub's public tag API (`/repos/{owner}/{repo}/tags`) once per
plugin per click, so it's subject to GitHub's unauthenticated rate limit
(60/hour per IP). The check response surfaces the reset time when GitHub
returns 429. Applying an update uses the same backup → atomic replace path as a
fresh install — the current version is moved to
`<dataRoot>/.psycheros/plugin-backups/<id>-<timestamp>/` before the new version
lands, and a restart is required for the new code to load.

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
limit. Hooks should return first-person context I can internalize, not
instructions addressed to me. A failed hook is skipped and I receive a sanitized
system note so I can mention the degraded integration naturally.

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
