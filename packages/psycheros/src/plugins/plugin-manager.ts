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

  constructor(
    private pluginRoot: string,
    private getLlm: () => LLMClient,
  ) {}

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

    for (const entry of entries.filter((item) => item.isDirectory)) {
      const directory = join(this.pluginRoot, entry.name);
      let appliedEnv: AppliedPluginEnv | undefined;
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
          enabled: manifest.enabled,
          active: false,
          degraded: false,
          restartRequired: false,
          entrypoints: {
            psycheros: !!manifest.entrypoints?.psycheros,
            entityCore: !!manifest.entrypoints?.entityCore,
          },
          capabilities,
        };
        const loaded: LoadedPlugin = { directory, manifest, status };
        this.plugins.push(loaded);
        if (!manifest.enabled || !manifest.entrypoints?.psycheros) continue;

        appliedEnv = await applyPluginEnv(this.pluginRoot, manifest.id);
        loaded.appliedEnv = appliedEnv;
        const entrypoint = validatePluginRelativePath(
          manifest.entrypoints.psycheros,
        );
        const imported = await import(
          toFileUrl(join(directory, entrypoint)).href
        );
        const module = (imported.default ?? imported) as PsycherosPluginModule;
        loaded.module = module;
        status.capabilities.tools = module.tools?.length ?? 0;
        status.capabilities.promptHooks = module.promptHooks?.length ?? 0;
        status.capabilities.routes = module.routes?.length ?? 0;
        status.active = true;
        await module.start?.(this.services(loaded));
      } catch (error) {
        appliedEnv?.restore();
        console.error(`[Plugins] Failed to load ${entry.name}:`, error);
        this.plugins = this.plugins.filter((plugin) =>
          plugin.manifest.id !== entry.name
        );
        this.plugins.push({
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
            entrypoints: { psycheros: false, entityCore: false },
            capabilities: emptyPluginCapabilityCounts(),
            lastError: safeError(error),
          },
        });
      }
    }
    this.plugins.sort((a, b) => a.manifest.id.localeCompare(b.manifest.id));
  }

  async stop(): Promise<void> {
    for (const plugin of [...this.plugins].reverse()) {
      try {
        await plugin.module?.stop?.(this.services(plugin));
      } catch (error) {
        console.error(`[Plugins] Failed to stop ${plugin.manifest.id}:`, error);
      } finally {
        plugin.appliedEnv?.restore();
        plugin.appliedEnv = undefined;
      }
    }
  }

  getStatuses(): PluginStatus[] {
    return this.plugins.map((plugin) => ({ ...plugin.status }));
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

  async buildPromptContent(
    context: Omit<PluginPromptContext, "statePath" | "env" | "completeWorker">,
  ): Promise<string | undefined> {
    const contributions: string[] = [];
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
      const maxChars = hook.maxChars ??
        plugin.manifest.promptHookDefaults?.maxChars ??
        DEFAULT_PROMPT_HOOK_MAX_CHARS;
      let timeoutId: number | undefined;
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
          contributions.push(
            `<plugin_context source="${plugin.manifest.id}" hook="${hook.name}">\n${
              output.trim().slice(0, maxChars)
            }\n</plugin_context>`,
          );
        }
      } catch (error) {
        plugin.status.degraded = true;
        plugin.status.lastError = safeError(error);
        console.error(
          `[Plugins] Prompt hook ${plugin.manifest.id}/${hook.name} failed:`,
          error,
        );
        contributions.push(
          `<plugin_failure source="${plugin.manifest.id}">\nI could not access my ${plugin.manifest.name} integration during this turn. I should mention that naturally if it affects my response.\n</plugin_failure>`,
        );
      } finally {
        if (timeoutId !== undefined) clearTimeout(timeoutId);
      }
    }
    return contributions.length > 0 ? contributions.join("\n\n") : undefined;
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
