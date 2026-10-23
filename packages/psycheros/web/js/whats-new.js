/**
 * What's New — release-notes splash.
 *
 * The server (src/server/whats-new.ts) caches the public repo's GitHub
 * releases and serves them at GET /api/whats-new. This module decides
 * whether to interrupt the user — once per version, per device
 * (localStorage) — and renders the full-screen overlay. `WhatsNew.open()`
 * reopens it from Settings > General. Design: docs/design/whats-new.md.
 */

const SEEN_KEY = "psycheros.whatsNew.seenVersion";
const AUTO_SHOW_DELAY_MS = 800;
const FETCH_TIMEOUT_MS = 5000;

/** @typedef {{tag: string, name: string, publishedAt: string, body: string, url: string}} Release */
/** @typedef {{currentVersion: string, fetchedAt: number, releases: Release[]}} Feed */

/**
 * Parse "v1.2.3" / "1.2" style tags into a comparable tuple, or null.
 * Mirrors parseVersionTag on the server.
 * @param {string} tag
 * @returns {[number, number, number] | null}
 */
function parseVersionTag(tag) {
  const m = String(tag).trim().replace(/^[vV]/, "").match(/^(\d+)\.(\d+)(?:\.(\d+))?/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)];
}

/**
 * @param {[number, number, number]} a
 * @param {[number, number, number]} b
 * @returns {number}
 */
function compareVersions(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

/**
 * @returns {Promise<Feed | null>}
 */
async function fetchFeed() {
  try {
    const res = await fetch("/api/whats-new", {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/**
 * Render a release body (GitHub markdown) to sanitized HTML. marked and
 * DOMPurify are loaded by the app shell. Falls back to escaped text.
 * @param {string} markdown
 * @returns {string}
 */
function renderBody(markdown) {
  if (!markdown) return "";
  if (typeof marked === "undefined" || typeof DOMPurify === "undefined") {
    const div = document.createElement("div");
    div.textContent = markdown;
    return div.innerHTML;
  }
  return DOMPurify.sanitize(marked.parse(markdown), {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ["style", "form", "input", "button"],
  });
}

/**
 * @param {string} isoDate
 * @returns {string}
 */
function formatDate(isoDate) {
  if (!isoDate) return "";
  try {
    return new Date(isoDate).toLocaleDateString(undefined, {
      year: "numeric",
      month: "long",
      day: "numeric",
    });
  } catch {
    return "";
  }
}

/**
 * Build the full-screen overlay. Mobile: full-screen takeover. Desktop
 * (≥768px): centered card. Inline onclick handlers live here (not in
 * fragments), so plain closures are fine.
 * @param {Release[]} releases Newest first.
 * @param {{ markSeenTag?: string }} opts When set, dismissing records the
 *        seen flag (auto-show); history mode leaves it untouched.
 */
function showOverlay(releases, opts = {}) {
  closeOverlay();

  const overlay = document.createElement("div");
  overlay.className = "whats-new-overlay";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-label", "What's New");

  const sheet = document.createElement("div");
  sheet.className = "whats-new-sheet";

  const head = document.createElement("div");
  head.className = "whats-new-head";
  const kicker = document.createElement("div");
  kicker.className = "whats-new-kicker";
  kicker.textContent = "Psycheros";
  const title = document.createElement("h2");
  title.className = "whats-new-title";
  title.textContent = "What's New";
  head.appendChild(kicker);
  head.appendChild(title);
  sheet.appendChild(head);

  const scroll = document.createElement("div");
  scroll.className = "whats-new-scroll";
  for (const release of releases) {
    const section = document.createElement("article");
    section.className = "whats-new-release";

    const releaseHead = document.createElement("div");
    releaseHead.className = "whats-new-release-head";
    const releaseName = document.createElement("h3");
    releaseName.className = "whats-new-release-name";
    releaseName.textContent = release.name || release.tag;
    const releaseDate = document.createElement("span");
    releaseDate.className = "whats-new-release-date";
    releaseDate.textContent = formatDate(release.publishedAt);
    releaseHead.appendChild(releaseName);
    if (releaseDate.textContent) releaseHead.appendChild(releaseDate);
    section.appendChild(releaseHead);

    const body = document.createElement("div");
    body.className = "whats-new-body";
    body.innerHTML = renderBody(release.body);
    section.appendChild(body);

    scroll.appendChild(section);
  }
  sheet.appendChild(scroll);

  const actions = document.createElement("div");
  actions.className = "whats-new-actions";
  const latest = releases[0];
  if (latest && latest.url) {
    const viewLink = document.createElement("a");
    viewLink.className = "btn whats-new-link";
    viewLink.href = latest.url;
    viewLink.target = "_blank";
    viewLink.rel = "noopener noreferrer";
    viewLink.textContent = "View on GitHub";
    actions.appendChild(viewLink);
  }
  const continueBtn = document.createElement("button");
  continueBtn.className = "btn btn--primary";
  continueBtn.textContent = "Continue";
  continueBtn.addEventListener("click", () => {
    if (opts.markSeenTag) {
      try {
        localStorage.setItem(SEEN_KEY, opts.markSeenTag);
      } catch { /* private mode etc. — shows again next load, acceptable */ }
    }
    closeOverlay();
  });
  actions.appendChild(continueBtn);
  sheet.appendChild(actions);

  overlay.appendChild(sheet);
  overlay.addEventListener("click", (e) => {
    // Click on the scrim (desktop) dismisses without marking seen —
    // the auto-show returns next load. Cheap safety against a stray tap.
    if (e.target === overlay) closeOverlay();
  });
  document.body.appendChild(overlay);
  continueBtn.focus();
}

function closeOverlay() {
  document.querySelector(".whats-new-overlay")?.remove();
}

/**
 * Auto-show on load: releases newer than the seen flag, but never newer
 * than the running app (users who haven't updated yet aren't told about
 * what they can't have).
 * @param {Feed} feed
 * @returns {Release[] | null} Eligible releases (newest first) or null.
 */
function eligibleReleases(feed) {
  const current = parseVersionTag(feed.currentVersion ?? "");
  const seenTag = (() => {
    try {
      return localStorage.getItem(SEEN_KEY);
    } catch {
      return null;
    }
  })();
  const seen = seenTag ? parseVersionTag(seenTag) : null;

  const eligible = feed.releases.filter((r) => {
    const v = parseVersionTag(r.tag);
    if (!v) return false;
    if (current && compareVersions(v, current) > 0) return false;
    if (seen && compareVersions(v, seen) <= 0) return false;
    return true;
  });

  return eligible.length > 0 ? eligible : null;
}

/**
 * Entry point for the automatic splash on page load.
 */
async function maybeShowSplash() {
  if (document.querySelector(".whats-new-overlay")) return;
  const feed = await fetchFeed();
  if (!feed || !Array.isArray(feed.releases) || feed.releases.length === 0) {
    return;
  }
  const eligible = eligibleReleases(feed);
  if (!eligible) return;
  // Dismissal marks the NEWEST eligible release as seen — older unshown
  // ones are covered by transitivity (they're all ≤ it).
  showOverlay(eligible, { markSeenTag: eligible[0].tag });
}

/**
 * Reopen from Settings > General — history view of the cached releases.
 * Never touches the seen flag.
 */
async function openWhatsNew() {
  const feed = await fetchFeed();
  const releases = feed && Array.isArray(feed.releases) && feed.releases.length > 0
    ? feed.releases
    : [{
      tag: "",
      name: "No release notes yet",
      publishedAt: "",
      body:
        "Nothing has been published to the project's GitHub releases yet. " +
        "Notes will appear here after the next update.",
      url: "",
    }];
  showOverlay(releases, {});
}

// Settings fragments are HTMX-swapped; inline onclick needs a global
// (same rule as psycheros.js exports).
window.WhatsNew = { open: openWhatsNew };

document.addEventListener("DOMContentLoaded", () => {
  setTimeout(maybeShowSplash, AUTO_SHOW_DELAY_MS);
});
