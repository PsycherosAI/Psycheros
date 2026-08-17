# Design System

The frontend's color contract. Every color in the UI routes through the `--c-*`
custom properties defined in `web/css/tokens.css` — hardcoded hexes anywhere
else are bugs.

Status: implemented. The palette system's own design doc is
[`theming.md`](theming.md).

## Principles

1. **Tokens only.** No hex/rgba literals in `web/css/**`, `templates.ts` inline
   styles, or JS DOM styling. No `var(--c-x, #fallback)` fallbacks either —
   fallbacks are drift seeds, and `main.css` import order guarantees
   `tokens.css` loads first. The only exemptions are whitelisted below.
2. **Seven picked slots, everything derived.** Users pick bg/fg/accent/
   highlight/success/warning/error; ~45 other tokens derive from those at apply
   time in `web/js/color.js` (`ColorMath.deriveTokens`). CSS files never
   compute.
3. **Semantic-first.** Pick the token by meaning (error? warning? muted?), not
   by the color it happens to be today. Never reuse accent for error states;
   never reuse error for destructive-but-confirmed actions.
4. **Mode-agnostic derivation.** Neutrals are mixes of bg and fg, so the same
   rules produce a dark ramp on dark themes and a light ramp on light themes.

## Picked slots

| Slot       | Token           | Drives                                                           |
| ---------- | --------------- | ---------------------------------------------------------------- |
| Background | `--c-bg`        | page base                                                        |
| Text       | `--c-fg`        | primary text                                                     |
| Accent     | `--c-accent`    | primary interactive: buttons, links, send, badges, active states |
| Highlight  | `--c-highlight` | secondary emphasis: quotes, tags, entity name, info surfaces     |
| Success    | `--c-success`   | confirmations, connected/healthy status                          |
| Warning    | `--c-warning`   | caution: stop-button confirm, toasts asking attention, banners   |
| Alert      | `--c-error`     | errors, destructive, disconnected/failed status                  |

The stop button's double-tap confirm state is warning-linked — it's a safety
color carrying meaning, keep it on `--c-warning`.

## Derived tokens

Computed by `ColorMath.deriveTokens(slots)`; static defaults in `tokens.css`
equal the derived values of the default violet theme (so first paint matches
runtime — historically the static hand-picked values differed from what theme.js
applied moments later).

`mix(a, b, t)` = sRGB lerp. `isDark` = relative luminance of bg < 0.5.
Percentages are calibrated so the default theme reproduces the historical
violet-dark values exactly.

**Accent-collision clearance:** semantic hue families are anchors, not pins —
success 100–190°, warning 40–105°, error −25–45°. When a semantic color lands
within 35° of the accent hue (amber accent vs amber warning, green accent vs
green success), it rotates to the nearest in-family hue that clears the accent,
so interactive vs status stays readable. Without a collision, semantics pass
through untouched.

| Token                          | Derivation                     | Default   |
| ------------------------------ | ------------------------------ | --------- |
| `--c-bg-sunken`                | mix(bg→fg, 0.02)               | `#050505` |
| `--c-bg-raised`                | mix(bg→fg, 0.043)              | `#0a0a0a` |
| `--c-bg-hover`                 | mix(bg→fg, 0.073)              | `#111111` |
| `--c-border`                   | mix(bg→fg, 0.112)              | `#1a1a1a` |
| `--c-border-strong`            | mix(bg→fg, 0.181)              | `#2a2a2a` |
| `--c-fg-muted`, `--c-fg-label` | mix(fg→bg, 0.41)               | `#888888` |
| `--c-fg-subtle`                | mix(fg→bg, 0.63)               | `#555555` |
| `--c-muted`                    | mix(fg→bg, 0.56)               | `#666666` |
| `--c-muted-subtle`             | rgba(muted, 0.1)               |           |
| `--c-fg-strong`                | isDark ? `#ffffff` : `#000000` | `#ffffff` |
| `--c-bg-terminal`              | mix(bg→fg, 0.055)              | `#0d0d0d` |
| `--c-text-terminal`            | mix(fg→bg, 0.086)              | `#d4d4d4` |
| `--c-text-terminal-dim`        | mix(fg→bg, 0.41)               | `#888888` |

Per chromatic color c ∈ {accent, highlight, success, warning, error}:

| Token             | Derivation                                                               |
| ----------------- | ------------------------------------------------------------------------ |
| `--c-{c}-hover`   | isDark ? lighten(c, 0.2) : darken(c, 0.15)                               |
| `--c-{c}-muted`   | isDark ? darken(c, 0.4) : darken(c, 0.25)                                |
| `--c-{c}-subtle`  | rgba(c, 0.08) — tint backgrounds, badges                                 |
| `--c-{c}-glow`    | rgba(c, 0.25) — focus rings, soft shadows                                |
| `--c-accent-line` | rgba(accent, 0.4) — borders/glow lines in accent                         |
| `--c-on-{c}`      | higher-contrast of `#000000`/`#ffffff` against c — text on colored chips |

(All five chromatic colors derive `hover`/`subtle`; `accent`/`highlight`
additionally derive `muted`/`glow`/`line`, and `success`/`warning`/`error`
derive `subtle` at 0.1 and `glow` at 0.4 for status badges.)

Overlays and glass:

| Token              | Derivation                                | Replaces                                  |
| ------------------ | ----------------------------------------- | ----------------------------------------- |
| `--c-wash`         | rgba(fg, 0.05)                            | `rgba(255,255,255,0.05)` surface overlays |
| `--c-wash-strong`  | rgba(fg, 0.1)                             | `rgba(255,255,255,0.1)`                   |
| `--c-bubble`       | isDark ? rgba(0,0,0,0.5) : rgba(fg, 0.06) | user message bubbles                      |
| `--c-scrim`        | rgba(0,0,0,0.5)                           | modal dims (black in both modes)          |
| `--c-scrim-strong` | rgba(0,0,0,0.7)                           |                                           |
| `--c-scrim-heavy`  | rgba(0,0,0,0.92)                          | voice call overlay backdrop               |
| `--glass-bg`       | rgba(bg-raised, 0.85)                     |                                           |
| `--glass-border`   | rgba(fg, 0.08)                            |                                           |

Meta: root `color-scheme` (`dark`/`light`) and `<meta name="theme-color">`
follow the theme so form controls and browser chrome match.

Logo gradient stops (`--c-logo-stop-0..4`) stay exempt — the violet preset ships
the canonical hand-tuned cyan→magenta brand gradient; phosphor (mono-green CRT),
sunset (multi-hue arc), and sweet (pastel arc) carry hand-tuned stops because
their namesakes demand a specific structure. Every other theme derives an
accent-dominant fade (hue within ±25°, the accent at the middle stop,
`ColorMath.logoStops`). When a namesake demands a specific structure, hand-tune
its `logoStops` instead of bending the formula. Derived stops merge into the
computed snapshot, so first paint includes them.

## Theming flow

```
Settings (presets | generator | manual)
  → Theme state {version: 2, source, presetId, slots, generator, computed, bg*, glass}
  → ColorMath.deriveTokens(slots) → computed snapshot (~45 vars)
  → applied by theme.js to :root; snapshot persisted via POST /api/appearance-settings
  → server injects the snapshot as an inline <style> on first paint (no FOUC)
```

The snapshot is validated server-side (token-name and color-value regexes)
before it is ever echoed into a `<style>` tag — that validation is the
CSS-injection guard; don't loosen it.

Legacy saved themes (v1: `preset` + `customAccent`) normalize client-side on
load and re-POST as v2.

## Adding a token

1. Add a static default to `web/css/tokens.css` (name it `--c-<semantic>`).
2. Emit it in `ColorMath.deriveTokens()` (`web/js/color.js`).
3. **Sync the mirror**: `packages/launcher-v2/frontend/styles/tokens.css`
   duplicates our token names so the launcher shares the visual identity — add
   the static default there too. Never rename existing tokens; additive only.
4. If it starts as a hardcoded value somewhere, migrate that usage in the same
   change (grep gate: only whitelisted hexes remain).
5. Add/adjust the row in the table above.

## Exemption whitelist

The only literal colors allowed outside `tokens.css`:

- `--c-logo-stop-*` defaults (canonical brand gradient).
- Discord blurple `#5865f2` / `#c9cdfb` (brand color, not themeable).
- `rgba(0,0,0,α)` inside `box-shadow` / `--shadow` (shadows stay black in both
  modes).
- `--c-scrim`/`--c-scrim-strong` values themselves (defined in tokens.css).
- **Over-media surfaces** (gallery badges, lightbox): white/near-white text and
  white-alpha controls over black scrims sit on top of user images and must not
  flip with the theme — literal `#fff`/`#ccc` and `rgba(255,255,255,α)` are
  allowed there (scrims themselves use `--c-scrim*`).
- Preset swatch chips in settings render `--swatch-color` from preset data —
  that's data, not styling.

## Inventory greps

Run these before and after any styling migration; the delta is the drift:

```bash
grep -rnoE "#[0-9a-fA-F]{3,8}\b" web/css packages/../src/server/templates.ts | sort | uniq -c | sort -rn
grep -rnoE "rgba?\([0-9, .]+\)" web/css src/server/templates.ts | sort | uniq -c | sort -rn
```

## Contrast targets

- `--c-fg` on `--c-bg`: ≥ 7:1 (AAA body text).
- `--c-fg-muted` on `--c-bg`: ≥ 4.5:1.
- `--c-accent`/`--c-highlight` used as text on bg: ≥ 4.5:1 (Theme Studio warns
  live and offers a one-tap lightness fix).
- `--c-on-{c}` on `--c-{c}`: whichever of black/white scores higher.
