# Feature Design Doc: Themeable Palette System

Status: implemented Date: 2026-08-15 Template: [`TEMPLATE.md`](TEMPLATE.md) ·
Contract: [`design-system.md`](design-system.md)

## Problem / Motivation

Appearance settings offered a single accent color (8 presets + custom hex) over
a fixed dark neutral ramp — light or pastel themes were impossible, and
secondary colors couldn't be themed at all. Meanwhile the frontend accumulated
~73 distinct hardcoded hexes: 5 different reds, 6 greens, 8 ambers, ~10 greys
bypassing the token ramp, and 6 purple `rgba(168,85,247,0.4)` glows that stayed
purple regardless of the picked accent. Custom theming and CSS drift have the
same root cause: surfaces that don't route through tokens.

## Goals & Non-goals

- Goals: full user-configurable palette (dark **and** light themes) via presets,
  a harmony generator, or manual slot picking; zero hardcoded colors outside the
  whitelist; no flash-of-default-theme on load; design docs so future features
  stop drifting.
- Non-goals: theme packs with assets (future direction, below); font/spacing
  theming; per-conversation themes; any launcher-v2 behavior changes beyond
  syncing its mirrored token defaults.

## Current-state audit (pre-migration)

- `web/css/tokens.css`: 22 hexes — the only sanctioned definitions, but
  everything assumed dark mode, and `--c-success` aliased `--c-accent`.
- `workspace.css`: 99 hex occurrences (60% of the total). `components.css` 28,
  `voice.css` 18, `discord.css` 17, `settings.css` 16, `admin.css` 5,
  `embeddings.css` 2, `graph.css` 1.
- `templates.ts`: ~21 inline-style hexes plus phantom-var usage
  (`var(--bg-secondary, #1a1a1a)` at :5902/:5925 — vars never defined, fallbacks
  were the live values). `voice.css` had 13 phantom-var usages of the same kind.
- `theme.js` applied only accent vars at runtime; static token defaults were
  hand-picked values that **differed** from the runtime-derived ones (e.g.
  `--c-accent-hover` static `#c084fc` vs derived `#b978fd`), so first paint
  silently shifted after JS loaded. No server-side first-paint theming.
- Persistence: `AppearanceSettings` (routes.ts:8858) →
  `.psycheros/appearance-settings.json`, v1 shape.

Cluster mapping applied during migration:

| Cluster       | Hexes                                                                                   | Token                                      |
| ------------- | --------------------------------------------------------------------------------------- | ------------------------------------------ |
| Reds          | #ef4444 #ff4444 #e74c3c #ff6b6b #f87171 #e53935 #e53e3e #e5484d #c62828 #ff6666 #fca5a5 | `--c-error` (+ `*-subtle`/`*-glow` tints)  |
| Greens        | #22c55e #10b981 #34d399 #4caf50 #4ade80 #30a46c                                         | `--c-success`                              |
| Ambers        | #f59e0b #fbbf24 #f0ad4e #eab308 #ffa500 #ffaa00 #e5a822 #e5a00d #e38934                 | `--c-warning`                              |
| Purples       | #a855f7 #c084fc #7e22ce, rgba(168,85,247,α)                                             | `--c-accent` family, `--c-accent-line`     |
| Info blues    | #3b82f6, #64b4ff                                                                        | `--c-highlight`                            |
| Greys         | #888→fg-muted, #555→fg-subtle, #666→muted, #333/#1a1a1a→border, #2a2a2a→border-strong   |                                            |
| Terminal      | #d4d4d4/#eee→text-terminal, #0c0d10→bg-terminal                                         |                                            |
| On-color      | #000/#fff text on chips                                                                 | `--c-on-*`                                 |
| Washes/scrims | rgba(255,255,255,α) / rgba(0,0,0,.5/.7)                                                 | `--c-wash(-strong)` / `--c-scrim(-strong)` |

## Design decisions

- **7 picked slots, everything derived** — expressiveness (light/pastel themes)
  without asking anyone to hand-pick a 45-value ramp. Rejected: more slots
  (users produce muddy palettes; derivation harmonizes better than hand-picking
  "lowlight" variants), fewer slots (no light themes without bg/fg).
- **Neutrals as bg/fg mixes** — one rule produces a dark ramp on dark themes and
  a light ramp on light themes; percentages calibrated to reproduce the
  historical violet-dark ramp exactly. Rejected: separate light/dark token sets
  (double maintenance, drift).
- **Derivation in JS at apply time** (`web/js/color.js`), not CSS `color-mix()`
  — the harmony generator and contrast checks need the math in JS anyway; one
  derivation system instead of two; no browser-support matrix. The server never
  derives: it echoes the persisted, validated snapshot for first paint.
- **Generator in OKLCH, hand-rolled** — perceptually uniform; HSL rotations
  produce screaming yellows and muddy blues at "equal lightness". No dependency:
  ~150 lines including gamut clamping via chroma reduction. Semantic trio stays
  hue-anchored (green/amber/red families) with lightness/chroma adapted to the
  theme — a pastel theme gets pastel semantics, not pastel "warning blue".
- **`--c-success` de-aliased from accent** — success states were purple because
  of the alias; informational toasts route to accent, confirmations to success.
- **Server-side first-paint injection** — the saved snapshot is inlined as a
  `<style>` after the main.css link (extends the `PSYCHEROS_ACCENT_COLOR`
  env-var override mechanism). Without it, light themes flash dark on every
  load. Env var still wins (hard override, unchanged behavior).
- **Validation is the CSS-injection guard** — the snapshot is user-persisted
  data echoed into a `<style>` tag; POST validation restricts token names to
  `/^--c-[a-z0-9-]+$/` and values to hex/rgba forms. Don't loosen.
- **Self-healing v1→v2** — the server normalizes legacy shapes to a default
  view; the client resolves presets, upgrades to v2, and re-POSTs. No server
  color knowledge, no migration script.
- **Stop button stays warning-linked** — the amber double-tap confirm is a
  safety color; it themes with `--c-warning` but is never re-routed to accent.

## Token / API surface changes

- Tokens: +`--c-highlight` family, +`--c-accent-line`, +`--c-{c}-subtle`/`-glow`
  for semantics, +`--c-on-{c}`, +washes/scrims, +terminal tokens (names
  workspace.css already referenced but were never defined), glass derived from
  bg/fg. `--c-success` becomes a real color. Full table: `design-system.md`.
- `web/js/color.js` (new): `globalThis.ColorMath` — OKLCH/sRGB conversions with
  gamut clamping, mix, contrast ratio, `deriveTokens`, `harmony`,
  `semanticDefaults`, `randomSeed`, `fixContrast`.
- `theme.js`: v2 state
  `{version, source, presetId, slots, generator,
  computed, bgImage, bgBlur, bgOverlayOpacity, glassEnabled}`;
  presets gain full slot sets (+ light showcase presets); new API `setSlots`,
  `applyGenerator`, `exportTheme`, `importTheme`, `getComputed`; legacy API
  (`setPreset`, `setCustomAccent`, …) preserved and writes v2-compatible state.
- Server: `AppearanceSettings` v2 + legacy normalization; first-paint `<style>`
  injection; `<meta theme-color>` from bg.
- Decor: `decor: "none" | "lace" | "stamp"` theme field (legacy `"scallops"`
  migrates to `"lace"`) — body-class-driven, off by default, persisted
  allowlisted server-side. Lace frames the whole user message box (header +
  bubble): alpha-only CSS masks — one-period strip tiles at
  `web/svg/lace-strip-*.svg` repeated along all four edges, disc corner caps —
  recolor with `--c-bubble`. Stamp perforates the bubble only.

## Migration & backwards compat

- v1 appearance JSON loads as: violet default slots, accent from `customAccent`
  if present, `presetId` passed through for the client to resolve. First client
  visit upgrades and re-POSTs the v2 shape.
- Static `tokens.css` defaults now equal the derived violet values (closing the
  pre-existing static/runtime mismatch — first paint no longer shifts).
- launcher-v2's mirrored `tokens.css` gets the new tokens additively (static
  defaults only). No renames — its `--c-state-*` reference `--c-accent`.

## Phasing

1. Docs (this file, template, design-system, CLAUDE.md pointer) + token schema +
   color.js + theme.js v2 + server v2/first-paint. Zero visual change on the
   default theme.
2. CSS migration file-by-file (components → settings → workspace → voice →
   discord → admin/embeddings/graph/layout → templates.ts inline), each its own
   commit with a grep gate.
3. Theme Studio settings UI (presets | generate | custom).

## Test plan

- Gates: `deno check src/main.ts`, `deno lint`, `deno fmt --check`; color.js
  covered by a Deno test (web/js is lint/fmt-excluded) — OKLCH round-trip,
  black/white contrast = 21, known mix/derive values.
- Self-heal: legacy `{preset:"ocean"}` file → reload → accent applies, GET
  returns v2.
- First paint: view-source shows inline `:root` tokens; light preset + CPU
  throttle → no dark flash.
- Per migrated file: `grep -nE '#[0-9a-fA-F]{3,8}'` shows only whitelisted;
  default theme visually identical; re-check under phosphor + a light preset.
- Manual matrix: chat + settings tabs, workspace terminal, voice overlay,
  discord view, admin, graph, embeddings, gallery; stop-btn two-tap (amber),
  success/error toasts, reindex banner, stalled workspace FAB; phone viewport;
  browser chrome follows theme; launcher-v2 webview.

## Risks / gotchas

- Phantom-var swaps in voice.css/templates.ts: fallbacks were the live values —
  preserve computed values, test the call overlay.
- Success de-aliasing changes hue on surfaces that used accent-as-success.
- OKLCH gamut clipping: saturated seeds need chroma reduction or produce invalid
  sRGB.
- Old/new client coexistence: legacy setters must write v2-compatible state so a
  stale tab can't corrupt a saved palette.

## Open questions

- Should presets grow user-defined entries (persist user palettes as named
  presets)? Deferred until the Studio ships.

## Future direction

**Theme packs** — the long-term vision, not a commitment: zipped manifests +
images (decorative overlays, fancy borders, bubble textures, custom cursors —
early-2000s maximalist customization). The palette JSON is the embryo: a pack is
a preset plus named asset slots (`bubbleTexture`, `overlay`, `borderImage`,
`cursor`) growing the same schema; token values would later accept `url(...)`.
Precedents already in the codebase: bgImage upload/list/delete API, hoisted
`jszip`, entity-loom's importable packages. Full tokenization is what makes
packs possible — a pack can only override what routes through tokens.
