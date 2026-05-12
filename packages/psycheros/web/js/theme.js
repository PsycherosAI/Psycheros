/**
 * Theme Management Module
 * Handles theme persistence, color generation, and background customization.
 */

// Storage key for theme preferences
const THEME_KEY = 'psycheros-theme';

// Predefined color themes
const THEMES = {
  phosphor: { accent: '#39ff14', name: 'Phosphor Green' },
  ocean: { accent: '#00d4ff', name: 'Ocean Blue' },
  sunset: { accent: '#ff6b35', name: 'Sunset Orange' },
  violet: { accent: '#a855f7', name: 'Violet Dream' },
  rose: { accent: '#f43f5e', name: 'Rose' },
  amber: { accent: '#f59e0b', name: 'Amber' },
  mint: { accent: '#10b981', name: 'Mint' },
  slate: { accent: '#64748b', name: 'Slate' },
};

// Default theme configuration
const DEFAULT_THEME = {
  preset: 'violet',
  customAccent: null,
  bgImage: null,
  bgBlur: 0,
  bgOverlayOpacity: 0,
  glassEnabled: false,
};

// Current theme state (in sync with localStorage)
let currentTheme = { ...DEFAULT_THEME };

// =============================================================================
// Color Utilities
// =============================================================================

/**
 * Parse a hex color to RGB components.
 * @param {string} hex - Hex color string (with or without #)
 * @returns {{ r: number, g: number, b: number } | null}
 */
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

/**
 * Convert RGB to hex.
 * @param {number} r - Red (0-255)
 * @param {number} g - Green (0-255)
 * @param {number} b - Blue (0-255)
 * @returns {string} Hex color string with #
 */
function rgbToHex(r, g, b) {
  return '#' + [r, g, b].map((x) => {
    const hex = Math.max(0, Math.min(255, Math.round(x))).toString(16);
    return hex.length === 1 ? '0' + hex : hex;
  }).join('');
}

/**
 * Lighten a color by a percentage.
 * @param {string} hex - Hex color
 * @param {number} percent - Lighten amount (0-1)
 * @returns {string} Lightened hex color
 */
function lighten(hex, percent) {
  const rgb = hexToRgb(hex);
  if (!rgb) return hex;
  return rgbToHex(
    rgb.r + (255 - rgb.r) * percent,
    rgb.g + (255 - rgb.g) * percent,
    rgb.b + (255 - rgb.b) * percent
  );
}

/**
 * Darken a color by a percentage.
 * @param {string} hex - Hex color
 * @param {number} percent - Darken amount (0-1)
 * @returns {string} Darkened hex color
 */
function darken(hex, percent) {
  const rgb = hexToRgb(hex);
  if (!rgb) return hex;
  return rgbToHex(
    rgb.r * (1 - percent),
    rgb.g * (1 - percent),
    rgb.b * (1 - percent)
  );
}

/**
 * Generate accent color variants from a base hex color.
 * @param {string} hex - Base accent color
 * @returns {{ accent: string, hover: string, muted: string, subtle: string, glow: string }}
 */
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

// =============================================================================
// Theme Application
// =============================================================================

/**
 * Apply theme settings to CSS custom properties.
 * @param {object} theme - Theme configuration object
 */
function applyTheme(theme) {
  const root = document.documentElement;

  // Determine the effective accent color
  const accentColor = theme.customAccent || THEMES[theme.preset]?.accent || THEMES.phosphor.accent;

  // Generate and apply color variants
  const variants = generateColorVariants(accentColor);
  if (variants) {
    root.style.setProperty('--c-accent', variants.accent);
    root.style.setProperty('--c-accent-hover', variants.hover);
    root.style.setProperty('--c-accent-muted', variants.muted);
    root.style.setProperty('--c-accent-subtle', variants.subtle);
    root.style.setProperty('--c-accent-glow', variants.glow);
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
}

/**
 * Save theme to localStorage and persist to server.
 * @param {object} theme - Theme configuration
 */
function saveTheme(theme) {
  try {
    localStorage.setItem(THEME_KEY, JSON.stringify(theme));
  } catch (e) {
    console.warn('Failed to save theme to localStorage:', e);
  }

  // Persist to server (fire-and-forget)
  fetch('/api/appearance-settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(theme),
  }).catch((e) => {
    console.warn('Failed to save theme to server:', e);
  });
}

/**
 * Load theme from localStorage (synchronous fallback).
 * @returns {object} Theme configuration
 */
function loadThemeLocal() {
  try {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved) {
      const parsed = JSON.parse(saved);
      // Merge with defaults to handle new properties
      return { ...DEFAULT_THEME, ...parsed };
    }
  } catch (e) {
    console.warn('Failed to load theme from localStorage:', e);
  }
  return { ...DEFAULT_THEME };
}

/**
 * Initialize theme on page load.
 * Fetches from server first, falls back to localStorage for instant apply.
 */
async function initTheme() {
  // Apply from localStorage immediately for instant rendering
  currentTheme = loadThemeLocal();
  applyTheme(currentTheme);

  // Then try to fetch server-side settings
  try {
    const response = await fetch('/api/appearance-settings');
    if (response.ok) {
      const serverSettings = await response.json();
      const merged = { ...DEFAULT_THEME, ...serverSettings };
      // Only update if server has different data
      if (JSON.stringify(merged) !== JSON.stringify(currentTheme)) {
        currentTheme = merged;
        saveTheme(currentTheme); // Sync localStorage cache with server
        applyTheme(currentTheme);
      }
    }
  } catch (e) {
    // Server unavailable — localStorage values are already applied
    console.warn('Failed to load theme from server, using localStorage:', e);
  }
}

/**
 * Update a specific theme setting.
 * @param {string} key - Theme property name
 * @param {*} value - New value
 */
function setThemeValue(key, value) {
  currentTheme[key] = value;
  saveTheme(currentTheme);
  applyTheme(currentTheme);
}

/**
 * Set the accent color by preset name.
 * @param {string} presetName - Name of the preset theme
 */
function setThemePreset(presetName) {
  if (!THEMES[presetName]) {
    console.warn(`Unknown theme preset: ${presetName}`);
    return;
  }
  currentTheme.preset = presetName;
  currentTheme.customAccent = null; // Clear custom when using preset
  saveTheme(currentTheme);
  applyTheme(currentTheme);
}

/**
 * Set a custom accent color.
 * @param {string} hex - Hex color value
 */
function setCustomAccent(hex) {
  // Validate hex format
  if (!/^#[0-9a-fA-F]{6}$/.test(hex)) {
    console.warn(`Invalid hex color: ${hex}`);
    return;
  }
  currentTheme.customAccent = hex;
  currentTheme.preset = null; // Clear preset when using custom
  saveTheme(currentTheme);
  applyTheme(currentTheme);
}

/**
 * Set the background image.
 * @param {string|null} url - Image URL or null to clear
 */
function setBackgroundImage(url) {
  currentTheme.bgImage = url || null;
  saveTheme(currentTheme);
  applyTheme(currentTheme);
}

/**
 * Set background blur amount.
 * @param {number} blur - Blur in pixels (0-50)
 */
function setBackgroundBlur(blur) {
  currentTheme.bgBlur = Math.max(0, Math.min(50, blur));
  saveTheme(currentTheme);
  applyTheme(currentTheme);
}

/**
 * Set background overlay opacity.
 * @param {number} opacity - Opacity (0-1)
 */
function setBackgroundOverlay(opacity) {
  currentTheme.bgOverlayOpacity = Math.max(0, Math.min(1, opacity));
  saveTheme(currentTheme);
  applyTheme(currentTheme);
}

/**
 * Toggle glass effect.
 * @param {boolean} enabled - Whether glass is enabled
 */
function setGlassEnabled(enabled) {
  currentTheme.glassEnabled = enabled;
  saveTheme(currentTheme);
  applyTheme(currentTheme);
}

/**
 * Reset theme to defaults.
 */
function resetTheme() {
  currentTheme = { ...DEFAULT_THEME };
  saveTheme(currentTheme);
  applyTheme(currentTheme);
}

/**
 * Get current theme settings.
 * @returns {object} Current theme configuration
 */
function getTheme() {
  return { ...currentTheme };
}

/**
 * Get available theme presets.
 * @returns {object} Map of preset names to { accent, name }
 */
function getThemePresets() {
  return { ...THEMES };
}

// =============================================================================
// Background Upload API
// =============================================================================

/**
 * Upload a background image file.
 * @param {File} file - Image file to upload
 * @returns {Promise<{ success: boolean, filename?: string, url?: string, error?: string }>}
 */
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

/**
 * Get list of uploaded background images.
 * @returns {Promise<Array<{ filename: string, url: string }>>}
 */
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

/**
 * Delete an uploaded background image.
 * @param {string} filename - Filename to delete
 * @returns {Promise<{ success: boolean, error?: string }>}
 */
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

  // Theme setters
  setPreset: setThemePreset,
  setCustomAccent: setCustomAccent,
  setBackground: setBackgroundImage,
  setBackgroundBlur,
  setBackgroundOverlay,
  setGlassEnabled,
  reset: resetTheme,

  // Background API
  uploadBackground: uploadBackgroundImage,
  listBackgrounds: listBackgroundImages,
  deleteBackground: deleteBackgroundImage,

  // Color utilities (exposed for debugging/advanced use)
  hexToRgb,
  rgbToHex,
  lighten,
  darken,
  generateColorVariants,
};

// Auto-initialize on load
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initTheme);
} else {
  initTheme();
}
