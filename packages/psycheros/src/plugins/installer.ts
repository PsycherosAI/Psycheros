/**
 * Install, stage, and remove my trusted local plugins.
 */

import JSZip from "jszip";
import { ensureDir } from "@std/fs";
import { basename, dirname, isAbsolute, join, relative } from "@std/path";
import { VERSION_BASE as PSYCHEROS_VERSION } from "../version.ts";
import entityCoreDeno from "../../../entity-core/deno.json" with {
  type: "json",
};
import {
  emptyPluginCapabilityCounts,
  isPluginSecretFilename,
  isSafePluginId,
  type PluginCapabilityCounts,
  type PluginManifest,
  type PluginStatus,
  validatePluginDirectory,
  validatePluginManifest,
} from "../../../plugin-api/src/mod.ts";

export type PluginInstallSource =
  | { type: "zip"; fileName?: string }
  | { type: "git"; repoUrl: string; ref?: string };

export interface PluginInstallExisting {
  name: string;
  version: string;
  /**
   * Manifest-declared browser asset counts in the existing install. Used by
   * the install-review UI to render a `old → new` diff. Tools/hooks/routes
   * aren't included — getting those requires importing the entrypoint,
   * which is too heavy for an inspect call. The UI documents this limit.
   */
  browserScripts?: number;
  browserStyles?: number;
  /** Manifest-declared dependencies in the existing install, for diffing. */
  dependencies?: Record<string, string>;
}

export interface PluginInstallPreview {
  draftId: string;
  manifest: PluginManifest;
  source: PluginInstallSource;
  capabilities: PluginCapabilityCounts;
  compatibilityWarnings: string[];
  warnings: string[];
  dependencies: Record<string, string>;
  existing?: PluginInstallExisting;
  restartRequired: true;
}

export interface PluginDraftInstallResult {
  success: true;
  pluginId: string;
  backupPath?: string;
  restartRequired: true;
}

export interface PluginRemoveResult {
  success: true;
  pluginId: string;
  backupPath: string;
  secretsPath: string;
  restartRequired: true;
}

export interface UnmanagedCustomTool {
  filename: string;
}

interface DraftMetadata {
  manifest: PluginManifest;
  source: PluginInstallSource;
}

interface InstalledManifest {
  manifest: PluginManifest;
  warnings: string[];
}

export class PluginInstallerError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
    this.name = "PluginInstallerError";
  }
}

const DRAFT_META_FILE = ".draft.json";
const ENTITY_CORE_VERSION = String(entityCoreDeno.version);

function fail(message: string, status = 400): never {
  throw new PluginInstallerError(message, status);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isSafeDraftId(id: string): boolean {
  return /^[a-z0-9][a-z0-9_-]{7,80}$/.test(id);
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

async function removeIfExists(path: string): Promise<void> {
  try {
    await Deno.remove(path, { recursive: true });
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
}

function assertInside(root: string, path: string): void {
  const rel = relative(root, path);
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) return;
  fail("A plugin path that would escape the plugin directory was blocked.");
}

function timestampForBackup(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function normalizeArchivePath(path: string): string {
  const cleaned = path.replace(/\\/g, "/");
  if (
    !cleaned || cleaned.includes("\0") || cleaned.startsWith("/") ||
    /^[A-Za-z]:/.test(cleaned) || cleaned.includes("//")
  ) {
    fail(`Unsafe plugin archive path blocked: ${path}`);
  }
  const parts = cleaned.split("/").filter((part) => part.length > 0);
  if (
    parts.length === 0 ||
    parts.some((part) => part === "." || part === "..")
  ) {
    fail(`Unsafe plugin archive path blocked: ${path}`);
  }
  return parts.join("/");
}

function detectWrapperPrefix(paths: string[]): string | null {
  if (paths.includes("plugin.json")) return null;
  const roots = new Set(paths.map((path) => path.split("/")[0]));
  if (roots.size !== 1) return null;
  const [root] = roots;
  const prefix = `${root}/`;
  return paths.includes(`${prefix}plugin.json`) ? prefix : null;
}

function readManifestCandidate(raw: string): PluginManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    fail(`Could not parse plugin.json: ${safeError(error)}`);
  }
  const candidateId = isRecord(parsed) && typeof parsed.id === "string"
    ? parsed.id
    : "";
  return validatePluginManifest(parsed, candidateId);
}

function ensureInstallableSurface(manifest: PluginManifest): void {
  const hasSurface = !!manifest.entrypoints?.psycheros ||
    !!manifest.entrypoints?.entityCore ||
    (manifest.browser?.scripts?.length ?? 0) > 0 ||
    (manifest.browser?.styles?.length ?? 0) > 0;
  if (!hasSurface) {
    fail(
      "No Psycheros entrypoint, entity-core entrypoint, browser script, or browser stylesheet was found in this plugin manifest.",
    );
  }
}

function deriveDeclaredCapabilities(
  manifest: PluginManifest,
): PluginCapabilityCounts {
  return {
    ...emptyPluginCapabilityCounts(),
    browserScripts: manifest.browser?.scripts?.length ?? 0,
    browserStyles: manifest.browser?.styles?.length ?? 0,
  };
}

function parseVersion(version: string): number[] | null {
  const match = version.trim().match(/^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  if (!match) return null;
  return [
    Number(match[1]),
    Number(match[2] ?? "0"),
    Number(match[3] ?? "0"),
  ];
}

function compareVersions(actual: string, expected: string): number | null {
  const left = parseVersion(actual);
  const right = parseVersion(expected);
  if (!left || !right) return null;
  for (let i = 0; i < 3; i++) {
    if (left[i] > right[i]) return 1;
    if (left[i] < right[i]) return -1;
  }
  return 0;
}

function satisfiesComparator(
  actual: string,
  comparator: string,
): boolean | null {
  const match = comparator.match(/^(>=|<=|>|<|=)?\s*v?(\d+(?:\.\d+){0,2})$/);
  if (!match) return null;
  const comparison = compareVersions(actual, match[2]);
  if (comparison === null) return null;
  switch (match[1] ?? "=") {
    case ">=":
      return comparison >= 0;
    case "<=":
      return comparison <= 0;
    case ">":
      return comparison > 0;
    case "<":
      return comparison < 0;
    default:
      return comparison === 0;
  }
}

function satisfiesRange(actual: string, range: string): boolean | null {
  const comparators = range.trim().split(/\s+/).filter(Boolean);
  if (comparators.length === 0) return true;
  for (const comparator of comparators) {
    const satisfied = satisfiesComparator(actual, comparator);
    if (satisfied === null) return null;
    if (!satisfied) return false;
  }
  return true;
}

function compatibilityWarnings(manifest: PluginManifest): string[] {
  const compatibility = manifest.compatibility;
  if (!compatibility) return [];
  const checks: Array<[string, string, string | undefined]> = [
    ["Psycheros", PSYCHEROS_VERSION, compatibility.psycheros],
    ["entity-core", ENTITY_CORE_VERSION, compatibility.entityCore],
  ];
  const warnings: string[] = [];
  for (const [label, actual, range] of checks) {
    if (!range) continue;
    const satisfied = satisfiesRange(actual, range);
    if (satisfied === null) {
      warnings.push(
        `Could not verify this plugin's ${label} compatibility range (${range}) against ${actual}.`,
      );
    } else if (!satisfied) {
      warnings.push(
        `This installation is running ${label} ${actual}, but the plugin declares ${label} compatibility ${range}.`,
      );
    }
  }
  if (compatibility.launcher) {
    warnings.push(
      `This plugin declares launcher compatibility ${compatibility.launcher}, but launcher compatibility is not verified from inside Psycheros.`,
    );
  }
  return warnings;
}

function dependencyWarnings(manifest: PluginManifest): string[] {
  const dependencies = Object.keys(manifest.dependencies ?? {});
  if (dependencies.length === 0) return [];
  return [
    `This plugin declares dependencies, but dependency installation is not automatic yet: ${
      dependencies.join(", ")
    }.`,
  ];
}

function allWarnings(manifest: PluginManifest): string[] {
  return [
    ...compatibilityWarnings(manifest),
    ...dependencyWarnings(manifest),
  ];
}

function mergeWarnings(...groups: Array<string[] | undefined>): string[] {
  return [...new Set(groups.flatMap((group) => group ?? []))];
}

function statusFromManifest(
  manifest: PluginManifest,
  overrides: Partial<PluginStatus>,
): PluginStatus {
  return {
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
    warnings: allWarnings(manifest),
    entrypoints: {
      psycheros: !!manifest.entrypoints?.psycheros,
      entityCore: !!manifest.entrypoints?.entityCore,
    },
    capabilities: deriveDeclaredCapabilities(manifest),
    ...overrides,
  };
}

async function findConventionalSecretFiles(root: string): Promise<string[]> {
  const found: string[] = [];
  async function walk(directory: string): Promise<void> {
    for await (const entry of Deno.readDir(directory)) {
      const path = join(directory, entry.name);
      const rel = relative(root, path);
      if (entry.isDirectory) {
        await walk(path);
      } else if (entry.isFile && isPluginSecretFilename(rel)) {
        found.push(rel.replace(/\\/g, "/"));
      }
    }
  }
  await walk(root);
  return found;
}

function validateGitRef(ref: string): void {
  if (
    ref.startsWith("-") || ref.startsWith("/") || ref.includes("..") ||
    !/^[A-Za-z0-9._/-]+$/.test(ref)
  ) {
    fail("Only branch or tag names are accepted for plugin Git refs.");
  }
}

export class PluginInstaller {
  readonly pluginRoot: string;
  readonly stagingRoot: string;
  readonly backupRoot: string;
  readonly customToolsRoot: string;
  readonly secretsRoot: string;

  constructor(dataRoot: string) {
    this.pluginRoot = join(dataRoot, ".psycheros", "plugins");
    this.stagingRoot = join(dataRoot, ".psycheros", "plugin-staging");
    this.backupRoot = join(dataRoot, ".psycheros", "plugin-backups");
    this.customToolsRoot = join(dataRoot, ".psycheros", "custom-tools");
    this.secretsRoot = join(dataRoot, ".psycheros", "plugin-secrets");
  }

  async inspectZip(
    bytes: Uint8Array,
    fileName?: string,
  ): Promise<PluginInstallPreview> {
    const draftId = crypto.randomUUID();
    const draftRoot = join(this.stagingRoot, draftId);
    const unpackRoot = join(draftRoot, "package");
    await ensureDir(unpackRoot);
    try {
      const zip = await JSZip.loadAsync(bytes);
      await this.writeZipPackage(zip, unpackRoot);
      return await this.finalizeStagedPackage(draftId, unpackRoot, {
        type: "zip",
        fileName,
      });
    } catch (error) {
      await removeIfExists(draftRoot);
      if (error instanceof PluginInstallerError) throw error;
      fail(`Could not inspect this plugin zip: ${safeError(error)}`);
    }
  }

  async inspectGit(
    repoUrl: string,
    ref?: string,
  ): Promise<PluginInstallPreview> {
    const cleanRepoUrl = repoUrl.trim();
    const cleanRef = ref?.trim() || undefined;
    if (!cleanRepoUrl) fail("A Git repository URL is required.");
    if (cleanRepoUrl.startsWith("-")) {
      fail("That Git repository URL could not be used.");
    }
    if (cleanRef) validateGitRef(cleanRef);

    const draftId = crypto.randomUUID();
    const draftRoot = join(this.stagingRoot, draftId);
    const cloneRoot = join(draftRoot, "package");
    await ensureDir(draftRoot);
    const args = ["clone", "--depth", "1"];
    if (cleanRef) args.push("--branch", cleanRef);
    args.push("--", cleanRepoUrl, cloneRoot);
    try {
      const result = await new Deno.Command("git", {
        args,
        stdout: "piped",
        stderr: "piped",
      }).output();
      if (!result.success) {
        const stderr = new TextDecoder().decode(result.stderr).trim();
        fail(stderr || "Could not clone that plugin repository.");
      }
      return await this.finalizeStagedPackage(draftId, cloneRoot, {
        type: "git",
        repoUrl: cleanRepoUrl,
        ref: cleanRef,
      });
    } catch (error) {
      await removeIfExists(draftRoot);
      if (error instanceof PluginInstallerError) throw error;
      if (error instanceof Deno.errors.NotFound) {
        fail(
          "Git was not found on PATH. Plugin zip install is still available.",
          503,
        );
      }
      fail(`Could not inspect that plugin repository: ${safeError(error)}`);
    }
  }

  async installDraft(draftId: string): Promise<PluginDraftInstallResult> {
    const draftRoot = this.resolveDraftRoot(draftId);
    const metadata = await this.readDraftMetadata(draftRoot);
    const packageRoot = join(draftRoot, metadata.manifest.id);
    const manifest = await validatePluginDirectory(packageRoot);
    ensureInstallableSurface(manifest);
    await ensureDir(this.pluginRoot);

    const installedPath = join(this.pluginRoot, manifest.id);
    let backupPath: string | undefined;
    if (await exists(installedPath)) {
      backupPath = await this.nextBackupPath(manifest.id);
      await Deno.rename(installedPath, backupPath);
    }

    try {
      await Deno.rename(packageRoot, installedPath);
    } catch (error) {
      if (backupPath) {
        await Deno.rename(backupPath, installedPath);
      }
      throw error;
    } finally {
      await removeIfExists(draftRoot);
    }

    return {
      success: true,
      pluginId: manifest.id,
      backupPath,
      restartRequired: true,
    };
  }

  async removePlugin(id: string): Promise<PluginRemoveResult> {
    if (!isSafePluginId(id)) fail(`Invalid plugin id could not be removed.`);
    const installedPath = join(this.pluginRoot, id);
    if (!(await exists(installedPath))) {
      fail("That installed plugin was not found.", 404);
    }
    const backupPath = await this.nextBackupPath(id);
    await Deno.rename(installedPath, backupPath);
    return {
      success: true,
      pluginId: id,
      backupPath,
      secretsPath: join(this.secretsRoot, `${id}.env`),
      restartRequired: true,
    };
  }

  async listUnmanagedCustomTools(): Promise<UnmanagedCustomTool[]> {
    try {
      const tools: UnmanagedCustomTool[] = [];
      for await (const entry of Deno.readDir(this.customToolsRoot)) {
        if (entry.isFile && entry.name.endsWith(".js")) {
          tools.push({ filename: entry.name });
        }
      }
      return tools.sort((a, b) => a.filename.localeCompare(b.filename));
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return [];
      throw error;
    }
  }

  async enrichStatuses(
    runtimeStatuses: PluginStatus[],
  ): Promise<PluginStatus[]> {
    const manifests = await this.readInstalledManifests();
    const statuses = new Map(
      runtimeStatuses.map((status) => [status.id, { ...status }]),
    );

    for (const [id, installed] of manifests) {
      const manifest = installed.manifest;
      const runtime = statuses.get(id);
      if (!runtime) {
        statuses.set(
          id,
          statusFromManifest(manifest, {
            restartRequired: true,
            pendingAction: "install",
            warnings: mergeWarnings(
              installed.warnings,
              allWarnings(manifest),
              ["Restart required before this plugin can load."],
            ),
          }),
        );
        continue;
      }

      const restartRequired = runtime.restartRequired ||
        runtime.version !== manifest.version ||
        runtime.enabled !== manifest.enabled;
      statuses.set(id, {
        ...runtime,
        name: manifest.name,
        version: runtime.version,
        description: manifest.description ?? runtime.description,
        homepageUrl: manifest.homepageUrl ?? runtime.homepageUrl,
        compatibility: manifest.compatibility ?? runtime.compatibility,
        update: manifest.update ?? runtime.update,
        dependencies: manifest.dependencies ?? runtime.dependencies,
        restartRequired,
        pendingAction: restartRequired ? "install" : runtime.pendingAction,
        warnings: mergeWarnings(
          runtime.warnings,
          installed.warnings,
          allWarnings(manifest),
          restartRequired
            ? ["Restart required before this plugin change takes effect."]
            : undefined,
        ),
      });
    }

    for (const [id, status] of statuses) {
      if (!manifests.has(id)) {
        statuses.set(id, {
          ...status,
          restartRequired: true,
          pendingAction: "remove",
          warnings: mergeWarnings(status.warnings, [
            "This plugin was removed from disk and will stop being exposed after restart.",
          ]),
        });
      }
    }

    return [...statuses.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  private async writeZipPackage(zip: JSZip, root: string): Promise<void> {
    const entries = Object.values(zip.files).map((file) => {
      const unsafeName = (file as { unsafeOriginalName?: string })
        .unsafeOriginalName;
      const normalized = normalizeArchivePath(unsafeName ?? file.name);
      normalizeArchivePath(file.name);
      return { file, path: normalized };
    });
    const filePaths = entries.filter(({ file }) => !file.dir).map(({ path }) =>
      path
    );
    const prefix = detectWrapperPrefix(filePaths);
    for (const { file, path } of entries) {
      if (file.dir) continue;
      if (prefix && !path.startsWith(prefix)) continue;
      const relativePath = prefix ? path.slice(prefix.length) : path;
      if (!relativePath) {
        continue;
      }
      if (isPluginSecretFilename(relativePath)) {
        fail(
          `Conventional secret file blocked in this plugin package: ${relativePath}`,
        );
      }
      const destination = join(root, ...relativePath.split("/"));
      assertInside(root, destination);
      await ensureDir(dirname(destination));
      await Deno.writeFile(destination, await file.async("uint8array"));
    }
  }

  private async finalizeStagedPackage(
    draftId: string,
    packageRoot: string,
    source: PluginInstallSource,
  ): Promise<PluginInstallPreview> {
    const manifestPath = join(packageRoot, "plugin.json");
    let manifest = readManifestCandidate(await Deno.readTextFile(manifestPath));
    ensureInstallableSurface(manifest);
    const secretFiles = await findConventionalSecretFiles(packageRoot);
    if (secretFiles.length > 0) {
      fail(
        `Conventional secret files blocked in this plugin package: ${
          secretFiles.join(", ")
        }`,
      );
    }

    const draftRoot = this.resolveDraftRoot(draftId);
    const pluginPackageRoot = join(draftRoot, manifest.id);
    assertInside(draftRoot, pluginPackageRoot);
    if (pluginPackageRoot !== packageRoot) {
      await Deno.rename(packageRoot, pluginPackageRoot);
    }
    manifest = await validatePluginDirectory(pluginPackageRoot);
    ensureInstallableSurface(manifest);
    const metadata: DraftMetadata = { manifest, source };
    await Deno.writeTextFile(
      join(draftRoot, DRAFT_META_FILE),
      JSON.stringify(metadata, null, 2),
    );

    const existing = await this.readExistingInstall(manifest.id);
    const compatibility = compatibilityWarnings(manifest);
    return {
      draftId,
      manifest,
      source,
      capabilities: deriveDeclaredCapabilities(manifest),
      compatibilityWarnings: compatibility,
      warnings: [...compatibility, ...dependencyWarnings(manifest)],
      dependencies: manifest.dependencies ?? {},
      existing,
      restartRequired: true,
    };
  }

  private resolveDraftRoot(draftId: string): string {
    if (!isSafeDraftId(draftId)) {
      fail("That plugin draft id could not be used.");
    }
    const draftRoot = join(this.stagingRoot, draftId);
    assertInside(this.stagingRoot, draftRoot);
    return draftRoot;
  }

  private async readDraftMetadata(draftRoot: string): Promise<DraftMetadata> {
    try {
      const raw = JSON.parse(
        await Deno.readTextFile(join(draftRoot, DRAFT_META_FILE)),
      );
      if (!isRecord(raw)) fail("Could not read that plugin draft.");
      return {
        manifest: validatePluginManifest(
          raw.manifest,
          isRecord(raw.manifest) && typeof raw.manifest.id === "string"
            ? raw.manifest.id
            : "",
        ),
        source: this.validateDraftSource(raw.source),
      };
    } catch (error) {
      if (error instanceof PluginInstallerError) throw error;
      if (error instanceof Deno.errors.NotFound) {
        fail("That plugin draft was not found.", 404);
      }
      fail(`Could not read that plugin draft: ${safeError(error)}`);
    }
  }

  private validateDraftSource(source: unknown): PluginInstallSource {
    if (!isRecord(source) || typeof source.type !== "string") {
      fail("Could not read that plugin draft source.");
    }
    if (source.type === "zip") {
      return {
        type: "zip",
        fileName: typeof source.fileName === "string"
          ? source.fileName
          : undefined,
      };
    }
    if (source.type === "git" && typeof source.repoUrl === "string") {
      return {
        type: "git",
        repoUrl: source.repoUrl,
        ref: typeof source.ref === "string" ? source.ref : undefined,
      };
    }
    fail("Could not read that plugin draft source.");
  }

  private async readExistingInstall(
    id: string,
  ): Promise<PluginInstallExisting | undefined> {
    try {
      const manifest = await validatePluginDirectory(join(this.pluginRoot, id));
      return {
        name: manifest.name,
        version: manifest.version,
        browserScripts: manifest.browser?.scripts?.length ?? 0,
        browserStyles: manifest.browser?.styles?.length ?? 0,
        dependencies: manifest.dependencies,
      };
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return undefined;
      return { name: id, version: "unknown" };
    }
  }

  private async readInstalledManifests(): Promise<
    Map<string, InstalledManifest>
  > {
    const manifests = new Map<string, InstalledManifest>();
    try {
      for await (const entry of Deno.readDir(this.pluginRoot)) {
        if (!entry.isDirectory) continue;
        const directory = join(this.pluginRoot, entry.name);
        try {
          manifests.set(entry.name, {
            manifest: await validatePluginDirectory(directory),
            warnings: [],
          });
        } catch (error) {
          const message = safeError(error);
          manifests.set(
            entry.name,
            {
              manifest: {
                id: entry.name,
                name: entry.name,
                version: "unknown",
                apiVersion: 1,
                enabled: false,
              },
              warnings: [
                `Could not validate this plugin on disk: ${message}`,
              ],
            },
          );
        }
      }
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return manifests;
      throw error;
    }
    return manifests;
  }

  private async nextBackupPath(id: string): Promise<string> {
    await ensureDir(this.backupRoot);
    const safeId = basename(id);
    for (let attempt = 0; attempt < 100; attempt++) {
      const suffix = attempt === 0 ? "" : `-${attempt}`;
      const path = join(
        this.backupRoot,
        `${timestampForBackup()}-${safeId}${suffix}`,
      );
      if (!(await exists(path))) return path;
    }
    fail("Could not choose a unique plugin backup path.");
  }
}
