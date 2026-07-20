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
  /** Repository-relative directory containing this plugin's plugin.json. */
  packagePath?: string;
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
  /**
   * Env var names from the plugin's secret file that were refused because they
   * matched the denylist (process-global runtime, TLS, proxy, or host-owned
   * namespace vars). Empty when nothing was refused. The host typically
   * surfaces these in PluginStatus.warnings so the operator can see them.
   */
  readonly skippedEnvVars: readonly string[];
}

/**
 * Env var names a plugin may not set, because setting them affects more than
 * the plugin itself. These either redirect all outbound process traffic,
 * override TLS trust, inject native code, mutate process identity, or
 * reconfigure the host runtime. A plugin that genuinely needs one of these
 * should document the requirement and let the operator set it at the daemon
 * level instead.
 *
 * Lowercase proxy variants are included because some libraries read them in
 * addition to the uppercase form.
 */
const PLUGIN_ENV_DENYLIST = new Set<string>([
  // Outbound traffic redirection — affects every fetch() in the process,
  // including the LLM client, MCP client, and auto-updater.
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "all_proxy",
  // TLS trust store override — could let a malicious proxy MITM HTTPS.
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "REQUESTS_CA_BUNDLE",
  "CURL_CA_BUNDLE",
  "NODE_EXTRA_CA_CERTS",
  "NODE_TLS_REJECT_UNAUTHORIZED",
  // Native code injection (Linux/macOS dynamic linker).
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "DYLD_INSERT_LIBRARIES",
  "DYLD_LIBRARY_PATH",
  "DYLD_FALLBACK_LIBRARY_PATH",
  // Process identity / lookup — changing these breaks the host's own
  // file resolution, expansion of ~/, and shell execution.
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "PWD",
  // Node-compat runtime behavior.
  "NODE_OPTIONS",
  "NODE_PATH",
  // Deno runtime behavior — module resolution, registry auth, reload flags.
  "DENO_DIR",
  "DENO_CONFIG_PATH",
  "DENO_INSTALL_ROOT",
  "DENO_RELOAD",
  "DENO_AUTH_TOKENS",
]);

/**
 * Returns true if a plugin-owned env file may not set the given var name.
 *
 * Exact-match names come from {@link PLUGIN_ENV_DENYLIST}. Prefix checks
 * reserve host-owned namespaces:
 *   - `PSYCHEROS_*` is host-owned; plugins use `PSYCHEROS_PLUGIN_<ID>_*`.
 *   - `ENTITY_CORE_*` is the canonical identity server's own namespace.
 */
export function isDeniedPluginEnvVar(name: string): boolean {
  if (PLUGIN_ENV_DENYLIST.has(name)) return true;
  if (name.startsWith("PSYCHEROS_") && !name.startsWith("PSYCHEROS_PLUGIN_")) {
    return true;
  }
  if (name.startsWith("ENTITY_CORE_")) return true;
  return false;
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
  const packagePath = optionalString(
    input.packagePath ?? input.package_path,
    "update.packagePath",
  );
  return {
    repoUrl: optionalString(input.repoUrl ?? input.repo_url, "update.repoUrl"),
    tagPrefix: optionalString(
      input.tagPrefix ?? input.tag_prefix,
      "update.tagPrefix",
    ),
    packagePath: packagePath === undefined
      ? undefined
      : validatePluginPackagePath(packagePath),
  };
}

/**
 * Validate a repository-relative directory used to locate a plugin package.
 *
 * Repository paths always use forward slashes and never include `.` or `..`
 * segments. Omitting update.packagePath means the repository root.
 */
export function validatePluginPackagePath(path: string): string {
  requireString(path, "update.packagePath");
  const trimmed = path.trim();
  if (
    trimmed.includes("\\") || trimmed.startsWith("/") ||
    /^[A-Za-z]:/.test(trimmed) || trimmed.includes("\0") ||
    trimmed.includes("//")
  ) {
    throw new Error(
      `update.packagePath must be a repository-relative path: ${path}`,
    );
  }
  const parts = trimmed.split("/");
  if (
    parts.length === 0 ||
    parts.some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error(
      `update.packagePath must be a repository-relative path: ${path}`,
    );
  }
  return parts.join("/");
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
  const skippedEnvVars: string[] = [];
  for (const [name, value] of Object.entries(values)) {
    if (isDeniedPluginEnvVar(name)) {
      skippedEnvVars.push(name);
      console.warn(
        `[Plugins] Refused to set denied env var "${name}" for plugin "${pluginId}". ` +
          `This name is process-global or host-owned; if the plugin genuinely needs it, ` +
          `the operator should set it at the daemon level.`,
      );
      continue;
    }
    previous.set(name, Deno.env.get(name));
    Deno.env.set(name, value);
  }

  return {
    env: createPluginEnv(),
    skippedEnvVars,
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
