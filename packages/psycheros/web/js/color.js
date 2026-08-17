/**
 * ColorMath — palette derivation engine.
 * Contract: docs/design/design-system.md. Dual-environment safe (no top-level
 * DOM access) so Deno tests can import it directly.
 */

const DEFAULT_SLOTS = {
  bg: '#000000',
  fg: '#e8e8e8',
  accent: '#a855f7',
  highlight: '#00d4ff',
  success: '#22c55e',
  warning: '#f59e0b',
  error: '#ef4444',
};

const HEX_RE = /^#?([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

function hexToRgb(hex) {
  if (typeof hex !== 'string') return null;
  let m = HEX_RE.exec(hex.trim());
  if (!m) return null;
  let h = m[1];
  if (h.length === 3) {
    h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  }
  if (h.length === 8) h = h.slice(0, 6);
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  };
}

function rgbToHex(r, g, b) {
  return '#' + [r, g, b].map((x) => {
    const h = Math.max(0, Math.min(255, Math.round(x))).toString(16);
    return h.length === 1 ? '0' + h : h;
  }).join('');
}

function clamp01(x) {
  return Math.max(0, Math.min(1, x));
}

// --- sRGB <-> linear (transfer function) ---

function srgbToLinear(c) {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function linearToSrgb(c) {
  return c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

// --- OKLab (Björn Ottosson) ---

function linearToOklab(r, g, b) {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return {
    L: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    a: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    b: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  };
}

function oklabToLinear(L, a, b) {
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;
  const l = l_ * l_ * l_;
  const m = m_ * m_ * m_;
  const s = s_ * s_ * s_;
  return {
    r: 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    g: -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    b: -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  };
}

function hexToOklch(hex) {
  const rgb = hexToRgb(hex);
  if (!rgb) return null;
  const lab = linearToOklab(
    srgbToLinear(rgb.r / 255),
    srgbToLinear(rgb.g / 255),
    srgbToLinear(rgb.b / 255),
  );
  const C = Math.sqrt(lab.a * lab.a + lab.b * lab.b);
  let H = Math.atan2(lab.b, lab.a) * 180 / Math.PI;
  if (H < 0) H += 360;
  return { L: lab.L, C, H };
}

// Chroma-reduce an OKLCH color until it fits in sRGB gamut.
function oklchToHex(L, C, H) {
  const rad = H * Math.PI / 180;
  const inGamut = (c) => {
    const { r, g, b } = oklabToLinear(L, Math.cos(rad) * c, Math.sin(rad) * c);
    return [r, g, b].every((v) => v >= -1e-4 && v <= 1 + 1e-4);
  };
  let chroma = C;
  if (!inGamut(chroma)) {
    let lo = 0;
    let hi = chroma;
    for (let i = 0; i < 22; i++) {
      const mid = (lo + hi) / 2;
      if (inGamut(mid)) lo = mid;
      else hi = mid;
    }
    chroma = lo;
  }
  const { r, g, b } = oklabToLinear(L, Math.cos(rad) * chroma, Math.sin(rad) * chroma);
  return rgbToHex(
    linearToSrgb(clamp01(r)) * 255,
    linearToSrgb(clamp01(g)) * 255,
    linearToSrgb(clamp01(b)) * 255,
  );
}

// --- basic ops (sRGB space) ---

function mix(a, b, t) {
  const A = hexToRgb(a);
  const B = hexToRgb(b);
  if (!A || !B) return a;
  return rgbToHex(A.r + (B.r - A.r) * t, A.g + (B.g - A.g) * t, A.b + (B.b - A.b) * t);
}

function lighten(hex, percent) {
  return mix(hex, '#ffffff', percent);
}

function darken(hex, percent) {
  return mix(hex, '#000000', percent);
}

function rgbaStr(hex, alpha) {
  const c = hexToRgb(hex);
  return c ? `rgba(${c.r}, ${c.g}, ${c.b}, ${alpha})` : hex;
}

// --- contrast ---

function relLuminance(hex) {
  const c = hexToRgb(hex);
  if (!c) return 0;
  const [r, g, b] = [c.r, c.g, c.b].map((v) => srgbToLinear(v / 255));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(a, b) {
  const la = relLuminance(a);
  const lb = relLuminance(b);
  const hi = Math.max(la, lb);
  const lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}

function onColor(hex) {
  return contrastRatio(hex, '#000000') >= contrastRatio(hex, '#ffffff')
    ? '#000000'
    : '#ffffff';
}

function isDarkColor(hex) {
  return relLuminance(hex) < 0.5;
}

// --- derivation: the design-system table ---

// Semantic hue families — anchors, not pins. When a semantic color lands
// too close to the accent (e.g. an amber accent vs the amber warning, a
// green accent vs the green success), rotate it to the nearest in-family
// hue that clears the accent, so interactive vs status stays readable.
const SEMANTIC_HUE_WINDOWS = {
  success: [100, 190],
  warning: [40, 105],
  error: [-25, 45],
};
const SEMANTIC_CLEARANCE = 35;

function hueDelta(a, b) {
  const d = Math.abs(a - b) % 360;
  return Math.min(d, 360 - d);
}

function avoidAccentCollision(hex, accentHue, window) {
  const c = hexToOklch(hex);
  if (!c) return hex;
  if (hueDelta(c.H, accentHue) >= SEMANTIC_CLEARANCE) return hex;
  // Work in a frame rotated to the window's center so hues near the 0°/360°
  // seam compare correctly (accent 356° + clearance must land near 31°, not
  // fall through to a window edge).
  const [lo, hi] = window;
  const center = (lo + hi) / 2;
  const rel = (h) => {
    let d = (h - center) % 360;
    if (d > 180) d -= 360;
    if (d < -180) d += 360;
    return d;
  };
  const rlo = lo - center;
  const rhi = hi - center;
  const aRel = rel(accentHue);
  const cRel = rel(c.H);
  const options = [aRel - SEMANTIC_CLEARANCE, aRel + SEMANTIC_CLEARANCE]
    .filter((h) => h >= rlo && h <= rhi);
  let targetRel;
  if (options.length > 0) {
    options.sort((a, b) => Math.abs(a - cRel) - Math.abs(b - cRel));
    targetRel = options[0];
  } else {
    targetRel = Math.abs(rlo - aRel) >= Math.abs(rhi - aRel) ? rlo : rhi;
  }
  return oklchToHex(c.L, c.C, ((targetRel + center) % 360 + 360) % 360);
}

function deriveTokens(slotInput) {
  const warnings = [];
  const slots = { ...DEFAULT_SLOTS };
  for (const k of Object.keys(slots)) {
    const rgb = hexToRgb(slotInput?.[k] ?? '');
    if (rgb) slots[k] = rgbToHex(rgb.r, rgb.g, rgb.b);
    else warnings.push({ pair: `slot:${k}`, ratio: 0 });
  }

  const accentHue = hexToOklch(slots.accent)?.H;
  if (accentHue !== undefined) {
    for (const sem of ['success', 'warning', 'error']) {
      slots[sem] = avoidAccentCollision(
        slots[sem],
        accentHue,
        SEMANTIC_HUE_WINDOWS[sem],
      );
    }
  }

  const isDark = isDarkColor(slots.bg);
  const tokens = {
    '--c-bg': slots.bg,
    '--c-fg': slots.fg,
    '--c-accent': slots.accent,
    '--c-highlight': slots.highlight,
    '--c-success': slots.success,
    '--c-warning': slots.warning,
    '--c-error': slots.error,
  };

  tokens['--c-bg-sunken'] = mix(slots.bg, slots.fg, 0.02);
  tokens['--c-bg-raised'] = mix(slots.bg, slots.fg, 0.043);
  tokens['--c-bg-hover'] = mix(slots.bg, slots.fg, 0.073);
  tokens['--c-border'] = mix(slots.bg, slots.fg, 0.112);
  tokens['--c-border-hover'] = mix(slots.bg, slots.fg, 0.145);
  tokens['--c-border-strong'] = mix(slots.bg, slots.fg, 0.181);
  tokens['--c-fg-muted'] = mix(slots.fg, slots.bg, 0.414);
  tokens['--c-fg-label'] = tokens['--c-fg-muted'];
  tokens['--c-fg-subtle'] = mix(slots.fg, slots.bg, 0.633);
  tokens['--c-muted'] = mix(slots.fg, slots.bg, 0.56);
  tokens['--c-muted-subtle'] = rgbaStr(tokens['--c-muted'], 0.1);
  tokens['--c-fg-strong'] = isDark ? '#ffffff' : '#000000';

  tokens['--c-accent-hover'] = isDark ? lighten(slots.accent, 0.2) : darken(slots.accent, 0.15);
  tokens['--c-accent-muted'] = isDark ? darken(slots.accent, 0.4) : darken(slots.accent, 0.25);
  tokens['--c-accent-subtle'] = rgbaStr(slots.accent, 0.08);
  tokens['--c-accent-glow'] = rgbaStr(slots.accent, 0.25);
  tokens['--c-accent-line'] = rgbaStr(slots.accent, 0.4);

  tokens['--c-highlight-hover'] = isDark
    ? lighten(slots.highlight, 0.2)
    : darken(slots.highlight, 0.15);
  tokens['--c-highlight-subtle'] = rgbaStr(slots.highlight, 0.08);

  for (const sem of ['success', 'warning', 'error']) {
    tokens[`--c-${sem}-hover`] = isDark
      ? lighten(slots[sem], 0.2)
      : darken(slots[sem], 0.15);
    tokens[`--c-${sem}-subtle`] = rgbaStr(slots[sem], 0.1);
    tokens[`--c-${sem}-glow`] = rgbaStr(slots[sem], 0.4);
    tokens[`--c-on-${sem}`] = onColor(slots[sem]);
  }
  tokens['--c-on-accent'] = onColor(slots.accent);
  tokens['--c-on-highlight'] = onColor(slots.highlight);

  tokens['--c-bg-terminal'] = mix(slots.bg, slots.fg, 0.055);
  tokens['--c-text-terminal'] = mix(slots.fg, slots.bg, 0.086);
  tokens['--c-text-terminal-dim'] = mix(slots.fg, slots.bg, 0.414);

  tokens['--c-wash'] = rgbaStr(slots.fg, 0.05);
  tokens['--c-wash-strong'] = rgbaStr(slots.fg, 0.1);
  tokens['--c-bubble'] = isDark ? 'rgba(0, 0, 0, 0.5)' : rgbaStr(slots.fg, 0.06);
  tokens['--c-scrim'] = 'rgba(0, 0, 0, 0.5)';
  tokens['--c-scrim-strong'] = 'rgba(0, 0, 0, 0.7)';
  tokens['--c-scrim-heavy'] = 'rgba(0, 0, 0, 0.92)';

  tokens['--glass-bg'] = rgbaStr(tokens['--c-bg-raised'], 0.85);
  tokens['--glass-border'] = rgbaStr(slots.fg, 0.08);

  const pairs = [
    { pair: 'fg/bg', a: slots.fg, b: slots.bg, min: 4.5 },
    { pair: 'accent/bg', a: slots.accent, b: slots.bg, min: 3 },
    { pair: 'highlight/bg', a: slots.highlight, b: slots.bg, min: 3 },
    { pair: 'on-accent/accent', a: tokens['--c-on-accent'], b: slots.accent, min: 4.5 },
  ];
  for (const p of pairs) {
    const ratio = contrastRatio(p.a, p.b);
    if (ratio < p.min) warnings.push({ pair: p.pair, ratio: Math.round(ratio * 10) / 10 });
  }

  return { tokens, isDark, warnings, slots };
}

// --- harmony generation (OKLCH hue rotation) ---

const HARMONY_RULES = {
  analogous: 30,
  complementary: 180,
  triadic: 120,
  tetradic: 90,
};

function harmony(seed, rule) {
  const seedOklch = hexToOklch(seed);
  if (!seedOklch || !(rule in HARMONY_RULES)) return null;
  const hue = (seedOklch.H + HARMONY_RULES[rule] + 360) % 360;
  return {
    accent: seed,
    highlight: oklchToHex(seedOklch.L, Math.min(seedOklch.C, 0.18), hue),
  };
}

// 5-stop brand-mark gradient, accent-dominant: the accent hue stays within
// ±25° across all stops (the accent itself is stop 2), sweeping bright →
// deep with chroma held rich toward the end — a luminous fade in the
// theme's own color instead of accent-to-dark or a hue excursion.
function logoStops(accent) {
  const a = hexToOklch(accent);
  if (!a) return null;
  const spec = [
    { dH: -20, dL: 0.18, cM: 0.95 },
    { dH: -10, dL: 0.09, cM: 1.0 },
    { dH: 0, dL: 0, cM: 1.0 },
    { dH: 15, dL: -0.06, cM: 1.1 },
    { dH: 25, dL: -0.11, cM: 1.2 },
  ];
  return spec.map(({ dH, dL, cM }) =>
    oklchToHex(
      Math.min(0.97, Math.max(0.15, a.L + dL)),
      Math.max(0.02, a.C * cM),
      (a.H + dH + 360) % 360,
    )
  );
}

// Hue-anchored semantic trio, lightness adapted to the theme mode.
function semanticDefaults(isDark, softness = 0) {
  const anchors = [
    { key: 'success', hue: 145, L: isDark ? 0.68 : 0.55, C: 0.16 },
    { key: 'warning', hue: 75, L: isDark ? 0.76 : 0.68, C: 0.16 },
    { key: 'error', hue: 25, L: isDark ? 0.65 : 0.55, C: 0.2 },
  ];
  const out = {};
  for (const a of anchors) {
    const L = Math.min(1, Math.max(0.2, a.L + (isDark ? 1 : -1) * 0.05 * softness));
    out[a.key] = oklchToHex(L, a.C * (1 - 0.45 * softness), a.hue);
  }
  return out;
}

function randomSeed() {
  return oklchToHex(
    0.55 + Math.random() * 0.25,
    0.12 + Math.random() * 0.08,
    Math.random() * 360,
  );
}

function fixContrast(color, against, target = 4.5) {
  const oc = hexToOklch(color);
  const og = hexToOklch(against);
  if (!oc || !og) return color;
  if (contrastRatio(color, against) >= target) return color;
  const direction = og.L > 0.5 ? -1 : 1;
  for (let i = 1; i <= 20; i++) {
    const L = Math.min(1, Math.max(0.1, oc.L + direction * 0.03 * i));
    const candidate = oklchToHex(L, oc.C, oc.H);
    if (contrastRatio(candidate, against) >= target) return candidate;
  }
  return color;
}

globalThis.ColorMath = {
  DEFAULT_SLOTS,
  hexToRgb,
  rgbToHex,
  hexToOklch,
  oklchToHex,
  mix,
  lighten,
  darken,
  relLuminance,
  contrastRatio,
  isDarkColor,
  onColor,
  deriveTokens,
  harmony,
  logoStops,
  semanticDefaults,
  randomSeed,
  fixContrast,
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = globalThis.ColorMath;
}
