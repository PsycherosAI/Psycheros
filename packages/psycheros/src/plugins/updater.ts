/**
 * Plugin update checker + applier.
 *
 * The update surface piggybacks on PluginInstaller's existing inspectGit →
 * installDraft pipeline. This module is the GitHub tag-API glue and
 * compatibility gate:
 *   - parse owner/repo from a plugin's `update.repoUrl`
 *   - fetch matching semver tags and inspect each tagged plugin manifest
 *   - select the newest release compatible with this Psycheros installation
 *   - compare against the installed version
 *   - when applying, hand off to inspectGit + installDraft (which already
 *     handle backup, validation, atomic replace, restartRequired surfacing)
 *
 * v1 scope: public GitHub only, no token, no scheduler integration. The
 * operator triggers checks manually from the Plugins Settings UI. Future
 * versions can add a daily scheduler task and optional auth for private
 * repos / higher rate limits.
 */

import * as semver from "@std/semver";
import { join } from "@std/path";
import {
  type PluginManifest,
  type PluginUpdateMetadata,
  validatePluginManifest,
} from "../../../plugin-api/src/mod.ts";
import {
  type PluginInstaller,
  pluginUpdateCompatibilityBlockers,
} from "./installer.ts";

export interface SkippedPluginUpdate {
  tag: string;
  version: string;
  reasons: string[];
}

/** Whether an update is available, with the details needed to apply it. */
export interface PluginUpdateCheckResult {
  pluginId: string;
  currentVersion: string;
  updateAvailable: boolean;
  /** Present only when an update is available. */
  latestVersion?: string;
  latestTag?: string;
  /** Highest published semver tag, even when it is incompatible or invalid. */
  latestPublishedVersion?: string;
  repoUrl: string;
  packagePath?: string;
  skippedUpdateCount?: number;
  /** At most five newest skipped releases, for concise UI diagnostics. */
  skippedUpdates?: SkippedPluginUpdate[];
  /** ISO timestamp of the check — for the UI to show freshness. */
  checkedAt: string;
}

export interface PluginUpdateCheckFailure {
  pluginId: string;
  /** Category of failure — drives UI messaging. */
  reason:
    | "not-configured" // manifest has no update.repoUrl
    | "unsupported-host" // not a GitHub URL
    | "network" // fetch failed
    | "rate-limited" // GitHub returned 403/429
    | "no-valid-tags" // repo has tags but none match prefix + parse as semver
    | "invalid-release" // selected tag/package is internally inconsistent
    | "incompatible"; // selected tag does not support this installation
  message: string;
  checkedAt: string;
}

export interface InstalledPluginSummary {
  id: string;
  version: string;
  update?: PluginUpdateMetadata;
}

export interface PluginUpdateCheckOptions {
  fetch?: typeof fetch;
}

/**
 * Read a plugin's manifest from disk to get the version + update metadata.
 * Cheaper than holding the full loaded-plugin state in memory just for an
 * update check.
 */
export async function readInstalledPluginSummary(
  pluginRoot: string,
  pluginId: string,
): Promise<InstalledPluginSummary> {
  const manifestPath = join(pluginRoot, pluginId, "plugin.json");
  const raw = JSON.parse(await Deno.readTextFile(manifestPath));
  const manifest = validatePluginManifest(raw, pluginId);
  return {
    id: manifest.id,
    version: manifest.version,
    update: manifest.update,
  };
}

/**
 * Parse owner/repo from a GitHub URL. Accepts the common shapes:
 *   https://github.com/owner/repo
 *   https://github.com/owner/repo.git
 *   git@github.com:owner/repo.git
 *
 * Returns undefined for non-GitHub URLs or malformed paths — the caller
 * surfaces an "unsupported-host" failure.
 */
export function parseGitHubOwnerRepo(
  repoUrl: string,
): { owner: string; repo: string } | undefined {
  const trimmed = repoUrl.trim();
  // SSH form: git@github.com:owner/repo(.git)
  const sshMatch = trimmed.match(
    /^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/,
  );
  if (sshMatch) return { owner: sshMatch[1], repo: sshMatch[2] };
  // HTTPS form: https://github.com/owner/repo(.git)?optional-cruft
  const httpsMatch = trimmed.match(
    /^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?(?:[/?#].*)?$/,
  );
  if (httpsMatch) return { owner: httpsMatch[1], repo: httpsMatch[2] };
  return undefined;
}

export interface GitHubTag {
  name: string;
}

async function fetchGitHubTags(
  owner: string,
  repo: string,
  fetchImpl: typeof fetch,
): Promise<GitHubTag[]> {
  const url = `https://api.github.com/repos/${owner}/${repo}/tags?per_page=100`;
  const response = await fetchImpl(url, {
    headers: {
      "Accept": "application/vnd.github+json",
      "User-Agent": "psycheros-plugin-updater",
    },
  });
  if (response.status === 403 || response.status === 429) {
    throw new UpdateCheckError(
      "rate-limited",
      response.headers.get("x-ratelimit-reset")
        ? `GitHub API rate limit hit. Resets at ${
          new Date(
            parseInt(response.headers.get("x-ratelimit-reset")!, 10) * 1000,
          )
            .toISOString()
        }.`
        : "GitHub API rate limit hit. Try again later.",
    );
  }
  if (response.status === 404) {
    throw new UpdateCheckError(
      "network",
      `Repository not found: ${owner}/${repo}.`,
    );
  }
  if (!response.ok) {
    throw new UpdateCheckError(
      "network",
      `GitHub returned ${response.status} ${response.statusText} for ${owner}/${repo}.`,
    );
  }
  return await response.json() as GitHubTag[];
}

function githubContentPath(packagePath?: string): string {
  return [...(packagePath?.split("/") ?? []), "plugin.json"]
    .map(encodeURIComponent)
    .join("/");
}

function decodeBase64Utf8(content: string): string {
  const binary = atob(content.replace(/\s/g, ""));
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

async function fetchGitHubPluginManifest(
  owner: string,
  repo: string,
  tag: string,
  packagePath: string | undefined,
  fetchImpl: typeof fetch,
): Promise<PluginManifest> {
  const manifestPath = githubContentPath(packagePath);
  const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${
    encodeURIComponent(repo)
  }/contents/${manifestPath}?ref=${encodeURIComponent(tag)}`;
  const response = await fetchImpl(url, {
    headers: {
      "Accept": "application/vnd.github+json",
      "User-Agent": "psycheros-plugin-updater",
    },
  });
  if (response.status === 403 || response.status === 429) {
    throw new UpdateCheckError(
      "rate-limited",
      "GitHub API rate limit hit while checking tagged plugin manifests. Try again later.",
    );
  }
  if (response.status === 404) {
    throw new Error(`${manifestPath} was not found at tag ${tag}.`);
  }
  if (!response.ok) {
    throw new UpdateCheckError(
      "network",
      `GitHub returned ${response.status} ${response.statusText} while reading ${manifestPath} at ${tag}.`,
    );
  }

  const body = await response.json() as {
    type?: string;
    encoding?: string;
    content?: string;
  };
  if (
    body.type !== "file" || body.encoding !== "base64" ||
    typeof body.content !== "string"
  ) {
    throw new Error(`${manifestPath} at tag ${tag} was not a readable file.`);
  }
  const raw = JSON.parse(decodeBase64Utf8(body.content)) as unknown;
  const candidateId = raw && typeof raw === "object" && !Array.isArray(raw) &&
      typeof (raw as Record<string, unknown>).id === "string"
    ? (raw as Record<string, unknown>).id as string
    : "";
  return validatePluginManifest(raw, candidateId);
}

/** Custom error class so the caller can branch on `reason` without string-matching. */
export class UpdateCheckError extends Error {
  constructor(
    public reason: PluginUpdateCheckFailure["reason"],
    message: string,
  ) {
    super(message);
    this.name = "UpdateCheckError";
  }
}

/**
 * Find the latest tag in `tags` that matches `tagPrefix` and parses as semver.
 * Returns the original tag name (with prefix) and the parsed version.
 */
export function findLatestTag(
  tags: GitHubTag[],
  tagPrefix?: string,
): { tag: string; version: semver.SemVer } | undefined {
  return findVersionTags(tags, tagPrefix)[0];
}

/** Matching semver tags sorted newest first. */
export function findVersionTags(
  tags: GitHubTag[],
  tagPrefix?: string,
): Array<{ tag: string; version: semver.SemVer }> {
  const versions: Array<{ tag: string; version: semver.SemVer }> = [];
  for (const { name } of tags) {
    if (tagPrefix && !name.startsWith(tagPrefix)) continue;
    const versionPart = tagPrefix ? name.slice(tagPrefix.length) : name;
    let parsed: semver.SemVer;
    try {
      parsed = semver.parse(versionPart);
    } catch {
      continue; // tag isn't a version tag, skip silently
    }
    versions.push({ tag: name, version: parsed });
  }
  return versions.sort((left, right) =>
    semver.greaterThan(left.version, right.version)
      ? -1
      : semver.greaterThan(right.version, left.version)
      ? 1
      : 0
  );
}

function parseTagVersion(
  tag: string,
  tagPrefix?: string,
): semver.SemVer | undefined {
  if (tagPrefix && !tag.startsWith(tagPrefix)) return undefined;
  try {
    return semver.parse(tagPrefix ? tag.slice(tagPrefix.length) : tag);
  } catch {
    return undefined;
  }
}

function parsedVersion(version: string): semver.SemVer | undefined {
  try {
    return semver.parse(version);
  } catch {
    return undefined;
  }
}

function sameVersion(left: semver.SemVer, right: semver.SemVer): boolean {
  return semver.format(left) === semver.format(right);
}

function updateChannelBlockers(
  manifest: PluginManifest,
  installed: PluginUpdateMetadata,
): string[] {
  const candidate = manifest.update;
  if (!candidate?.repoUrl) {
    return [
      "The tagged manifest removes update.repoUrl, which would disable future one-click updates.",
    ];
  }
  const blockers: string[] = [];
  const fields: Array<keyof PluginUpdateMetadata> = [
    "repoUrl",
    "tagPrefix",
    "packagePath",
  ];
  for (const field of fields) {
    if ((candidate[field] ?? "") !== (installed[field] ?? "")) {
      blockers.push(
        `The tagged manifest changes update.${field}; update channels can only be changed by a reviewed manual reinstall.`,
      );
    }
  }
  return blockers;
}

/**
 * Check one plugin for an available update. Reads the manifest from disk
 * (not from the in-memory PluginManager state) so this works even if the
 * manager hasn't loaded yet, and so the check doesn't need a manager
 * reference at all.
 */
export async function checkPluginUpdate(
  pluginRoot: string,
  pluginId: string,
  options: PluginUpdateCheckOptions = {},
): Promise<PluginUpdateCheckResult | PluginUpdateCheckFailure> {
  const checkedAt = new Date().toISOString();
  const fetchImpl = options.fetch ?? fetch;
  let summary: InstalledPluginSummary;
  try {
    summary = await readInstalledPluginSummary(pluginRoot, pluginId);
  } catch (error) {
    return {
      pluginId,
      reason: "network",
      message: `Could not read plugin manifest: ${(error as Error).message}`,
      checkedAt,
    };
  }

  const repoUrl = summary.update?.repoUrl;
  if (!repoUrl) {
    return {
      pluginId,
      reason: "not-configured",
      message:
        "This plugin does not declare update.repoUrl in its manifest, so updates cannot be checked automatically.",
      checkedAt,
    };
  }

  const ownerRepo = parseGitHubOwnerRepo(repoUrl);
  if (!ownerRepo) {
    return {
      pluginId,
      reason: "unsupported-host",
      message:
        `Update checks currently support GitHub URLs only. This plugin's repoUrl is "${repoUrl}".`,
      checkedAt,
    };
  }

  let tags: GitHubTag[];
  try {
    tags = await fetchGitHubTags(ownerRepo.owner, ownerRepo.repo, fetchImpl);
  } catch (error) {
    if (error instanceof UpdateCheckError) {
      return {
        pluginId,
        reason: error.reason,
        message: error.message,
        checkedAt,
      };
    }
    return {
      pluginId,
      reason: "network",
      message: `Update check failed: ${(error as Error).message}`,
      checkedAt,
    };
  }

  const versions = findVersionTags(tags, summary.update?.tagPrefix);
  if (versions.length === 0) {
    return {
      pluginId,
      reason: "no-valid-tags",
      message:
        `No tags in ${ownerRepo.owner}/${ownerRepo.repo} match the prefix "${
          summary.update?.tagPrefix ?? ""
        }" and parse as semver.`,
      checkedAt,
    };
  }

  const currentVersion = parsedVersion(summary.version);
  const candidates = currentVersion
    ? versions.filter((candidate) =>
      semver.greaterThan(candidate.version, currentVersion)
    )
    : versions;
  const skippedUpdates: SkippedPluginUpdate[] = [];
  let skippedUpdateCount = 0;
  const recordSkipped = (
    candidate: { tag: string; version: semver.SemVer },
    reasons: string[],
  ) => {
    skippedUpdateCount += 1;
    if (skippedUpdates.length < 5) {
      skippedUpdates.push({
        tag: candidate.tag,
        version: semver.format(candidate.version),
        reasons,
      });
    }
  };

  for (const candidate of candidates) {
    let manifest: PluginManifest;
    try {
      manifest = await fetchGitHubPluginManifest(
        ownerRepo.owner,
        ownerRepo.repo,
        candidate.tag,
        summary.update?.packagePath,
        fetchImpl,
      );
    } catch (error) {
      if (error instanceof UpdateCheckError) {
        return {
          pluginId,
          reason: error.reason,
          message: error.message,
          checkedAt,
        };
      }
      recordSkipped(candidate, [
        `Could not validate the tagged plugin manifest: ${
          (error as Error).message
        }`,
      ]);
      continue;
    }

    const reasons: string[] = [];
    if (manifest.id !== pluginId) {
      reasons.push(
        `The tagged manifest id "${manifest.id}" does not match installed plugin id "${pluginId}".`,
      );
    }
    const manifestVersion = parsedVersion(manifest.version);
    if (!manifestVersion || !sameVersion(manifestVersion, candidate.version)) {
      reasons.push(
        `The tagged manifest version "${manifest.version}" does not match tag version ${
          semver.format(candidate.version)
        }.`,
      );
    }
    reasons.push(...updateChannelBlockers(manifest, summary.update!));
    reasons.push(...pluginUpdateCompatibilityBlockers(manifest));
    if (reasons.length > 0) {
      recordSkipped(candidate, reasons);
      continue;
    }

    return {
      pluginId,
      currentVersion: summary.version,
      updateAvailable: true,
      latestVersion: semver.format(candidate.version),
      latestTag: candidate.tag,
      latestPublishedVersion: semver.format(versions[0].version),
      repoUrl,
      packagePath: summary.update?.packagePath,
      skippedUpdateCount: skippedUpdateCount || undefined,
      skippedUpdates: skippedUpdates.length > 0 ? skippedUpdates : undefined,
      checkedAt,
    };
  }

  return {
    pluginId,
    currentVersion: summary.version,
    updateAvailable: false,
    latestVersion: skippedUpdateCount === 0
      ? semver.format(versions[0].version)
      : undefined,
    latestTag: skippedUpdateCount === 0 ? versions[0].tag : undefined,
    latestPublishedVersion: semver.format(versions[0].version),
    repoUrl,
    packagePath: summary.update?.packagePath,
    skippedUpdateCount: skippedUpdateCount || undefined,
    skippedUpdates: skippedUpdates.length > 0 ? skippedUpdates : undefined,
    checkedAt,
  };
}

/**
 * Apply a previously-checked update. Hands off to PluginInstaller.inspectGit
 * with the latest tag, then installDraft — the installer already handles
 * backup, manifest validation, atomic replace, and restartRequired
 * surfacing.
 */
export async function applyPluginUpdate(
  installer: PluginInstaller,
  pluginId: string,
  latestTag: string,
): Promise<{ backupPath?: string }> {
  const summary = await readInstalledPluginSummary(
    installer.pluginRoot,
    pluginId,
  );
  const repoUrl = summary.update?.repoUrl;
  if (!repoUrl) {
    throw new UpdateCheckError(
      "invalid-release",
      "The installed plugin does not declare update.repoUrl.",
    );
  }
  const tagVersion = parseTagVersion(latestTag, summary.update?.tagPrefix);
  if (!tagVersion) {
    throw new UpdateCheckError(
      "invalid-release",
      `Update tag "${latestTag}" does not match this plugin's tagPrefix or semver format.`,
    );
  }
  const currentVersion = parsedVersion(summary.version);
  if (currentVersion && !semver.greaterThan(tagVersion, currentVersion)) {
    throw new UpdateCheckError(
      "invalid-release",
      `Update version ${
        semver.format(tagVersion)
      } is not newer than installed version ${summary.version}.`,
    );
  }

  const preview = await installer.inspectGit(
    repoUrl,
    latestTag,
    summary.update?.packagePath,
  );
  try {
    if (preview.manifest.id !== pluginId) {
      throw new UpdateCheckError(
        "invalid-release",
        `Update target's id "${preview.manifest.id}" does not match installed plugin id "${pluginId}". Aborting before replace.`,
      );
    }
    const manifestVersion = parsedVersion(preview.manifest.version);
    if (!manifestVersion || !sameVersion(manifestVersion, tagVersion)) {
      throw new UpdateCheckError(
        "invalid-release",
        `Update target's manifest version "${preview.manifest.version}" does not match tag version ${
          semver.format(tagVersion)
        }. Aborting before replace.`,
      );
    }
    const blockers = [
      ...updateChannelBlockers(preview.manifest, summary.update!),
      ...pluginUpdateCompatibilityBlockers(preview.manifest),
    ];
    if (blockers.length > 0) {
      throw new UpdateCheckError(
        "incompatible",
        `Update ${
          semver.format(tagVersion)
        } is not compatible with this installation: ${blockers.join(" ")}`,
      );
    }
    const result = await installer.installDraft(preview.draftId);
    return { backupPath: result.backupPath };
  } catch (error) {
    await installer.discardDraft(preview.draftId);
    throw error;
  }
}
