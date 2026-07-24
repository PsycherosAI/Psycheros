/**
 * Trusted local plugin harness for my Psycheros embodiment.
 */

import { basename, extname, join, normalize, toFileUrl } from "@std/path";
import {
  type AppliedPluginEnv,
  applyPluginEnv,
  DEFAULT_PROMPT_HOOK_MAX_CHARS,
  DEFAULT_PROMPT_HOOK_TIMEOUT_MS,
  emptyPluginCapabilityCounts,
  getPluginEnvPath,
  isDeniedPluginEnvVar,
  type PluginEnv,
  type PluginManifest,
  type PluginStatus,
  readPluginEnv,
  validatePluginManifest,
  validatePluginRelativePath,
} from "../../../plugin-api/src/mod.ts";
import type { Tool } from "../tools/mod.ts";
import type { MCPClient } from "../mcp-client/mod.ts";
import type { PluginHookDetail } from "../types.ts";
import type { LLMClient } from "../llm/mod.ts";
import { PluginEventLogRegistry } from "./event-log.ts";
import type { PluginEvent } from "./event-log.ts";
import { resolveDependencies } from "./dependency-resolver.ts";

/**
 * Default ceiling on the total prompt-hook context I internalize per turn.
 *
 * Per-hook caps (DEFAULT_PROMPT_HOOK_MAX_CHARS, 12k) bound individual plugins;
 * this aggregate bound protects my context window when many plugins each
 * contribute near their per-hook cap. The host (entity loop) typically passes
 * a computed value derived from the active LLM profile's contextLength; this
 * constant is the fallback when the host doesn't know its context window.
 */
const DEFAULT_PROMPT_HOOK_AGGREGATE_MAX_CHARS = 24_000;

/**
 * Approximate overhead of the wrapper tags + headers around a single hook's
 * contribution. Used to reserve headroom in the aggregate budget so the
 * wrapper itself doesn't push the total over the cap.
 */
const PLUGIN_CONTEXT_WRAPPER_OVERHEAD = 80;

export interface PluginPromptContext {
  conversationId: string;
  sourceType: "web" | "discord" | "pulse";
  userMessage: string;
  sections: Record<string, string | undefined>;
  statePath: string;
  env: PluginEnv;
  mcpClient?: MCPClient;
  /**
   * Configured user name from GeneralSettings. Plugins use this for
   * personalization (e.g. `calendarLabel` "{userName}'s calendar" template
   * substitution in the today-schedule hook). Optional because some turn
   * sources (Pulse?) may not have a user-message context — entity-side
   * defaults handle the undefined case.
   */
  userName?: string;
  completeWorker: (prompt: string, systemPrompt?: string) => Promise<string>;
}

export interface PsycherosPluginServices {
  statePath: string;
  env: PluginEnv;
  /**
   * Write or update a single secret in this plugin's secrets file. Name must
   * match `PSYCHEROS_PLUGIN_<ID>_*` prefix; value must be non-empty. Atomically
   * merges (read-modify-write). Also Deno.env.set's so the live environment
   * sees the new value before the next applyPluginEnv cycle.
   *
   * Used by plugin settings routes to persist credentials captured from a
   * form (e.g. OAuth client ID/secret, API keys). Avoids plugins reaching
   * outside their statePath — a security smell flagged in the vetting guide.
   */
  writeSecret: (name: string, value: string) => Promise<void>;
  /**
   * Read all secrets for this plugin as a { name: value } record. Empty
   * object if no secrets file exists yet. Convenience over env.get() when
   * the plugin needs to enumerate (e.g. which scopes were previously granted,
   * or to check whether a refresh token exists without throwing).
   */
  readSecrets: () => Promise<Record<string, string>>;
}

export interface PluginPromptHook {
  name: string;
  priority?: number;
  timeoutMs?: number;
  maxChars?: number;
  /** Return first-person context I can internalize during this turn. */
  run: (context: PluginPromptContext) => Promise<string | undefined>;
}

export interface PluginRoute {
  method?: string;
  path: string;
  handler: (
    request: Request,
    services: PsycherosPluginServices,
  ) => Response | Promise<Response>;
}

/**
 * Context passed to a plugin's `settingsFragment` callback. The fragment
 * returns an HTML string that the host wraps in standard settings chrome
 * (header, back button, content wrapper) — plugins must NOT emit their own
 * `<div class="settings-view">` or back button.
 *
 * Reachable even when the plugin is disabled, so operators can configure
 * credentials before enabling.
 */
export interface PluginSettingsContext {
  /** Plugin state dir, same path passed to start()/stop(). */
  statePath: string;
  /** Plugin env accessor (reads from applied plugin-secrets). */
  env: PluginEnv;
  /**
   * HTMX swap target the fragment will land in. Plugins should target this
   * for any in-fragment htmx swaps (e.g. re-rendering after a save).
   */
  targetElementId: string;
}

interface PsycherosPluginModule {
  tools?: Tool[];
  promptHooks?: PluginPromptHook[];
  routes?: PluginRoute[];
  /**
   * Returns an HTML fragment for the plugin's settings page. Declared in the
   * manifest via `capabilities.settings: true`. The host wraps the returned
   * HTML in standard settings chrome.
   */
  settingsFragment?: (ctx: PluginSettingsContext) => Promise<string> | string;
  start?: (services: PsycherosPluginServices) => void | Promise<void>;
  stop?: (services: PsycherosPluginServices) => void | Promise<void>;
}

interface LoadedPlugin {
  directory: string;
  manifest: PluginManifest;
  module?: PsycherosPluginModule;
  appliedEnv?: AppliedPluginEnv;
  status: PluginStatus;
  /**
   * Where the plugin was discovered. `builtin` plugins ship with Psycheros
   * (live under `<projectRoot>/bundled-plugins/`); `installed` plugins are
   * user-installed via zip/git. Controls statePath resolution, secrets path,
   * and which UI affordances the Plugins Settings page renders.
   */
  origin: "installed" | "builtin";
}

function getMimeType(path: string): string {
  switch (extname(path).toLowerCase()) {
    case ".js":
    case ".mjs":
      return "application/javascript; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    default:
      return "application/octet-stream";
  }
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Serialize a secrets record as `.env` text. One `KEY=value` per line. Values
 * containing whitespace, `#`, `"`, or `'` are wrapped in double quotes with
 * `"` and `\` escaped. This is the inverse of @std/dotenv's `parse` for the
 * subset of value shapes we control — caller controls all values, so we
 * don't need to handle every edge case (variable expansion, comments, etc.).
 */
function serializePluginEnv(values: Record<string, string>): string {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(values)) {
    if (value === "") continue; // skip empties — read-modify-write preserves file shape
    if (/[\s#"']/.test(value)) {
      const escaped = value.replace(/["\\]/g, "\\$&");
      lines.push(`${key}="${escaped}"`);
    } else {
      lines.push(`${key}=${value}`);
    }
  }
  return lines.join("\n") + (lines.length > 0 ? "\n" : "");
}

export class PluginManager {
  private plugins: LoadedPlugin[] = [];
  /**
   * Per-plugin event log registry. Always-on by default — the support
   * workflow needs logs to exist before the operator knows there's a
   * problem. The host (server) may flip `eventLog.enabled = false` to
   * disable globally.
   */
  readonly eventLog: PluginEventLogRegistry;
  /**
   * Last turn's plugin context budget accounting. Updated at the end of
   * every buildPromptContent call. Consumed by the entity loop to populate
   * LLMContextSnapshot.metrics (so the Context Inspector and the Plugins
   * Settings health card can show "X / Y chars" without re-running hooks).
   */
  private lastBudgetUsedChars: number | undefined;
  private lastBudgetCapChars: number | undefined;

  constructor(
    private pluginRoot: string,
    private getLlm: () => LLMClient,
    private bundledRoot?: string,
    private dataRoot?: string,
  ) {
    // Event log path: when dataRoot is provided (production wiring), use
    // `<dataRoot>/.psycheros/plugin-logs` for origin-independence — installed
    // and bundled plugins share the same logs directory. When omitted (tests),
    // preserve the original `<pluginRoot>/../plugin-logs` behavior.
    const logDir = dataRoot
      ? join(dataRoot, ".psycheros", "plugin-logs")
      : join(pluginRoot, "..", "plugin-logs");
    this.eventLog = new PluginEventLogRegistry(logDir);
  }

  /**
   * Directory holding plugin-secrets files. When `dataRoot` is provided,
   * always `<dataRoot>/.psycheros/plugin-secrets/` — both installed and
   * bundled plugins look here so credentials live in user data regardless
   * of plugin origin. When omitted, original behavior (`<pluginRoot>/../plugin-secrets/`).
   */
  private get secretsDir(): string | undefined {
    return this.dataRoot
      ? join(this.dataRoot, ".psycheros", "plugin-secrets")
      : undefined;
  }

  private services(plugin: LoadedPlugin): PsycherosPluginServices {
    // Bundled plugins load from `<projectRoot>/bundled-plugins/<id>/` which is
    // source tree — state can't live there. Redirect to dataRoot.
    const statePath = plugin.origin === "builtin" && this.dataRoot
      ? join(this.dataRoot, ".psycheros", "plugin-state", plugin.manifest.id)
      : join(plugin.directory, "state");
    const pluginId = plugin.manifest.id;
    const upperId = pluginId.toUpperCase().replace(/[^A-Z0-9]/g, "_");
    const prefix = `PSYCHEROS_PLUGIN_${upperId}_`;
    const prefixRe = new RegExp(`^${prefix}[A-Z0-9_]+$`);
    // Capture secretsDir on the local stack so closures can read it without
    // rebinding `this`. `this.secretsDir` is a getter, so the value is fresh
    // per services() call but constant for the manager's lifetime.
    const secretsDir = this.secretsDir;
    const pluginDir = plugin.directory;
    return {
      statePath,
      env: plugin.appliedEnv?.env ?? {
        get: (name) => Deno.env.get(name),
        has: (name) => Deno.env.has(name),
        require(name) {
          const value = Deno.env.get(name);
          if (!value) {
            throw new Error(`missing required plugin environment: ${name}`);
          }
          return value;
        },
      },
      async writeSecret(name, value) {
        if (!prefixRe.test(name)) {
          throw new Error(
            `writeSecret: name must match ${prefix}*[A-Z0-9_]+ — got "${name}"`,
          );
        }
        if (typeof value !== "string" || value.length === 0) {
          throw new Error(`writeSecret: value for "${name}" must be non-empty`);
        }
        if (isDeniedPluginEnvVar(name)) {
          throw new Error(
            `writeSecret: name "${name}" is denylisted (process-global or host-owned)`,
          );
        }
        // Read-modify-write under the plugin's secrets path. Uses the same
        // path resolution as applyPluginEnv (secretsDir-aware).
        const secretsFile = getPluginEnvPath(pluginDir, pluginId, secretsDir);
        const existing = await readPluginEnv(pluginDir, pluginId, secretsDir);
        existing[name] = value;
        await Deno.mkdir(join(secretsFile, ".."), { recursive: true });
        await Deno.writeTextFile(secretsFile, serializePluginEnv(existing));
        // Mirror applyPluginEnv's behavior: live env sees the new value
        // immediately, no restart needed.
        Deno.env.set(name, value);
      },
      async readSecrets() {
        return await readPluginEnv(pluginDir, pluginId, secretsDir);
      },
    };
  }

  /**
   * Scan a single root for plugin directories. Returns LoadedPlugin entries
   * with `origin` tagged. Used for both the user-installed plugin root and
   * (when configured) the bundled-plugins root.
   */
  private async discoverInRoot(
    root: string,
    origin: "installed" | "builtin",
  ): Promise<LoadedPlugin[]> {
    let entries: Deno.DirEntry[];
    try {
      entries = Array.from(Deno.readDirSync(root));
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return [];
      throw error;
    }

    const discovered: LoadedPlugin[] = [];
    for (const entry of entries.filter((item) => item.isDirectory)) {
      const directory = join(root, entry.name);
      try {
        const raw = JSON.parse(
          await Deno.readTextFile(join(directory, "plugin.json")),
        );
        const manifest = validatePluginManifest(raw, entry.name);
        const capabilities = emptyPluginCapabilityCounts();
        capabilities.browserScripts = manifest.browser?.scripts?.length ?? 0;
        capabilities.browserStyles = manifest.browser?.styles?.length ?? 0;
        const status: PluginStatus = {
          id: manifest.id,
          name: manifest.name,
          version: manifest.version,
          description: manifest.description,
          homepageUrl: manifest.homepageUrl,
          enabled: manifest.enabled,
          active: false,
          degraded: false,
          restartRequired: false,
          compatibility: manifest.compatibility,
          update: manifest.update,
          dependencies: manifest.dependencies,
          warnings: [],
          entrypoints: {
            psycheros: !!manifest.entrypoints?.psycheros,
            entityCore: !!manifest.entrypoints?.entityCore,
          },
          capabilities,
          declaresSettings: manifest.capabilities?.settings === true,
          origin,
        };
        discovered.push({ directory, manifest, status, origin });
      } catch (error) {
        console.error(`[Plugins] Failed to load ${entry.name}:`, error);
        await this.eventLog.record(entry.name, {
          level: "error",
          category: "load",
          message: `manifest load failed: ${safeError(error)}`,
        });
        // Placeholder preserves that a directory exists but is unusable.
        // Excluded from dependency resolution (version "unknown" can't
        // satisfy any range).
        discovered.push({
          directory,
          manifest: {
            id: entry.name,
            name: entry.name,
            version: "unknown",
            apiVersion: 1,
            enabled: false,
          },
          status: {
            id: entry.name,
            name: entry.name,
            version: "unknown",
            enabled: false,
            active: false,
            degraded: true,
            restartRequired: false,
            warnings: [safeError(error)],
            entrypoints: { psycheros: false, entityCore: false },
            capabilities: emptyPluginCapabilityCounts(),
            lastError: safeError(error),
            origin,
          },
          origin,
        });
      }
    }
    return discovered;
  }

  async load(): Promise<void> {
    await this.stop();
    this.plugins = [];

    // === DISCOVER: scan installed plugins root (always) and bundled-plugins
    // root (when configured). Built-in plugins win on id collisions — a
    // user-installed plugin with the same id is shadowed with a warning.
    const installed = await this.discoverInRoot(this.pluginRoot, "installed");
    const builtin = this.bundledRoot
      ? await this.discoverInRoot(this.bundledRoot, "builtin")
      : [];

    const seenIds = new Set<string>();
    const discovered: LoadedPlugin[] = [];
    for (const plugin of [...builtin, ...installed]) {
      if (seenIds.has(plugin.manifest.id)) {
        console.warn(
          `[Plugins] Plugin "${plugin.manifest.id}" exists in both bundled and installed roots; bundled wins.`,
        );
        await this.eventLog.record(plugin.manifest.id, {
          level: "warn",
          category: "load",
          message:
            `shadowed by bundled plugin with the same id (bundled wins, this copy is ignored)`,
        });
        continue;
      }
      seenIds.add(plugin.manifest.id);
      discovered.push(plugin);
    }

    // === RESOLVE: figure out load order, identify plugins that can't load
    // because their deps are missing, incompatible, or cyclic.
    const resolvable = discovered
      .filter((p) => p.manifest.version !== "unknown")
      .map((p) => ({
        id: p.manifest.id,
        version: p.manifest.version,
        dependencies: p.manifest.dependencies,
      }));
    const resolution = resolveDependencies(resolvable);
    const resolvableById = new Map(
      discovered.filter((p) => p.manifest.version !== "unknown")
        .map((p) => [p.manifest.id, p]),
    );
    for (const [id, reason] of Object.entries(resolution.failures)) {
      const plugin = resolvableById.get(id);
      if (!plugin) continue;
      plugin.status.degraded = true;
      plugin.status.lastError = reason;
      plugin.status.warnings = [
        ...(plugin.status.warnings ?? []),
        reason,
      ];
      await this.eventLog.record(id, {
        level: "error",
        category: "load",
        message: `dependency resolution failed: ${reason}`,
      });
    }

    // === LOAD: import entrypoints in dependency order so a plugin's deps
    // are guaranteed active by the time its start() runs. Plugins not in
    // resolution.order (failed resolution, manifest failed, disabled, no
    // psycheros entrypoint) stay inactive.
    for (const id of resolution.order) {
      const plugin = resolvableById.get(id);
      if (!plugin) continue;
      if (
        !plugin.manifest.enabled || !plugin.manifest.entrypoints?.psycheros
      ) continue;

      let appliedEnv: AppliedPluginEnv | undefined;
      try {
        appliedEnv = await applyPluginEnv(
          this.pluginRoot,
          plugin.manifest.id,
          this.secretsDir,
        );
        plugin.appliedEnv = appliedEnv;
        if (appliedEnv.skippedEnvVars.length > 0) {
          this.markDegraded(
            plugin,
            `env file attempted to set denied vars: ${
              appliedEnv.skippedEnvVars.join(", ")
            }`,
          );
          await this.eventLog.record(plugin.manifest.id, {
            level: "warn",
            category: "env",
            message:
              `env file refused ${appliedEnv.skippedEnvVars.length} denied var(s)`,
            details: { names: [...appliedEnv.skippedEnvVars] },
          });
        }
        const entrypoint = validatePluginRelativePath(
          plugin.manifest.entrypoints.psycheros,
        );
        const imported = await import(
          toFileUrl(join(plugin.directory, entrypoint)).href
        );
        const module = (imported.default ?? imported) as PsycherosPluginModule;
        plugin.module = module;
        plugin.status.active = true;
        // Run start() BEFORE counting capabilities — many plugins use async
        // initialization in start() (loading config, building clients) and
        // their get tools()/get promptHooks() getters return [] until
        // start() completes. Counting after ensures the real counts.
        await module.start?.(this.services(plugin));
        plugin.status.capabilities.tools = module.tools?.length ?? 0;
        plugin.status.capabilities.promptHooks = module.promptHooks?.length ??
          0;
        plugin.status.capabilities.routes = module.routes?.length ?? 0;
        plugin.status.capabilities.settings =
          typeof module.settingsFragment === "function" ? 1 : 0;
        await this.eventLog.record(plugin.manifest.id, {
          level: "info",
          category: "lifecycle",
          message:
            `loaded v${plugin.manifest.version} — ${plugin.status.capabilities.tools} tool(s), ${plugin.status.capabilities.promptHooks} hook(s), ${plugin.status.capabilities.routes} route(s)`,
        });
      } catch (error) {
        appliedEnv?.restore();
        plugin.appliedEnv = undefined;
        console.error(
          `[Plugins] Failed to load ${plugin.manifest.id}:`,
          error,
        );
        await this.eventLog.record(plugin.manifest.id, {
          level: "error",
          category: "load",
          message: `entrypoint load failed: ${safeError(error)}`,
        });
        // Preserve the manifest info (more useful than a placeholder) but
        // mark as degraded + inactive so the UI can show what failed.
        plugin.status.degraded = true;
        plugin.status.lastError = safeError(error);
        plugin.status.active = false;
      }
    }

    this.plugins = discovered;
    this.plugins.sort((a, b) => a.manifest.id.localeCompare(b.manifest.id));
  }

  async stop(): Promise<void> {
    for (const plugin of [...this.plugins].reverse()) {
      try {
        await plugin.module?.stop?.(this.services(plugin));
        await this.eventLog.record(plugin.manifest.id, {
          level: "info",
          category: "lifecycle",
          message: "stopped",
        });
      } catch (error) {
        console.error(`[Plugins] Failed to stop ${plugin.manifest.id}:`, error);
        await this.eventLog.record(plugin.manifest.id, {
          level: "error",
          category: "lifecycle",
          message: `stop() failed: ${safeError(error)}`,
        });
      } finally {
        plugin.appliedEnv?.restore();
        plugin.appliedEnv = undefined;
      }
    }
  }

  getStatuses(): PluginStatus[] {
    return this.plugins.map((plugin) => ({ ...plugin.status }));
  }

  /**
   * Recent in-memory events for a plugin (newest last). Returns an empty
   * array if the plugin has no events yet (or doesn't exist). Used by the
   * Plugins Settings page's per-plugin "Recent activity" panel.
   */
  getRecentEvents(pluginId: string): PluginEvent[] {
    return this.eventLog.snapshot(pluginId);
  }

  /**
   * Absolute path to a plugin's plain-text log file. The file may not yet
   * exist if the plugin has never emitted an event. Used by the UI's
   * "Download log" affordance and to show users where to find the file on
   * disk for support chats.
   */
  getEventLogPath(pluginId: string): string {
    return this.eventLog.filePath(pluginId);
  }

  /**
   * Whether a plugin (by id) declares the settings capability in its manifest.
   * Manifest-only check — works for disabled, failed-load, or not-yet-loaded
   * plugins. The Plugins Settings UI uses this to decide whether to render
   * a "Configure" button on the plugin row.
   */
  hasSettings(id: string): boolean {
    const plugin = this.plugins.find((p) => p.manifest.id === id);
    return plugin?.status.declaresSettings === true;
  }

  /**
   * Public accessor for a plugin's services. Used by the settings fragment
   * route to build PluginSettingsContext without reaching into private state.
   * Returns undefined for unknown plugin ids. The returned services object
   * is fresh on each call (no leaky shared references).
   */
  getServices(id: string): PsycherosPluginServices | undefined {
    const plugin = this.plugins.find((p) => p.manifest.id === id);
    if (!plugin) return undefined;
    return this.services(plugin);
  }

  /**
   * Render the settings fragment for a plugin. One-shot imports the
   * psycheros entrypoint if not already loaded (so disabled plugins can
   * still render their settings form — operators configure credentials
   * before enabling). Does NOT call start() or flip status.active.
   *
   * Throws if the plugin doesn't exist, doesn't declare capabilities.settings,
   * or doesn't export settingsFragment.
   */
  async renderSettingsFragment(
    id: string,
    ctx: PluginSettingsContext,
  ): Promise<string> {
    const plugin = this.plugins.find((p) => p.manifest.id === id);
    if (!plugin) {
      throw new Error(`renderSettingsFragment: unknown plugin "${id}"`);
    }
    if (!plugin.status.declaresSettings) {
      throw new Error(
        `renderSettingsFragment: plugin "${id}" does not declare capabilities.settings`,
      );
    }

    // One-shot import for disabled plugins. Active plugins already have the
    // module cached on the LoadedPlugin.
    if (!plugin.module) {
      const entrypoint = plugin.manifest.entrypoints?.psycheros;
      if (!entrypoint) {
        throw new Error(
          `renderSettingsFragment: plugin "${id}" has no psycheros entrypoint`,
        );
      }
      const resolved = validatePluginRelativePath(entrypoint);
      const imported = await import(
        toFileUrl(join(plugin.directory, resolved)).href
      );
      plugin.module = (imported.default ?? imported) as PsycherosPluginModule;
    }

    const fragment = plugin.module.settingsFragment;
    if (typeof fragment !== "function") {
      throw new Error(
        `Plugin "${id}" declares capabilities.settings but its entrypoint does not export settingsFragment`,
      );
    }
    return await fragment(ctx);
  }

  getTools(): Record<string, Tool> {
    const tools: Record<string, Tool> = {};
    for (const plugin of this.plugins) {
      for (const tool of plugin.module?.tools ?? []) {
        tools[tool.definition.function.name] = tool;
      }
    }
    return tools;
  }

  getBrowserHeadHtml(): string {
    const tags: string[] = [];
    for (const plugin of this.plugins) {
      if (!plugin.status.active) continue;
      for (const path of plugin.manifest.browser?.styles ?? []) {
        tags.push(
          `<link rel="stylesheet" href="/plugins/${plugin.manifest.id}/${
            validatePluginRelativePath(path)
          }">`,
        );
      }
      for (const path of plugin.manifest.browser?.scripts ?? []) {
        tags.push(
          `<script type="module" src="/plugins/${plugin.manifest.id}/${
            validatePluginRelativePath(path)
          }"></script>`,
        );
      }
    }
    return tags.join("\n  ");
  }

  /**
   * Run every active plugin's prompt hooks and concatenate their outputs into
   * first-person context I can internalize this turn.
   *
   * Aggregate budget: the joined output is bounded by `options.maxTotalChars`
   * (default 24,000). Hooks run in priority
   * order — lower priority numbers are processed first and preserved when the
   * aggregate budget comes under pressure; higher-numbered hooks are truncated
   * or skipped. Truncated hooks push a partial `<plugin_context>` block with a
   * `[truncated...]` marker and set `degraded` + a status warning. Skipped
   * hooks (aggregate exhausted before they ran) push nothing to prompt content
   * but set `degraded` + a status warning so the user can see why their
   * plugin didn't contribute.
   */
  async buildPromptContent(
    context: Omit<PluginPromptContext, "statePath" | "env" | "completeWorker">,
    options?: { maxTotalChars?: number },
  ): Promise<{ content: string | undefined; hooks: PluginHookDetail[] }> {
    const maxTotalChars = options?.maxTotalChars ??
      DEFAULT_PROMPT_HOOK_AGGREGATE_MAX_CHARS;
    const contributions: string[] = [];
    const hookDetails: PluginHookDetail[] = [];
    let remainingChars = maxTotalChars;
    const hooks = this.plugins.flatMap((plugin) =>
      (plugin.module?.promptHooks ?? []).map((hook) => ({ plugin, hook }))
    ).sort((a, b) =>
      (a.hook.priority ?? 0) - (b.hook.priority ?? 0) ||
      a.plugin.manifest.id.localeCompare(b.plugin.manifest.id) ||
      a.hook.name.localeCompare(b.hook.name)
    );

    for (const { plugin, hook } of hooks) {
      const timeoutMs = hook.timeoutMs ??
        plugin.manifest.promptHookDefaults?.timeoutMs ??
        DEFAULT_PROMPT_HOOK_TIMEOUT_MS;
      const perHookMaxChars = hook.maxChars ??
        plugin.manifest.promptHookDefaults?.maxChars ??
        DEFAULT_PROMPT_HOOK_MAX_CHARS;
      const startedAt = performance.now();
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      try {
        const output = await Promise.race([
          hook.run({
            ...context,
            statePath: join(plugin.directory, "state"),
            env: this.services(plugin).env,
            completeWorker: async (prompt, systemPrompt) => {
              const messages = [];
              if (systemPrompt) {
                messages.push({
                  role: "system" as const,
                  content: systemPrompt,
                });
              }
              messages.push({ role: "user" as const, content: prompt });
              let content = "";
              for await (const chunk of this.getLlm().chatStream(messages)) {
                if (chunk.type === "content") content += chunk.content;
              }
              return content;
            },
          }),
          new Promise<never>((_, reject) =>
            timeoutId = setTimeout(
              () => reject(new Error(`hook timed out after ${timeoutMs}ms`)),
              timeoutMs,
            )
          ),
        ]);
        const elapsedMs = Math.round(performance.now() - startedAt);
        if (output?.trim()) {
          const trimmedOutput = output.trim();
          const aggregateAwareMax = Math.max(
            0,
            Math.min(
              perHookMaxChars,
              remainingChars - PLUGIN_CONTEXT_WRAPPER_OVERHEAD,
            ),
          );

          if (aggregateAwareMax <= 0) {
            // Aggregate budget exhausted — drop this hook's output entirely.
            // Failure blocks below still push so I can mention the degradation
            // naturally, but budget skips are silent to prompt content to avoid
            // a cascade of skip-notices themselves eating context. Surfaced
            // via status.warnings for the UI.
            this.markDegraded(
              plugin,
              `prompt hook "${hook.name}" skipped due to aggregate plugin context budget (${maxTotalChars} chars)`,
            );
            await this.eventLog.record(plugin.manifest.id, {
              level: "warn",
              category: "budget",
              message:
                `hook "${hook.name}" skipped — aggregate budget exhausted at ${maxTotalChars} chars`,
              details: { hook: hook.name, budget: maxTotalChars },
            });
            hookDetails.push({
              pluginId: plugin.manifest.id,
              hookName: hook.name,
              priority: hook.priority ?? 0,
              charsUsed: 0,
              truncated: false,
              degraded: false,
              budgetSkipped: true,
              elapsedMs,
            });
            continue;
          }

          const perHookSliced = trimmedOutput.slice(0, perHookMaxChars);
          const aggregateSliced = perHookSliced.slice(0, aggregateAwareMax);
          const truncatedByAggregate = aggregateSliced.length <
            perHookSliced.length;

          let body = aggregateSliced;
          if (truncatedByAggregate) {
            body += "\n[truncated due to aggregate plugin context budget]";
            this.markDegraded(
              plugin,
              `prompt hook "${hook.name}" truncated due to aggregate plugin context budget`,
            );
            await this.eventLog.record(plugin.manifest.id, {
              level: "warn",
              category: "budget",
              message:
                `hook "${hook.name}" truncated from ${perHookSliced.length} to ${aggregateSliced.length} chars by aggregate budget`,
              details: {
                hook: hook.name,
                originalChars: perHookSliced.length,
                truncatedChars: aggregateSliced.length,
                budget: maxTotalChars,
              },
            });
          }

          const contribution =
            `<plugin_context source="${plugin.manifest.id}" hook="${hook.name}">\n${body}\n</plugin_context>`;
          contributions.push(contribution);
          remainingChars = Math.max(0, remainingChars - contribution.length);
          hookDetails.push({
            pluginId: plugin.manifest.id,
            hookName: hook.name,
            priority: hook.priority ?? 0,
            output: trimmedOutput,
            charsUsed: contribution.length,
            truncated: truncatedByAggregate,
            degraded: false,
            budgetSkipped: false,
            elapsedMs,
          });
        } else {
          // Hook returned empty/undefined — silent skip (not a failure).
          hookDetails.push({
            pluginId: plugin.manifest.id,
            hookName: hook.name,
            priority: hook.priority ?? 0,
            charsUsed: 0,
            truncated: false,
            degraded: false,
            budgetSkipped: false,
            elapsedMs,
          });
        }
      } catch (error) {
        const elapsedMs = Math.round(performance.now() - startedAt);
        plugin.status.degraded = true;
        plugin.status.lastError = safeError(error);
        console.error(
          `[Plugins] Prompt hook ${plugin.manifest.id}/${hook.name} failed:`,
          error,
        );
        await this.eventLog.record(plugin.manifest.id, {
          level: "error",
          category: "hook",
          message: `hook "${hook.name}" failed: ${safeError(error)}`,
          details: { hook: hook.name },
        });
        const failureContribution =
          `<plugin_failure source="${plugin.manifest.id}">\nI could not access my ${plugin.manifest.name} integration during this turn. I should mention that naturally if it affects my response.\n</plugin_failure>`;
        contributions.push(failureContribution);
        hookDetails.push({
          pluginId: plugin.manifest.id,
          hookName: hook.name,
          priority: hook.priority ?? 0,
          charsUsed: failureContribution.length,
          truncated: false,
          degraded: true,
          budgetSkipped: false,
          elapsedMs,
        });
      } finally {
        if (timeoutId !== undefined) clearTimeout(timeoutId);
      }
    }
    // Record how much of the aggregate cap was actually consumed so the
    // entity loop can surface it in LLMContextSnapshot.metrics. The used
    // value is the length of the joined string that flows into the system
    // message — includes wrappers, separators, and `<plugin_failure>`
    // fallbacks. May exceed maxTotalChars slightly because failure fallbacks
    // are intentionally not counted against the budget (they're small and
    // important for the entity to see).
    const result = contributions.length > 0
      ? contributions.join("\n\n")
      : undefined;
    this.lastBudgetCapChars = maxTotalChars;
    this.lastBudgetUsedChars = result?.length ?? 0;
    return { content: result, hooks: hookDetails };
  }

  /**
   * Last turn's plugin context budget accounting, or undefined if no turn
   * has run yet (e.g., no plugin manager, or buildPromptContent hasn't been
   * called). The entity loop reads this to populate
   * LLMContextSnapshot.metrics.{pluginBudgetUsed, pluginBudgetMax}.
   */
  getLastBudgetReport(): { used: number; cap: number } | undefined {
    if (
      this.lastBudgetUsedChars === undefined ||
      this.lastBudgetCapChars === undefined
    ) {
      return undefined;
    }
    return { used: this.lastBudgetUsedChars, cap: this.lastBudgetCapChars };
  }

  /**
   * Mark a plugin degraded and append a warning to its status, deduped so a
   * sustained budget-pressure condition doesn't balloon the warnings array.
   */
  private markDegraded(plugin: LoadedPlugin, warning: string): void {
    plugin.status.degraded = true;
    if (!plugin.status.warnings) plugin.status.warnings = [];
    if (!plugin.status.warnings.includes(warning)) {
      plugin.status.warnings.push(warning);
    }
  }

  async handleApiRoute(
    pluginId: string,
    subpath: string,
    request: Request,
  ): Promise<Response> {
    const plugin = this.plugins.find((item) => item.manifest.id === pluginId);
    if (!plugin) return new Response("Not Found", { status: 404 });

    // For disabled-but-configurable plugins, one-shot import the entrypoint
    // so settings routes are available before the plugin is enabled.
    // Operators need to configure credentials BEFORE enabling, which means
    // the settings form's POST handlers must work while the plugin is inactive.
    if (!plugin.module) {
      if (!plugin.manifest.entrypoints?.psycheros) {
        return new Response("Not Found", { status: 404 });
      }
      try {
        const resolved = validatePluginRelativePath(
          plugin.manifest.entrypoints.psycheros,
        );
        const imported = await import(
          toFileUrl(join(plugin.directory, resolved)).href
        );
        plugin.module = (imported.default ?? imported) as PsycherosPluginModule;
      } catch (error) {
        console.error(
          `[Plugins] Failed to one-shot import ${pluginId} for route dispatch:`,
          error,
        );
        return new Response("Internal Server Error", { status: 500 });
      }
    }

    const method = request.method.toUpperCase();
    const route = plugin.module?.routes?.find((item) =>
      (item.method?.toUpperCase() ?? "GET") === method &&
      item.path === subpath
    );
    return route
      ? await route.handler(request, this.services(plugin))
      : new Response("Not Found", { status: 404 });
  }

  async serveAsset(pluginId: string, relativePath: string): Promise<Response> {
    const plugin = this.plugins.find((item) =>
      item.manifest.id === pluginId && item.status.active
    );
    if (!plugin) return new Response("Not Found", { status: 404 });
    let safePath: string;
    try {
      safePath = validatePluginRelativePath(`./${relativePath}`);
    } catch {
      return new Response("Forbidden", { status: 403 });
    }
    const root = normalize(plugin.directory);
    const filePath = normalize(join(root, safePath));
    if (!filePath.startsWith(root + "\\") && !filePath.startsWith(root + "/")) {
      return new Response("Forbidden", { status: 403 });
    }
    try {
      return new Response(await Deno.readFile(filePath), {
        headers: {
          "Content-Type": getMimeType(filePath),
          "Cache-Control": "no-cache",
        },
      });
    } catch (error) {
      return error instanceof Deno.errors.NotFound
        ? new Response("Not Found", { status: 404 })
        : new Response(`Failed to read ${basename(filePath)}`, { status: 500 });
    }
  }
}

export function createPluginManager(
  pluginRoot: string,
  getLlm: () => LLMClient,
  bundledRoot?: string,
  dataRoot?: string,
): PluginManager {
  return new PluginManager(pluginRoot, getLlm, bundledRoot, dataRoot);
}
