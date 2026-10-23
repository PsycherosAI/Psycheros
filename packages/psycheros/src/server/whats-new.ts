/**
 * What's New — release-notes feed
 *
 * Fetches the public repo's GitHub releases and caches them under the data
 * root so the web UI can show "What's New" without GitHub being reachable at
 * page load (offline installs, proxies, rate limits). The GitHub Release page
 * is the single source of truth for release notes and the owner's letter —
 * nothing is authored anywhere else. Design: docs/design/whats-new.md.
 */

import { join } from "@std/path";
import { VERSION_BASE } from "../version.ts";
import type { RouteContext } from "./routes.ts";

/** Releases API for the public-facing repo (owner-provided slug). */
const RELEASES_URL =
  "https://api.github.com/repos/PsycherosAI/Psycheros/releases?per_page=15";

/** Refresh cadence — 4 fetches/day is nowhere near the rate limit. */
const REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 10_000;

/** How many recent releases to keep + serve. */
const MAX_RELEASES = 5;

export interface WhatsNewRelease {
  tag: string;
  name: string;
  publishedAt: string;
  body: string;
  url: string;
}

interface WhatsNewCache {
  fetchedAt: number;
  releases: WhatsNewRelease[];
}

/**
 * Parse a release tag into a comparable version tuple. Accepts leading
 * "v"/"V" and missing patch component ("v0.12" == "v0.12.0"). Returns null
 * for anything unparseable — those releases are skipped everywhere.
 */
export function parseVersionTag(
  tag: string,
): [number, number, number] | null {
  const m = tag.trim().replace(/^[vV]/, "").match(/^(\d+)\.(\d+)(?:\.(\d+))?/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)];
}

function cachePath(dataRoot: string): string {
  return join(dataRoot, ".psycheros", "whats-new-cache.json");
}

/**
 * Fetch releases from GitHub and overwrite the local cache. Failures are
 * logged and swallowed — the last cache keeps serving.
 */
export async function refreshWhatsNewCache(dataRoot: string): Promise<void> {
  try {
    const res = await fetch(RELEASES_URL, {
      headers: { Accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.warn(
        `[whats-new] GitHub fetch returned ${res.status} — cache untouched`,
      );
      return;
    }
    const raw = await res.json() as Array<{
      tag_name?: string;
      name?: string | null;
      published_at?: string;
      body?: string | null;
      html_url?: string;
      prerelease?: boolean;
    }>;

    const releases: WhatsNewRelease[] = raw
      .filter((r) =>
        typeof r.tag_name === "string" &&
        !r.prerelease &&
        parseVersionTag(r.tag_name) !== null
      )
      .map((r) => ({
        tag: r.tag_name!,
        name: r.name || r.tag_name!,
        publishedAt: r.published_at ?? "",
        body: r.body ?? "",
        url: r.html_url ?? "",
      }))
      .slice(0, MAX_RELEASES);

    const cache: WhatsNewCache = {
      fetchedAt: Date.now(),
      releases,
    };
    await Deno.mkdir(join(dataRoot, ".psycheros"), { recursive: true });
    await Deno.writeTextFile(
      cachePath(dataRoot),
      JSON.stringify(cache, null, 2) + "\n",
    );
    console.log(`[whats-new] cached ${releases.length} release(s)`);
  } catch (err) {
    console.warn(
      `[whats-new] refresh failed (serving last cache):`,
      err instanceof Error ? err.message : String(err),
    );
  }
}

/**
 * Start the background refresh: one fetch now (fire-and-forget), then every
 * REFRESH_INTERVAL_MS. The timer is unref'd so it never holds the daemon
 * open on shutdown.
 */
export function startWhatsNewRefresh(dataRoot: string): void {
  refreshWhatsNewCache(dataRoot);
  const timer = setInterval(
    () => refreshWhatsNewCache(dataRoot),
    REFRESH_INTERVAL_MS,
  );
  Deno.unrefTimer(timer);
}

async function loadCache(dataRoot: string): Promise<WhatsNewCache> {
  try {
    const parsed = JSON.parse(
      await Deno.readTextFile(cachePath(dataRoot)),
    ) as Partial<WhatsNewCache>;
    return {
      fetchedAt: parsed.fetchedAt ?? 0,
      releases: Array.isArray(parsed.releases) ? parsed.releases : [],
    };
  } catch {
    return { fetchedAt: 0, releases: [] };
  }
}

/**
 * Handle GET /api/whats-new — the cached release list plus the running
 * app's base version (the client skips releases newer than the app itself).
 */
export async function handleWhatsNew(ctx: RouteContext): Promise<Response> {
  const cache = await loadCache(ctx.dataRoot);
  return new Response(
    JSON.stringify({
      currentVersion: VERSION_BASE,
      fetchedAt: cache.fetchedAt,
      releases: cache.releases,
    }),
    {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      },
    },
  );
}
