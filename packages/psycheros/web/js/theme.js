/**
 * Theme Management Module
 * Handles theme persistence, palette derivation, and background customization.
 * Contract: docs/design/design-system.md (theming flow) — 7 picked slots,
 * everything else derived by ColorMath (color.js) at apply time.
 */

// Storage key for theme preferences
const THEME_KEY = 'psycheros-theme';

// Predefined palettes. `slots` are the 7 picked hexes; derived tokens are
// computed at apply time. `logoStops` is an optional hand-tuned 5-stop
// gradient for the brand mark; when absent, stops derive procedurally from
// the accent (ColorMath.logoStops).
const THEMES = {
  phosphor: {
    name: 'Phosphor Green',
    dark: true,
    slots: {
      bg: '#000000',
      fg: '#e8e8e8',
      accent: '#39ff14',
      highlight: '#f6beff',
      success: '#22c55e',
      warning: '#f59e0b',
      error: '#ef4444',
    },
    // hand-tuned: mono-green CRT ramp (the procedural formula drifts teal)
    logoStops: ['#eaffdc', '#b8ffa0', '#70ff52', '#39ff14', '#1fe017'],
  },
  ocean: {
    name: 'Ocean Blue',
    dark: true,
    slots: {
      bg: '#000000',
      fg: '#e8e8e8',
      accent: '#00d4ff',
      highlight: '#ffa586',
      success: '#22c55e',
      warning: '#f59e0b',
      error: '#ef4444',
    },
  },
  sunset: {
    name: 'Sunset Orange',
    dark: true,
    slots: {
      bg: '#000000',
      fg: '#e8e8e8',
      accent: '#ff6b35',
      highlight: '#00b2d6',
      success: '#22c55e',
      warning: '#f59e0b',
      error: '#ef4444',
    },
    // hand-tuned: multi-hue sunset arc
    logoStops: ['#ffe29a', '#ffb45e', '#ff7a3c', '#f2506b', '#cf3e9e'],
  },
  violet: {
    name: 'Violet Dream',
    dark: true,
    slots: {
      bg: '#000000',
      fg: '#e8e8e8',
      accent: '#a855f7',
      highlight: '#00d4ff',
      success: '#22c55e',
      warning: '#f59e0b',
      error: '#ef4444',
    },
    // canonical brand gradient — never regenerate
    logoStops: ['#00D2FF', '#66BEFE', '#A989FD', '#C54EFE', '#D200FF'],
  },
  rose: {
    name: 'Rose',
    dark: true,
    slots: {
      bg: '#000000',
      fg: '#e8e8e8',
      accent: '#f43f5e',
      highlight: '#00a2a4',
      success: '#22c55e',
      warning: '#f59e0b',
      error: '#ef4444',
    },
  },
  amber: {
    name: 'Amber',
    dark: true,
    slots: {
      bg: '#000000',
      fg: '#e8e8e8',
      accent: '#f59e0b',
      highlight: '#74b9ff',
      success: '#22c55e',
      warning: '#f59e0b',
      error: '#ef4444',
    },
  },
  mint: {
    name: 'Mint',
    dark: true,
    slots: {
      bg: '#000000',
      fg: '#e8e8e8',
      accent: '#10b981',
      highlight: '#db74b6',
      success: '#22c55e',
      warning: '#f59e0b',
      error: '#ef4444',
    },
  },
  slate: {
    name: 'Slate',
    dark: true,
    slots: {
      bg: '#000000',
      fg: '#e8e8e8',
      accent: '#64748b',
      highlight: '#807058',
      success: '#22c55e',
      warning: '#f59e0b',
      error: '#ef4444',
    },
  },
  sweet: {
    name: 'Sweet',
    dark: false,
    slots: {
      bg: '#faf2ef',
      fg: '#43262f',
      accent: '#cc6f93',
      highlight: '#5b82b2',
      success: '#6e8f6a',
      warning: '#b08c3e',
      error: '#b83a3a',
    },
    // hand-tuned: pale rose→raspberry arc — hue pinned to the pink family,
    // pale end deep enough to read against the light header
    logoStops: ['#f4d5de', '#edbbca', '#e39cb3', '#d67e9d', '#c05a7f'],
  },
  parchment: {
    name: 'Parchment',
    dark: false,
    slots: {
      bg: '#f3eee3',
      fg: '#33291f',
      accent: '#3a5470',
      highlight: '#7d3440',
      success: '#3e6b4f',
      warning: '#a06b1f',
      error: '#b04a32',
    },
  },
  olive: {
    name: 'Olive',
    dark: false,
    slots: {
      bg: '#edeede',
      fg: '#2f3323',
      accent: '#5f7034',
      highlight: '#a25537',
      success: '#3e6b4f',
      warning: '#a3722a',
      error: '#ab4232',
    },
  },
  beige: {
    name: 'Beige',
    dark: false,
    slots: {
      bg: '#efe9db',
      fg: '#3b3024',
      accent: '#9a7448',
      highlight: '#6e5233',
      success: '#64785a',
      warning: '#a8842e',
      error: '#b45a3c',
    },
  },
};

const SLOT_KEYS = ['bg', 'fg', 'accent', 'highlight', 'success', 'warning', 'error'];
const HEX6_RE = /^#[0-9a-f]{6}$/i;

// Optional decorative flourishes ('none' = off). Driven by
// body[data-decor]; rules in components.css.
const DECOR_IDS = ['none', 'lace', 'stamp'];

// Default theme configuration (v2). `computed` holds the derived-token
// snapshot persisted for server-side first-paint injection.
const DEFAULT_THEME = {
  version: 2,
  source: 'preset', // 'preset' | 'generated' | 'manual'
  presetId: 'violet',
  slots: { ...THEMES.violet.slots },
  generator: null, // {seed, rule, mode, tintNeutrals} when source==='generated'
  computed: null, // {tokens, isDark}
  decor: 'none',
  bgImage: null,
  bgBlur: 0,
  bgOverlayOpacity: 0,
  glassEnabled: false,
};

// Current theme state (in sync with localStorage)
let currentTheme = JSON.parse(JSON.stringify(DEFAULT_THEME));

// =============================================================================
// Color Utilities (legacy surface — ColorMath in color.js is the engine)
// =============================================================================

function hexToRgb(hex) {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return result
    ? {
        r: parseInt(result[1], 16),
        g: parseInt(result[2], 16),
        b: parseInt(result[3], 16),
      }
    : null;
}

function rgbToHex(r, g, b) {
  return '#' + [r, g, b].map((x) => {
    const hex = Math.max(0, Math.min(255, Math.round(x))).toString(16);
    return hex.length === 1 ? '0' + hex : hex;
  }).join('');
}

function lighten(hex, percent) {
  const rgb = hexToRgb(hex);
  if (!rgb) return hex;
  return rgbToHex(
    rgb.r + (255 - rgb.r) * percent,
    rgb.g + (255 - rgb.g) * percent,
    rgb.b + (255 - rgb.b) * percent
  );
}

function darken(hex, percent) {
  const rgb = hexToRgb(hex);
  if (!rgb) return hex;
  return rgbToHex(
    rgb.r * (1 - percent),
    rgb.g * (1 - percent),
    rgb.b * (1 - percent)
  );
}

function generateColorVariants(hex) {
  const rgb = hexToRgb(hex);
  if (!rgb) return null;

  return {
    accent: hex,
    hover: lighten(hex, 0.2),
    muted: darken(hex, 0.4),
    subtle: `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.08)`,
    glow: `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.25)`,
  };
}

/**
 * Derive a 5-stop logo gradient from any accent hex as a single-hue
 * lightness ramp (see tokens.css logo-stop notes).
 */
function generateLogoStops(hex) {
  if (!hexToRgb(hex)) return null;
  return [
    lighten(hex, 0.30),
    lighten(hex, 0.15),
    hex,
    darken(hex, 0.20),
    darken(hex, 0.40),
  ];
}

// =============================================================================
// State normalization
// =============================================================================

function sanitizeSlots(input) {
  if (!input || typeof input !== 'object') return null;
  const out = {};
  for (const key of SLOT_KEYS) {
    const v = input[key];
    if (typeof v !== 'string' || !HEX6_RE.test(v)) return null;
    out[key] = v.toLowerCase();
  }
  return out;
}

function matchPreset(slots) {
  for (const [id, preset] of Object.entries(THEMES)) {
    if (SLOT_KEYS.every((k) => preset.slots[k].toLowerCase() === slots[k])) {
      return id;
    }
  }
  return null;
}

/**
 * Normalize any persisted shape (v1 accent-only or v2 palette) to v2.
 * v1: `preset` + `customAccent` — customAccent maps to the accent slot on
 * the preset's (or default) neutrals.
 */
function normalizeTheme(raw) {
  const base = JSON.parse(JSON.stringify(DEFAULT_THEME));
  if (!raw || typeof raw !== 'object') return base;

  const norm = {
    ...base,
    bgImage: typeof raw.bgImage === 'string' ? raw.bgImage : null,
    bgBlur: Number.isFinite(raw.bgBlur) ? raw.bgBlur : 0,
    bgOverlayOpacity: Number.isFinite(raw.bgOverlayOpacity) ? raw.bgOverlayOpacity : 0,
    glassEnabled: !!raw.glassEnabled,
  };

  if (raw.decor === 'scallops') raw = { ...raw, decor: 'lace' };
  norm.decor = DECOR_IDS.includes(raw.decor) ? raw.decor : 'none';

  if (raw.version === 2) {
    const slots = sanitizeSlots(raw.slots);
    if (slots) {
      norm.slots = slots;
      norm.source = ['preset', 'generated', 'manual'].includes(raw.source)
        ? raw.source
        : 'manual';
      norm.presetId = norm.source === 'preset' && THEMES[raw.presetId]
        ? raw.presetId
        : matchPreset(slots);
      if (!norm.presetId && norm.source === 'preset') norm.source = 'manual';
      norm.generator = norm.source === 'generated' && raw.generator &&
          typeof raw.generator === 'object'
        ? {
            seed: String(raw.generator.seed || ''),
            rule: String(raw.generator.rule || 'analogous'),
            mode: raw.generator.mode === 'light' ? 'light' : 'dark',
            tintNeutrals: Number.isFinite(raw.generator.tintNeutrals)
              ? raw.generator.tintNeutrals
              : 0,
          }
        : null;
    }
    // invalid slots → keep defaults
  } else {
    // v1 legacy
    const presetId = raw.preset && THEMES[raw.preset] ? raw.preset : null;
    const custom = typeof raw.customAccent === 'string' && HEX6_RE.test(raw.customAccent)
      ? raw.customAccent.toLowerCase()
      : null;
    norm.slots = { ...(presetId ? THEMES[presetId].slots : THEMES.violet.slots) };
    if (custom) {
      norm.slots.accent = custom;
      norm.source = 'manual';
      norm.presetId = null;
    } else {
      norm.source = 'preset';
      norm.presetId = presetId || 'violet';
    }
  }
  return norm;
}

// =============================================================================
// Theme Application
// =============================================================================

function applyTheme(theme) {
  const root = document.documentElement;
  let derived = null;

  if (theme.slots && globalThis.ColorMath) {
    derived = ColorMath.deriveTokens(theme.slots);
    for (const [key, value] of Object.entries(derived.tokens)) {
      root.style.setProperty(key, value);
    }
    root.style.setProperty('--theme-mode', derived.isDark ? 'dark' : 'light');
    root.style.setProperty('color-scheme', derived.isDark ? 'dark' : 'light');
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', theme.slots.bg);
  } else {
    // Safety net: accent-only application (pre-v2 state without ColorMath).
    const accentColor = theme.slots?.accent ||
      THEMES[theme.presetId]?.slots.accent || THEMES.violet.slots.accent;
    const variants = generateColorVariants(accentColor);
    if (variants) {
      root.style.setProperty('--c-accent', variants.accent);
      root.style.setProperty('--c-accent-hover', variants.hover);
      root.style.setProperty('--c-accent-muted', variants.muted);
      root.style.setProperty('--c-accent-subtle', variants.subtle);
      root.style.setProperty('--c-accent-glow', variants.glow);
    }
  }

  if (derived) {
    theme.computed = { tokens: derived.tokens, isDark: derived.isDark };
  }

  // Logo gradient stops. Preset's hand-tuned logoStops win when using that
  // preset verbatim; otherwise derive an analogous spread around the accent
  // (ColorMath.logoStops). Stops merge into the computed snapshot so the
  // server-side first-paint <style> includes them (no violet flash on the
  // splash logo for other themes).
  const accentColor = theme.slots?.accent || THEMES.violet.slots.accent;
  const presetStops = theme.source === 'preset' && theme.presetId
    ? THEMES[theme.presetId]?.logoStops
    : null;
  const logoStops = presetStops ||
    (globalThis.ColorMath
      ? ColorMath.logoStops(accentColor)
      : generateLogoStops(accentColor));
  if (logoStops && logoStops.length === 5) {
    logoStops.forEach((stop, i) => {
      root.style.setProperty(`--c-logo-stop-${i}`, stop);
      if (theme.computed?.tokens) {
        theme.computed.tokens[`--c-logo-stop-${i}`] = stop;
      }
    });
  }

  // Apply background image settings
  if (theme.bgImage) {
    root.style.setProperty('--bg-image', `url(${theme.bgImage})`);
    root.style.setProperty('--bg-image-url', theme.bgImage);
    document.body.classList.add('has-bg-image');
  } else {
    root.style.setProperty('--bg-image', 'none');
    root.style.setProperty('--bg-image-url', '');
    document.body.classList.remove('has-bg-image');
  }

  root.style.setProperty('--bg-blur', `${theme.bgBlur}px`);
  root.style.setProperty('--bg-overlay-opacity', theme.bgOverlayOpacity.toString());

  // Apply glass effect
  if (theme.glassEnabled && theme.bgImage) {
    document.body.classList.add('glass-enabled');
  } else {
    document.body.classList.remove('glass-enabled');
  }

  document.body.dataset.decor = theme.decor || 'none';
}

/**
 * Set an optional decor ('none' | 'scallops').
 * @param {string} id
 */
function setDecor(id) {
  if (!DECOR_IDS.includes(id)) return;
  currentTheme.decor = id;
  applyAndSave();
}

/**
 * Save theme to localStorage and persist to server.
 */
function saveTheme(theme) {
  try {
    localStorage.setItem(THEME_KEY, JSON.stringify(theme));
  } catch (e) {
    console.warn('Failed to save theme to localStorage:', e);
  }

  fetch('/api/appearance-settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(theme),
  }).catch((e) => {
    console.warn('Failed to save theme to server:', e);
  });
}

function applyAndSave() {
  applyTheme(currentTheme);
  saveTheme(currentTheme);
}

/**
 * Load theme from localStorage (synchronous fallback).
 */
function loadThemeLocal() {
  try {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved) return JSON.parse(saved);
  } catch (e) {
    console.warn('Failed to load theme from localStorage:', e);
  }
  return null;
}

/**
 * Initialize theme on page load. Server settings are authoritative; if the
 * server still holds a v1 shape, the normalized v2 state is re-POSTed so
 * the stored file self-heals.
 */
async function initTheme() {
  currentTheme = normalizeTheme(loadThemeLocal());
  applyTheme(currentTheme);

  try {
    const response = await fetch('/api/appearance-settings');
    if (response.ok) {
      const serverSettings = await response.json();
      const normalized = normalizeTheme(serverSettings);
      if (serverSettings.version !== 2) {
        // self-heal legacy server data
        currentTheme = normalized;
        applyTheme(currentTheme);
        saveTheme(currentTheme);
      } else if (JSON.stringify(normalized) !== JSON.stringify(currentTheme)) {
        currentTheme = normalized;
        applyTheme(currentTheme);
        saveTheme(currentTheme); // sync localStorage cache with server
      }
    }
  } catch (e) {
    console.warn('Failed to load theme from server, using localStorage:', e);
  }
}

// =============================================================================
// Setters
// =============================================================================

function setThemePreset(presetName) {
  if (!THEMES[presetName]) {
    console.warn(`Unknown theme preset: ${presetName}`);
    return;
  }
  currentTheme.slots = { ...THEMES[presetName].slots };
  currentTheme.source = 'preset';
  currentTheme.presetId = presetName;
  currentTheme.generator = null;
  applyAndSave();
}

function setCustomAccent(hex) {
  if (!HEX6_RE.test(hex)) {
    console.warn(`Invalid hex color: ${hex}`);
    return;
  }
  currentTheme.slots = { ...currentTheme.slots, accent: hex.toLowerCase() };
  currentTheme.source = 'manual';
  currentTheme.presetId = null;
  currentTheme.generator = null;
  applyAndSave();
}

/**
 * Set the full 7-slot palette manually.
 * @param {object} slots - {bg, fg, accent, highlight, success, warning, error}
 * @param {string} [source] - 'manual' (default)
 */
function setSlots(slots, source = 'manual') {
  const clean = sanitizeSlots(slots);
  if (!clean) {
    console.warn('Theme.setSlots: invalid slots');
    return;
  }
  currentTheme.slots = clean;
  currentTheme.source = source;
  currentTheme.presetId = source === 'preset' ? matchPreset(clean) : null;
  currentTheme.generator = null;
  applyAndSave();
}

/**
 * Generate and apply a palette from a seed color + harmony rule.
 * @param {{seed: string, rule: string, mode: 'dark'|'light', tintNeutrals: number}} gen
 */
function applyGenerator(gen) {
  if (!globalThis.ColorMath) return;
  const seed = HEX6_RE.test(gen?.seed || '') ? gen.seed.toLowerCase() : null;
  if (!seed) {
    console.warn('Theme.applyGenerator: invalid seed');
    return;
  }
  const pair = ColorMath.harmony(seed, gen.rule);
  if (!pair) {
    console.warn(`Theme.applyGenerator: unknown rule ${gen.rule}`);
    return;
  }
  const isDark = gen.mode !== 'light';
  const baseNeutrals = isDark
    ? { bg: '#000000', fg: '#e8e8e8' }
    : { bg: '#f7f4f2', fg: '#292524' };
  const tint = Math.max(0, Math.min(1, Number(gen.tintNeutrals) || 0));
  const bg = ColorMath.mix(baseNeutrals.bg, seed, (isDark ? 0.05 : 0.04) * tint);
  currentTheme.slots = {
    bg,
    fg: baseNeutrals.fg,
    accent: seed,
    highlight: pair.highlight,
    ...ColorMath.semanticDefaults(isDark),
  };
  currentTheme.source = 'generated';
  currentTheme.presetId = null;
  currentTheme.generator = {
    seed,
    rule: gen.rule,
    mode: isDark ? 'dark' : 'light',
    tintNeutrals: tint,
  };
  applyAndSave();
}

/**
 * Export the current theme as shareable JSON.
 * @returns {string}
 */
function exportTheme() {
  return JSON.stringify(currentTheme, null, 2);
}

/**
 * Import a theme (v2 palette JSON or legacy v1 shape).
 * @param {string|object} json
 * @returns {boolean} success
 */
function importTheme(json) {
  try {
    const parsed = typeof json === 'string' ? JSON.parse(json) : json;
    const normalized = normalizeTheme(parsed);
    currentTheme = normalized;
    applyAndSave();
    return true;
  } catch (e) {
    console.warn('Theme.importTheme failed:', e);
    return false;
  }
}

function setBackgroundImage(url) {
  currentTheme.bgImage = url || null;
  applyAndSave();
}

function setBackgroundBlur(blur) {
  currentTheme.bgBlur = Math.max(0, Math.min(50, blur));
  applyAndSave();
}

function setBackgroundOverlay(opacity) {
  currentTheme.bgOverlayOpacity = Math.max(0, Math.min(1, opacity));
  applyAndSave();
}

function setGlassEnabled(enabled) {
  currentTheme.glassEnabled = enabled;
  applyAndSave();
}

function resetTheme() {
  currentTheme = JSON.parse(JSON.stringify(DEFAULT_THEME));
  applyAndSave();
}

// =============================================================================
// Getters
// =============================================================================

/**
 * Get current theme state. Includes v1-compat fields (`preset`,
 * `customAccent`) so pre-Studio settings fragments keep working.
 */
function getTheme() {
  return {
    ...currentTheme,
    preset: currentTheme.source === 'preset' ? currentTheme.presetId : null,
    customAccent: currentTheme.source === 'manual' && !currentTheme.generator
      ? currentTheme.slots.accent
      : null,
  };
}

function getThemePresets() {
  const out = {};
  for (const [id, preset] of Object.entries(THEMES)) {
    out[id] = {
      name: preset.name,
      dark: preset.dark,
      accent: preset.slots.accent,
      slots: { ...preset.slots },
    };
  }
  return out;
}

/**
 * Get the last derived-token snapshot + contrast warnings (for UI chips).
 */
function getComputed() {
  if (!currentTheme.computed && globalThis.ColorMath) {
    const derived = ColorMath.deriveTokens(currentTheme.slots);
    currentTheme.computed = { tokens: derived.tokens, isDark: derived.isDark };
  }
  const warnings = globalThis.ColorMath
    ? ColorMath.deriveTokens(currentTheme.slots).warnings
    : [];
  return { ...currentTheme.computed, warnings };
}

// =============================================================================
// Background Upload API
// =============================================================================

async function uploadBackgroundImage(file) {
  const formData = new FormData();
  formData.append('background', file);

  try {
    const response = await fetch('/api/backgrounds', {
      method: 'POST',
      body: formData,
    });

    const result = await response.json();

    if (response.ok && result.success) {
      return {
        success: true,
        filename: result.filename,
        url: result.url,
      };
    }

    return {
      success: false,
      error: result.error || 'Upload failed',
    };
  } catch (e) {
    return {
      success: false,
      error: e.message,
    };
  }
}

async function listBackgroundImages() {
  try {
    const response = await fetch('/api/backgrounds');
    const result = await response.json();
    return result.backgrounds || [];
  } catch (e) {
    console.warn('Failed to list backgrounds:', e);
    return [];
  }
}

async function deleteBackgroundImage(filename) {
  try {
    const response = await fetch(`/api/backgrounds/${encodeURIComponent(filename)}`, {
      method: 'DELETE',
    });

    const result = await response.json();

    return {
      success: response.ok,
      error: result.error,
    };
  } catch (e) {
    return {
      success: false,
      error: e.message,
    };
  }
}

// =============================================================================
// Global Export
// =============================================================================

globalThis.Theme = {
  // Initialization
  init: initTheme,

  // Theme getters
  get: getTheme,
  getPresets: getThemePresets,
  getComputed,

  // Theme setters
  setPreset: setThemePreset,
  setCustomAccent,
  setSlots,
  setDecor,
  applyGenerator,
  exportTheme,
  importTheme,
  setBackground: setBackgroundImage,
  setBackgroundBlur,
  setBackgroundOverlay,
  setGlassEnabled,
  reset: resetTheme,

  // Background API
  uploadBackground: uploadBackgroundImage,
  listBackgrounds: listBackgroundImages,
  deleteBackground: deleteBackgroundImage,

  // Color utilities (legacy surface; ColorMath is canonical)
  hexToRgb,
  rgbToHex,
  lighten,
  darken,
  generateColorVariants,
  generateLogoStops,

  // Internal (pure; exposed for tests)
  _normalizeTheme: normalizeTheme,
};

// Auto-initialize on load. Gated on `document` so this module can be
// loaded by Deno test runners (which set up the API on `globalThis.Theme`
// but have no DOM) without touching localStorage or firing the
// `/api/appearance-settings` fetch.
if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initTheme);
  } else {
    initTheme();
  }
}
