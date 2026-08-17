/**
 * Tests for the browser-side theme module's pure color utilities.
 *
 * `theme.js` is loaded as a `<script>` in the browser and attaches its
 * public API to `globalThis.Theme`. We import it as a side-effecting
 * file:// module here; the module gates its `initTheme()` call behind
 * `typeof document !== 'undefined'`, so loading it in Deno populates
 * the global without touching the DOM, localStorage, or the network.
 */

import { assert, assertEquals } from "@std/assert";
import { fromFileUrl } from "@std/path";

const themeJsPath = fromFileUrl(
  new URL("../web/js/theme.js", import.meta.url),
);
await import(`file://${themeJsPath}`);

// deno-lint-ignore no-explicit-any
const Theme = (globalThis as any).Theme as {
  generateLogoStops: (hex: string) => string[] | null;
  hexToRgb: (hex: string) => { r: number; g: number; b: number } | null;
  lighten: (hex: string, pct: number) => string;
  darken: (hex: string, pct: number) => string;
  _normalizeTheme: (raw: unknown) => {
    version: number;
    source: string;
    presetId: string | null;
    slots: Record<string, string>;
    generator: unknown;
    bgBlur?: number;
    decor?: string;
  };
};

Deno.test("generateLogoStops returns 5 hex stops for a valid accent", () => {
  const stops = Theme.generateLogoStops("#a855f7");
  assert(stops !== null);
  assertEquals(stops.length, 5);
  stops.forEach((s) => {
    assert(/^#[0-9a-f]{6}$/i.test(s), `not a hex string: ${s}`);
  });
});

Deno.test("generateLogoStops middle stop equals the accent", () => {
  const accent = "#a855f7";
  const stops = Theme.generateLogoStops(accent);
  assertEquals(stops?.[2]?.toLowerCase(), accent.toLowerCase());
});

Deno.test("generateLogoStops produces a monotonic lightness ramp", () => {
  // For an arbitrary mid-tone color, stop 0 should be lighter than the
  // accent and stop 4 should be darker. We compare the channel sums as
  // a rough proxy for perceived lightness — sufficient for monotonicity.
  const stops = Theme.generateLogoStops("#39ff14");
  assert(stops !== null);
  const brightness = (hex: string) => {
    const rgb = Theme.hexToRgb(hex)!;
    return rgb.r + rgb.g + rgb.b;
  };
  const b = stops.map(brightness);
  assert(b[0] >= b[1], `stop 0 (${b[0]}) should be ≥ stop 1 (${b[1]})`);
  assert(b[1] >= b[2], `stop 1 (${b[1]}) should be ≥ stop 2 (${b[2]})`);
  assert(b[2] >= b[3], `stop 2 (${b[2]}) should be ≥ stop 3 (${b[3]})`);
  assert(b[3] >= b[4], `stop 3 (${b[3]}) should be ≥ stop 4 (${b[4]})`);
});

Deno.test("generateLogoStops returns null for invalid hex input", () => {
  assertEquals(Theme.generateLogoStops("not-a-hex"), null);
  assertEquals(Theme.generateLogoStops(""), null);
});

Deno.test("generateLogoStops handles short-form (no #) prefix", () => {
  // hexToRgb regex tolerates the missing #, so generateLogoStops should
  // accept it too. The middle stop comes back as the original input.
  const stops = Theme.generateLogoStops("a855f7");
  assert(stops !== null);
  assertEquals(stops.length, 5);
  assertEquals(stops[2], "a855f7");
});

Deno.test("generateLogoStops at the extremes — white", () => {
  // Lightening white can't go lighter; darkening produces grays. The
  // ramp degenerates but should still produce 5 valid hex strings.
  const stops = Theme.generateLogoStops("#ffffff");
  assert(stops !== null);
  assertEquals(stops.length, 5);
  assertEquals(stops[0].toLowerCase(), "#ffffff");
});

Deno.test("generateLogoStops at the extremes — black", () => {
  // Darkening black stays black; lightening produces grays.
  const stops = Theme.generateLogoStops("#000000");
  assert(stops !== null);
  assertEquals(stops.length, 5);
  assertEquals(stops[2].toLowerCase(), "#000000");
  assertEquals(stops[4].toLowerCase(), "#000000");
});

// --- v2 state normalization ---

Deno.test("normalizeTheme upgrades v1 preset state to v2 palette", () => {
  const norm = Theme._normalizeTheme({ preset: "ocean" });
  assertEquals(norm.version, 2);
  assertEquals(norm.source, "preset");
  assertEquals(norm.presetId, "ocean");
  assertEquals(norm.slots.accent, "#00d4ff");
  assertEquals(norm.slots.bg, "#000000");
});

Deno.test("normalizeTheme maps v1 customAccent to the manual accent slot", () => {
  const norm = Theme._normalizeTheme({
    preset: "rose",
    customAccent: "#39FF14",
  });
  assertEquals(norm.source, "manual");
  assertEquals(norm.presetId, null);
  assertEquals(norm.slots.accent, "#39ff14");
  // rose's other slots carried over
  assertEquals(norm.slots.highlight, "#00a2a4");
});

Deno.test("normalizeTheme passes v2 state through and matches presets", () => {
  const v2 = {
    version: 2,
    source: "preset",
    presetId: "violet",
    slots: {
      bg: "#000000",
      fg: "#e8e8e8",
      accent: "#a855f7",
      highlight: "#00d4ff",
      success: "#22c55e",
      warning: "#f59e0b",
      error: "#ef4444",
    },
    generator: null,
    computed: null,
    bgImage: null,
    bgBlur: 3,
    bgOverlayOpacity: 0,
    glassEnabled: false,
  };
  const norm = Theme._normalizeTheme(v2);
  assertEquals(norm.presetId, "violet");
  assertEquals(norm.slots.accent, "#a855f7");
  assertEquals(norm.bgBlur, 3);
});

Deno.test("normalizeTheme falls back to defaults on invalid input", () => {
  const norm = Theme._normalizeTheme({ version: 2, slots: { bg: "garbage" } });
  assertEquals(norm.slots.accent, "#a855f7");
  const empty = Theme._normalizeTheme(null);
  assertEquals(empty.source, "preset");
  assertEquals(empty.presetId, "violet");
});

// --- decor ---

Deno.test("normalizeTheme sanitizes the decor field", () => {
  const lace = Theme._normalizeTheme({ version: 2, decor: "lace" });
  assertEquals(lace.decor, "lace");
  const stamp = Theme._normalizeTheme({ version: 2, decor: "stamp" });
  assertEquals(stamp.decor, "stamp");
  // v1 decor id migrates to the renamed style
  const migrated = Theme._normalizeTheme({ version: 2, decor: "scallops" });
  assertEquals(migrated.decor, "lace");
  const bad = Theme._normalizeTheme({ version: 2, decor: "confetti" });
  assertEquals(bad.decor, "none");
  const legacy = Theme._normalizeTheme({ preset: "ocean" });
  assertEquals(legacy.decor, "none");
});
