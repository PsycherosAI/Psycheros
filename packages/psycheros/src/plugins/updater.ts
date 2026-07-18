/**
 * Plugin update checker + applier.
 *
 * The update surface piggybacks on PluginInstaller's existing inspectGit →
 * installDraft pipeline. This module is just the GitHub tag-API glue:
 *   - parse owner/repo from a plugin's `update.repoUrl`
 *   - fetch that repo's tags, filter by `update.tagPrefix`, pick the highest semver
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
import type { PluginInstaller } from "./installer.ts";

/** Whether an update is available, with the details needed to apply it. */
export interface PluginUpdateCheckResult {
  pluginId: string;
  currentVersion: string;
  updateAvailable: boolean;
  /** Present only when an update is available. */
  latestVersion?: string;
  latestTag?: string;
  repoUrl: string;
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
    | "no-valid-tags"; // repo has tags but none match prefix + parse as semver
  message: string;
  checkedAt: string;
}

export interface InstalledPluginSummary {
  id: string;
  version: string;
  update?: {
    repoUrl?: string;
    tagPrefix?: string;
  };
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
  return {
    id: raw.id,
    version: raw.version,
    update: raw.update,
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

interface GitHubTag {
  name: string;
}

async function fetchGitHubTags(
  owner: string,
  repo: string,
): Promise<GitHubTag[]> {
  const url = `https://api.github.com/repos/${owner}/${repo}/tags?per_page=100`;
  const response = await fetch(url, {
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
  let best: { tag: string; version: semver.SemVer } | undefined;
  for (const { name } of tags) {
    if (tagPrefix && !name.startsWith(tagPrefix)) continue;
    const versionPart = tagPrefix ? name.slice(tagPrefix.length) : name;
    let parsed: semver.SemVer;
    try {
      parsed = semver.parse(versionPart);
    } catch {
      continue; // tag isn't a version tag, skip silently
    }
    if (!best || semver.greaterThan(parsed, best.version)) {
      best = { tag: name, version: parsed };
    }
  }
  return best;
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
): Promise<PluginUpdateCheckResult | PluginUpdateCheckFailure> {
  const checkedAt = new Date().toISOString();
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
    tags = await fetchGitHubTags(ownerRepo.owner, ownerRepo.repo);
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

  const latest = findLatestTag(tags, summary.update?.tagPrefix);
  if (!latest) {
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

  let currentVersion: semver.SemVer;
  try {
    currentVersion = semver.parse(summary.version);
  } catch {
    // Installed version isn't semver-parsable (e.g., "unknown"). Treat any
    // remote tag as an update so the operator can re-install to a known
    // good version.
    return {
      pluginId,
      currentVersion: summary.version,
      updateAvailable: true,
      latestVersion: semver.format(latest.version),
      latestTag: latest.tag,
      repoUrl,
      checkedAt,
    };
  }

  const isUpdate = semver.greaterThan(latest.version, currentVersion);
  return {
    pluginId,
    currentVersion: summary.version,
    updateAvailable: isUpdate,
    latestVersion: semver.format(latest.version),
    latestTag: latest.tag,
    repoUrl,
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
  repoUrl: string,
): Promise<{ backupPath?: string }> {
  const preview = await installer.inspectGit(repoUrl, latestTag);
  if (preview.manifest.id !== pluginId) {
    throw new UpdateCheckError(
      "network",
      `Update target's id "${preview.manifest.id}" does not match installed plugin id "${pluginId}". Aborting before replace.`,
    );
  }
  const result = await installer.installDraft(preview.draftId);
  return { backupPath: result.backupPath };
}
