/**
 * Tests for the ColorMath palette-derivation engine (web/js/color.js).
 *
 * `color.js` attaches its API to `globalThis.ColorMath` and never touches
 * the DOM at top level, so importing it here is side-effect safe.
 * Contract: docs/design/design-system.md.
 */

import { assert, assertEquals } from "@std/assert";
import { fromFileUrl } from "@std/path";

const colorJsPath = fromFileUrl(new URL("../web/js/color.js", import.meta.url));
await import(`file://${colorJsPath}`);

// deno-lint-ignore no-explicit-any
const ColorMath = (globalThis as any).ColorMath as {
  DEFAULT_SLOTS: Record<string, string>;
  hexToRgb: (hex: string) => { r: number; g: number; b: number } | null;
  rgbToHex: (r: number, g: number, b: number) => string;
  hexToOklch: (hex: string) => { L: number; C: number; H: number } | null;
  oklchToHex: (L: number, C: number, H: number) => string;
  mix: (a: string, b: string, t: number) => string;
  lighten: (hex: string, pct: number) => string;
  darken: (hex: string, pct: number) => string;
  relLuminance: (hex: string) => number;
  contrastRatio: (a: string, b: string) => number;
  isDarkColor: (hex: string) => boolean;
  onColor: (hex: string) => string;
  deriveTokens: (slots: Record<string, string>) => {
    tokens: Record<string, string>;
    isDark: boolean;
    warnings: { pair: string; ratio: number }[];
    slots: Record<string, string>;
  };
  harmony: (
    seed: string,
    rule: string,
  ) => { accent: string; highlight: string } | null;
  logoStops: (accent: string) => string[] | null;
  semanticDefaults: (
    isDark: boolean,
    softness?: number,
  ) => Record<string, string>;
  randomSeed: () => string;
  fixContrast: (color: string, against: string, target?: number) => string;
};

const HEX_RE = /^#[0-9a-f]{6}$/;

Deno.test("hexToRgb accepts 3/6/8-digit forms, rejects garbage", () => {
  assertEquals(ColorMath.hexToRgb("#fff"), { r: 255, g: 255, b: 255 });
  assertEquals(ColorMath.hexToRgb("a855f7"), { r: 168, g: 85, b: 247 });
  assertEquals(ColorMath.hexToRgb("#a855f7ff")!.r, 168);
  assertEquals(ColorMath.hexToRgb("nope"), null);
  assertEquals(ColorMath.hexToRgb("#12"), null);
});

Deno.test("contrastRatio black/white is 21", () => {
  assertEquals(Math.round(ColorMath.contrastRatio("#000000", "#ffffff")), 21);
});

Deno.test("OKLCH round-trip stays within 1 unit per channel", () => {
  for (
    const hex of [
      "#000000",
      "#ffffff",
      "#a855f7",
      "#f59e0b",
      "#22c55e",
      "#39ff14",
    ]
  ) {
    const { L, C, H } = ColorMath.hexToOklch(hex)!;
    const back = ColorMath.hexToOklch(ColorMath.oklchToHex(L, C, H))!;
    assert(Math.abs(back.L - L) < 0.01, `${hex}: L drift ${back.L - L}`);
    assert(Math.abs(back.C - C) < 0.01, `${hex}: C drift ${back.C - C}`);
    const dh = Math.abs(back.H - H);
    assert(Math.min(dh, 360 - dh) < 2, `${hex}: H drift ${dh}`);
  }
});

Deno.test("oklchToHex clamps out-of-gamut chroma to a valid hex", () => {
  const hex = ColorMath.oklchToHex(0.8, 0.4, 30); // way past sRGB gamut
  assert(HEX_RE.test(hex), `not a hex: ${hex}`);
  const rgb = ColorMath.hexToRgb(hex)!;
  for (const v of [rgb.r, rgb.g, rgb.b]) assert(v >= 0 && v <= 255);
});

Deno.test("mix produces known sRGB lerps", () => {
  assertEquals(ColorMath.mix("#000000", "#e8e8e8", 0.073), "#111111");
  assertEquals(ColorMath.mix("#e8e8e8", "#000000", 0.414), "#888888");
  assertEquals(ColorMath.mix("#e8e8e8", "#000000", 0.56), "#666666");
  assertEquals(ColorMath.mix("#000000", "#e8e8e8", 0), "#000000");
  assertEquals(ColorMath.mix("#000000", "#e8e8e8", 1), "#e8e8e8");
});

Deno.test("deriveTokens(default) matches the static tokens.css calibration", () => {
  // The static defaults in web/css/tokens.css MUST equal the derived output
  // for the default violet slots — this is the first-paint == runtime
  // guarantee. If this test fails after changing a derivation, regenerate
  // the static block in tokens.css (and the launcher-v2 mirror).
  const { tokens, isDark } = ColorMath.deriveTokens(ColorMath.DEFAULT_SLOTS);
  assert(isDark);
  const expected: Record<string, string> = {
    "--c-bg": "#000000",
    "--c-fg": "#e8e8e8",
    "--c-accent": "#a855f7",
    "--c-highlight": "#00d4ff",
    "--c-success": "#22c55e",
    "--c-warning": "#f59e0b",
    "--c-error": "#ef4444",
    "--c-bg-sunken": "#050505",
    "--c-bg-raised": "#0a0a0a",
    "--c-bg-hover": "#111111",
    "--c-border": "#1a1a1a",
    "--c-border-hover": "#222222",
    "--c-border-strong": "#2a2a2a",
    "--c-fg-muted": "#888888",
    "--c-fg-label": "#888888",
    "--c-fg-subtle": "#555555",
    "--c-muted": "#666666",
    "--c-muted-subtle": "rgba(102, 102, 102, 0.1)",
    "--c-fg-strong": "#ffffff",
    "--c-accent-hover": "#b977f9",
    "--c-accent-muted": "#653394",
    "--c-accent-subtle": "rgba(168, 85, 247, 0.08)",
    "--c-accent-glow": "rgba(168, 85, 247, 0.25)",
    "--c-accent-line": "rgba(168, 85, 247, 0.4)",
    "--c-highlight-hover": "#33ddff",
    "--c-highlight-subtle": "rgba(0, 212, 255, 0.08)",
    "--c-success-hover": "#4ed17e",
    "--c-success-subtle": "rgba(34, 197, 94, 0.1)",
    "--c-success-glow": "rgba(34, 197, 94, 0.4)",
    "--c-warning-hover": "#f7b13c",
    "--c-warning-subtle": "rgba(245, 158, 11, 0.1)",
    "--c-warning-glow": "rgba(245, 158, 11, 0.4)",
    "--c-error-hover": "#f26969",
    "--c-error-subtle": "rgba(239, 68, 68, 0.1)",
    "--c-error-glow": "rgba(239, 68, 68, 0.4)",
    "--c-on-accent": "#000000",
    "--c-on-highlight": "#000000",
    "--c-on-success": "#000000",
    "--c-on-warning": "#000000",
    "--c-on-error": "#000000",
    "--c-bg-terminal": "#0d0d0d",
    "--c-text-terminal": "#d4d4d4",
    "--c-text-terminal-dim": "#888888",
    "--c-wash": "rgba(232, 232, 232, 0.05)",
    "--c-wash-strong": "rgba(232, 232, 232, 0.1)",
    "--c-bubble": "rgba(0, 0, 0, 0.5)",
    "--c-scrim": "rgba(0, 0, 0, 0.5)",
    "--c-scrim-strong": "rgba(0, 0, 0, 0.7)",
    "--c-scrim-heavy": "rgba(0, 0, 0, 0.92)",
    "--glass-bg": "rgba(10, 10, 10, 0.85)",
    "--glass-border": "rgba(232, 232, 232, 0.08)",
  };
  for (const [k, v] of Object.entries(expected)) {
    assertEquals(tokens[k], v, `token ${k}`);
  }
});

Deno.test("deriveTokens flips for light themes", () => {
  const { tokens, isDark } = ColorMath.deriveTokens({
    ...ColorMath.DEFAULT_SLOTS,
    bg: "#fdf0f5",
    fg: "#2a1e28",
  });
  assert(!isDark);
  assertEquals(tokens["--c-fg-strong"], "#000000");
  assertEquals(tokens["--c-bubble"], "rgba(42, 30, 40, 0.06)");
  // neutral ramp must land between bg and fg
  const ramp = [
    tokens["--c-bg-sunken"],
    tokens["--c-bg-raised"],
    tokens["--c-bg-hover"],
    tokens["--c-border"],
    tokens["--c-border-strong"],
  ];
  const lum = ramp.map((h: string) => ColorMath.relLuminance(h));
  for (let i = 1; i < lum.length; i++) {
    assert(lum[i] <= lum[i - 1] + 1e-9, `light ramp not monotonic at ${i}`);
  }
});

Deno.test("deriveTokens reports low-contrast warnings", () => {
  const { warnings } = ColorMath.deriveTokens({
    ...ColorMath.DEFAULT_SLOTS,
    bg: "#f0f0f0",
    fg: "#e8e8e8", // text nearly invisible on bg
  });
  assert(warnings.some((w) => w.pair === "fg/bg"));
});

Deno.test("deriveTokens falls back to default slots on invalid input", () => {
  const { tokens } = ColorMath.deriveTokens({ bg: "garbage" });
  assertEquals(tokens["--c-accent"], "#a855f7");
});

Deno.test("harmony rotates the seed and keeps the accent", () => {
  const analogous = ColorMath.harmony("#a855f7", "analogous")!;
  assertEquals(analogous.accent, "#a855f7");
  assert(HEX_RE.test(analogous.highlight));
  const complementary = ColorMath.harmony("#a855f7", "complementary")!;
  assert(analogous.highlight !== complementary.highlight);
  assertEquals(ColorMath.harmony("#a855f7", "nope"), null);
  assertEquals(ColorMath.harmony("zzz", "analogous"), null);
});

Deno.test("semanticDefaults anchor hue families and adapt to mode", () => {
  const dark = ColorMath.semanticDefaults(true);
  const light = ColorMath.semanticDefaults(false);
  for (const trio of [dark, light]) {
    for (const key of ["success", "warning", "error"]) {
      assert(HEX_RE.test(trio[key]), `${key} not hex: ${trio[key]}`);
    }
    // hue anchoring: green/warning/red stay in their families
    const g = ColorMath.hexToOklch(trio.success)!.H;
    assert(g > 100 && g < 190, `success hue drifted: ${g}`);
    const a = ColorMath.hexToOklch(trio.warning)!.H;
    assert(a > 45 && a < 105, `warning hue drifted: ${a}`);
    const r = ColorMath.hexToOklch(trio.error)!.H;
    assert(r < 45 || r > 340, `error hue drifted: ${r}`);
  }
  assert(dark.success !== light.success);
});

Deno.test("randomSeed returns distinct valid hexes", () => {
  const seeds = new Set(
    Array.from({ length: 12 }, () => ColorMath.randomSeed()),
  );
  for (const s of seeds) assert(HEX_RE.test(s), `not hex: ${s}`);
  assert(seeds.size > 1);
});

Deno.test("fixContrast nudges a failing color past the target", () => {
  const bg = "#000000";
  const tooDim = "#1a1a1a"; // ~1.3:1 on black
  const fixed = ColorMath.fixContrast(tooDim, bg, 4.5);
  assert(ColorMath.contrastRatio(fixed, bg) >= 4.4); // one step of rounding slack
  // already-passing colors pass through unchanged
  assertEquals(ColorMath.fixContrast("#ffffff", bg, 4.5), "#ffffff");
});

Deno.test("onColor picks the higher-contrast black/white", () => {
  assertEquals(ColorMath.onColor("#ffffff"), "#000000");
  assertEquals(ColorMath.onColor("#000000"), "#ffffff");
  assertEquals(ColorMath.onColor("#f59e0b"), "#000000");
});

Deno.test("logoStops produces an in-family 5-stop fade", () => {
  for (const accent of ["#00d4ff", "#39ff14", "#f43f5e", "#64748b"]) {
    const stops = ColorMath.logoStops(accent)!;
    assertEquals(stops.length, 5);
    const hues = stops.map((s) => ColorMath.hexToOklch(s)!.H);
    const aH = ColorMath.hexToOklch(accent)!.H;
    // every stop within 30° of the accent hue (accent-dominant fade)
    for (const h of hues) {
      const d = Math.min(Math.abs(h - aH), 360 - Math.abs(h - aH));
      assert(d <= 30, `${accent}: stop hue ${h} too far from accent ${aH}`);
    }
    // the accent itself is the middle stop
    assertEquals(stops[2].toLowerCase(), accent);
    stops.forEach((s) => assert(HEX_RE.test(s), `not hex: ${s}`));
  }
  assertEquals(ColorMath.logoStops("nope"), null);
});

Deno.test("deriveTokens rotates semantics that collide with the accent", () => {
  const h = (hex: string) => ColorMath.hexToOklch(hex)!.H;
  const dist = (a: number, b: number) =>
    Math.min(Math.abs(a - b), 360 - Math.abs(a - b));

  // amber accent == amber warning → warning rotates within its family
  const amber = ColorMath.deriveTokens({
    ...ColorMath.DEFAULT_SLOTS,
    accent: "#f59e0b",
  });
  assert(
    amber.slots.warning !== "#f59e0b",
    "warning should not equal amber accent",
  );
  assert(
    dist(h(amber.slots.warning), h("#f59e0b")) >= 34,
    "warning should clear the accent hue",
  );
  const wH = h(amber.slots.warning);
  assert(wH >= 40 && wH <= 105, `warning left its family: ${wH}`);

  // green accent vs green success → success rotates within its family
  const phosphor = ColorMath.deriveTokens({
    ...ColorMath.DEFAULT_SLOTS,
    accent: "#39ff14",
  });
  assert(
    dist(h(phosphor.slots.success), h("#39ff14")) >= 34,
    "success should clear the green accent",
  );
  const sH = h(phosphor.slots.success);
  assert(sH >= 100 && sH <= 190, `success left its family: ${sH}`);

  // no collision → semantics pass through untouched
  const violet = ColorMath.deriveTokens(ColorMath.DEFAULT_SLOTS);
  assertEquals(violet.slots.success, "#22c55e");
  assertEquals(violet.slots.warning, "#f59e0b");
  assertEquals(violet.slots.error, "#ef4444");
});

Deno.test("collision clearance handles the hue 0°/360° seam", () => {
  // Accent at hue ~356 vs error at hue ~30 are only ~34° apart — the
  // pre-fix code compared window candidates unrotated, missed both, and
  // fell through to the window edge (brick). The rotated frame must nudge
  // the error barely, staying inside the error family.
  const r = ColorMath.deriveTokens({
    ...ColorMath.DEFAULT_SLOTS,
    bg: "#faf2ef",
    fg: "#43262f",
    accent: "#cc6f93",
    error: "#b83a3a",
  });
  const eH = ColorMath.hexToOklch(r.slots.error)!.H;
  const aH = ColorMath.hexToOklch("#cc6f93")!.H;
  const inFamily = eH <= 45 || eH >= 335;
  assert(inFamily, `error left its family: ${eH}`);
  const d = Math.min(Math.abs(eH - aH), 360 - Math.abs(eH - aH));
  assert(d >= 34, `error too close to accent: ${d}`);
  assert(d <= 40, `error moved too far (edge fallback?): ${d}`);
});
