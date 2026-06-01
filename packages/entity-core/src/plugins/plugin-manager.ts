/**
 * Trusted local plugin harness for my canonical core.
 */

import { join, toFileUrl } from "@std/path";
import {
  type AppliedPluginEnv,
  applyPluginEnv,
  emptyPluginCapabilityCounts,
  type PluginEnv,
  type PluginManifest,
  type PluginStatus,
  validatePluginManifest,
  validatePluginRelativePath,
} from "../../../plugin-api/src/mod.ts";
import type { FileStore } from "../storage/mod.ts";
import type { GraphStore } from "../graph/mod.ts";
import type { EmbeddingCache } from "../embeddings/mod.ts";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { z } from "zod";

export interface EntityCorePluginServices {
  dataDir: string;
  statePath: string;
  env: PluginEnv;
  store: FileStore;
  graphStore: GraphStore;
  embeddingCache: EmbeddingCache;
  log: (...args: unknown[]) => void;
}

export interface EntityCorePluginTool {
  name: string;
  description: string;
  schema: Record<string, z.ZodTypeAny>;
  handler: (
    args: Record<string, unknown>,
    services: EntityCorePluginServices,
  ) => unknown | Promise<unknown>;
}

export interface EntityCoreResultDecorator {
  tool: string;
  name: string;
  priority?: number;
  decorate: (
    result: Record<string, unknown>,
    services: EntityCorePluginServices,
  ) => Record<string, unknown> | Promise<Record<string, unknown>>;
}

interface EntityCorePluginModule {
  tools?: EntityCorePluginTool[];
  resultDecorators?: EntityCoreResultDecorator[];
  start?: (services: EntityCorePluginServices) => void | Promise<void>;
  stop?: (services: EntityCorePluginServices) => void | Promise<void>;
}

interface LoadedPlugin {
  directory: string;
  manifest: PluginManifest;
  module?: EntityCorePluginModule;
  appliedEnv?: AppliedPluginEnv;
  status: PluginStatus;
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class EntityCorePluginManager {
  private plugins: LoadedPlugin[] = [];

  constructor(
    private pluginRoot: string,
    private baseServices: Omit<EntityCorePluginServices, "statePath" | "env">,
  ) {}

  private services(plugin: LoadedPlugin): EntityCorePluginServices {
    return {
      ...this.baseServices,
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
        const manifest = validatePluginManifest(
          JSON.parse(await Deno.readTextFile(join(directory, "plugin.json"))),
          entry.name,
        );
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
          capabilities: emptyPluginCapabilityCounts(),
        };
        const loaded: LoadedPlugin = { directory, manifest, status };
        this.plugins.push(loaded);
        if (!manifest.enabled || !manifest.entrypoints?.entityCore) continue;
        appliedEnv = await applyPluginEnv(this.pluginRoot, manifest.id);
        loaded.appliedEnv = appliedEnv;
        const entrypoint = validatePluginRelativePath(
          manifest.entrypoints.entityCore,
        );
        const imported = await import(
          toFileUrl(join(directory, entrypoint)).href
        );
        loaded.module =
          (imported.default ?? imported) as EntityCorePluginModule;
        status.capabilities.tools = loaded.module.tools?.length ?? 0;
        status.capabilities.resultDecorators =
          loaded.module.resultDecorators?.length ?? 0;
        status.active = true;
        await loaded.module.start?.(this.services(loaded));
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

  getTools(): Array<{
    plugin: LoadedPlugin;
    tool: EntityCorePluginTool;
  }> {
    return this.plugins.flatMap((plugin) =>
      (plugin.module?.tools ?? []).map((tool) => ({ plugin, tool }))
    );
  }

  async decorate(
    toolName: string,
    input: unknown,
  ): Promise<Record<string, unknown>> {
    const result: Record<string, unknown> =
      input && typeof input === "object" && !Array.isArray(input)
        ? { ...input as Record<string, unknown> }
        : { result: input };
    const failures: Array<{ plugin: string; decorator: string }> = [];
    const decorators = this.plugins.flatMap((plugin) =>
      (plugin.module?.resultDecorators ?? [])
        .filter((decorator) => decorator.tool === toolName)
        .map((decorator) => ({ plugin, decorator }))
    ).sort((a, b) =>
      (a.decorator.priority ?? 0) - (b.decorator.priority ?? 0) ||
      a.plugin.manifest.id.localeCompare(b.plugin.manifest.id) ||
      a.decorator.name.localeCompare(b.decorator.name)
    );

    for (const { plugin, decorator } of decorators) {
      try {
        const addition = await decorator.decorate(
          { ...result },
          this.services(plugin),
        );
        for (const [key, value] of Object.entries(addition)) {
          if (key in result) throw new Error(`field collision: ${key}`);
          result[key] = value;
        }
      } catch (error) {
        plugin.status.degraded = true;
        plugin.status.lastError = safeError(error);
        failures.push({
          plugin: plugin.manifest.id,
          decorator: decorator.name,
        });
        console.error(
          `[Plugins] Decorator ${plugin.manifest.id}/${decorator.name} failed:`,
          error,
        );
      }
    }
    if (failures.length > 0) result.plugin_failures = failures;
    return result;
  }

  registerTools(server: McpServer): void {
    for (const { plugin, tool } of this.getTools()) {
      server.tool(tool.name, tool.description, tool.schema, async (args) => ({
        content: [{
          type: "text" as const,
          text: JSON.stringify(
            await this.decorate(
              tool.name,
              await tool.handler(args, this.services(plugin)),
            ),
            null,
            2,
          ),
        }],
      }));
    }
  }
}

export function createEntityCorePluginManager(
  pluginRoot: string,
  services: Omit<EntityCorePluginServices, "statePath" | "env">,
): EntityCorePluginManager {
  return new EntityCorePluginManager(pluginRoot, services);
}
