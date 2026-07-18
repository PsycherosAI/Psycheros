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
  type PluginEnv,
  type PluginManifest,
  type PluginStatus,
  validatePluginManifest,
  validatePluginRelativePath,
} from "../../../plugin-api/src/mod.ts";
import type { Tool } from "../tools/mod.ts";
import type { MCPClient } from "../mcp-client/mod.ts";
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
  completeWorker: (prompt: string, systemPrompt?: string) => Promise<string>;
}

export interface PsycherosPluginServices {
  statePath: string;
  env: PluginEnv;
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

interface PsycherosPluginModule {
  tools?: Tool[];
  promptHooks?: PluginPromptHook[];
  routes?: PluginRoute[];
  start?: (services: PsycherosPluginServices) => void | Promise<void>;
  stop?: (services: PsycherosPluginServices) => void | Promise<void>;
}

interface LoadedPlugin {
  directory: string;
  manifest: PluginManifest;
  module?: PsycherosPluginModule;
  appliedEnv?: AppliedPluginEnv;
  status: PluginStatus;
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
  ) {
    this.eventLog = new PluginEventLogRegistry(
      join(pluginRoot, "..", "plugin-logs"),
    );
  }

  private services(plugin: LoadedPlugin): PsycherosPluginServices {
    return {
      statePath: join(plugin.directory, "state"),
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
    };
  }

  async load(): Promise<void> {
    await this.stop();
    this.plugins = [];
    let entries: Deno.DirEntry[];
    try {
      entries = Array.from(Deno.readDirSync(this.pluginRoot));
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return;
      throw error;
    }

    // === DISCOVER: read every plugin.json, validate, build LoadedPlugin
    // entries with active=false. Don't load entrypoints yet — we need the
    // full manifest set first so dependency resolution can see it.
    const discovered: LoadedPlugin[] = [];
    for (const entry of entries.filter((item) => item.isDirectory)) {
      const directory = join(this.pluginRoot, entry.name);
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
        };
        discovered.push({ directory, manifest, status });
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
          },
        });
      }
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
        appliedEnv = await applyPluginEnv(this.pluginRoot, plugin.manifest.id);
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
        plugin.status.capabilities.tools = module.tools?.length ?? 0;
        plugin.status.capabilities.promptHooks = module.promptHooks?.length ??
          0;
        plugin.status.capabilities.routes = module.routes?.length ?? 0;
        plugin.status.active = true;
        await module.start?.(this.services(plugin));
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
  ): Promise<string | undefined> {
    const maxTotalChars = options?.maxTotalChars ??
      DEFAULT_PROMPT_HOOK_AGGREGATE_MAX_CHARS;
    const contributions: string[] = [];
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
        }
      } catch (error) {
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
        contributions.push(
          `<plugin_failure source="${plugin.manifest.id}">\nI could not access my ${plugin.manifest.name} integration during this turn. I should mention that naturally if it affects my response.\n</plugin_failure>`,
        );
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
    return result;
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
    const plugin = this.plugins.find((item) =>
      item.manifest.id === pluginId && item.status.active
    );
    if (!plugin) return new Response("Not Found", { status: 404 });
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
): PluginManager {
  return new PluginManager(pluginRoot, getLlm);
}
