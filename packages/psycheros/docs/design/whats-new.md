# Feature Design Doc: What's New splash

Status: approved Date: 2026-10-22

## Problem / Motivation

Not all Psycheros users are in the Discord where announcements are posted, and
few read the public repo's pages. Updates land silently — someone can go months
without knowing a major feature (Flux, cache optimization) exists. The owner
also wants a place for an occasional personal letter ("thank you for using
Psycheros, here's what's new and my thoughts"). Mainstream apps solve this with
a What's New splash on first launch after an update; Psycheros needs the same,
with zero dependency on the launcher (not everyone uses it).

## Goals & Non-goals

- Goals: a full-screen What's New overlay shown once per version, per device,
  sourced from the public repo's GitHub Releases; the owner's letter rides in
  the release body; a reopen affordance in Settings > General.
- Non-goals: launcher-v2 surfaces (the daemon web UI is the universal surface);
  mid-cycle letters not attached to a release (future extension); in-app update
  installation; per-release layout customization.

## Current-state audit

- Version identity exists: `packages/psycheros/deno.json` `version` (0.11.4)
  surfaced via `src/version.ts` (`VERSION_BASE` ignores build suffixes —
  staging/local dogfood builds compare on the base).
- No changelog, no release-notes surface anywhere in the repo or web UI
  (verified: no matches for `*changelog*`; `VERSION` unused in templates.ts or
  psycheros.js).
- The app shell already loads `marked.min.js` and `dompurify.min.js`
  (templates.ts:353-354) — markdown rendering + sanitizing are free.
- GitHub Releases on the public repo (`PsycherosAI/Psycheros`, owner-provided)
  are the single source of truth for notes. None published yet at design time;
  the splash simply stays dormant until the first one exists.

## Design decisions

**GitHub Releases as the source** — owner ruling 2026-10-22. One place to
remember: the Release page is the notes. Drafted in-session with the owner,
published by the promotion/publishing agent. Rejected: bundled notes file
(rejected by owner — two-track mental model), hybrid (same objection).

**Daemon-side cache (`.psycheros/whats-new-cache.json`)** — the daemon fetches
`api.github.com/repos/PsycherosAI/Psycheros/releases` at startup and every 6h,
and serves `GET /api/whats-new` from cache. Users' page loads never touch
GitHub: offline/proxy installs get the last cached copy, rate limits
(unauthenticated: 60/hr/IP) are a non-issue.

**Per-device once-per-version trigger (localStorage)** — owner ruling.
`psycheros.whatsNew.seenVersion` stores the newest shown release tag. A release
shows when it's newer than seen AND not newer than the running app version
(`currentVersion` rides the API payload so the client can skip releases for
versions the user hasn't updated to yet).

**Prereleases skipped** — releases flagged as prerelease on GitHub don't trigger
the splash; unparseable tags are skipped. Build suffixes never matter
(comparison is on `VERSION_BASE`).

**Full-screen overlay, mobile-first** — full-screen takeover on phones, centered
card (max-width ~640px, max-height 85vh, internal scroll) on ≥768px. Dismiss
marks seen; "View on GitHub" opens the release page. Settings > General gets a
"What's New" section with a reopen button (history view: the cached releases
stacked, dismiss doesn't touch the seen flag).

**Sanitized markdown body** — release bodies render via `marked` then
`DOMPurify.sanitize`. The content is the owner's own, but sanitizing is free
insurance.

**Neutral voice** — user-facing product copy ("What's New in v0.12"),
release-notes voice from the owner. Not the entity's first person (same ruling
as the site guide).

## Token / API surface changes

- New endpoint: `GET /api/whats-new` →
  `{ currentVersion, fetchedAt, releases: [{ tag, name, publishedAt, body, url }] }`.
- New module: `src/server/whats-new.ts` (`startWhatsNewRefresh`,
  `handleWhatsNew`).
- New assets: `web/js/whats-new.js` (module; exports `window.WhatsNew.open()`),
  `web/css/whats-new.css`.
- New localStorage key: `psycheros.whatsNew.seenVersion`.

## Migration & backwards compat

None — purely additive. Installs with no cache and no GitHub reach get an empty
release list and no splash.

## Phasing

1. Server module + endpoint + cache refresher.
2. Client overlay + auto-show + Settings reopen.
3. Docs (this file; ui-features.md entry).

Each phase leaves the app working (phase 1 is an unused endpoint).

## Test plan

- Gates: `deno check` (entry-file form), `deno lint`, `deno fmt --check`.
- Manual matrix (when the daemon is next running, owner's call): fresh load with
  unseen cached release → splash shows once; reload → silent; Settings > General
  → "What's New" reopens; empty cache → nothing; release newer than app version
  → nothing until the app catches up; mobile viewport full-screen vs desktop
  card; light + dark themes (token-derived, no literals).

## Risks / gotchas

- **The public repo has no Releases yet** — by design the splash stays dormant
  until the first one is published (the big Flux release). Not a bug.
- **Promotion must publish the Release** — the splash depends on the publishing
  agent creating it. Accepted by the owner as the single-source tradeoff.
- **Unauthenticated GitHub API** — 60 req/hr/IP is ample at 4 fetches/day, but
  the endpoint must stay unauthenticated-simple; if the repo ever goes private,
  every install's splash goes quiet (cache serves last-known).
- The overlay must not block first-run flows on a brand-new install more than
  once — per-device seen flag covers it (first install sees the latest eligible
  release once, which is correct: a new user should still get the "thank you"
  letter).

## Open questions

None — all forks owner-ruled 2026-10-22.

## Future direction

Mid-cycle owner letters not attached to a release (would need a second feed
shape — explicitly deferred). Showing the splash as a toast for patch releases
while keeping the full-screen ceremony for majors.
