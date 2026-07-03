/**
 * Shared plugin contract for my Psycheros hosts.
 */

import { basename, extname, isAbsolute, join, normalize } from "@std/path";
import { parse } from "@std/dotenv";

export const PLUGIN_API_VERSION = 1;
export const DEFAULT_PROMPT_HOOK_TIMEOUT_MS = 15_000;
export const DEFAULT_PROMPT_HOOK_MAX_CHARS = 12_000;

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  apiVersion: number;
  description?: string;
  homepageUrl?: string;
  enabled: boolean;
  compatibility?: PluginCompatibility;
  update?: PluginUpdateMetadata;
  dependencies?: Record<string, string>;
  entrypoints?: {
    psycheros?: string;
    entityCore?: string;
  };
  browser?: {
    scripts?: string[];
    styles?: string[];
  };
  promptHookDefaults?: {
    timeoutMs?: number;
    maxChars?: number;
  };
}

export interface PluginCompatibility {
  psycheros?: string;
  entityCore?: string;
  launcher?: string;
}

export interface PluginUpdateMetadata {
  repoUrl?: string;
  tagPrefix?: string;
}

export interface PluginCapabilityCounts {
  tools: number;
  promptHooks: number;
  routes: number;
  resultDecorators: number;
  browserScripts: number;
  browserStyles: number;
}

export type PluginPendingAction = "install" | "remove";

export interface PluginStatus {
  id: string;
  name: string;
  version: string;
  description?: string;
  homepageUrl?: string;
  enabled: boolean;
  active: boolean;
  degraded: boolean;
  restartRequired: boolean;
  compatibility?: PluginCompatibility;
  update?: PluginUpdateMetadata;
  dependencies?: Record<string, string>;
  warnings?: string[];
  pendingAction?: PluginPendingAction;
  entrypoints: {
    psycheros: boolean;
    entityCore: boolean;
  };
  capabilities: PluginCapabilityCounts;
  lastError?: string;
}

export interface DiscoveredPlugin {
  directory: string;
  manifest: PluginManifest;
}

export interface PluginEnv {
  get(name: string): string | undefined;
  has(name: string): boolean;
  require(name: string): string;
}

export interface AppliedPluginEnv {
  env: PluginEnv;
  restore(): void;
}

function requireString(
  value: unknown,
  field: string,
): asserts value is string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field} must be a non-empty string`);
  }
}

function optionalString(
  value: unknown,
  field: string,
): string | undefined {
  if (value === undefined) return undefined;
  requireString(value, field);
  return value;
}

function validateStringRecord(
  value: unknown,
  field: string,
): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  const record: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    requireString(item, `${field}.${key}`);
    record[key] = item;
  }
  return record;
}

function validateCompatibility(
  value: unknown,
): PluginCompatibility | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("compatibility must be an object");
  }
  const input = value as Record<string, unknown>;
  return {
    psycheros: optionalString(input.psycheros, "compatibility.psycheros"),
    entityCore: optionalString(
      input.entityCore ?? input.entity_core,
      "compatibility.entityCore",
    ),
    launcher: optionalString(input.launcher, "compatibility.launcher"),
  };
}

function validateUpdateMetadata(
  value: unknown,
): PluginUpdateMetadata | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("update must be an object");
  }
  const input = value as Record<string, unknown>;
  return {
    repoUrl: optionalString(input.repoUrl ?? input.repo_url, "update.repoUrl"),
    tagPrefix: optionalString(
      input.tagPrefix ?? input.tag_prefix,
      "update.tagPrefix",
    ),
  };
}

export function isSafePluginId(id: string): boolean {
  return /^[a-z0-9][a-z0-9._-]*$/.test(id);
}

/**
 * Validate a path declared by a plugin manifest.
 *
 * Manifest paths are always relative to the plugin directory. Requiring a
 * leading "./" keeps the boundary around my plugin directory visible during
 * review.
 */
export function validatePluginRelativePath(path: string): string {
  requireString(path, "plugin path");
  if (!path.startsWith("./") || isAbsolute(path)) {
    throw new Error(`plugin path must start with "./": ${path}`);
  }
  const normalized = normalize(path.replace(/\\/g, "/")).replace(/\\/g, "/");
  if (
    normalized === ".." || normalized.startsWith("../") ||
    normalized.includes("/../")
  ) {
    throw new Error(`plugin path escapes its directory: ${path}`);
  }
  return normalized.startsWith("./") ? normalized.slice(2) : normalized;
}

export function validatePluginManifest(
  raw: unknown,
  directoryName: string,
): PluginManifest {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("plugin.json must contain an object");
  }
  const input = raw as Record<string, unknown>;
  requireString(input.id, "id");
  requireString(input.name, "name");
  requireString(input.version, "version");
  if (!isSafePluginId(input.id)) {
    throw new Error(`id contains unsupported characters: ${input.id}`);
  }
  if (input.id !== directoryName) {
    throw new Error(`id must match directory name "${directoryName}"`);
  }
  if (input.apiVersion !== PLUGIN_API_VERSION) {
    throw new Error(`unsupported apiVersion: ${String(input.apiVersion)}`);
  }

  const entrypoints = input.entrypoints as
    | Record<string, unknown>
    | undefined;
  const browser = input.browser as Record<string, unknown> | undefined;
  const promptDefaults = input.promptHookDefaults as
    | Record<string, unknown>
    | undefined;
  const validateOptionalPath = (value: unknown): string | undefined => {
    if (value === undefined) return undefined;
    return `./${validatePluginRelativePath(String(value))}`;
  };
  const validateOptionalEntrypoint = (value: unknown): string | undefined => {
    const path = validateOptionalPath(value);
    if (
      path !== undefined && extname(path).toLowerCase() !== ".ts" &&
      extname(path).toLowerCase() !== ".js"
    ) {
      throw new Error(`plugin entrypoint must use .ts or .js: ${path}`);
    }
    return path;
  };
  const validatePathArray = (value: unknown): string[] | undefined => {
    if (value === undefined) return undefined;
    if (!Array.isArray(value)) throw new Error("browser paths must be arrays");
    return value.map((path) => `./${validatePluginRelativePath(String(path))}`);
  };
  const validatePositiveNumber = (
    value: unknown,
    field: string,
  ): number | undefined => {
    if (value === undefined) return undefined;
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
      throw new Error(`${field} must be a positive number`);
    }
    return value;
  };

  return {
    id: input.id,
    name: input.name,
    version: input.version,
    apiVersion: input.apiVersion,
    description: optionalString(input.description, "description"),
    homepageUrl: optionalString(
      input.homepageUrl ?? input.homepage_url,
      "homepageUrl",
    ),
    enabled: input.enabled === undefined ? true : input.enabled === true,
    compatibility: validateCompatibility(input.compatibility),
    update: validateUpdateMetadata(input.update),
    dependencies: validateStringRecord(input.dependencies, "dependencies"),
    entrypoints: entrypoints
      ? {
        psycheros: validateOptionalEntrypoint(entrypoints.psycheros),
        entityCore: validateOptionalEntrypoint(entrypoints.entityCore),
      }
      : undefined,
    browser: browser
      ? {
        scripts: validatePathArray(browser.scripts),
        styles: validatePathArray(browser.styles),
      }
      : undefined,
    promptHookDefaults: promptDefaults
      ? {
        timeoutMs: validatePositiveNumber(
          promptDefaults.timeoutMs,
          "promptHookDefaults.timeoutMs",
        ),
        maxChars: validatePositiveNumber(
          promptDefaults.maxChars,
          "promptHookDefaults.maxChars",
        ),
      }
      : undefined,
  };
}

export function emptyPluginCapabilityCounts(): PluginCapabilityCounts {
  return {
    tools: 0,
    promptHooks: 0,
    routes: 0,
    resultDecorators: 0,
    browserScripts: 0,
    browserStyles: 0,
  };
}

/**
 * Apply a plugin-owned environment file for the lifetime of one host load.
 *
 * My secrets live outside the executable plugin tree so my portable plugin
 * backups do not include credentials. I should use namespaced variables
 * because my trusted plugins share one process environment.
 */
export async function applyPluginEnv(
  pluginRoot: string,
  pluginId: string,
): Promise<AppliedPluginEnv> {
  const values = await readPluginEnv(pluginRoot, pluginId);
  const previous = new Map<string, string | undefined>();
  for (const [name, value] of Object.entries(values)) {
    previous.set(name, Deno.env.get(name));
    Deno.env.set(name, value);
  }

  return {
    env: createPluginEnv(),
    restore() {
      for (const [name, value] of previous) {
        if (value === undefined) Deno.env.delete(name);
        else Deno.env.set(name, value);
      }
    },
  };
}

export function getPluginEnvPath(pluginRoot: string, pluginId: string): string {
  if (!isSafePluginId(pluginId)) {
    throw new Error(`invalid plugin id: ${pluginId}`);
  }
  return join(pluginRoot, "..", "plugin-secrets", `${pluginId}.env`);
}

export async function readPluginEnv(
  pluginRoot: string,
  pluginId: string,
): Promise<Record<string, string>> {
  try {
    return parse(
      await Deno.readTextFile(getPluginEnvPath(pluginRoot, pluginId)),
    );
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return {};
    throw error;
  }
}

export function createPluginEnv(): PluginEnv {
  return {
    get: (name) => Deno.env.get(name),
    has: (name) => Deno.env.has(name),
    require(name) {
      const value = Deno.env.get(name);
      if (!value) {
        throw new Error(`missing required plugin environment: ${name}`);
      }
      return value;
    },
  };
}

/**
 * Identify conventional credential files that should never enter my portable
 * plugin archives. My plugin state may still contain sensitive provider data,
 * so I should keep credentials in the supported plugin-secrets directory.
 */
export function isPluginSecretFilename(path: string): boolean {
  const name = path.replace(/\\/g, "/").split("/").pop()?.toLowerCase() ?? "";
  return name === ".env" || name.endsWith(".env") ||
    name === "secrets.json" || name === ".secrets.json";
}

/**
 * Validate my manually installed plugin directory before my next restart.
 */
export async function validatePluginDirectory(
  directory: string,
): Promise<PluginManifest> {
  const manifest = validatePluginManifest(
    JSON.parse(await Deno.readTextFile(join(directory, "plugin.json"))),
    basename(normalize(directory)),
  );
  const paths = [
    manifest.entrypoints?.psycheros,
    manifest.entrypoints?.entityCore,
    ...(manifest.browser?.scripts ?? []),
    ...(manifest.browser?.styles ?? []),
  ].filter((path): path is string => path !== undefined);
  for (const path of paths) {
    const stat = await Deno.stat(
      join(directory, validatePluginRelativePath(path)),
    );
    if (!stat.isFile) throw new Error(`plugin path is not a file: ${path}`);
  }
  return manifest;
}
