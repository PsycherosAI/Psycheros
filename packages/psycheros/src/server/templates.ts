/**
 * HTML Templates
 *
 * Server-side template functions for rendering HTML components.
 * Used by routes to serve HTMX-compatible HTML fragments.
 *
 * @module
 */

import type {
  Conversation,
  Message,
  ToolCall,
  ToolResult,
  TurnMetrics,
} from "../types.ts";

/** Get the user's configured display timezone for Intl formatting. */
function getDisplayTZ(): string | undefined {
  return Deno.env.get("PSYCHEROS_DISPLAY_TZ") || Deno.env.get("TZ") ||
    undefined;
}
import type { Lorebook, LorebookEntry } from "../lorebook/mod.ts";
import type {
  LLMConnectionProfile,
  LLMProfileSettings,
  LLMProvider,
  LLMSettings,
} from "../llm/mod.ts";
import type {
  VoiceProfile,
  VoiceSettings,
  VoiceSTTProvider,
  VoiceTTSProvider,
} from "../llm/voice-settings.ts";
import { LLM_PROVIDER_PRESETS, maskApiKey } from "../llm/mod.ts";
import type { DiscordGatewayConfig, DiscordSettings } from "../llm/mod.ts";
import type { ToolsSettings } from "../tools/mod.ts";
import {
  DEFAULT_DISABLED_TOOLS,
  DEPRECATED_TOOLS,
  TOOL_CATEGORIES,
} from "../tools/mod.ts";
import type { Tool } from "../tools/mod.ts";
import { renderMarkdown } from "./markdown.ts";
import { pulseIconSvg } from "../pulse/templates.ts";
import type { ExtractionHealth } from "../mcp-client/mod.ts";
import { getWearableConnectionManager } from "../wearable/mod.ts";
import type { PluginStatus } from "../../../plugin-api/src/mod.ts";
import type { UnmanagedCustomTool } from "../plugins/mod.ts";

// =============================================================================
// Utilities
// =============================================================================

/**
 * Escape HTML special characters to prevent XSS.
 */
export function escapeHtml(text: string): string {
  if (!text) return "";
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

/**
 * Safely parse JSON with a fallback value.
 * Returns the fallback if parsing fails.
 */
function tryJsonParse<T>(text: string, fallback: T): T | unknown {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

/**
 * Type guard for objects with a string command property.
 */
function hasStringCommand(obj: unknown): obj is { command: string } {
  return (
    typeof obj === "object" &&
    obj !== null &&
    "command" in obj &&
    typeof (obj as Record<string, unknown>).command === "string"
  );
}

/**
 * Format a message timestamp for display in the chat UI.
 * Shows time only for today's messages, date + time for older ones.
 * Respects the TZ environment variable for display formatting.
 */
function formatMessageTime(date: Date): string {
  const timeZone = getDisplayTZ();
  const now = new Date();
  const isToday = date.toLocaleDateString("en-US", { timeZone }) ===
    now.toLocaleDateString("en-US", { timeZone });

  if (isToday) {
    return date.toLocaleTimeString("en-US", {
      timeZone,
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    });
  }

  return date.toLocaleDateString("en-US", {
    timeZone,
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

/**
 * Format a date for display.
 * Uses the configured display timezone for both formatting and today/yesterday checks.
 */
function formatDate(date: Date | string): string {
  const d = typeof date === "string" ? new Date(date) : date;
  const tz = getDisplayTZ();

  // Compare dates in the display timezone, not UTC
  const todayStr = new Date().toLocaleDateString("en-US", { timeZone: tz });
  const dateStr = d.toLocaleDateString("en-US", { timeZone: tz });

  if (dateStr === todayStr) {
    return d.toLocaleTimeString([], {
      timeZone: tz,
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayStr = yesterday.toLocaleDateString("en-US", { timeZone: tz });

  if (dateStr === yesterdayStr) {
    return "Yesterday";
  }

  // Use sv-SE locale for sortable YYYY-MM-DD comparison
  const fmt = (dt: Date) =>
    new Intl.DateTimeFormat("sv-SE", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(dt);
  const weekAgo = new Date();
  weekAgo.setDate(weekAgo.getDate() - 7);

  if (fmt(d) >= fmt(weekAgo)) {
    return d.toLocaleDateString([], { timeZone: tz, weekday: "short" });
  }

  return d.toLocaleDateString([], {
    timeZone: tz,
    month: "short",
    day: "numeric",
  });
}

// =============================================================================
// Accent Color Override
// =============================================================================

/**
 * Parse a hex color to RGB components.
 */
function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
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
 */
function rgbToHex(r: number, g: number, b: number): string {
  return "#" + [r, g, b].map((x) => {
    const hex = Math.max(0, Math.min(255, Math.round(x))).toString(16);
    return hex.length === 1 ? "0" + hex : hex;
  }).join("");
}

/**
 * Lighten a color by a percentage.
 */
function lighten(hex: string, percent: number): string {
  const rgb = hexToRgb(hex);
  if (!rgb) return hex;
  return rgbToHex(
    rgb.r + (255 - rgb.r) * percent,
    rgb.g + (255 - rgb.g) * percent,
    rgb.b + (255 - rgb.b) * percent,
  );
}

/**
 * Darken a color by a percentage.
 */
function darken(hex: string, percent: number): string {
  const rgb = hexToRgb(hex);
  if (!rgb) return hex;
  return rgbToHex(
    rgb.r * (1 - percent),
    rgb.g * (1 - percent),
    rgb.b * (1 - percent),
  );
}

/**
 * Generate CSS override for accent color from env var.
 * Returns empty string if no override is set.
 */
function getAccentColorOverride(): string {
  const accentColor = Deno.env.get("PSYCHEROS_ACCENT_COLOR");
  if (!accentColor) return "";

  const rgb = hexToRgb(accentColor);
  if (!rgb) return "";

  const hover = lighten(accentColor, 0.2);
  const muted = darken(accentColor, 0.4);
  const subtle = `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.08)`;
  const glow = `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.25)`;

  return `<style>
  :root {
    --c-accent: ${accentColor};
    --c-accent-hover: ${hover};
    --c-accent-muted: ${muted};
    --c-accent-subtle: ${subtle};
    --c-accent-glow: ${glow};
  }
</style>`;
}

// =============================================================================
// Page Templates
// =============================================================================

/**
 * Render the full app shell HTML.
 * This is served on initial page load.
 */
export function renderAppShell(pluginHeadHtml = ""): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
  <meta name="theme-color" content="#000000">
  <meta name="mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
  <title>Psycheros</title>
  <link rel="stylesheet" href="/css/main.css">
  ${getAccentColorOverride()}
  <link rel="icon" href="/favicon.svg" type="image/svg+xml">
  <link rel="manifest" href="/manifest.json" crossorigin="use-credentials">
  <link rel="apple-touch-icon" href="/icons/apple-touch-icon.svg">
  <script src="/lib/htmx.min.js"></script>
  <script src="/lib/idiomorph-ext.min.js"></script>
  <script src="/lib/htmx-sse.js"></script>
  <script src="/lib/marked.min.js"></script>
  <script src="/lib/dompurify.min.js"></script>
  ${pluginHeadHtml}
</head>
<body>
  <div class="bg-layer"></div>
  <div class="bg-overlay"></div>
  <div class="app">
    ${renderHeader()}
    <div class="main">
      <div class="sidebar-overlay" onclick="Psycheros.toggleSidebar()"></div>
      ${renderSidebar([])}
      <div class="chat" id="chat">
        ${renderEmptyState()}
        ${renderInputArea()}
      </div>
      <button
        class="voice-call-fab"
        id="voice-call-btn"
        style="display: none; position: absolute; top: calc(12px + env(safe-area-inset-top)); right: 12px; width: 44px; height: 44px; border-radius: 50%; align-items: center; justify-content: center; background-color: var(--c-bg-raised, #0a0a0a); border: 1px solid var(--c-accent-muted, #7e22ce); color: var(--c-accent, #a855f7); cursor: pointer; z-index: 50; box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15); padding: 0; margin: 0; box-sizing: border-box;"
        onclick="Psycheros.startVoiceCall()"
        title="Start voice call"
        aria-label="Start voice call"
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07 19.5 19.5 0 01-6-6 19.79 19.79 0 01-3.07-8.67A2 2 0 014.11 2h3a2 2 0 012 1.72c.127.96.361 1.903.7 2.81a2 2 0 01-.45 2.11L8.09 9.91a16 16 0 006 6l1.27-1.27a2 2 0 012.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0122 16.92z"/>
        </svg>
      </button>
    </div>
  </div>
  <script src="/js/theme.js"></script>
  <script>
  (function() {
    const btn = document.getElementById('intimacy-status-btn');
    if (!btn) return;

    let interval = null;

    async function checkStatus() {
      try {
        // Check both Lovense and Buttplug (Intiface) in parallel
        const [lovenseResp, buttplugResp] = await Promise.allSettled([
          fetch('/api/lovense-status', { signal: AbortSignal.timeout(5000) }),
          fetch('/api/buttplug-status', { signal: AbortSignal.timeout(5000) }),
        ]);

        let connected = false;
        let details = [];

        if (lovenseResp.status === 'fulfilled') {
          try {
            const data = await lovenseResp.value.json();
            if (data.connected) {
              connected = true;
              const toy = data.toy;
              const label = toy ? (toy.nickname || toy.name) : 'Lovense';
              const battery = toy ? ' (' + toy.battery + '%)' : '';
              details.push('Lovense: ' + label + battery);
            }
          } catch {}
        }

        if (buttplugResp.status === 'fulfilled') {
          try {
            const data = await buttplugResp.value.json();
            if (data.connected) {
              connected = true;
              const count = data.deviceCount || 0;
              const names = (data.devices || []).map(d => d.name).join(', ');
              details.push('Universal: ' + (names || count + ' device(s)'));
            }
          } catch {}
        }

        if (connected) {
          btn.style.display = 'flex';
          btn.className = 'header-icon connected';
          btn.title = 'Connected: ' + details.join(' | ');
        } else {
          btn.style.display = 'none';
        }
      } catch {
        btn.style.display = 'none';
      }
    }

    checkStatus();
    interval = setInterval(checkStatus, 30000);
  })();
  </script>
  <script>
  // Show Discord sidebar tab only if Discord is enabled
  (function() {
    fetch('/api/discord/status').then(r => r.json()).then(data => {
      const btn = document.getElementById('discord-sidebar-btn');
      if (!btn) return;
      const show = (data.enabled || data.gatewayEnabled) && data.showHubInSidebar !== false;
      btn.style.display = show ? '' : 'none';
      if (show) {
        const dot = document.getElementById('discord-status-dot');
        if (dot) dot.className = 'discord-status-dot ' + (data.connected ? 'discord-dot-connected' : 'discord-dot-disconnected');
      }
    }).catch(() => {});
  })();
  </script>
  <script type="module" src="/js/psycheros.js"></script>
  <script type="module" src="/js/voice.js"></script>
</body>
</html>`;
}

/**
 * Render the canonical heart-chip brand mark as inline SVG. Inlined so
 * the gradient stops can resolve `--c-logo-stop-{0..4}` from the host
 * document's theme variables (an external `<img src=...svg>` can't).
 *
 * Two callers today (header at 32×32, empty-state hero at 120×120) — the
 * gradientId must be unique per page render to avoid SVG `<defs>` ID
 * collisions when both are present.
 */
function renderBrandMark(
  gradientId: string,
  size?: number,
  ariaLabel?: string,
): string {
  const sizeAttrs = size ? ` width="${size}" height="${size}"` : "";
  const a11y = ariaLabel
    ? ` role="img" aria-label="${ariaLabel}"`
    : ` aria-hidden="true"`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 836 836"${sizeAttrs}${a11y}>
  <defs>
    <linearGradient id="${gradientId}" x1="0" y1="0" x2="836" y2="0" gradientUnits="userSpaceOnUse">
      <stop offset="0%" stop-color="var(--c-logo-stop-0)"/>
      <stop offset="25%" stop-color="var(--c-logo-stop-1)"/>
      <stop offset="50%" stop-color="var(--c-logo-stop-2)"/>
      <stop offset="75%" stop-color="var(--c-logo-stop-3)"/>
      <stop offset="100%" stop-color="var(--c-logo-stop-4)"/>
    </linearGradient>
  </defs>
  <g fill="none" stroke="url(#${gradientId})" stroke-width="28" stroke-linejoin="round" stroke-linecap="round" stroke-miterlimit="1">
    <path stroke-linejoin="miter" stroke-miterlimit="20" d="M 232,76 C 116,76 19,178 19,300 C 3,460 200,560 418,810 C 636,560 833,460 817,300 C 817,178 720,76 604,76 C 528,76 452,130 418,179 C 384,130 308,76 232,76 Z"/>
    <rect x="282" y="280" width="270" height="268" rx="22" ry="22"/>
    <rect x="338" y="337" width="160" height="158" rx="6" ry="6"/>
    <line x1="330" y1="234" x2="330" y2="280"/>
    <line x1="389" y1="234" x2="389" y2="280"/>
    <line x1="447" y1="234" x2="447" y2="280"/>
    <line x1="505" y1="234" x2="505" y2="280"/>
    <line x1="330" y1="548" x2="330" y2="594"/>
    <line x1="389" y1="548" x2="389" y2="594"/>
    <line x1="447" y1="548" x2="447" y2="594"/>
    <line x1="505" y1="548" x2="505" y2="594"/>
    <line x1="234" y1="330" x2="282" y2="330"/>
    <line x1="234" y1="387" x2="282" y2="387"/>
    <line x1="234" y1="443" x2="282" y2="443"/>
    <line x1="234" y1="500" x2="282" y2="500"/>
    <line x1="552" y1="330" x2="600" y2="330"/>
    <line x1="552" y1="387" x2="600" y2="387"/>
    <line x1="552" y1="443" x2="600" y2="443"/>
    <line x1="552" y1="500" x2="600" y2="500"/>
  </g>
</svg>`;
}

/**
 * Render the header component.
 */
export function renderHeader(): string {
  return `<header class="header">
  <div class="header-left">
    <button class="logo-btn" onclick="Psycheros.toggleSidebar()" aria-label="Toggle sidebar">
      <div class="logo-icon">
        ${renderBrandMark("logo-grad")}
      </div>
    </button>
    <span class="logo-sub" id="header-title"></span>
  </div>
  <div class="header-right">
    <button id="intimacy-status-btn" class="header-icon" style="display:none;" aria-label="Intimacy status">
      <svg width="20" height="20" viewBox="0 0 24 24" style="color:var(--c-accent);fill:currentColor;stroke:none;">
        <path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/>
      </svg>
    </button>
    <button class="context-toggle" onclick="Psycheros.toggleContextViewer()" aria-label="Toggle context viewer" title="View LLM Context">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <polyline points="16 18 22 12 16 6"/>
        <polyline points="8 6 2 12 8 18"/>
      </svg>
    </button>
  </div>
</header>`;
}

/**
 * Render just the header title text.
 * Returns the conversation title if available, otherwise "Untitled".
 */
export function renderHeaderTitle(title?: string): string {
  return escapeHtml(title || "Untitled");
}

/**
 * Render a back button that returns to the settings hub.
 */
function renderSettingsBackButton(): string {
  return `<a class="settings-back-btn"
    hx-get="/fragments/settings"
    hx-target="#chat"
    hx-swap="innerHTML">
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <polyline points="15 18 9 12 15 6"/>
    </svg>
    <span>Settings</span>
  </a>`;
}

/**
 * Render the settings hub page listing all 5 settings categories as cards.
 */
export function renderSettingsHub(): string {
  return `<div class="settings-view">
  <div class="settings-header">
    <h1 class="settings-title">Settings</h1>
    <p class="settings-desc">Manage entity behavior, appearance, and model configuration</p>
  </div>
  <div class="settings-content" id="settings-content">
    <div class="settings-hub-grid">
      <a class="settings-hub-card"
        hx-get="/fragments/settings/general"
        hx-target="#chat"
        hx-swap="innerHTML">
        <div class="settings-hub-card-icon">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="4" y1="21" x2="4" y2="14"/>
            <line x1="4" y1="10" x2="4" y2="3"/>
            <line x1="12" y1="21" x2="12" y2="12"/>
            <line x1="12" y1="8" x2="12" y2="3"/>
            <line x1="20" y1="21" x2="20" y2="16"/>
            <line x1="20" y1="12" x2="20" y2="3"/>
            <line x1="1" y1="14" x2="7" y2="14"/>
            <line x1="9" y1="8" x2="15" y2="8"/>
            <line x1="17" y1="16" x2="23" y2="16"/>
          </svg>
        </div>
        <div class="settings-hub-card-body">
          <span class="settings-hub-card-title">General Settings</span>
          <span class="settings-hub-card-desc">Display names, chat configuration, and appearance</span>
        </div>
        <svg class="settings-hub-card-arrow" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="9 18 15 12 9 6"/>
        </svg>
      </a>
      <a class="settings-hub-card"
        hx-get="/fragments/settings/core-prompts"
        hx-target="#chat"
        hx-swap="innerHTML">
        <div class="settings-hub-card-icon">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="3"/>
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/>
          </svg>
        </div>
        <div class="settings-hub-card-body">
          <span class="settings-hub-card-title">Core Prompts</span>
          <span class="settings-hub-card-desc">Edit prompt files that define the entity's core behavior</span>
        </div>
        <svg class="settings-hub-card-arrow" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="9 18 15 12 9 6"/>
        </svg>
      </a>
      <a class="settings-hub-card"
        hx-get="/fragments/settings/memories"
        hx-target="#chat"
        hx-swap="innerHTML">
        <div class="settings-hub-card-icon">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M12 2a7 7 0 0 1 7 7c0 2.38-1.19 4.47-3 5.74V17a2 2 0 0 1-2 2h-4a2 2 0 0 1-2-2v-2.26C6.19 13.47 5 11.38 5 9a7 7 0 0 1 7-7z"/>
            <line x1="9" y1="21" x2="15" y2="21"/>
            <path d="M9 9h.01M15 9h.01M9.5 13a3.5 3.5 0 0 0 5 0"/>
          </svg>
        </div>
        <div class="settings-hub-card-body">
          <span class="settings-hub-card-title">Memories</span>
          <span class="settings-hub-card-desc">Review and edit the entity's recorded memories</span>
        </div>
        <svg class="settings-hub-card-arrow" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="9 18 15 12 9 6"/>
        </svg>
      </a>
      <a class="settings-hub-card"
        hx-get="/fragments/settings/vault"
        hx-target="#chat"
        hx-swap="innerHTML">
        <div class="settings-hub-card-icon">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <rect x="2" y="3" width="20" height="14" rx="2" ry="2"/>
            <line x1="8" y1="21" x2="16" y2="21"/>
            <line x1="12" y1="17" x2="12" y2="21"/>
          </svg>
        </div>
        <div class="settings-hub-card-body">
          <span class="settings-hub-card-title">Data Vault</span>
          <span class="settings-hub-card-desc">Store and search documents for context-aware responses</span>
        </div>
        <svg class="settings-hub-card-arrow" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="9 18 15 12 9 6"/>
        </svg>
      </a>
      <a class="settings-hub-card"
        hx-get="/fragments/settings/lorebooks"
        hx-target="#chat"
        hx-swap="innerHTML">
        <div class="settings-hub-card-icon">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/>
            <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>
          </svg>
        </div>
        <div class="settings-hub-card-body">
          <span class="settings-hub-card-title">Context Books</span>
          <span class="settings-hub-card-desc">Manage context books and keyword-triggered entries</span>
        </div>
        <svg class="settings-hub-card-arrow" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="9 18 15 12 9 6"/>
        </svg>
      </a>
      <a class="settings-hub-card"
        hx-get="/fragments/settings/vision"
        hx-target="#chat"
        hx-swap="innerHTML">
        <div class="settings-hub-card-icon">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
            <circle cx="12" cy="12" r="3"/>
          </svg>
        </div>
        <div class="settings-hub-card-body">
          <span class="settings-hub-card-title">Vision</span>
          <span class="settings-hub-card-desc">Image generation, captioning, and visual references</span>
        </div>
        <svg class="settings-hub-card-arrow" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="9 18 15 12 9 6"/>
        </svg>
      </a>
      <a class="settings-hub-card"
        hx-get="/fragments/settings/voice"
        hx-target="#chat"
        hx-swap="innerHTML">
        <div class="settings-hub-card-icon">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z"/>
          </svg>
        </div>
        <div class="settings-hub-card-body">
          <span class="settings-hub-card-title">Audio</span>
          <span class="settings-hub-card-desc">Voice profiles, TTS/STT providers, pronunciation</span>
        </div>
        <svg class="settings-hub-card-arrow" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="9 18 15 12 9 6"/>
        </svg>
      </a>
      <a class="settings-hub-card"
        hx-get="/fragments/settings/pulse"
        hx-target="#chat"
        hx-swap="innerHTML">
        <div class="settings-hub-card-icon">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M22 12h-4l-3 9L9 3l-3 9H2"/>
          </svg>
        </div>
        <div class="settings-hub-card-body">
          <span class="settings-hub-card-title">Pulse</span>
          <span class="settings-hub-card-desc">Schedule autonomous entity prompts and reminders</span>
        </div>
        <svg class="settings-hub-card-arrow" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="9 18 15 12 9 6"/>
        </svg>
      </a>
      <a class="settings-hub-card"
        hx-get="/fragments/settings/sa"
        hx-target="#chat"
        hx-swap="innerHTML">
        <div class="settings-hub-card-icon">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="2"/>
            <path d="M16.24 7.76a6 6 0 010 8.49"/>
            <path d="M7.76 16.24a6 6 0 010-8.49"/>
            <path d="M19.07 4.93a10 10 0 010 14.14"/>
            <path d="M4.93 19.07a10 10 0 010-14.14"/>
          </svg>
        </div>
        <div class="settings-hub-card-body">
          <span class="settings-hub-card-title">Situational Awareness</span>
          <span class="settings-hub-card-desc">Real-time signal feeds for entity awareness</span>
        </div>
        <svg class="settings-hub-card-arrow" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="9 18 15 12 9 6"/>
        </svg>
      </a>
      <a class="settings-hub-card"
        hx-get="/fragments/settings/connections"
        hx-target="#chat"
        hx-swap="innerHTML">
        <div class="settings-hub-card-icon">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
            <polyline points="15 3 21 3 21 9"/>
            <line x1="10" y1="14" x2="21" y2="3"/>
          </svg>
        </div>
        <div class="settings-hub-card-body">
          <span class="settings-hub-card-title">External Connections</span>
          <span class="settings-hub-card-desc">Discord, web search, and third-party integrations</span>
        </div>
        <svg class="settings-hub-card-arrow" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="9 18 15 12 9 6"/>
        </svg>
      </a>
      <a class="settings-hub-card"
        hx-get="/fragments/settings/entity-core"
        hx-target="#chat"
        hx-swap="innerHTML">
        <div class="settings-hub-card-icon">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="3"/>
            <circle cx="19" cy="5" r="2"/>
            <circle cx="5" cy="19" r="2"/>
            <line x1="14.5" y1="9.5" x2="17.5" y2="6.5"/>
            <line x1="9.5" y1="14.5" x2="6.5" y2="17.5"/>
          </svg>
        </div>
        <div class="settings-hub-card-body">
          <span class="settings-hub-card-title">Entity Core</span>
          <span class="settings-hub-card-desc">Manage entity-core connection, knowledge graph, and maintenance</span>
        </div>
        <svg class="settings-hub-card-arrow" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="9 18 15 12 9 6"/>
        </svg>
      </a>
      <a class="settings-hub-card"
        hx-get="/fragments/settings/tools"
        hx-target="#chat"
        hx-swap="innerHTML">
        <div class="settings-hub-card-icon">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>
          </svg>
        </div>
        <div class="settings-hub-card-body">
          <span class="settings-hub-card-title">Tools</span>
          <span class="settings-hub-card-desc">Manage entity tools and add custom tools</span>
        </div>
        <svg class="settings-hub-card-arrow" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="9 18 15 12 9 6"/>
        </svg>
      </a>
      <a class="settings-hub-card"
        hx-get="/fragments/settings/plugins"
        hx-target="#chat"
        hx-swap="innerHTML">
        <div class="settings-hub-card-icon">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M8 3v4M16 3v4M5 7h14v5a7 7 0 0 1-14 0V7z"/>
            <path d="M12 19v3"/>
          </svg>
        </div>
        <div class="settings-hub-card-body">
          <span class="settings-hub-card-title">Plugins</span>
          <span class="settings-hub-card-desc">Inspect trusted local extensions and runtime status</span>
        </div>
        <svg class="settings-hub-card-arrow" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="9 18 15 12 9 6"/>
        </svg>
      </a>
      <a class="settings-hub-card"
        hx-get="/fragments/settings/llm"
        hx-target="#chat"
        hx-swap="innerHTML">
        <div class="settings-hub-card-icon">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <rect x="4" y="4" width="16" height="16" rx="2"/>
            <rect x="9" y="9" width="6" height="6"/>
            <path d="M9 1v3M15 1v3M9 20v3M15 20v3M20 9h3M20 15h3M1 9h3M1 15h3"/>
          </svg>
        </div>
        <div class="settings-hub-card-body">
          <span class="settings-hub-card-title">LLM Settings</span>
          <span class="settings-hub-card-desc">Configure model connection and generation parameters</span>
        </div>
        <svg class="settings-hub-card-arrow" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="9 18 15 12 9 6"/>
        </svg>
      </a>

      <a class="settings-hub-card"
        hx-get="/fragments/admin"
        hx-target="#chat"
        hx-swap="innerHTML">
        <div class="settings-hub-card-icon">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <line x1="18" y1="20" x2="18" y2="10"/>
            <line x1="12" y1="20" x2="12" y2="4"/>
            <line x1="6" y1="20" x2="6" y2="14"/>
            <line x1="2" y1="20" x2="22" y2="20"/>
          </svg>
        </div>
        <div class="settings-hub-card-body">
          <span class="settings-hub-card-title">System Admin</span>
          <span class="settings-hub-card-desc">Logs, diagnostics, and system health monitoring</span>
        </div>
        <svg class="settings-hub-card-arrow" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="9 18 15 12 9 6"/>
        </svg>
      </a>
    </div>
  </div>
</div>`;
}

export function renderPluginsSettingsLegacy(statuses: PluginStatus[]): string {
  const rows = statuses.length === 0
    ? `<p class="settings-note">No local plugins installed.</p>`
    : statuses.map((status) => {
      const state = status.degraded
        ? "Degraded"
        : status.active
        ? "Active"
        : status.enabled
        ? "Inactive"
        : "Disabled";
      const capabilities = Object.entries(status.capabilities)
        .filter(([, count]) => count > 0)
        .map(([name, count]) => `${name}: ${count}`)
        .join(", ") || "No registered capabilities";
      return `<section class="theme-section">
        <h3 class="theme-section-title">${escapeHtml(status.name)} <code>${
        escapeHtml(status.version)
      }</code></h3>
        <p class="theme-section-desc">${escapeHtml(state)}. ${
        escapeHtml(capabilities)
      }.</p>
        <p class="settings-note">Psycheros entrypoint: ${
        status.entrypoints.psycheros ? "yes" : "no"
      } · Entity-core entrypoint: ${
        status.entrypoints.entityCore ? "yes" : "no"
      }</p>
        ${
        status.lastError
          ? `<p class="settings-note">Last error: ${
            escapeHtml(status.lastError)
          }</p>`
          : ""
      }
      </section>`;
    }).join("");

  return `<div class="settings-view">
    <div class="settings-header">
      <div class="settings-header-row">
        ${renderSettingsBackButton()}
        <div>
          <h1 class="settings-title">Plugins</h1>
          <p class="settings-desc">Trusted local extensions loaded from the persistent data directory</p>
        </div>
      </div>
    </div>
    <div class="settings-content" id="settings-content">
      <p class="settings-note">Plugins run as trusted local code. They can access the local filesystem, network, services, and plugin secrets. Portable exports do not include the plugin-secrets directory. Changes take effect after restart.</p>
      ${rows}
    </div>
  </div>`;
}

function renderPluginBadge(label: string, kind: string): string {
  return `<span class="badge ${kind}">${escapeHtml(label)}</span>`;
}

function formatPluginCapabilities(status: PluginStatus): string {
  return Object.entries(status.capabilities)
    .filter(([, count]) => count > 0)
    .map(([name, count]) => `${name}: ${count}`)
    .join(", ") || "No loaded runtime capabilities for this plugin";
}

function renderPluginWarnings(warnings?: string[]): string {
  if (!warnings || warnings.length === 0) return "";
  return `<ul class="settings-note" style="margin-top:var(--sp-2);padding-left:var(--sp-5);">${
    warnings.map((warning) => `<li>${escapeHtml(warning)}</li>`).join("")
  }</ul>`;
}

function renderPluginRecord(
  label: string,
  record?: object,
): string {
  if (!record || Object.keys(record).length === 0) return "";
  const values = Object.entries(record)
    .filter(([, value]) => value !== undefined)
    .map(([name, value]) => `${name}: ${String(value)}`)
    .join(", ");
  if (!values) return "";
  return `<p class="settings-note">${escapeHtml(label)}: ${
    escapeHtml(values)
  }</p>`;
}

function renderPluginUpdate(status: PluginStatus): string {
  if (!status.update || Object.keys(status.update).length === 0) return "";
  const values = [
    status.update.repoUrl ? `repo ${status.update.repoUrl}` : "",
    status.update.tagPrefix ? `tag prefix ${status.update.tagPrefix}` : "",
  ].filter(Boolean).join(", ");
  return `<p class="settings-note">Update metadata: ${
    escapeHtml(values || "declared")
  }. Displayed for review only; plugin updates are not checked or applied yet.</p>`;
}

function renderPluginStatusBadges(status: PluginStatus): string {
  const badges: string[] = [];
  if (status.pendingAction === "install") {
    badges.push(renderPluginBadge("Pending install", "badge-info"));
  } else if (status.pendingAction === "remove") {
    badges.push(renderPluginBadge("Pending removal", "badge-error"));
  } else if (status.degraded) {
    badges.push(renderPluginBadge("Degraded", "badge-error"));
  } else if (status.active) {
    badges.push(renderPluginBadge("Loaded", "badge-success"));
  } else if (status.enabled) {
    badges.push(renderPluginBadge("Installed", "badge-secondary"));
  } else {
    badges.push(renderPluginBadge("Disabled", "badge-muted"));
  }
  if (status.restartRequired) {
    badges.push(renderPluginBadge("Restart required", "badge-primary"));
  }
  if ((status.warnings ?? []).length > 0) {
    badges.push(renderPluginBadge("Warnings", "badge-error"));
  }
  return `<div style="display:flex;gap:var(--sp-2);flex-wrap:wrap;">${
    badges.join("")
  }</div>`;
}

function renderPluginRows(statuses: PluginStatus[]): string {
  if (statuses.length === 0) {
    return `<p class="settings-note">No local plugins installed.</p>`;
  }
  return statuses.map((status) => {
    return `<section class="theme-section">
      <div style="display:flex;justify-content:space-between;gap:var(--sp-3);align-items:flex-start;flex-wrap:wrap;">
        <div>
          <h3 class="theme-section-title">${escapeHtml(status.name)} <code>${
      escapeHtml(status.version)
    }</code></h3>
          <p class="theme-section-desc">${
      status.description
        ? escapeHtml(status.description)
        : escapeHtml(formatPluginCapabilities(status))
    }</p>
        </div>
        ${renderPluginStatusBadges(status)}
      </div>
      ${
      status.description
        ? `<p class="settings-note">${
          escapeHtml(formatPluginCapabilities(status))
        }</p>`
        : ""
    }
      <p class="settings-note">Psycheros entrypoint: ${
      status.entrypoints.psycheros ? "yes" : "no"
    } &middot; Entity-core entrypoint: ${
      status.entrypoints.entityCore ? "yes" : "no"
    }</p>
      ${
      status.lastError
        ? `<p class="settings-note">Last error: ${
          escapeHtml(status.lastError)
        }</p>`
        : ""
    }
      ${renderPluginWarnings(status.warnings)}
      ${renderPluginRecord("Compatibility", status.compatibility)}
      ${renderPluginRecord("Dependencies", status.dependencies)}
      ${
      status.homepageUrl
        ? `<p class="settings-note">Homepage: <a href="${
          escapeHtml(status.homepageUrl)
        }" target="_blank" rel="noopener" style="color:var(--c-accent);">${
          escapeHtml(status.homepageUrl)
        }</a></p>`
        : ""
    }
      ${renderPluginUpdate(status)}
      ${
      status.pendingAction === "remove"
        ? `<p class="settings-note">Plugin secrets remain available for reinstall until removed manually.</p>`
        : `<div style="display:flex;gap:var(--sp-2);flex-wrap:wrap;margin-top:var(--sp-3);">
            <button type="button" class="btn btn--danger btn--sm" data-plugin-id="${
          escapeHtml(status.id)
        }" onclick="removePlugin(this.dataset.pluginId)">Remove</button>
            <button type="button" class="btn btn--ghost btn--sm" data-plugin-id="${
          escapeHtml(status.id)
        }" onclick="togglePluginActivity(this.dataset.pluginId, this)">Show recent activity</button>
            <button type="button" class="btn btn--ghost btn--sm" data-plugin-id="${
          escapeHtml(status.id)
        }" onclick="checkPluginUpdate(this.dataset.pluginId, this)">Check for updates</button>
          </div>
          <div id="plugin-update-result-${
          escapeHtml(status.id)
        }" style="margin-top:var(--sp-2);"></div>`
    }
      <div id="plugin-activity-${
      escapeHtml(status.id)
    }" style="display:none;margin-top:var(--sp-3);"></div>
    </section>`;
  }).join("");
}

function renderUnmanagedCustomTools(tools: UnmanagedCustomTool[]): string {
  const body = tools.length === 0
    ? `<p class="settings-note">No loose custom tool files installed.</p>`
    : `<div style="display:flex;flex-direction:column;gap:var(--sp-2);">${
      tools.map((tool) =>
        `<div style="display:flex;justify-content:space-between;gap:var(--sp-3);align-items:center;">
          <code>${escapeHtml(tool.filename)}</code>
          ${renderPluginBadge("Unmanaged", "badge-muted")}
        </div>`
      ).join("")
    }</div>`;

  return `<section class="theme-section">
    <h3 class="theme-section-title">Loose Custom Tools</h3>
    <p class="theme-section-desc">Files in <code>.psycheros/custom-tools/*.js</code> still load normally, but they do not carry plugin manifest metadata.</p>
    ${body}
  </section>`;
}

export function renderPluginsSettings(
  statuses: PluginStatus[],
  unmanagedTools: UnmanagedCustomTool[] = [],
): string {
  return `<div class="settings-view">
    <div class="settings-header">
      <div class="settings-header-row">
        ${renderSettingsBackButton()}
        <div>
          <h1 class="settings-title">Plugins</h1>
          <p class="settings-desc">Trusted local extensions loaded from the persistent data directory</p>
        </div>
      </div>
    </div>
    <div class="settings-content" id="settings-content">
      <section class="theme-section" style="border-left:3px solid var(--c-accent);">
        <h3 class="theme-section-title">Before you install</h3>
        <p class="theme-section-desc" id="plugin-safety-banner">Plugins are trusted local code. They run inside the Psycheros process with full access to the entity's identity, memories, vault, and network — and prompt hooks can shape what the entity thinks each turn. Only install plugins you have personally vetted. See the <a href="https://psycherosai.github.io/Psycheros/psycheros/user-guide/#plugins" target="_blank" rel="noopener" style="color:var(--c-accent);">Plugins section of the User Guide</a> for how to vet a plugin before installing.</p>
      </section>

      <section class="theme-section">
        <h3 class="theme-section-title">Plugin Health</h3>
        <p class="theme-section-desc">At-a-glance status across every installed plugin. Numbers refresh with the page.</p>
        <div id="plugin-health-card"><p class="settings-note">Loading…</p></div>
      </section>

      <section class="theme-section">
        <h3 class="theme-section-title">Install Plugin</h3>
        <p class="theme-section-desc">Stage a plugin from a local zip or Git repository, review what it declares, then install it.</p>
        <p class="settings-note">Plugins run as trusted local code. Install code only from trusted sources because plugins can access the local filesystem, network, services, and plugin secrets. Portable exports do not include the plugin-secrets directory. Changes take effect after restart.</p>

        <div class="llm-fields">
          <form onsubmit="inspectPluginZip(event)" style="display:flex;gap:var(--sp-3);align-items:flex-end;flex-wrap:wrap;">
            <div class="llm-field" style="min-width:220px;">
              <label for="plugin-zip-input">Plugin zip</label>
              <input type="file" id="plugin-zip-input" class="input-field llm-input" accept=".zip,application/zip">
            </div>
            <button type="submit" class="btn btn--primary">Inspect Zip</button>
          </form>

          <form onsubmit="inspectPluginGit(event)" style="display:flex;gap:var(--sp-3);align-items:flex-end;flex-wrap:wrap;">
            <div class="llm-field" style="min-width:260px;flex:1;">
              <label for="plugin-git-url">Git repository URL</label>
              <input type="url" id="plugin-git-url" class="input-field llm-input" placeholder="https://github.com/author/plugin">
            </div>
            <div class="llm-field" style="min-width:160px;">
              <label for="plugin-git-ref">Branch or tag</label>
              <input type="text" id="plugin-git-ref" class="input-field llm-input" placeholder="default">
            </div>
            <button type="submit" class="btn btn--primary">Inspect Git</button>
          </form>
        </div>

        <div id="plugin-manager-review" style="display:none;margin-top:var(--sp-4);"></div>
      </section>

      <section class="theme-section">
        <h3 class="theme-section-title">Installed Plugins</h3>
        <p class="theme-section-desc">Loaded, degraded, compatibility-warning, pending-install, and pending-removal states appear here. Expand a plugin to see its recent activity log.</p>
        ${renderPluginRows(statuses)}
      </section>

      ${renderUnmanagedCustomTools(unmanagedTools)}
    </div>
  </div>`;
}

export interface GeneralSettings {
  entityName: string;
  userName: string;
  timezone: string;
}

export function renderGeneralSettings(settings: GeneralSettings): string {
  return `<div class="settings-view">
  <div class="settings-header">
    <div class="settings-header-row">
      ${renderSettingsBackButton()}
      <div>
        <h1 class="settings-title">General Settings</h1>
        <p class="settings-desc">Display names, chat configuration, and appearance</p>
      </div>
    </div>
  </div>
  <div class="settings-content" id="settings-content">

    <div class="settings-tabs">
      <button class="settings-tab active" data-tab="general" onclick="switchGeneralTab('general')">General</button>
      <button class="settings-tab" data-tab="theme" onclick="switchGeneralTab('theme')">Theme</button>
    </div>

    <div id="general-tab-general" class="general-tab-panel">

    <section class="theme-section">
      <h3 class="theme-section-title">Display Names</h3>
      <p class="theme-section-desc">Customize how names appear in the chat interface</p>
      <div class="llm-fields">
        <div class="llm-field">
          <label for="general-entity-name">Entity Name</label>
          <input type="text" id="general-entity-name" class="input-field llm-input" value="${
    escapeHtml(settings.entityName)
  }" placeholder="Assistant">
        </div>
        <div class="llm-field">
          <label for="general-user-name">Your Name</label>
          <input type="text" id="general-user-name" class="input-field llm-input" value="${
    escapeHtml(settings.userName)
  }" placeholder="You">
        </div>
      </div>
    </section>

    <section class="theme-section">
      <h3 class="theme-section-title">Timezone</h3>
      <p class="theme-section-desc">Set the timezone used for message timestamps</p>
      <div class="llm-fields">
        <div class="llm-field">
          <label for="general-timezone">Display Timezone</label>
          <select id="general-timezone" class="input-field llm-input">
            <option value=""${
    settings.timezone === "" ? " selected" : ""
  }>(System Default)</option>
            <option value="UTC"${
    settings.timezone === "UTC" ? " selected" : ""
  }>UTC+0 UTC</option>
            <option value="Etc/GMT+12"${
    settings.timezone === "Etc/GMT+12" ? " selected" : ""
  }>UTC-12 Etc/GMT+12</option>
            <option value="Pacific/Honolulu"${
    settings.timezone === "Pacific/Honolulu" ? " selected" : ""
  }>UTC-10 Pacific/Honolulu (HST)</option>
            <option value="America/Anchorage"${
    settings.timezone === "America/Anchorage" ? " selected" : ""
  }>UTC-9 America/Anchorage (AKST)</option>
            <option value="America/Los_Angeles"${
    settings.timezone === "America/Los_Angeles" ? " selected" : ""
  }>UTC-8 America/Los_Angeles (PST)</option>
            <option value="America/Denver"${
    settings.timezone === "America/Denver" ? " selected" : ""
  }>UTC-7 America/Denver (MST)</option>
            <option value="America/Chicago"${
    settings.timezone === "America/Chicago" ? " selected" : ""
  }>UTC-6 America/Chicago (CST)</option>
            <option value="America/New_York"${
    settings.timezone === "America/New_York" ? " selected" : ""
  }>UTC-5 America/New_York (EST)</option>
            <option value="America/Sao_Paulo"${
    settings.timezone === "America/Sao_Paulo" ? " selected" : ""
  }>UTC-3 America/Sao_Paulo (BRT)</option>
            <option value="America/Argentina/Buenos_Aires"${
    settings.timezone === "America/Argentina/Buenos_Aires" ? " selected" : ""
  }>UTC-3 America/Argentina/Buenos_Aires (ART)</option>
            <option value="Atlantic/South_Georgia"${
    settings.timezone === "Atlantic/South_Georgia" ? " selected" : ""
  }>UTC-2 Atlantic/South_Georgia</option>
            <option value="Atlantic/Azores"${
    settings.timezone === "Atlantic/Azores" ? " selected" : ""
  }>UTC-1 Atlantic/Azores</option>
            <option value="Europe/London"${
    settings.timezone === "Europe/London" ? " selected" : ""
  }>UTC+0 Europe/London (GMT)</option>
            <option value="Europe/Paris"${
    settings.timezone === "Europe/Paris" ? " selected" : ""
  }>UTC+1 Europe/Paris (CET)</option>
            <option value="Europe/Berlin"${
    settings.timezone === "Europe/Berlin" ? " selected" : ""
  }>UTC+1 Europe/Berlin (CET)</option>
            <option value="Europe/Madrid"${
    settings.timezone === "Europe/Madrid" ? " selected" : ""
  }>UTC+1 Europe/Madrid (CET)</option>
            <option value="Europe/Rome"${
    settings.timezone === "Europe/Rome" ? " selected" : ""
  }>UTC+1 Europe/Rome (CET)</option>
            <option value="Europe/Amsterdam"${
    settings.timezone === "Europe/Amsterdam" ? " selected" : ""
  }>UTC+1 Europe/Amsterdam (CET)</option>
            <option value="Africa/Lagos"${
    settings.timezone === "Africa/Lagos" ? " selected" : ""
  }>UTC+1 Africa/Lagos (WAT)</option>
            <option value="Europe/Athens"${
    settings.timezone === "Europe/Athens" ? " selected" : ""
  }>UTC+2 Europe/Athens (EET)</option>
            <option value="Europe/Istanbul"${
    settings.timezone === "Europe/Istanbul" ? " selected" : ""
  }>UTC+3 Europe/Istanbul (TRT)</option>
            <option value="Europe/Moscow"${
    settings.timezone === "Europe/Moscow" ? " selected" : ""
  }>UTC+3 Europe/Moscow (MSK)</option>
            <option value="Africa/Nairobi"${
    settings.timezone === "Africa/Nairobi" ? " selected" : ""
  }>UTC+3 Africa/Nairobi (EAT)</option>
            <option value="Asia/Dubai"${
    settings.timezone === "Asia/Dubai" ? " selected" : ""
  }>UTC+4 Asia/Dubai (GST)</option>
            <option value="Asia/Kolkata"${
    settings.timezone === "Asia/Kolkata" ? " selected" : ""
  }>UTC+5:30 Asia/Kolkata (IST)</option>
            <option value="Asia/Dhaka"${
    settings.timezone === "Asia/Dhaka" ? " selected" : ""
  }>UTC+6 Asia/Dhaka (BST)</option>
            <option value="Asia/Bangkok"${
    settings.timezone === "Asia/Bangkok" ? " selected" : ""
  }>UTC+7 Asia/Bangkok (ICT)</option>
            <option value="Asia/Shanghai"${
    settings.timezone === "Asia/Shanghai" ? " selected" : ""
  }>UTC+8 Asia/Shanghai (CST)</option>
            <option value="Asia/Hong_Kong"${
    settings.timezone === "Asia/Hong_Kong" ? " selected" : ""
  }>UTC+8 Asia/Hong_Kong (HKT)</option>
            <option value="Asia/Singapore"${
    settings.timezone === "Asia/Singapore" ? " selected" : ""
  }>UTC+8 Asia/Singapore (SGT)</option>
            <option value="Asia/Tokyo"${
    settings.timezone === "Asia/Tokyo" ? " selected" : ""
  }>UTC+9 Asia/Tokyo (JST)</option>
            <option value="Asia/Seoul"${
    settings.timezone === "Asia/Seoul" ? " selected" : ""
  }>UTC+9 Asia/Seoul (KST)</option>
            <option value="Australia/Sydney"${
    settings.timezone === "Australia/Sydney" ? " selected" : ""
  }>UTC+11 Australia/Sydney (AEDT)</option>
            <option value="Australia/Melbourne"${
    settings.timezone === "Australia/Melbourne" ? " selected" : ""
  }>UTC+11 Australia/Melbourne (AEDT)</option>
            <option value="Pacific/Auckland"${
    settings.timezone === "Pacific/Auckland" ? " selected" : ""
  }>UTC+13 Pacific/Auckland (NZDT)</option>
          </select>
        </div>
      </div>
    </section>

    <div style="margin-top: 16px;">
      <button class="btn btn--primary" onclick="saveGeneralSettings()">Save Changes</button>
    </div>

    <!-- Status messages -->
    <div id="general-settings-status" class="settings-status"></div>

    </div>

    <div id="general-tab-theme" class="general-tab-panel" style="display:none;">

    <!-- Accent Color Section -->
    <section class="theme-section">
      <h3 class="theme-section-title">Accent Color</h3>
      <p class="theme-section-desc">Choose a preset or pick a custom color</p>
      <div class="theme-grid" id="theme-grid">
        <button class="theme-swatch" data-theme="phosphor" title="Phosphor Green" style="--swatch-color: #39ff14">
          <span class="swatch-preview"></span>
          <span class="swatch-name">Phosphor</span>
        </button>
        <button class="theme-swatch" data-theme="ocean" title="Ocean Blue" style="--swatch-color: #00d4ff">
          <span class="swatch-preview"></span>
          <span class="swatch-name">Ocean</span>
        </button>
        <button class="theme-swatch" data-theme="sunset" title="Sunset Orange" style="--swatch-color: #ff6b35">
          <span class="swatch-preview"></span>
          <span class="swatch-name">Sunset</span>
        </button>
        <button class="theme-swatch" data-theme="violet" title="Violet Dream" style="--swatch-color: #a855f7">
          <span class="swatch-preview"></span>
          <span class="swatch-name">Violet</span>
        </button>
        <button class="theme-swatch" data-theme="rose" title="Rose" style="--swatch-color: #f43f5e">
          <span class="swatch-preview"></span>
          <span class="swatch-name">Rose</span>
        </button>
        <button class="theme-swatch" data-theme="amber" title="Amber" style="--swatch-color: #f59e0b">
          <span class="swatch-preview"></span>
          <span class="swatch-name">Amber</span>
        </button>
        <button class="theme-swatch" data-theme="mint" title="Mint" style="--swatch-color: #10b981">
          <span class="swatch-preview"></span>
          <span class="swatch-name">Mint</span>
        </button>
        <button class="theme-swatch" data-theme="slate" title="Slate" style="--swatch-color: #64748b">
          <span class="swatch-preview"></span>
          <span class="swatch-name">Slate</span>
        </button>
        <button class="theme-swatch" data-theme="custom" title="Custom Color" style="--swatch-color: #888888">
          <span class="swatch-preview swatch-preview--custom">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M20.71 4.63l-1.34-1.34c-.37-.39-1.02-.39-1.41 0L9 12.25 11.75 15l8.96-8.96c.39-.39.39-1.04 0-1.41z"/>
              <path d="M7 14l-4.69 4.69a1 1 0 0 0-.21.33l-1 3a1 1 0 0 0 1.21 1.21l3-1a1 1 0 0 0 .33-.21L10 18"/>
            </svg>
          </span>
          <span class="swatch-name">Custom</span>
        </button>
      </div>
      <div class="custom-color-row" id="custom-color-row" style="display: none;">
        <input type="color" id="custom-color-picker" class="color-picker" value="#a855f7">
        <input type="text" id="custom-color-hex" class="color-hex-input" placeholder="#a855f7" maxlength="7">
      </div>
      <button class="btn btn--ghost btn--sm" onclick="Theme.reset(); initAppearance();" style="margin-top: var(--sp-3);">Reset to Default</button>
    </section>

    <!-- Background Image Section -->
    <section class="theme-section">
      <h3 class="theme-section-title">Background Image</h3>
      <p class="theme-section-desc">Add a background image for a personalized look</p>

      <div class="bg-controls">
        <div class="bg-url-input">
          <input type="url" id="bg-url" class="input-field" placeholder="Enter image URL...">
          <button class="btn btn--primary btn--sm" onclick="applyBackgroundUrl()">Apply URL</button>
        </div>

        <div class="bg-upload-area">
          <span class="bg-upload-label">Or upload an image:</span>
          <label class="btn btn--ghost btn--sm upload-btn">
            <input type="file" id="bg-file-input" accept="image/*" onchange="handleBackgroundUpload(this)" hidden>
            Choose File
          </label>
        </div>

        <div class="bg-gallery" id="bg-gallery">
          <!-- Populated by JS -->
        </div>

        <div class="bg-sliders">
          <div class="slider-group">
            <label for="bg-blur">Blur</label>
            <input type="range" id="bg-blur" min="0" max="50" value="0" oninput="updateBgBlur(this.value)">
            <span id="bg-blur-value">0px</span>
          </div>
          <div class="slider-group">
            <label for="bg-overlay">Overlay</label>
            <input type="range" id="bg-overlay" min="0" max="100" value="0" oninput="updateBgOverlay(this.value)">
            <span id="bg-overlay-value">0%</span>
          </div>
        </div>

        <button class="btn btn--ghost btn--sm" onclick="clearBackground()">Clear Background</button>
      </div>
    </section>

    <!-- Glass Effect Section -->
    <section class="theme-section">
      <h3 class="theme-section-title">Glass Effect</h3>
      <p class="theme-section-desc">Enable frosted glass effect on UI panels when background is active</p>
      <label class="toggle-label">
        <input type="checkbox" id="glass-toggle" role="switch" aria-label="Enable Glass Effect" onchange="toggleGlass(this.checked)">
        <span class="toggle-slider"></span>
        <span class="toggle-text">Enable Glass Effect</span>
      </label>
    </section>

    <!-- Status messages -->
    <div id="appearance-status" class="settings-status"></div>

    </div>

  </div>
</div>

<script>
function switchGeneralTab(tab) {
  document.querySelectorAll('#settings-content .settings-tab[data-tab]').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
  document.querySelectorAll('.general-tab-panel').forEach(p => p.style.display = p.id === 'general-tab-' + tab ? '' : 'none');
}

// General tab logic
(function() {
  const sel = document.getElementById('general-timezone');
  if (sel && window.PsycherosSettings && window.PsycherosSettings.timezone) {
    sel.value = window.PsycherosSettings.timezone;
  }
})();

async function saveGeneralSettings() {
  const entityName = document.getElementById('general-entity-name').value.trim();
  const userName = document.getElementById('general-user-name').value.trim();
  const timezone = document.getElementById('general-timezone').value;

  try {
    const res = await fetch('/api/general-settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entityName, userName, timezone }),
    });
    const data = await res.json();
    const el = document.getElementById('general-settings-status');
    if (!el) return;
    if (data.success) {
      el.className = 'settings-status visible success';
      el.textContent = 'Settings saved successfully';
      setTimeout(() => { el.className = 'settings-status'; }, 3000);
      if (window.PsycherosSettings) {
        window.PsycherosSettings.entityName = entityName || 'Assistant';
        window.PsycherosSettings.userName = userName || 'You';
        window.PsycherosSettings.timezone = timezone;
      }
    } else {
      el.className = 'settings-status visible error';
      el.textContent = data.error || 'Failed to save settings';
    }
  } catch {
    const el = document.getElementById('general-settings-status');
    if (!el) return;
    el.className = 'settings-status visible error';
    el.textContent = 'Failed to save settings';
  }
}

// Theme tab logic
function showAppearanceStatus(type, message) {
  const el = document.getElementById('appearance-status');
  if (!el) return;
  el.className = 'settings-status visible ' + type;
  el.textContent = message;
  if (type !== 'error') {
    setTimeout(() => { el.className = 'settings-status'; }, 3000);
  }
}

function initAppearance() {
  const theme = Theme.get();
  const customRow = document.getElementById('custom-color-row');
  const colorPicker = document.getElementById('custom-color-picker');
  const colorHex = document.getElementById('custom-color-hex');
  const customSwatch = document.querySelector('.theme-swatch[data-theme="custom"]');

  const isCustom = !!theme.customAccent;

  document.querySelectorAll('.theme-swatch').forEach(el => {
    const isPresetMatch = !isCustom && el.dataset.theme === theme.preset;
    const isCustomMatch = isCustom && el.dataset.theme === 'custom';
    el.classList.toggle('active', isPresetMatch || isCustomMatch);

    el.onclick = () => {
      document.querySelectorAll('.theme-swatch').forEach(s => s.classList.remove('active'));
      el.classList.add('active');
      if (el.dataset.theme === 'custom') {
        customRow.style.display = 'flex';
        const hex = colorPicker.value;
        Theme.setCustomAccent(hex);
        customSwatch.style.setProperty('--swatch-color', hex);
      } else {
        customRow.style.display = 'none';
        Theme.setPreset(el.dataset.theme);
      }
    };
  });

  if (isCustom) {
    customRow.style.display = 'flex';
    colorPicker.value = theme.customAccent;
    colorHex.value = theme.customAccent;
    customSwatch.style.setProperty('--swatch-color', theme.customAccent);
  } else {
    customRow.style.display = 'none';
  }

  colorPicker.oninput = () => {
    colorHex.value = colorPicker.value;
    Theme.setCustomAccent(colorPicker.value);
    customSwatch.style.setProperty('--swatch-color', colorPicker.value);
  };
  colorHex.onchange = () => {
    if (/^#[0-9a-fA-F]{6}$/.test(colorHex.value)) {
      colorPicker.value = colorHex.value;
      Theme.setCustomAccent(colorHex.value);
      customSwatch.style.setProperty('--swatch-color', colorHex.value);
    }
  };

  const bgBlur = document.getElementById('bg-blur');
  const bgOverlay = document.getElementById('bg-overlay');
  const glassToggle = document.getElementById('glass-toggle');
  bgBlur.value = theme.bgBlur;
  bgOverlay.value = Math.round(theme.bgOverlayOpacity * 100);
  glassToggle.checked = theme.glassEnabled;
  document.getElementById('bg-blur-value').textContent = theme.bgBlur + 'px';
  document.getElementById('bg-overlay-value').textContent = Math.round(theme.bgOverlayOpacity * 100) + '%';

  loadBackgroundGallery();
}
initAppearance();

function updateBgBlur(value) {
  document.getElementById('bg-blur-value').textContent = value + 'px';
  Theme.setBackgroundBlur(parseInt(value));
}

function updateBgOverlay(value) {
  document.getElementById('bg-overlay-value').textContent = value + '%';
  Theme.setBackgroundOverlay(parseInt(value) / 100);
}

function toggleGlass(enabled) {
  Theme.setGlassEnabled(enabled);
}

async function applyBackgroundUrl() {
  const url = document.getElementById('bg-url').value.trim();
  if (url) {
    Theme.setBackground(url);
    await loadBackgroundGallery();
  }
}

function handleBackgroundUpload(input) {
  if (input.files && input.files[0]) {
    uploadBackground(input.files[0]);
  }
}

async function uploadBackground(file) {
  const result = await Theme.uploadBackground(file);
  if (result.success) {
    Theme.setBackground(result.url);
    await loadBackgroundGallery();
  } else {
    showAppearanceStatus('error', 'Upload failed: ' + result.error);
  }
}

function escapeAttr(s) {
  return s.replace(/&/g, '&amp;').replace(/'/g, '&#39;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function loadBackgroundGallery() {
  const gallery = document.getElementById('bg-gallery');
  const backgrounds = await Theme.listBackgrounds();
  const currentTheme = Theme.get();

  gallery.innerHTML = backgrounds.map(bg => \`
    <div class="bg-gallery-item \${currentTheme.bgImage === bg.url ? 'active' : ''}" onclick="selectBackground('\${escapeAttr(bg.url)}')">
      <img src="\${escapeAttr(bg.url)}" alt="\${escapeAttr(bg.filename)}">
      <button class="delete-btn" onclick="event.stopPropagation(); deleteBackground('\${escapeAttr(bg.filename)}')" title="Delete">×</button>
    </div>
  \`).join('');
}

function selectBackground(url) {
  Theme.setBackground(url);
  document.querySelectorAll('.bg-gallery-item').forEach(el => {
    el.classList.toggle('active', el.querySelector('img').src === url);
  });
}

async function deleteBackground(filename) {
  if (confirm('Delete this background image?')) {
    const result = await Theme.deleteBackground(filename);
    if (result.success) {
      const theme = Theme.get();
      if (theme.bgImage && theme.bgImage.includes(filename)) {
        Theme.setBackground(null);
      }
      await loadBackgroundGallery();
    } else {
      showAppearanceStatus('error', 'Delete failed: ' + result.error);
    }
  }
}

function clearBackground() {
  Theme.setBackground(null);
  document.getElementById('bg-url').value = '';
  document.querySelectorAll('.bg-gallery-item').forEach(el => el.classList.remove('active'));
}
</script>`;
}

// =============================================================================
// Situational Awareness Settings
// =============================================================================

/**
 * Render the Situational Awareness settings page with two tabs:
 * Signals (sensor data config) and Webhooks (event rules).
 */
export function renderSASettings(
  settings: { enabled: boolean },
  bleSettings?: import("../llm/ble-settings.ts").BLESettings,
  eventRules?: import("../wearable/event-rules.ts").EventRule[],
  pulses?: import("../types.ts").PulseRow[],
): string {
  const connectedIds = getWearableConnectionManager().connectedDeviceIds;
  const devicesWithStreams = (bleSettings?.devices ?? []).filter(
    (d) => d.streams && Object.keys(d.streams).length > 0,
  );

  // Collect all unique stream IDs across devices
  const allStreamIds = [
    ...new Set(
      devicesWithStreams.flatMap((d) => Object.keys(d.streams ?? {})),
    ),
  ];
  const streamOptions = allStreamIds.map((id) =>
    `<option value="${escapeHtml(id)}">${escapeHtml(id)}</option>`
  ).join("\n");
  const pulseOptions = (pulses ?? []).map((p) =>
    `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)}</option>`
  ).join("\n");

  const dataStreamsSection = devicesWithStreams.length > 0
    ? `<section class="theme-section">
      <h3 class="theme-section-title">Data Streams</h3>
      <p class="theme-section-desc">Toggle which data streams from connected wearables appear in my situational awareness</p>
      <div class="llm-fields">
        ${
      devicesWithStreams.map((device) => {
        const isConnected = connectedIds.includes(device.id);
        return `<div class="llm-field" style="margin-bottom:12px;" data-device-id="${
          escapeHtml(device.id)
        }">
            <label style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">
              <span style="font-weight:500;">${
          escapeHtml(device.name || device.id)
        }</span>
              <span class="ble-status-badge" style="font-size:var(--font-size-xs);padding:2px 8px;border-radius:8px;${
          isConnected
            ? "background:rgba(76,175,80,0.15);color:#4CAF50;"
            : "background:rgba(158,158,158,0.15);color:#9E9E9E;"
        }">${isConnected ? "Connected" : "Disconnected"}</span>
            </label>
            ${
          Object.entries(device.streams ?? {}).map(([streamId, config]) =>
            `<div style="display:flex;align-items:center;gap:8px;padding:4px 0 4px 12px;">
                <label class="toggle-label" style="gap:6px;">
                  <input type="checkbox" data-sa-device="${
              escapeHtml(device.id)
            }" data-sa-stream="${escapeHtml(streamId)}" ${
              config.enabled ? "checked" : ""
            } role="switch" style="accent-color:var(--c-accent);">
                  <span style="font-size:var(--font-size-sm);">${
              escapeHtml(config.label)
            }</span>
                </label>
                <span style="font-size:var(--font-size-xs);color:var(--c-fg-muted);font-family:monospace;">&lt;${
              escapeHtml(config.xmlTag)
            }&gt;</span>
              </div>`
          ).join("\n")
        }
          </div>`;
      }).join("\n")
    }
      </div>
    </section>`
    : `<section class="theme-section">
      <h3 class="theme-section-title">Data Streams</h3>
      <p class="theme-section-desc" style="opacity:0.6;">No wearable data sources configured. <a href="#" onclick="event.preventDefault();htmx.ajax('GET','/fragments/settings/connections',{target:'#chat',swap:'innerHTML'});setTimeout(()=>switchConnectionsTab('ble'),50);" style="color:var(--c-accent);text-decoration:underline;">Connect a device in External Connections &gt; BLE</a> to get started.</p>
    </section>`;

  const webhooksRulesList = (eventRules ?? []).length === 0
    ? `<p style="color: var(--c-fg-muted); margin: 8px 0;">No webhooks configured yet.</p>`
    : (eventRules ?? []).map((r) => renderEventRuleCard(r)).join("\n");

  return `<div class="settings-view">
  <div class="settings-header">
    <div class="settings-header-row">
      ${renderSettingsBackButton()}
      <div>
        <h1 class="settings-title">Situational Awareness</h1>
        <p class="settings-desc">Configure real-time signal feeds and data-driven triggers</p>
      </div>
    </div>
  </div>
  <div class="settings-content" id="settings-content">

    <section class="theme-section">
      <h3 class="theme-section-title">Enable</h3>
      <p class="theme-section-desc">When enabled, the entity receives a situational awareness block each turn with real-time signal data</p>
      <div class="llm-fields">
        <div class="llm-field">
          <label class="toggle-label">
            <input type="checkbox" id="sa-enabled" role="switch" aria-label="Situational Awareness" ${
    settings.enabled ? "checked" : ""
  }>
            <span class="toggle-slider"></span>
            <span class="toggle-text">Situational Awareness</span>
          </label>
        </div>
      </div>
    </section>

    <div class="sa-tabs" style="display:flex;gap:4px;margin-bottom:16px;border-bottom:1px solid var(--c-border);padding-bottom:0;">
      <button class="sa-tab sa-tab--active" onclick="switchSATab('signals')" id="sa-tab-signals" style="padding:8px 16px;border:none;background:none;color:var(--c-accent);font-weight:600;cursor:pointer;border-bottom:2px solid var(--c-accent);margin-bottom:-1px;">Signals</button>
      <button class="sa-tab" onclick="switchSATab('webhooks')" id="sa-tab-webhooks" style="padding:8px 16px;border:none;background:none;color:var(--c-fg-muted);font-weight:400;cursor:pointer;border-bottom:2px solid transparent;margin-bottom:-1px;">Webhooks</button>
    </div>

    <div id="sa-panel-signals">
      <section class="theme-section">
        <h3 class="theme-section-title">Active Signals</h3>
        <p class="theme-section-desc">Built-in signal feeds currently providing data to the entity</p>
        <div class="llm-fields">
          <div class="llm-field">
            <label>Current Conversation</label>
            <div class="sa-signal-desc">Tells the entity which conversation they are currently processing, including the conversation ID and title.</div>
          </div>
          <div class="llm-field">
            <label>Last User Interaction</label>
            <div class="sa-signal-desc">Tracks the most recent human message across all threads, excluding automated Pulse messages. The entity sees the timestamp and which thread the message was sent in.</div>
          </div>
          <div class="llm-field">
            <label>Device Detection</label>
            <div class="sa-signal-desc">Detects whether you're on desktop or mobile when sending a message. The entity receives this as a simple desktop/mobile indicator.</div>
          </div>
          <div class="llm-field">
            <label>Connected Devices</label>
            <div class="sa-signal-desc">Shows which Lovense toys, Intiface devices, and home smart devices are currently connected. Refreshed every 30 seconds.</div>
          </div>
        </div>
      </section>
      ${dataStreamsSection}
    </div>

    <div id="sa-panel-webhooks" style="display:none;">
      <section class="theme-section">
        <h3 class="theme-section-title">Webhooks</h3>
        <p class="theme-section-desc">Trigger Pulses when data streams match conditions</p>
        <div id="event-rules-list">
          ${webhooksRulesList}
        </div>
        <div style="margin-top: 12px;">
          <button class="btn btn--primary" onclick="addEventRule()">Add Webhook</button>
        </div>
      </section>
      <template id="event-rule-blank-row">
        <div class="event-rule-card" data-rule-id="" style="border:1px solid var(--c-border);border-radius:8px;padding:12px;margin-bottom:8px;">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;">
            <label class="toggle-label" style="margin:0;">
              <input type="checkbox" data-rule-enabled role="switch" checked>
              <span class="toggle-slider"></span>
            </label>
            <input type="text" data-rule-name placeholder="Rule name"
              style="flex:1;background:var(--input-bg);color:var(--c-fg);border:1px solid var(--c-border);border-radius:4px;padding:6px 8px;font-size:14px;">
            <button class="btn" onclick="deleteEventRule(this)" title="Delete rule"
              style="padding:4px 8px;color:var(--c-fg-muted);">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
            </button>
          </div>
          <div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:8px;align-items:center;">
            <label style="font-size:12px;color:var(--c-fg-muted);">IF</label>
            <select data-cond-stream style="background:var(--input-bg);color:var(--c-fg);border:1px solid var(--c-border);border-radius:4px;padding:4px 6px;font-size:13px;">
              ${streamOptions}
            </select>
            <select data-cond-operator style="background:var(--input-bg);color:var(--c-fg);border:1px solid var(--c-border);border-radius:4px;padding:4px 6px;font-size:13px;">
              <option value="changes_to">changes to</option>
              <option value="goes_above">goes above</option>
              <option value="goes_below">goes below</option>
            </select>
            <input type="text" data-cond-value placeholder="value"
              style="width:60px;background:var(--input-bg);color:var(--c-fg);border:1px solid var(--c-border);border-radius:4px;padding:4px 6px;font-size:13px;">
            <input type="number" data-cond-sustained placeholder="sustain min" min="0"
              style="width:80px;background:var(--input-bg);color:var(--c-fg);border:1px solid var(--c-border);border-radius:4px;padding:4px 6px;font-size:13px;" title="Sustained: condition must hold for this many minutes before firing">
          </div>
          <div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:8px;align-items:center;">
            <label style="font-size:12px;color:var(--c-fg-muted);">THEN</label>
            <span style="font-size:13px;">Run Pulse:</span>
            <select data-action-pulse style="background:var(--input-bg);color:var(--c-fg);border:1px solid var(--c-border);border-radius:4px;padding:4px 6px;font-size:13px;">
              ${pulseOptions}
            </select>
          </div>
          <div style="display:flex;align-items:center;gap:8px;">
            <label style="font-size:13px;color:var(--c-fg-muted);">Cooldown:</label>
            <input type="number" data-rule-cooldown value="5" min="0"
              style="width:50px;background:var(--input-bg);color:var(--c-fg);border:1px solid var(--c-border);border-radius:4px;padding:4px 6px;font-size:13px;">
            <span style="font-size:12px;color:var(--c-fg-muted);">min</span>
          </div>
        </div>
      </template>
    </div>

    <div style="margin-top: 16px;">
      <button class="btn btn--primary" onclick="saveSASettings()">Save Changes</button>
    </div>

    <div id="sa-settings-status" class="settings-status"></div>

  </div>
</div>
<style>
  .sa-signal-desc {
    font-size: var(--font-size-sm);
    color: var(--c-fg-muted);
    line-height: 1.5;
    margin-top: 4px;
  }
  .sa-tab--active { color: var(--c-accent) !important; font-weight: 600 !important; border-bottom-color: var(--c-accent) !important; }
</style>`;
}

function renderEventRuleCard(
  rule: import("../wearable/event-rules.ts").EventRule,
): string {
  const opLabel: Record<string, string> = {
    changes_to: "changes to",
    goes_above: "goes above",
    goes_below: "goes below",
  };
  return `<div class="event-rule-card" data-rule-id="${
    escapeHtml(rule.id)
  }" style="border:1px solid var(--c-border);border-radius:8px;padding:12px;margin-bottom:8px;${
    !rule.enabled ? "opacity:0.5;" : ""
  }">
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">
      <label class="toggle-label" style="margin:0;">
        <input type="checkbox" data-rule-enabled role="switch" ${
    rule.enabled ? "checked" : ""
  }>
        <span class="toggle-slider"></span>
      </label>
      <span style="font-weight:600;font-size:14px;flex:1;">${
    escapeHtml(rule.name)
  }</span>
      <span style="font-size:12px;color:var(--c-fg-muted);">Cooldown: ${rule.cooldownMinutes}min</span>
      <button class="btn" onclick="deleteEventRule(this)" title="Delete rule"
        style="padding:4px 8px;color:var(--c-fg-muted);">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
      </button>
    </div>
    <div style="display:flex;flex-wrap:wrap;gap:4px;align-items:center;margin-bottom:4px;">
      <span style="font-size:12px;color:var(--c-fg-muted);">IF</span>
      <span style="background:var(--input-bg);padding:2px 6px;border-radius:4px;font-size:13px;font-family:monospace;">${
    escapeHtml(rule.condition.streamId)
  } ${opLabel[rule.condition.operator] ?? rule.condition.operator} ${
    escapeHtml(String(rule.condition.value))
  }${
    rule.condition.sustainedMinutes
      ? " for " + rule.condition.sustainedMinutes + "min"
      : ""
  }</span>
    </div>
    <div style="display:flex;flex-wrap:wrap;gap:4px;align-items:center;">
      <span style="font-size:12px;color:var(--c-fg-muted);">THEN</span>
      <span style="font-size:13px;">Run Pulse: <strong>${
    escapeHtml(rule.action.pulseId)
  }</strong></span>
    </div>
  </div>`;
}

/**
 * Render the sidebar with conversation list.
 */
export function renderSidebar(conversations: Conversation[]): string {
  return `<aside class="sidebar" id="sidebar">
  <div class="sidebar-header">
    <span class="sidebar-title">Conversations</span>
    <button class="btn btn--primary btn--sm" onclick="Psycheros.newConversation()">+ New</button>
  </div>
  <nav class="conv-list" id="conv-list" hx-get="/fragments/conv-list" hx-trigger="load" hx-swap="innerHTML">
    ${renderConversationList(conversations)}
  </nav>
  <div class="sidebar-footer">
    <button class="sidebar-settings-link discord-nav-link" id="discord-sidebar-btn" style="display:none"
      hx-get="/fragments/discord"
      hx-target="#chat"
      hx-swap="innerHTML"
      onclick="Psycheros.closeSidebarAfterNav()">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
        <path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z"/>
      </svg>
      <span>Discord</span>
      <span class="discord-status-dot" id="discord-status-dot"></span>
    </button>
    <button class="sidebar-settings-link"
      hx-get="/fragments/settings"
      hx-target="#chat"
      hx-swap="innerHTML"
      onclick="Psycheros.closeSidebarAfterNav()">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <circle cx="12" cy="12" r="3"/>
        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/>
      </svg>
      <span>Settings</span>
    </button>
  </div>
</aside>`;
}

/**
 * Render the conversation list items.
 * This can be returned as a partial for HTMX swaps.
 */
export function renderConversationList(
  conversations: Conversation[],
  pulseConversationIds?: Set<string>,
): string {
  if (conversations.length === 0) {
    return `<div class="conv-empty">No conversations yet</div>`;
  }

  return conversations
    .map((conv) =>
      renderConversationItem(
        conv,
        false,
        pulseConversationIds?.has(conv.id),
      )
    )
    .join("");
}

/**
 * Render a single conversation list item with swipe actions.
 */
export function renderConversationItem(
  conv: Conversation,
  isActive = false,
  hasPulse = false,
): string {
  const title = escapeHtml(conv.title || "Untitled");
  const date = formatDate(conv.updatedAt || conv.createdAt);
  const escapedId = escapeHtml(conv.id);
  const encodedId = encodeURIComponent(conv.id);
  const pulseIndicator = hasPulse
    ? `<svg class="pulse-indicator" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" title="Active Pulse"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>`
    : "";

  // Swipe wrapper structure with edit action (delete removed - too easy to lose conversations)
  return `<div class="conv-item-wrapper" data-conv-id="${escapedId}">
  <div class="conv-swipe-action conv-swipe-action--edit" data-action="edit">
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
      <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
    </svg>
  </div>
  <a class="conv-item${isActive ? " active" : ""}"
    data-conv-id="${escapedId}"
    hx-get="/fragments/chat/${encodedId}"
    hx-target="#chat"
    hx-swap="innerHTML"
    hx-push-url="/c/${encodedId}">
    <input type="checkbox" class="conv-select-checkbox" data-conv-id="${escapedId}" onclick="event.stopPropagation()">
    <span class="conv-title">${pulseIndicator}${title}</span>
    <span class="conv-date">${date}</span>
    <div class="conv-actions">
      <button class="conv-action-btn conv-action-btn--edit" data-action="edit" title="Edit title" onclick="event.preventDefault(); event.stopPropagation(); Psycheros.startTitleEdit('${escapedId}')">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
          <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
        </svg>
      </button>
      <button class="conv-action-btn conv-action-btn--delete" data-action="delete" title="Delete" onclick="event.preventDefault(); event.stopPropagation(); Psycheros.showDeleteModal(['${escapedId}'])">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="3,6 5,6 21,6"/>
          <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
        </svg>
      </button>
    </div>
  </a>
</div>`;
}

// =============================================================================
// Chat View Templates
// =============================================================================

/**
 * Map of message ID to metrics for efficient lookup during rendering.
 */
export type MetricsMap = Map<string, TurnMetrics>;

/**
 * Render the chat view for a conversation.
 * Includes messages and input area.
 *
 * @param messages - Messages to render
 * @param metricsMap - Optional map of message ID to metrics
 * @param hasMoreOlder - If true, render a sentinel for loading older messages
 */
export function renderChatView(
  messages: Message[],
  metricsMap?: MetricsMap,
  displayNames?: { entityName: string; userName: string },
  hasMoreOlder?: boolean,
): string {
  const oldestCreatedAt = messages.length > 0
    ? messages[0].createdAt.toISOString()
    : "";
  const oldestId = messages.length > 0 ? messages[0].id : "";
  const sentinel = hasMoreOlder
    ? `<div id="load-earlier-sentinel" class="load-earlier-sentinel" data-oldest-created-at="${
      escapeHtml(oldestCreatedAt)
    }" data-oldest-id="${escapeHtml(oldestId)}">
    <div class="load-earlier-spinner"></div>
  </div>`
    : "";
  return `<div class="messages" id="messages">
  ${sentinel}${
    messages.length === 0
      ? ""
      : renderMessages(messages, metricsMap, displayNames)
  }
</div>
${renderInputArea()}`;
}

/**
 * Render all messages.
 */
export function renderMessages(
  messages: Message[],
  metricsMap?: MetricsMap,
  displayNames?: { entityName: string; userName: string },
): string {
  // Build a lookup of tool results by toolCallId so renderToolCard can
  // surface persisted results (and their image sidecar) on reload. Without
  // this, tool cards on reload show only the call args — no result and no
  // generated image.
  const toolResultsByCallId = new Map<string, Message>();
  for (const m of messages) {
    if (m.role === "tool" && m.toolCallId) {
      toolResultsByCallId.set(m.toolCallId, m);
    }
  }
  return messages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) =>
      renderMessage(m, metricsMap?.get(m.id), displayNames, toolResultsByCallId)
    )
    .join("");
}

/**
 * Render a single message based on role.
 */
export function renderMessage(
  msg: Message,
  metrics?: TurnMetrics,
  displayNames?: { entityName: string; userName: string },
  toolResultsByCallId?: Map<string, Message>,
): string {
  // Derive [Voice Chat] prefix from the isVoice column (authoritative).
  // Also strip any stray prefix from content as defense-in-depth — the
  // column is the source of truth, content should never carry the prefix.
  const cleanContent = msg.content.replace(/\[Voice Chat\]\s*/g, "");
  const voicedMsg = msg.isVoice
    ? { ...msg, content: "[Voice Chat] " + cleanContent }
    : { ...msg, content: cleanContent };
  if (voicedMsg.role === "user") {
    if (voicedMsg.pulseId || voicedMsg.pulseName) {
      return renderPulseMessage(voicedMsg);
    }
    return renderUserMessage(
      voicedMsg.content,
      voicedMsg.id,
      voicedMsg.editedAt,
      voicedMsg.createdAt,
      displayNames?.userName,
    );
  } else if (voicedMsg.role === "assistant") {
    return renderAssistantMessage(
      voicedMsg,
      metrics,
      displayNames?.entityName,
      toolResultsByCallId,
    );
  }
  return "";
}

/**
 * Render a user message.
 *
 * @param content - Message content
 * @param messageId - Optional message ID (for edit functionality)
 * @param editedAt - Optional timestamp when message was edited
 */
export function renderUserMessage(
  content: string,
  messageId?: string,
  editedAt?: Date,
  createdAt?: Date,
  userName?: string,
): string {
  const editedIndicator = editedAt
    ? `<span class="msg-edited-indicator">(edited)</span>`
    : "";
  const editBtn = messageId
    ? `<button class="msg-edit-btn" onclick="Psycheros.startMessageEdit('${
      escapeHtml(messageId)
    }')" title="Edit message">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
          <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
        </svg>
      </button>`
    : "";
  const dataAttr = messageId
    ? `data-message-id="${escapeHtml(messageId)}"`
    : "";
  const timeStr = createdAt ? formatMessageTime(createdAt) : "";
  const timeEl = timeStr
    ? `<span class="msg-timestamp">${escapeHtml(timeStr)}</span>`
    : "";
  const displayName = escapeHtml(userName || "You");

  // Extract [USER_IMAGE: path | ...] markers and render as images
  let imageHtml = "";
  let textContent = content;
  const userImageMatch = content.match(
    /^\[USER_IMAGE:\s*(\/[^\s\]]+)(?:\s*\|[^\]]*)?\]\s*([\s\S]*)$/,
  );
  if (userImageMatch) {
    const imagePath = userImageMatch[1];
    textContent = userImageMatch[2].trim();
    // Suppress the fallback placeholder text for image-only messages
    if (textContent === "(image attached)") textContent = "";
    imageHtml = `<img src="${
      escapeHtml(imagePath)
    }" class="attachment-in-message" alt="Attached image" loading="lazy"/>`;
  }

  const contentHtml = textContent ? renderMarkdown(textContent) : "";

  return `<div class="msg msg--user" ${dataAttr}>
  <div class="msg-header">
    ${timeEl}
    <span>${displayName}</span>
    ${editedIndicator}
    ${editBtn}
  </div>
  <div class="msg-content user-text" data-raw-content="${
    escapeHtml(content)
  }">${imageHtml}${contentHtml}</div>
</div>`;
}

/**
 * Render a Pulse system message — centered with accent border and Pulse icon.
 */
function renderPulseMessage(msg: Message): string {
  const dataAttr = msg.id ? `data-message-id="${escapeHtml(msg.id)}"` : "";
  const timeStr = msg.createdAt ? formatMessageTime(msg.createdAt) : "";
  const timeEl = timeStr
    ? `<span class="msg-timestamp">${escapeHtml(timeStr)}</span>`
    : "";
  const pulseName = escapeHtml(msg.pulseName || "Pulse");
  const icon = pulseIconSvg(14);
  const editBtn = msg.id
    ? `<button class="msg-edit-btn" onclick="Psycheros.startMessageEdit('${
      escapeHtml(msg.id)
    }')" title="Edit message">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
          <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
        </svg>
      </button>`
    : "";

  return `<div class="msg msg--pulse" ${dataAttr}>
  <div class="msg-header">
    <span class="pulse-header-icon">${icon}</span>
    <span>${pulseName}</span>
    ${timeEl}
    ${editBtn}
  </div>
  <div class="msg-content" data-raw-content="${escapeHtml(msg.content)}">${
    renderMarkdown(msg.content)
  }</div>
</div>`;
}

/**
 * Render an assistant message with optional thinking, tool calls, and metrics.
 */
export function renderAssistantMessage(
  msg: Message,
  metrics?: TurnMetrics,
  entityName?: string,
  toolResultsByCallId?: Map<string, Message>,
): string {
  const editedIndicator = msg.editedAt
    ? `<span class="msg-edited-indicator">(edited)</span>`
    : "";
  const editBtn = msg.id
    ? `<button class="msg-edit-btn" onclick="Psycheros.startMessageEdit('${
      escapeHtml(msg.id)
    }')" title="Edit message">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
          <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
        </svg>
      </button>`
    : "";

  const timeStr = msg.createdAt ? formatMessageTime(msg.createdAt) : "";
  const timeEl = timeStr
    ? `<span class="msg-timestamp">${escapeHtml(timeStr)}</span>`
    : "";
  const displayName = escapeHtml(entityName || "Assistant");

  let html = `<div class="msg msg--assistant" data-message-id="${
    escapeHtml(msg.id)
  }">
  <div class="msg-header">
    <span>${displayName}</span>
    ${timeEl}
    ${editedIndicator}
    ${metrics ? renderMetricsIndicator(metrics) : ""}
    ${editBtn}
  </div>
  <div class="msg-content">`;

  // Thinking section
  if (msg.reasoningContent) {
    html += renderThinkingSection(msg.reasoningContent);
  }

  // Tool calls
  if (msg.toolCalls && msg.toolCalls.length > 0) {
    for (const tc of msg.toolCalls) {
      const toolMsg = toolResultsByCallId?.get(tc.id);
      const result: ToolResult | undefined = toolMsg
        ? { toolCallId: tc.id, content: toolMsg.content }
        : undefined;
      html += renderToolCard(tc, result);
      // If the tool produced an image sidecar, render it as a sibling below
      // the (collapsed) tool card. Matches the streaming `image_generated`
      // event path — same DOM, same caption toggle, both keyed by toolCallId.
      if (toolMsg?.metadata?.image) {
        html += renderGeneratedImageSibling(toolMsg.metadata.image, tc.id);
      }
    }
  }

  // Main content - render markdown for assistant messages
  if (msg.content) {
    // Extract [IMAGE:...] markers from raw content BEFORE markdown rendering.
    // marked would corrupt JSON values containing markdown syntax (*, _, `, etc.)
    // causing JSON.parse to fail on page reload.
    let preprocessed = msg.content;
    preprocessed = preprocessed.replace(
      /\[IMAGE:\{.*?\}\]/g,
      (match) => {
        try {
          const jsonStr = match.slice(7, -1); // Strip "[IMAGE:" and "]"
          const img = JSON.parse(jsonStr);
          return `\n\n<div class="generated-image-container"><img src="${
            escapeHtml(img.path)
          }" alt="${
            escapeHtml(img.prompt)
          }" class="generated-image" loading="lazy"/><div class="generated-image-meta">${
            escapeHtml(img.generator)
          }</div></div>\n\n`;
        } catch {
          return match;
        }
      },
    );
    const contentHtml = renderMarkdown(preprocessed);
    html += `<div class="assistant-text" data-raw-content="${
      escapeHtml(msg.content)
    }">${contentHtml}</div>`;
  }

  html += `</div></div>`;
  return html;
}

/**
 * Format milliseconds as human-readable string.
 */
function formatMs(ms: number | null): string {
  if (ms === null || ms === undefined) return "-";
  if (ms >= 1000) {
    return (ms / 1000).toFixed(1) + "s";
  }
  return Math.round(ms) + "ms";
}

/**
 * Get CSS class for metric value based on thresholds.
 */
function getMetricClass(metric: string, value: number | null): string {
  if (value === null || value === undefined) return "";

  switch (metric) {
    case "ttfb":
      if (value > 2000) return "slow";
      if (value > 1000) return "warning";
      return "";
    case "ttfc":
      if (value > 3000) return "slow";
      if (value > 2000) return "warning";
      return "";
    case "maxChunkGap":
      if (value > 1000) return "slow";
      if (value > 500) return "warning";
      return "";
    case "slowChunkCount":
      if (value > 5) return "slow";
      if (value > 0) return "warning";
      return "";
    default:
      return "";
  }
}

/**
 * Render the metrics indicator for an assistant message header.
 */
export function renderMetricsIndicator(metrics: TurnMetrics): string {
  const summary = formatMs(metrics.totalDuration);

  const rows = [
    { label: "TTFB", value: metrics.ttfb, metric: "ttfb", raw: false },
    { label: "TTFC", value: metrics.ttfc, metric: "ttfc", raw: false },
    {
      label: "Max Gap",
      value: metrics.maxChunkGap,
      metric: "maxChunkGap",
      raw: false,
    },
    {
      label: "Slow Chunks",
      value: metrics.slowChunkCount,
      metric: "slowChunkCount",
      raw: true,
    },
    {
      label: "Total",
      value: metrics.totalDuration,
      metric: "total",
      raw: false,
    },
    { label: "Chunks", value: metrics.chunkCount, metric: "chunks", raw: true },
  ];

  const tooltipRows = rows
    .map((row) => {
      const valueClass = getMetricClass(row.metric, row.value);
      const displayValue = row.raw ? (row.value ?? "-") : formatMs(row.value);
      return `<div class="metrics-row">
      <span class="metrics-label">${row.label}</span>
      <span class="metrics-value ${valueClass}">${displayValue}</span>
    </div>`;
    })
    .join("");

  return `<div class="metrics-indicator">
    <span class="metrics-indicator-icon">&#9201;</span>
    <span class="metrics-indicator-summary">${summary}</span>
    <div class="metrics-tooltip">${tooltipRows}</div>
  </div>`;
}

/**
 * Render the empty state when no conversation is selected.
 */
export function renderEmptyState(): string {
  return `<div class="messages" id="messages">
  <div class="empty-state" id="empty-state">
    <div class="empty-logo">
      ${renderBrandMark("empty-logo-grad", 120, "Psycheros")}
    </div>
    <div class="empty-title">Psycheros</div>
    <div class="empty-tagline">seize the means of companionship</div>
    <p class="empty-text">Start a new conversation or select one from the sidebar.</p>
  </div>
</div>`;
}

/**
 * Render the input area.
 */
export function renderInputArea(): string {
  return `<div class="input-area">
  <div class="input-container">
    <label class="attach-btn" title="Attach image" style="position:relative;overflow:hidden;cursor:pointer;">
      <input type="file" id="attach-input" accept="image/*" style="position:absolute;inset:0;opacity:0;cursor:pointer;" onchange="Psycheros.handleAttachment(this)" />
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
        <circle cx="8.5" cy="8.5" r="1.5"/>
        <polyline points="21 15 16 10 5 21"/>
      </svg>
    </label>
    <textarea
      class="input-field"
      id="message-input"
      placeholder="Type your message..."
      rows="1"
      onkeydown="Psycheros.handleKeyDown(event)"
      oninput="Psycheros.autoResize(this)"
    ></textarea>
    <button class="send-btn" id="send-btn" onclick="Psycheros.sendMessage()">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>
    </button>
  </div>
  <div id="attachment-preview" class="attachment-preview" style="display:none;"></div>
</div>`;
}

// =============================================================================
// Component Templates
// =============================================================================

/**
 * Render a collapsible thinking section.
 * Collapsed by default; toggle 'expanded' class to show content.
 */
export function renderThinkingSection(content: string): string {
  return `<div class="thinking">
  <div class="thinking-header" onclick="this.parentElement.classList.toggle('expanded')">
    <span class="thinking-toggle">&#9660;</span>
    <span>Thinking</span>
  </div>
  <div class="thinking-content">${escapeHtml(content)}</div>
</div>`;
}

/**
 * Render a tool call card.
 * Collapsed by default; toggle 'expanded' class to show args/result.
 */
export function renderToolCard(
  toolCall: ToolCall,
  result?: ToolResult,
): string {
  const name = escapeHtml(toolCall.function.name);
  let args = toolCall.function.arguments;

  // Generate brief summary for collapsed state
  let summary = "";
  const parsed = tryJsonParse(args, null);
  if (hasStringCommand(parsed)) {
    // For shell commands, show abbreviated command
    const cmd = parsed.command;
    summary = cmd.length > 50 ? cmd.substring(0, 50) + "..." : cmd;
  }

  // Try to format JSON for expanded view
  const parsedForFormat = tryJsonParse(args, null);
  if (parsedForFormat !== null) {
    args = JSON.stringify(parsedForFormat, null, 2);
  }

  let html = `<div class="tool" data-tool-call-id="${toolCall.id}">
  <div class="tool-header" onclick="this.parentElement.classList.toggle('expanded')">
    <span class="tool-icon">&#9881;</span>
    <span class="tool-name">${name}</span>
    ${summary ? `<span class="tool-summary">${escapeHtml(summary)}</span>` : ""}
    <span class="tool-toggle">&#9660;</span>
  </div>
  <div class="tool-args">${escapeHtml(args)}</div>`;

  if (result) {
    html += renderToolResult(result);
  }

  html += `</div>`;
  return html;
}

/**
 * Render a generated image as a sibling element below the tool card.
 * Matches the streaming `image_generated` event's DOM exactly so the
 * caption-toggle ids line up across both paths.
 */
function renderGeneratedImageSibling(
  image: NonNullable<NonNullable<Message["metadata"]>["image"]>,
  toolCallId: string,
): string {
  const captionHtml = image.description
    ? `<div class="generated-image-caption-toggle" onclick="Psycheros.toggleImageCaption('${
      escapeHtml(toolCallId)
    }')">▸ Show caption</div>
  <div class="generated-image-caption" id="caption-${
      escapeHtml(toolCallId)
    }" hidden>${escapeHtml(image.description)}</div>`
    : "";
  return `<div class="generated-image-container">
  <img src="${escapeHtml(image.path)}" alt="${
    escapeHtml(image.prompt)
  }" class="generated-image" loading="lazy"/>
  <div class="generated-image-meta">${escapeHtml(image.generatorName)}</div>
  ${captionHtml}
</div>`;
}

/**
 * Render a tool result section.
 */
export function renderToolResult(result: ToolResult): string {
  const isError = result.isError ?? false;
  let content = result.content;

  // Try to format JSON if it looks like JSON
  if (content.startsWith("{") || content.startsWith("[")) {
    const parsed = tryJsonParse(content, null);
    if (parsed !== null) {
      content = JSON.stringify(parsed, null, 2);
    }
  }

  // Detect [IMAGE:...] markers and render them inline (legacy path for
  // messages persisted before the metadata.image refactor).
  const imagePattern = /\[IMAGE:(\{.*?\})\]/g;
  if (imagePattern.test(content)) {
    content = content.replace(imagePattern, (_match, jsonStr) => {
      try {
        const img = JSON.parse(jsonStr);
        return `<div class="generated-image-container"><img src="${
          escapeHtml(img.path)
        }" alt="${
          escapeHtml(img.prompt)
        }" class="generated-image" loading="lazy"/><div class="generated-image-meta">${
          escapeHtml(img.generator)
        }</div></div>`;
      } catch {
        return _match;
      }
    });
    // Remove the "Image generated successfully." prefix text if present
    content = content.replace(/^Image generated successfully\.\s*/, "");
    return `<div class="tool-result${isError ? " error" : ""}">
  <div class="tool-result-label">${isError ? "Error" : "Output"}</div>
  ${content}
</div>`;
  }

  return `<div class="tool-result${isError ? " error" : ""}">
  <div class="tool-result-label">${isError ? "Error" : "Output"}</div>
  ${escapeHtml(content)}
</div>`;
}

// =============================================================================
// Settings Templates
// =============================================================================

/**
 * Valid core prompt directories.
 */
const VALID_DIRECTORIES = [
  "self",
  "user",
  "relationship",
  "custom",
  "snapshots",
] as const;
type PromptDirectory = typeof VALID_DIRECTORIES[number];

/**
 * Check if a directory is a valid prompt directory.
 */
export function isValidPromptDirectory(dir: string): dir is PromptDirectory {
  return VALID_DIRECTORIES.includes(dir as PromptDirectory);
}

/**
 * Render the Core Prompts Settings view.
 * Shows tabs for self/user/relationship/custom directories and file list.
 */
export function renderCorePromptsSettings(
  activeDir: PromptDirectory = "self",
): string {
  const tabs = [
    { id: "self", label: "Self" },
    { id: "user", label: "User" },
    { id: "relationship", label: "Relationship" },
    { id: "custom", label: "Custom" },
  ];

  const tabsHtml = tabs.map((tab) => {
    const isActive = tab.id === activeDir;
    return `<button
      class="settings-tab${isActive ? " active" : ""}"
      hx-get="/fragments/settings/core-prompts/${tab.id}"
      hx-target="#settings-content"
      hx-swap="innerHTML"
      id="tab-${tab.id}"
    >${tab.label}</button>`;
  }).join("");

  return `<div class="settings-view">
  <div class="settings-header">
    <div class="settings-header-row">
      ${renderSettingsBackButton()}
      <div>
        <h1 class="settings-title">Core Prompts</h1>
        <p class="settings-desc">Edit the prompt files that define the entity's core behavior.</p>
      </div>
    </div>
  </div>
  <div class="settings-tabs">
    ${tabsHtml}
  </div>
  <div class="settings-content" id="settings-content"
    hx-get="/fragments/settings/core-prompts/${activeDir}"
    hx-trigger="load"
    hx-swap="innerHTML">
    <div class="settings-loading">Loading...</div>
  </div>
</div>`;
}

/**
 * Render the file list for a prompt directory.
 * Includes OOB swap to update the active tab state.
 * For custom directory, includes create file input and delete buttons.
 */
export function renderFileList(
  directory: PromptDirectory,
  files: string[],
): string {
  const isCustom = directory === "custom";

  // Custom directory has special UI for creating files
  let createFileHtml = "";
  if (isCustom) {
    createFileHtml = `
      <div class="settings-create-file">
        <input
          type="text"
          class="settings-create-file-input"
          id="custom-filename-input"
          placeholder="New file name (e.g., my_context.md)"
          pattern="[a-zA-Z0-9_]+\\.md"
        />
        <button
          class="btn btn--primary btn--sm"
          onclick="Psycheros.createCustomFile()"
        >
          Create
        </button>
      </div>`;
  }

  // All categories get an "Upload File" button
  const uploadFileHtml = `
    <details class="settings-upload-details" style="margin-bottom: 12px;">
      <summary class="btn btn--ghost btn--sm" style="cursor: pointer;">Upload File</summary>
      <div class="settings-upload-form" style="margin-top: 8px; display: flex; flex-direction: column; gap: 8px;">
        <input
          type="text"
          class="settings-create-file-input"
          id="upload-filename-input"
          placeholder="File name (e.g., base_instructions.md)"
          style="padding: 8px; border: 1px solid var(--border); border-radius: 6px; background: var(--input-bg); color: var(--fg); font-family: inherit; font-size: 13px;"
        />
        <textarea
          id="upload-content-input"
          placeholder="Paste file content here..."
          rows="5"
          style="padding: 8px; border: 1px solid var(--border); border-radius: 6px; background: var(--input-bg); color: var(--fg); resize: vertical; font-family: inherit; font-size: 13px;"
        ></textarea>
        <button
          class="btn btn--primary btn--sm"
          onclick="Psycheros.uploadIdentityFile('${directory}')"
          style="align-self: flex-end;"
        >
          Upload
        </button>
      </div>
    </details>`;

  const fileListHtml = files.length === 0
    ? `<div class="settings-empty">${
      isCustom
        ? "No custom files yet. Create one above!"
        : "No files in this directory"
    }</div>`
    : `<div class="settings-file-list">
      ${
      files.map((file) => {
        const displayName = file.replace(/\.md$/, "").replace(/_/g, " ");
        const deleteButton = isCustom
          ? `<button
              class="settings-file-delete"
              onclick="event.stopPropagation(); Psycheros.deleteCustomFile('${
            escapeHtml(file)
          }')"
              title="Delete file"
            ><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg></button>`
          : "";
        return `<button
          class="settings-file-item"
          hx-get="/fragments/settings/file/${directory}/${
          encodeURIComponent(file)
        }"
          hx-target="#settings-content"
          hx-swap="innerHTML"
        >
          <svg class="settings-file-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
            <polyline points="14 2 14 8 20 8"/>
          </svg>
          <span class="settings-file-name">${escapeHtml(displayName)}</span>
          ${deleteButton}
        </button>`;
      }).join("")
    }
    </div>`;

  // OOB swap to update active tab
  const oobSwap = renderTabActiveState(directory);

  return createFileHtml + uploadFileHtml + fileListHtml + oobSwap;
}

/**
 * Render the active tab indicator as an OOB swap.
 */
function renderTabActiveState(
  activeDir: PromptDirectory | "snapshots",
): string {
  const tabs = ["self", "user", "relationship", "custom", "snapshots"];
  return tabs.map((dir) => {
    const isActive = dir === activeDir;
    const label = dir === "custom"
      ? "Custom"
      : dir === "snapshots"
      ? "Snapshots"
      : dir.charAt(0).toUpperCase() + dir.slice(1);
    const url = dir === "snapshots"
      ? "/fragments/settings/snapshots"
      : `/fragments/settings/core-prompts/${dir}`;
    return `<button
      class="settings-tab${isActive ? " active" : ""}"
      hx-get="${url}"
      hx-target="#settings-content"
      hx-swap="innerHTML"
      hx-swap-oob="true"
      id="tab-${dir}"
    >${label}</button>`;
  }).join("");
}

/**
 * Render the file editor with textarea.
 */
export function renderFileEditor(
  directory: PromptDirectory,
  filename: string,
  content: string,
  promptLabel?: string,
): string {
  const displayName = filename.replace(/\.md$/, "").replace(/_/g, " ");
  const safeContent = escapeHtml(content);
  const safeLabel = escapeHtml(promptLabel ?? filename.replace(/\.md$/, ""));

  return `<div class="settings-editor">
  <div class="settings-editor-header">
    <button
      class="btn btn--ghost btn--sm"
      hx-get="/fragments/settings/core-prompts/${directory}"
      hx-target="#settings-content"
      hx-swap="innerHTML"
    >
      ← Back
    </button>
    <span class="settings-editor-filename">${escapeHtml(displayName)}</span>
    <span class="settings-editor-tokens" id="settings-editor-tokens">...</span>
  </div>
  <div class="settings-prompt-label">
    <label for="prompt-label">Prompt Label</label>
    <input
      type="text"
      id="prompt-label"
      name="promptLabel"
      value="${safeLabel}"
      pattern="[a-zA-Z0-9_]+"
      class="settings-input settings-input--sm"
      hx-post="/api/settings/prompt-label/${directory}/${
    encodeURIComponent(filename)
  }"
      hx-trigger="change"
      hx-target="#prompt-label-status"
      hx-swap="innerHTML"
    />
    <div id="prompt-label-status" class="settings-prompt-label-status"></div>
  </div>
  <form
    class="settings-editor-form"
    hx-post="/api/settings/file/${directory}/${encodeURIComponent(filename)}"
    hx-target="#settings-editor-status"
    hx-swap="innerHTML"
  >
    <textarea
      class="settings-textarea"
      name="content"
      data-tokenize
      placeholder="Enter prompt content..."
      rows="20"
    >${safeContent}</textarea>
    <div class="settings-editor-actions">
      <button
        type="button"
        class="btn btn--ghost"
        hx-get="/fragments/settings/core-prompts/${directory}"
        hx-target="#settings-content"
        hx-swap="innerHTML"
      >Cancel</button>
      <button type="submit" class="btn btn--primary">Save</button>
    </div>
    <div id="settings-editor-status" class="settings-editor-status"></div>
  </form>
</div>`;
}

/**
 * Render a success message after saving.
 */
export function renderSaveSuccess(): string {
  return `<div class="settings-save-success">✓ Saved successfully</div>`;
}

/**
 * Render an error message.
 */
export function renderSaveError(message: string): string {
  return `<div class="settings-save-error">✗ ${escapeHtml(message)}</div>`;
}

// =============================================================================
// Snapshot Templates
// =============================================================================

/**
 * Render the snapshots list view.
 *
 * @param snapshots - Array of snapshot metadata
 * @returns HTML string for the snapshots list
 */
export function renderSnapshotsView(
  snapshots: Array<{
    id: string;
    category: string;
    filename: string;
    timestamp: string;
    date: string;
    reason: string;
    source?: string;
  }>,
): string {
  // Group snapshots by date
  const grouped: Record<string, typeof snapshots> = {};
  for (const snapshot of snapshots) {
    if (!grouped[snapshot.date]) {
      grouped[snapshot.date] = [];
    }
    grouped[snapshot.date].push(snapshot);
  }

  // Sort dates descending (newest first)
  const sortedDates = Object.keys(grouped).sort((a, b) => b.localeCompare(a));

  if (sortedDates.length === 0) {
    return `<div class="snapshots-empty">
      <p>No snapshots available. Snapshots are created automatically on the scheduled hour (default 3 AM) and before major changes.</p>
      <button
        class="btn btn--primary"
        hx-post="/api/snapshots/create"
        hx-target="#settings-content"
        hx-swap="innerHTML"
      >Create Manual Snapshot</button>
    </div>` + renderTabActiveState("snapshots");
  }

  let html = `<div class="snapshots-header">
    <button
      class="btn btn--primary btn--sm"
      hx-post="/api/snapshots/create"
      hx-target="#settings-content"
      hx-swap="innerHTML"
    >Create Manual Snapshot</button>
  </div>`;

  for (const date of sortedDates) {
    const dateSnapshots = grouped[date];
    const formattedDate = formatSnapshotDate(date);

    html += `<div class="snapshot-group">
      <h3 class="snapshot-group-date">${escapeHtml(formattedDate)}</h3>`;

    for (const snapshot of dateSnapshots) {
      const formattedTime = formatTime(snapshot.timestamp);
      const formattedReason = snapshot.reason;
      const encodedSnapshotId = encodeURIComponent(snapshot.id);
      const snapshotSource = snapshot.source || "entity-core";

      html += `
        <div class="snapshot-item"
          hx-get="/fragments/settings/snapshots/${encodedSnapshotId}"
          hx-target="#settings-content"
          hx-swap="innerHTML"
        >
          <span class="snapshot-category">${
        escapeHtml(snapshot.category)
      }</span>
          <span class="snapshot-filename">${
        escapeHtml(snapshot.filename.replace(/\.md$/, ""))
      }</span>
          <span class="snapshot-time">${formattedTime}</span>
          <span class="snapshot-reason">${escapeHtml(formattedReason)}</span>
          <span class="snapshot-source">${escapeHtml(snapshotSource)}</span>
        </div>
      `;
    }

    html += `</div>`;
  }

  // OOB swap to update active tab
  html += renderTabActiveState("snapshots");

  return html;
}

/**
 * Render the snapshot preview view.
 *
 * @param category - The snapshot category
 * @param filename - The original filename
 * @param content - The snapshot content (including header comments)
 * @returns HTML string for the snapshot preview
 */
export function renderSnapshotPreview(
  category: string,
  filename: string,
  content: string,
  snapshotId: string,
): string {
  const displayName = filename.replace(/\.md$/, "").replace(/_/g, " ");
  const categoryLabel = category.charAt(0).toUpperCase() + category.slice(1);

  // Extract the actual content (skip the header comments)
  const lines = content.split("\n");
  let contentStart = 0;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === "" && i > 2) {
      contentStart = i + 1;
      break;
    }
  }
  const actualContent = lines.slice(contentStart).join("\n");

  return `<div class="snapshot-preview">
  <div class="snapshot-preview-header">
    <button
      class="btn btn--ghost btn--sm"
      hx-get="/fragments/settings/snapshots"
      hx-target="#settings-content"
      hx-swap="innerHTML"
    >← Back to Snapshots</button>
    <span class="snapshot-preview-filename">${escapeHtml(categoryLabel)} / ${
    escapeHtml(displayName)
  }</span>
  </div>
  <div class="snapshot-preview-content">
    <pre>${escapeHtml(actualContent)}</pre>
  </div>
  <div class="snapshot-preview-actions">
    <button
      class="btn btn--danger"
      hx-post="/api/snapshots/${encodeURIComponent(snapshotId)}/restore"
      hx-target="#settings-content"
      hx-swap="innerHTML"
      hx-confirm="Are you sure you want to restore this snapshot? This will replace the current ${
    escapeHtml(categoryLabel)
  } / ${escapeHtml(displayName)} file."
    >Restore Snapshot</button>
  </div>
</div>`;
}

/**
 * Format a date string for snapshot display.
 * Compares dates in the display timezone for correct Today/Yesterday labels.
 */
function formatSnapshotDate(dateStr: string): string {
  const tz = getDisplayTZ();
  const date = new Date(dateStr);

  const todayStr = new Date().toLocaleDateString("en-US", { timeZone: tz });
  const dateStrDisplay = date.toLocaleDateString("en-US", { timeZone: tz });

  if (dateStrDisplay === todayStr) {
    return "Today";
  }

  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayStr = yesterday.toLocaleDateString("en-US", { timeZone: tz });

  if (dateStrDisplay === yesterdayStr) {
    return "Yesterday";
  }

  return date.toLocaleDateString(undefined, {
    timeZone: tz,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

/**
 * Format a timestamp for display (just the time portion).
 */
function formatTime(timestamp: string): string {
  // Convert dashes back to colons for time portion (2026-03-02T07-24-15-996Z -> 2026-03-02T07:24:15.996Z)
  const isoTimestamp = timestamp.replace(
    /T(\d+)-(\d+)-(\d+)-(\d+)Z$/,
    "T$1:$2:$3.$4Z",
  );
  const date = new Date(isoTimestamp);
  return date.toLocaleTimeString(undefined, {
    timeZone: getDisplayTZ(),
    hour: "2-digit",
    minute: "2-digit",
  });
}

// =============================================================================
// Memories Templates
// =============================================================================

/**
 * Valid memory granularities.
 */
const VALID_MEMORY_GRANULARITIES = [
  "daily",
  "weekly",
  "monthly",
  "yearly",
  "significant",
] as const;
type MemoryGranularity = typeof VALID_MEMORY_GRANULARITIES[number];

/**
 * Render the memories view with tabs.
 */
export function renderMemoriesView(
  activeGranularity: string = "daily",
): string {
  const tabs: { id: string; label: string }[] = [
    { id: "daily", label: "Daily" },
    { id: "weekly", label: "Weekly" },
    { id: "monthly", label: "Monthly" },
    { id: "yearly", label: "Yearly" },
    { id: "significant", label: "Significant" },
    { id: "instructions", label: "Instructions" },
  ];

  const tabsHtml = tabs.map((tab) => {
    const isActive = tab.id === activeGranularity;
    return `<button
      class="settings-tab${isActive ? " active" : ""}"
      hx-get="/fragments/settings/memories/${tab.id}"
      hx-target="#settings-content"
      hx-swap="innerHTML"
      hx-include="[name=after],[name=before]"
      id="memtab-${tab.id}"
    >${tab.label}</button>`;
  }).join("");

  const filterBarHtml = `
    <div class="memory-filter-bar">
      <form class="memory-search-form" hx-get="/fragments/settings/memories/search"
            hx-target="#settings-content" hx-swap="innerHTML"
            hx-trigger="submit">
        <input type="search" name="q" class="memory-search-input"
               placeholder="Search all memories..."
               autocomplete="off" />
      </form>
      <div class="memory-date-filters">
        <label class="memory-date-label">
          From
          <input type="date" name="after" class="memory-date-input"
                 hx-get="/fragments/settings/memories/${activeGranularity}"
                 hx-target="#settings-content" hx-swap="innerHTML"
                 hx-include="[name=after],[name=before]"
                 hx-trigger="change" />
        </label>
        <label class="memory-date-label">
          To
          <input type="date" name="before" class="memory-date-input"
                 hx-get="/fragments/settings/memories/${activeGranularity}"
                 hx-target="#settings-content" hx-swap="innerHTML"
                 hx-include="[name=after],[name=before]"
                 hx-trigger="change" />
        </label>
        <button class="btn btn--sm memory-filter-clear"
                hx-get="/fragments/settings/memories/${activeGranularity}"
                hx-target="#settings-content" hx-swap="innerHTML"
                style="display:none;"
                onclick="document.querySelectorAll('.memory-date-input').forEach(function(i){i.value=''}); this.style.display='none';">
          Clear
        </button>
      </div>
    </div>`;

  return `<div class="settings-view">
  <div class="settings-header">
    <div class="settings-header-row">
      ${renderSettingsBackButton()}
      <div>
        <h1 class="settings-title">Memories</h1>
        <p class="settings-desc">Review and edit the entity's recorded memories.</p>
      </div>
    </div>
  </div>
  <div class="settings-tabs">
    ${tabsHtml}
  </div>
  ${filterBarHtml}
  <div class="settings-content" id="settings-content"
    hx-get="/fragments/settings/memories/${activeGranularity}"
    hx-trigger="load"
    hx-swap="innerHTML">
    <div class="settings-loading">Loading...</div>
  </div>
</div>`;
}

/**
 * Render the active tab indicator for memories as an OOB swap.
 */
function renderMemoryTabActiveState(activeGranularity: string): string {
  const tabs = [...VALID_MEMORY_GRANULARITIES, "consolidation", "instructions"];
  return tabs.map((g) => {
    const isActive = g === activeGranularity;
    const label = g === "consolidation"
      ? "Catch-up"
      : g === "instructions"
      ? "Instructions"
      : g.charAt(0).toUpperCase() + g.slice(1);
    return `<button
      class="settings-tab${isActive ? " active" : ""}"
      hx-get="/fragments/settings/memories/${g}"
      hx-target="#settings-content"
      hx-swap="innerHTML"
      hx-swap-oob="true"
      hx-include="[name=after],[name=before]"
      id="memtab-${g}"
    >${label}</button>`;
  }).join("");
}

/**
 * Render the memory file list for a granularity.
 */
export function renderMemoryList(
  granularity: MemoryGranularity,
  items: Array<{ date: string; preview: string }>,
  pagination?: { hasMore: boolean; nextOffset: number; total: number },
): string {
  const isSignificant = granularity === "significant";

  // Significant directory has a create form
  let createFormHtml = "";
  if (isSignificant) {
    createFormHtml = `
      <div class="settings-create-file" style="flex-wrap: wrap; gap: 8px;">
        <input
          type="text"
          class="settings-create-file-input"
          id="significant-title-input"
          placeholder="Memory title..."
          style="flex: 1 1 100%; padding: 8px; border: 1px solid var(--border); border-radius: 6px; background: var(--input-bg); color: var(--fg); font-family: inherit; font-size: 13px;"
        />
        <input
          type="date"
          class="settings-create-file-input"
          id="significant-date-input"
          style="flex: 0 1 auto;"
        />
        <textarea
          id="significant-content-input"
          placeholder="Memory content..."
          rows="2"
          style="flex: 1 1 100%; padding: 8px; border: 1px solid var(--border); border-radius: 6px; background: var(--input-bg); color: var(--fg); resize: vertical; font-family: inherit; font-size: 13px;"
        ></textarea>
        <button
          class="btn btn--primary btn--sm"
          onclick="Psycheros.createSignificantMemory()"
          style="align-self: flex-end;"
        >
          Create
        </button>
      </div>`;
  }

  // Items are already sorted newest-first from entity-core
  const countHtml = pagination && pagination.total > 0
    ? `<div class="memory-count">Showing ${
      Math.min(pagination.nextOffset, pagination.total)
    } of ${pagination.total}</div>`
    : "";

  const loadMoreHtml = pagination?.hasMore
    ? `<div class="memory-load-more">
         <button class="btn btn--sm" onclick="loadMoreMemories('${granularity}', ${pagination.nextOffset})">
           Load more
         </button>
       </div>`
    : "";

  const fileListHtml = items.length === 0
    ? `<div class="settings-empty">${
      isSignificant
        ? "No significant memories yet. Create one above!"
        : "No memories in this category"
    }</div>`
    : `${countHtml}<div class="settings-file-list">
      ${
      items.map((item) => {
        return `<button
          class="settings-file-item"
          hx-get="/fragments/settings/memories/${granularity}/${
          encodeURIComponent(item.date)
        }"
          hx-target="#settings-content"
          hx-swap="innerHTML"
        >
          <svg class="settings-file-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
            <polyline points="14 2 14 8 20 8"/>
          </svg>
          <span class="settings-file-name">${escapeHtml(item.date)}</span>
          ${
          item.preview
            ? `<span class="settings-file-preview">${
              escapeHtml(item.preview)
            }</span>`
            : ""
        }
        </button>`;
      }).join("")
    }
    </div>${loadMoreHtml}`;

  // OOB swap to update active tab
  const oobSwap = renderMemoryTabActiveState(granularity);

  return createFormHtml + fileListHtml + oobSwap;
}

/**
 * Render memory search results.
 */
export function renderMemorySearchResults(
  query: string,
  results: Array<
    { granularity: string; date: string; score: number; excerpt: string }
  >,
  errorMsg?: string,
): string {
  const oobSwap = renderMemoryTabActiveState("");

  let contentHtml: string;
  if (errorMsg) {
    contentHtml = `<div class="settings-empty">${escapeHtml(errorMsg)}</div>`;
  } else if (!query) {
    contentHtml =
      `<div class="settings-empty">Enter a search query above</div>`;
  } else if (results.length === 0) {
    contentHtml = `<div class="settings-empty">No memories match "${
      escapeHtml(query)
    }"</div>`;
  } else {
    contentHtml = `<div class="memory-search-count">${results.length} result${
      results.length === 1 ? "" : "s"
    } for "${escapeHtml(query)}"</div>
    <div class="settings-file-list">
      ${
      results.map((item) => {
        const badge =
          `<span class="memory-granularity-badge memory-badge-${item.granularity}">${item.granularity}</span>`;
        return `<button
          class="settings-file-item"
          hx-get="/fragments/settings/memories/${item.granularity}/${
          encodeURIComponent(item.date)
        }"
          hx-target="#settings-content"
          hx-swap="innerHTML"
        >
          <svg class="settings-file-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
            <polyline points="14 2 14 8 20 8"/>
          </svg>
          <div class="memory-search-item-content">
            <span class="settings-file-name">${badge} ${
          escapeHtml(item.date)
        }</span>
            ${
          item.excerpt
            ? `<span class="settings-file-preview">${
              escapeHtml(item.excerpt)
            }</span>`
            : ""
        }
          </div>
          <span class="memory-score">${Math.round(item.score * 100)}%</span>
        </button>`;
      }).join("")
    }
    </div>`;
  }

  return contentHtml + oobSwap;
}

/**
 * Render the memory editor with textarea.
 */
export function renderMemoryEditor(
  granularity: MemoryGranularity,
  date: string,
  content: string,
  metadata?: {
    sourceInstance?: string;
    createdAt?: string;
    updatedAt?: string;
    version?: number;
    editedBy?: string;
  },
): string {
  const safeContent = escapeHtml(content);

  let metaHtml = "";
  if (metadata) {
    const parts: string[] = [];
    if (metadata.sourceInstance && metadata.sourceInstance !== "unknown") {
      parts.push(`Source: ${escapeHtml(metadata.sourceInstance)}`);
    }
    if (metadata.version && metadata.version > 1) {
      parts.push(`Version: ${metadata.version}`);
    }
    if (metadata.editedBy) {
      parts.push(`Edited by: ${escapeHtml(metadata.editedBy)}`);
    }
    if (parts.length > 0) {
      metaHtml = `<div class="settings-editor-meta">${
        parts.join(" &middot; ")
      }</div>`;
    }
  }

  const deleteBtnHtml = granularity === "significant"
    ? `<button class="btn btn--sm btn--danger"
        onclick="Psycheros.deleteSignificantMemory('${escapeHtml(date)}')"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
        Delete
      </button>`
    : "";

  return `<div class="settings-editor">
  <div class="settings-editor-header">
    <button
      class="btn btn--ghost btn--sm"
      hx-get="/fragments/settings/memories/${granularity}"
      hx-target="#settings-content"
      hx-swap="innerHTML"
    >
      &larr; Back
    </button>
    <span class="settings-editor-filename">${escapeHtml(date)}</span>
    <span class="settings-editor-tokens" id="settings-editor-tokens">...</span>
    ${deleteBtnHtml}
  </div>
  ${metaHtml}
  <form
    class="settings-editor-form"
    hx-post="/api/memories/${granularity}/${encodeURIComponent(date)}"
    hx-target="#settings-editor-status"
    hx-swap="innerHTML"
  >
    <textarea
      class="settings-textarea"
      name="content"
      data-tokenize
      placeholder="Memory content..."
      rows="20"
    >${safeContent}</textarea>
    <div class="settings-editor-actions">
      <button
        type="button"
        class="btn btn--ghost"
        hx-get="/fragments/settings/memories/${granularity}"
        hx-target="#settings-content"
        hx-swap="innerHTML"
      >Cancel</button>
      <button type="submit" class="btn btn--primary">Save</button>
    </div>
    <div id="settings-editor-status" class="settings-editor-status"></div>
  </form>
</div>`;
}

// =============================================================================
// Lorebook Templates
// =============================================================================

/**
 * Render the main lorebooks list view.
 */
export function renderLorebooksView(lorebooks: Lorebook[]): string {
  let html = `<div class="settings-view">
    <div class="settings-header">
      <div class="settings-header-row">
        ${renderSettingsBackButton()}
        <div>
          <h1 class="settings-title">Context Books</h1>
          <p class="settings-desc">Collections of context entries that are injected into context when triggered by keywords.</p>
        </div>
      </div>
    </div>
    <div class="settings-content" id="settings-content">`;

  html += `<div class="lorebooks-list">`;

  if (lorebooks.length === 0) {
    html += `<div class="lorebooks-empty">
      <p>No context books yet. Create one to start adding context entries.</p>
    </div>`;
  } else {
    for (const book of lorebooks) {
      html += `<div class="lorebook-card ${
        book.enabled ? "" : "lorebook-card--disabled"
      }">
        <div class="lorebook-card-header">
          <h3 class="lorebook-card-name">${escapeHtml(book.name)}</h3>
          <span class="lorebook-card-status">${
        book.enabled ? "Enabled" : "Disabled"
      }</span>
        </div>
        ${
        book.description
          ? `<p class="lorebook-card-desc">${escapeHtml(book.description)}</p>`
          : ""
      }
        <div class="lorebook-card-actions" id="lorebook-actions-${book.id}">
          <button
            class="btn btn--ghost btn--sm"
            hx-get="/fragments/settings/lorebooks/${book.id}"
            hx-target="#settings-content"
            hx-swap="innerHTML"
          >View Entries</button>
          <button
            class="btn btn--ghost btn--sm"
            onclick="document.getElementById('lorebook-view-${book.id}').style.display='none';document.getElementById('lorebook-edit-${book.id}').style.display='block'"
          >Edit</button>
          <button
            class="btn btn--ghost btn--sm"
            hx-delete="/api/lorebooks/${book.id}"
            hx-confirm="Delete this context book and all its entries?"
            hx-target="#settings-content"
            hx-swap="innerHTML"
          >Delete</button>
        </div>
        <div class="lorebook-card-edit" id="lorebook-edit-${book.id}" style="display:none">
          <form
            hx-put="/api/lorebooks/${book.id}"
            hx-target="#settings-content"
            hx-swap="innerHTML"
          >
            <div class="form-group">
              <label for="lorebook-rename-${book.id}">Name</label>
              <input type="text" id="lorebook-rename-${book.id}" name="name" value="${
        escapeHtml(book.name)
      }" required />
            </div>
            <div class="form-group">
              <label for="lorebook-rename-desc-${book.id}">Description</label>
              <input type="text" id="lorebook-rename-desc-${book.id}" name="description" value="${
        escapeHtml(book.description || "")
      }" placeholder="Optional description" />
            </div>
            <div class="form-row" style="gap:0.5rem">
              <button type="submit" class="btn btn--primary btn--sm">Save</button>
              <button type="button" class="btn btn--ghost btn--sm" onclick="document.getElementById('lorebook-edit-${book.id}').style.display='none';document.getElementById('lorebook-view-${book.id}').style.display='block'">Cancel</button>
            </div>
          </form>
        </div>
        <div id="lorebook-view-${book.id}" style="display:none"></div>
      </div>`;
    }
  }

  html += `</div>`;

  // Add "Create Lorebook" form
  html += `<div class="lorebook-create">
    <h3>Create New Context Book</h3>
    <form
      hx-post="/api/lorebooks"
      hx-target="#settings-content"
      hx-swap="innerHTML"
    >
      <div class="form-group">
        <label for="lorebook-name">Name</label>
        <input type="text" id="lorebook-name" name="name" required placeholder="e.g., Project Notes" />
      </div>
      <div class="form-group">
        <label for="lorebook-desc">Description (optional)</label>
        <input type="text" id="lorebook-desc" name="description" placeholder="e.g., Background context for conversations" />
      </div>
      <button type="submit" class="btn btn--primary">Create Context Book</button>
    </form>
  </div>`;

  // Import section
  html += `<div class="lorebook-import">
    <h3>Import</h3>
    <p class="settings-desc">Upload a lorebook JSON file to create a new context book with all its entries.</p>
    <form
      hx-post="/api/lorebooks/import-sillytavern"
      hx-target="#settings-content"
      hx-swap="innerHTML"
      hx-encoding="multipart/form-data"
    >
      <div class="form-group">
        <input type="file" id="st-lorebook-file" name="file" accept=".json" required />
      </div>
      <button type="submit" class="btn btn--primary">Import</button>
    </form>
  </div>`;

  html += `</div></div>`; // Close settings-content and settings-view

  return html;
}

/**
 * Render a single lorebook with its entries.
 */
export function renderLorebookDetailView(
  book: Lorebook,
  entries: LorebookEntry[],
): string {
  let html = `<div class="settings-breadcrumb">
    <button
      class="btn btn--ghost btn--sm"
      hx-get="/fragments/settings/lorebooks"
      hx-target="#settings-content"
      hx-swap="innerHTML"
    >← Back to Context Books</button>
  </div>
  <div class="settings-section-header">
    <h2>${escapeHtml(book.name)}</h2>
    <p class="settings-section-desc">${
    book.description ? escapeHtml(book.description) : "No description"
  }</p>
  </div>`;

  // Entries list
  html += `<div class="lorebook-entries-list">`;

  if (entries.length === 0) {
    html += `<div class="lorebooks-empty">
      <p>No entries yet. Add triggers to inject content into context.</p>
    </div>`;
  } else {
    // Sort by priority (highest first)
    const sortedEntries = [...entries].sort((a, b) => b.priority - a.priority);

    for (const entry of sortedEntries) {
      html += renderEntryCard(entry);
    }
  }

  html += `</div>`;

  // Create entry form
  html += `<div class="lorebook-entry-create">
    <h3>Add New Entry</h3>
    <form
      hx-post="/api/lorebooks/${book.id}/entries"
      hx-target="#settings-content"
      hx-swap="innerHTML"
      class="lorebook-entry-form"
    >
      <div class="form-row">
        <div class="form-group">
          <label for="entry-name">Name</label>
          <input type="text" id="entry-name" name="name" required placeholder="e.g., Meeting Notes" />
        </div>
        <div class="form-group form-group--small">
          <label for="entry-priority">Priority</label>
          <input type="number" id="entry-priority" name="priority" value="0" />
        </div>
      </div>

      <div class="form-group">
        <label for="entry-triggers">Triggers (comma-separated)</label>
        <input type="text" id="entry-triggers" name="triggers" required placeholder="e.g., alice, character, friend" />
      </div>

      <div class="form-group">
        <label for="entry-content">Content</label>
        <textarea id="entry-content" name="content" rows="4" required placeholder="Information to inject when triggered..."></textarea>
      </div>

      <div class="form-row">
        <div class="form-group">
          <label for="entry-triggerMode">Trigger Mode</label>
          <select id="entry-triggerMode" name="triggerMode">
            <option value="substring">Substring (default)</option>
            <option value="word">Word Boundary</option>
            <option value="exact">Exact Match</option>
            <option value="regex">Regex</option>
          </select>
        </div>
        <div class="form-group form-group--small">
          <label for="entry-scanDepth">Scan Depth</label>
          <input type="number" id="entry-scanDepth" name="scanDepth" value="5" min="1" max="50" />
        </div>
      </div>

      <div class="form-row form-row--checkboxes">
        <label class="checkbox-label">
          <input type="checkbox" name="caseSensitive" />
          Case Sensitive
        </label>
        <label class="checkbox-label">
          <input type="checkbox" name="enabled" checked />
          Enabled
        </label>
        <label class="checkbox-label">
          <input type="checkbox" name="sticky" onchange="toggleStickyDuration(this)" />
          Sticky
        </label>
      </div>

      <div class="form-row">
        <div class="form-group form-group--small">
          <label for="entry-stickyDuration">Sticky Duration (turns)</label>
          <input type="number" id="entry-stickyDuration" name="stickyDuration" value="0" min="0" disabled style="opacity: 0.5; pointer-events: none;" />
        </div>
      </div>

      <button type="submit" class="btn btn--primary">Add Entry</button>
    </form>
  </div>`;

  return html;
}

/**
 * Render a single entry card.
 */
function renderEntryCard(entry: LorebookEntry): string {
  const triggersHtml = entry.triggers.map((t) =>
    `<span class="trigger-tag">${escapeHtml(t)}</span>`
  ).join("");

  return `<div class="entry-card ${
    entry.enabled ? "" : "entry-card--disabled"
  }">
    <div class="entry-card-header">
      <h4 class="entry-card-name">${escapeHtml(entry.name)}</h4>
      <span class="entry-card-priority">Priority: ${entry.priority}</span>
    </div>
    <div class="entry-card-triggers">${triggersHtml}</div>
    <div class="entry-card-content">${
    escapeHtml(entry.content.substring(0, 200))
  }${entry.content.length > 200 ? "..." : ""}</div>
    <div class="entry-card-meta">
      <span>${entry.triggerMode}</span>
      ${
    entry.sticky ? `<span>Sticky: ${entry.stickyDuration} turns</span>` : ""
  }
      ${!entry.enabled ? `<span>Disabled</span>` : ""}
    </div>
    <div class="entry-card-actions">
      <button
        class="btn btn--ghost btn--sm"
        hx-get="/fragments/settings/lorebooks/${entry.bookId}/entries/${entry.id}/edit"
        hx-target="#settings-content"
        hx-swap="innerHTML"
      >Edit</button>
      <button
        class="btn btn--ghost btn--sm"
        hx-delete="/api/lorebooks/${entry.bookId}/entries/${entry.id}"
        hx-confirm="Delete this entry?"
        hx-target="#settings-content"
        hx-swap="innerHTML"
      >Delete</button>
    </div>
  </div>`;
}

/**
 * Render the entry editor form.
 */
export function renderEntryEditor(entry: LorebookEntry): string {
  const triggersStr = entry.triggers.join(", ");

  return `<div class="settings-breadcrumb">
    <button
      class="btn btn--ghost btn--sm"
      hx-get="/fragments/settings/lorebooks/${entry.bookId}"
      hx-target="#settings-content"
      hx-swap="innerHTML"
    >← Back to Context Book</button>
  </div>
  <div class="settings-section-header">
    <h2>Edit Entry: ${escapeHtml(entry.name)}</h2>
  </div>

  <form
    hx-put="/api/lorebooks/${entry.bookId}/entries/${entry.id}"
    hx-target="#settings-content"
    hx-swap="innerHTML"
    class="lorebook-entry-form"
  >
    <div class="form-row">
      <div class="form-group">
        <label for="entry-name">Name</label>
        <input type="text" id="entry-name" name="name" value="${
    escapeHtml(entry.name)
  }" required />
      </div>
      <div class="form-group form-group--small">
        <label for="entry-priority">Priority</label>
        <input type="number" id="entry-priority" name="priority" value="${entry.priority}" />
      </div>
    </div>

    <div class="form-group">
      <label for="entry-triggers">Triggers (comma-separated)</label>
      <input type="text" id="entry-triggers" name="triggers" value="${
    escapeHtml(triggersStr)
  }" required />
    </div>

    <div class="form-group">
      <label for="entry-content">Content</label>
      <textarea id="entry-content" name="content" rows="6" required>${
    escapeHtml(entry.content)
  }</textarea>
    </div>

    <div class="form-row">
      <div class="form-group">
        <label for="entry-triggerMode">Trigger Mode</label>
        <select id="entry-triggerMode" name="triggerMode">
          <option value="substring" ${
    entry.triggerMode === "substring" ? "selected" : ""
  }>Substring</option>
          <option value="word" ${
    entry.triggerMode === "word" ? "selected" : ""
  }>Word Boundary</option>
          <option value="exact" ${
    entry.triggerMode === "exact" ? "selected" : ""
  }>Exact Match</option>
          <option value="regex" ${
    entry.triggerMode === "regex" ? "selected" : ""
  }>Regex</option>
        </select>
      </div>
      <div class="form-group form-group--small">
        <label for="entry-scanDepth">Scan Depth</label>
        <input type="number" id="entry-scanDepth" name="scanDepth" value="${entry.scanDepth}" min="1" max="50" />
      </div>
    </div>

    <div class="form-row form-row--checkboxes">
      <label class="checkbox-label">
        <input type="checkbox" name="caseSensitive" ${
    entry.caseSensitive ? "checked" : ""
  } />
        Case Sensitive
      </label>
      <label class="checkbox-label">
        <input type="checkbox" name="enabled" ${
    entry.enabled ? "checked" : ""
  } />
        Enabled
      </label>
      <label class="checkbox-label">
        <input type="checkbox" name="sticky" ${
    entry.sticky ? "checked" : ""
  } onchange="toggleStickyDuration(this)" />
        Sticky
      </label>
    </div>

    <div class="form-row form-row--checkboxes">
      <label class="checkbox-label">
        <input type="checkbox" name="nonRecursable" ${
    entry.nonRecursable ? "checked" : ""
  } />
        Non-Recursable
      </label>
      <label class="checkbox-label">
        <input type="checkbox" name="preventRecursion" ${
    entry.preventRecursion ? "checked" : ""
  } />
        Prevent Recursion
      </label>
      <label class="checkbox-label">
        <input type="checkbox" name="reTriggerResetsTimer" ${
    entry.reTriggerResetsTimer ? "checked" : ""
  } />
        Re-trigger Resets Timer
      </label>
    </div>

    <div class="form-row">
      <div class="form-group form-group--small">
        <label for="entry-stickyDuration">Sticky Duration (turns)</label>
        <input type="number" id="entry-stickyDuration" name="stickyDuration" value="${entry.stickyDuration}" min="0" ${
    !entry.sticky ? "disabled" : ""
  } style="${!entry.sticky ? "opacity: 0.5; pointer-events: none;" : ""}" />
      </div>
      <div class="form-group form-group--small">
        <label for="entry-maxTokens">Max Tokens (0 = unlimited)</label>
        <input type="number" id="entry-maxTokens" name="maxTokens" value="${entry.maxTokens}" min="0" />
      </div>
    </div>

    <div class="form-actions">
      <button type="submit" class="btn btn--primary">Save Changes</button>
      <button
        type="button"
        class="btn btn--ghost"
        hx-get="/fragments/settings/lorebooks/${entry.bookId}"
        hx-target="#settings-content"
        hx-swap="innerHTML"
      >Cancel</button>
    </div>
  </form>`;
}

// =============================================================================
// Knowledge Graph Templates
// =============================================================================

// =============================================================================
// Entity Core Templates
// =============================================================================

/**
 * Render the Entity Core hub with tab navigation.
 */
export function renderEntityCoreHub(activeTab: string = "overview"): string {
  const tabs = [
    { id: "overview", label: "Overview" },
    { id: "llm", label: "LLM" },
    { id: "graph", label: "Knowledge Graph" },
    { id: "maintenance", label: "Maintenance" },
    { id: "snapshots", label: "Snapshots" },
  ];

  const tabsHtml = tabs.map((tab) => {
    const isActive = tab.id === activeTab;
    return `<button
      class="settings-tab${isActive ? " active" : ""}"
      hx-get="/fragments/settings/entity-core/${tab.id}"
      hx-target="#settings-content"
      hx-swap="innerHTML"
      id="ectab-${tab.id}"
    >${tab.label}</button>`;
  }).join("");

  return `<div class="settings-view">
  <script src="/js/entity-core.js"></script>
  <div class="settings-header">
    <div class="settings-header-row">
      ${renderSettingsBackButton()}
      <div>
        <h1 class="settings-title">Entity Core</h1>
        <p class="settings-desc">Manage connection, LLM, knowledge graph, maintenance, and snapshots</p>
      </div>
    </div>
  </div>
  <div class="settings-tabs">
    ${tabsHtml}
  </div>
  <div class="settings-content" id="settings-content"
    hx-get="/fragments/settings/entity-core/${activeTab}"
    hx-trigger="load"
    hx-swap="innerHTML">
    <div class="settings-loading">Loading...</div>
  </div>
</div>`;
}

/**
 * Render Entity Core tab active state as an OOB swap.
 */
function renderEntityCoreTabActiveState(activeTab: string): string {
  const tabs = ["overview", "llm", "graph", "maintenance", "snapshots"];
  return tabs.map((tab) => {
    const isActive = tab === activeTab;
    const label = tab.charAt(0).toUpperCase() + tab.slice(1);
    return `<button
      class="settings-tab${isActive ? " active" : ""}"
      hx-get="/fragments/settings/entity-core/${tab}"
      hx-target="#settings-content"
      hx-swap="innerHTML"
      hx-swap-oob="true"
      id="ectab-${tab}"
    >${label}</button>`;
  }).join("");
}

/**
 * Data for the Entity Core overview tab.
 */
export interface EntityCoreOverviewData {
  connected: boolean;
  stats: {
    totalNodes: number;
    totalEdges: number;
    nodesByType: Record<string, number>;
    edgesByType: Record<string, number>;
    vectorSearchAvailable: boolean;
  } | null;
  pendingIdentity: number;
  lastSyncTime: string | null;
  extraction: ExtractionHealth | null;
}

/**
 * Render the Entity Core overview tab.
 */
export function renderEntityCoreOverview(data: EntityCoreOverviewData): string {
  const oobTabs = renderEntityCoreTabActiveState("overview");

  if (!data.connected) {
    return `${oobTabs}
<div class="ec-overview">
  <div class="ec-disconnected">
    <div class="ec-status ec-status--disconnected">
      <span class="ec-status-dot"></span>
      <span>Disconnected</span>
    </div>
    <p>Entity-core is not connected. Enable MCP in your environment with
      <code>PSYCHEROS_MCP_ENABLED=true</code> to manage identity, memories, and knowledge graph.</p>
    <a class="btn btn--primary"
      hx-get="/fragments/settings/connections"
      hx-target="#chat"
      hx-swap="innerHTML">
      Open Connections Settings
    </a>
  </div>
</div>`;
  }

  const stats = data.stats;
  const nodeCount = stats?.totalNodes ?? 0;
  const edgeCount = stats?.totalEdges ?? 0;
  const vecStatus = stats?.vectorSearchAvailable ? "active" : "off";
  const lastSync = data.lastSyncTime
    ? new Date(data.lastSyncTime).toLocaleString([], {
      timeZone: getDisplayTZ(),
    })
    : "Never";

  const topNodeTypes = stats?.nodesByType
    ? Object.entries(stats.nodesByType)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 5)
      .map(([type, count]) => `${type}: ${count}`)
      .join(", ")
    : "";

  return `${oobTabs}
<div class="ec-overview">
  <div class="ec-status ec-status--connected">
    <span class="ec-status-dot"></span>
    <span>Connected</span>
  </div>

  <div class="ec-stats-grid">
    <div class="ec-stat-card">
      <span class="ec-stat-value">${nodeCount}</span>
      <span class="ec-stat-label">Graph Nodes</span>
    </div>
    <div class="ec-stat-card">
      <span class="ec-stat-value">${edgeCount}</span>
      <span class="ec-stat-label">Graph Edges</span>
    </div>
    <div class="ec-stat-card">
      <span class="ec-stat-value ec-stat-value--${vecStatus}">${vecStatus}</span>
      <span class="ec-stat-label">Vector Search</span>
    </div>
    <div class="ec-stat-card">
      <span class="ec-stat-value">${data.pendingIdentity}</span>
      <span class="ec-stat-label">Pending Changes</span>
    </div>
  </div>

  ${
    data.extraction
      ? (() => {
        const ex = data.extraction;
        const llmBadge = ex.llmAvailable
          ? '<span class="ec-badge ec-badge--ok">LLM Ready</span>'
          : '<span class="ec-badge ec-badge--warn">No LLM</span>';
        const successRate = ex.attemptsTotal > 0
          ? Math.round((ex.successesTotal / ex.attemptsTotal) * 100)
          : null;
        const lastAttemptStr = ex.lastAttempt
          ? new Date(ex.lastAttempt).toLocaleString([], {
            timeZone: getDisplayTZ(),
          })
          : "Never";
        const lastSuccessStr = ex.lastSuccess
          ? new Date(ex.lastSuccess).toLocaleString([], {
            timeZone: getDisplayTZ(),
          })
          : "Never";

        return `
  <div class="ec-section">
    <h3 class="ec-section-title">Extraction Pipeline ${llmBadge}</h3>
    <div class="ec-stats-grid ec-stats-grid--compact">
      <div class="ec-stat-card">
        <span class="ec-stat-value">${ex.attemptsTotal}</span>
        <span class="ec-stat-label">Attempts</span>
      </div>
      <div class="ec-stat-card">
        <span class="ec-stat-value">${ex.successesTotal}</span>
        <span class="ec-stat-label">Successes</span>
      </div>
      <div class="ec-stat-card">
        <span class="ec-stat-value">${ex.nodesCreatedTotal}</span>
        <span class="ec-stat-label">Nodes</span>
      </div>
      <div class="ec-stat-card">
        <span class="ec-stat-value">${ex.edgesCreatedTotal}</span>
        <span class="ec-stat-label">Edges</span>
      </div>
    </div>
    ${
          successRate !== null
            ? `<div class="ec-detail">
      <span class="ec-detail-label">Success rate:</span>
      <span class="ec-detail-value">${successRate}%</span>
    </div>`
            : ""
        }
    <div class="ec-detail">
      <span class="ec-detail-label">Last attempt:</span>
      <span class="ec-detail-value">${escapeHtml(lastAttemptStr)}</span>
    </div>
    <div class="ec-detail">
      <span class="ec-detail-label">Last success:</span>
      <span class="ec-detail-value">${escapeHtml(lastSuccessStr)}</span>
    </div>
    ${
          ex.lastError
            ? `<div class="ec-detail ec-detail--error">
      <span class="ec-detail-label">Last error:</span>
      <span class="ec-detail-value">${escapeHtml(ex.lastError)}</span>
    </div>`
            : ""
        }
  </div>`;
      })()
      : ""
  }

  ${
    topNodeTypes
      ? `<div class="ec-detail">
    <span class="ec-detail-label">Top node types:</span>
    <span class="ec-detail-value">${escapeHtml(topNodeTypes)}</span>
  </div>`
      : ""
  }

  <div class="ec-detail">
    <span class="ec-detail-label">Last synced:</span>
    <span class="ec-detail-value">${escapeHtml(lastSync)}</span>
  </div>

  <div class="ec-actions">
    <button
      class="btn btn--primary btn--sm"
      id="ec-sync-btn"
      onclick="this.textContent='Syncing...'; this.disabled=true; fetch('/api/entity-core/sync', {method:'POST'}).then(r=>r.json()).then(d=>{ this.textContent=d.success?'Synced':'Failed'; setTimeout(()=>{this.textContent='Sync Now'; this.disabled=false;}, 1500); }).catch(()=>{this.textContent='Error'; this.disabled=false;})"
    >Sync Now</button>
  </div>
</div>`;
}

/**
 * Data for the Entity Core LLM tab.
 */
export interface EntityCoreLLMData {
  settings: {
    model?: string;
    temperature?: number;
    maxTokens?: number;
  };
  resolved: {
    model: string;
    temperature: number;
    maxTokens: number;
    profileName: string | null;
  };
}

/**
 * Render the Entity Core LLM tab.
 * Shows current resolved LLM config and allows overriding model, temperature, maxTokens.
 */
export function renderEntityCoreLLM(data: EntityCoreLLMData): string {
  const oobTabs = renderEntityCoreTabActiveState("llm");
  const { settings, resolved } = data;
  const isOverridden = (field: string) =>
    field === "model"
      ? !!settings.model
      : settings[field as keyof typeof settings] !== undefined;

  return `${oobTabs}
<div class="ec-overview">
  <p class="ec-llm-desc">Entity-core uses an LLM for extraction, memory consolidation, and knowledge graph tasks. By default it inherits your active chat profile's connection. Override fields below to use a different model or parameters.</p>

  <div class="ec-detail">
    <span class="ec-detail-label">Source profile:</span>
    <span class="ec-detail-value">${
    resolved.profileName ? escapeHtml(resolved.profileName) : "None"
  }</span>
  </div>

  <div class="ec-llm-section">
    <h3>Model Override</h3>
    <div class="form-group">
      <label for="ec-llm-model">Model</label>
      <div class="ec-llm-field-row">
        <input type="text" id="ec-llm-model" placeholder="Inherits from profile" value="${
    escapeHtml(settings.model || "")
  }" />
        ${
    isOverridden("model")
      ? '<button type="button" class="btn btn--sm btn--ghost" onclick="document.getElementById(\'ec-llm-model\').value=\'\'">Reset</button>'
      : ""
  }
      </div>
      <span class="ec-llm-resolved">Currently using: <strong>${
    escapeHtml(resolved.model || "(none)")
  }</strong></span>
    </div>
  </div>

  <div class="ec-llm-section">
    <h3>Parameters</h3>
    <div class="form-group">
      <label for="ec-llm-temperature">Temperature</label>
      <div class="ec-llm-field-row">
        <input type="number" id="ec-llm-temperature" step="0.1" min="0" max="2" placeholder="0.3" value="${
    settings.temperature !== undefined ? settings.temperature : ""
  }" />
        ${
    isOverridden("temperature")
      ? '<button type="button" class="btn btn--sm btn--ghost" onclick="document.getElementById(\'ec-llm-temperature\').value=\'\'">Reset</button>'
      : ""
  }
      </div>
      <span class="ec-llm-resolved">Default: <strong>0.3</strong> (lower = more deterministic)</span>
    </div>
    <div class="form-group">
      <label for="ec-llm-max-tokens">Max Tokens</label>
      <div class="ec-llm-field-row">
        <input type="number" id="ec-llm-max-tokens" step="256" min="256" placeholder="8000" value="${
    settings.maxTokens !== undefined ? settings.maxTokens : ""
  }" />
        ${
    isOverridden("maxTokens")
      ? '<button type="button" class="btn btn--sm btn--ghost" onclick="document.getElementById(\'ec-llm-max-tokens\').value=\'\'">Reset</button>'
      : ""
  }
      </div>
      <span class="ec-llm-resolved">Default: <strong>8000</strong></span>
    </div>
  </div>

  <div class="ec-actions">
    <button
      class="btn btn--primary btn--sm"
      onclick="saveEntityCoreLLMSettings()"
    >Save & Restart</button>
  </div>
</div>

<script>
function saveEntityCoreLLMSettings() {
  const model = document.getElementById('ec-llm-model').value.trim();
  const temperature = document.getElementById('ec-llm-temperature').value;
  const maxTokens = document.getElementById('ec-llm-max-tokens').value;

  const body = {};
  if (model) body.model = model;
  if (temperature) body.temperature = parseFloat(temperature);
  if (maxTokens) body.maxTokens = parseInt(maxTokens, 10);

  fetch('/api/entity-core-llm-settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
  .then(r => r.json())
  .then(d => {
    if (d.success) {
      // Reload the tab to show updated resolved values
      htmx.ajax('GET', '/fragments/settings/entity-core/llm', '#settings-content');
    } else {
      alert('Failed to save: ' + (d.error || 'Unknown error'));
    }
  })
  .catch(e => alert('Error: ' + e.message));
}
</script>`;
}

/**
 * Render the Entity Core knowledge graph tab.
 * Renders the knowledge graph list/network editor for the Entity Core settings tab.
 */
export function renderEntityCoreGraph(
  stats: {
    totalNodes: number;
    totalEdges: number;
    nodesByType: Record<string, number>;
    edgesByType: Record<string, number>;
    vectorSearchAvailable: boolean;
  } | null,
): string {
  const oobTabs = renderEntityCoreTabActiveState("graph");
  const nodeCount = stats?.totalNodes ?? 0;
  const edgeCount = stats?.totalEdges ?? 0;

  return `${oobTabs}
<div class="gv">
  <div class="gv-header">
    <div class="gv-header-left">
      <div class="gv-title-block">
        <h2 class="gv-title">Knowledge Graph</h2>
        <div class="gv-stats">
          <span><strong>${nodeCount}</strong> nodes</span>
          <span class="gv-stats-sep">&middot;</span>
          <span><strong>${edgeCount}</strong> edges</span>
        </div>
      </div>
    </div>
    <div class="gv-header-actions">
      <div class="gv-view-toggle" id="gv-view-toggle">
        <button class="gv-view-toggle-btn active" data-view="list">List</button>
        <button class="gv-view-toggle-btn" data-view="graph">Network</button>
      </div>
      <button id="graph-refresh" class="btn btn--ghost btn--sm" title="Refresh">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/>
          <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>
        </svg>
      </button>
    </div>
  </div>

  <div class="gv-toolbar">
    <input type="text" id="graph-search" placeholder="Search nodes..." class="gv-search" />
    <select id="graph-filter-type" class="gv-filter">
      <option value="">All types</option>
    </select>
    <button id="gv-add-node" class="btn btn--ghost btn--sm" title="Add Node">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
      </svg>
      <span>Add Node</span>
    </button>
  </div>

  <div id="gv-list-view" class="gv-list-view">
    <div class="gv-loading"><div class="gv-spinner"></div></div>
  </div>

  <div id="gv-graph-view" class="gv-hidden">
    <div id="graph-container" class="gv-canvas">
      <div class="gv-loading"><div class="gv-spinner"></div></div>
    </div>
    <div id="graph-node-panel" class="gv-panel">
      <div class="gv-panel-header">
        <h3 id="panel-node-label">Node</h3>
        <button id="panel-close" class="btn btn--ghost btn--sm">&times;</button>
      </div>
      <div class="gv-panel-body" id="panel-content"></div>
    </div>
  </div>

  <!-- Create Node Modal -->
  <div id="graph-create-modal" class="gv-modal">
    <div class="gv-modal-box">
      <h3>Create Node</h3>
      <form id="create-node-form">
        <div class="gv-field">
          <label for="node-type">Type</label>
          <select id="node-type" name="type" required>
            <option value="person">Person</option>
            <option value="emotion">Emotion</option>
            <option value="topic" selected>Topic</option>
            <option value="preference">Preference</option>
            <option value="place">Place</option>
            <option value="goal">Goal</option>
            <option value="health">Health</option>
            <option value="boundary">Boundary</option>
            <option value="tradition">Tradition</option>
            <option value="insight">Insight</option>
          </select>
        </div>
        <div class="gv-field">
          <label for="node-label">Label</label>
          <input type="text" id="node-label" name="label" required placeholder="e.g. hiking, my partner, anxiety" />
        </div>
        <div class="gv-field">
          <label for="node-description">Description</label>
          <textarea id="node-description" name="description" rows="2" placeholder="Optional..."></textarea>
        </div>
        <div class="gv-modal-actions">
          <button type="button" class="btn btn--ghost" id="cancel-create">Cancel</button>
          <button type="submit" class="btn btn--primary">Create</button>
        </div>
      </form>
    </div>
  </div>

  <!-- Edit Node Modal -->
  <div id="graph-edit-modal" class="gv-modal">
    <div class="gv-modal-box gv-modal-box--wide">
      <h3>Edit Node</h3>
      <form id="edit-node-form">
        <input type="hidden" id="edit-node-id" />
        <div class="gv-field">
          <label for="edit-node-type">Type</label>
          <select id="edit-node-type" name="type" required>
            <option value="person">Person</option>
            <option value="emotion">Emotion</option>
            <option value="topic">Topic</option>
            <option value="preference">Preference</option>
            <option value="place">Place</option>
            <option value="goal">Goal</option>
            <option value="health">Health</option>
            <option value="boundary">Boundary</option>
            <option value="tradition">Tradition</option>
            <option value="insight">Insight</option>
          </select>
        </div>
        <div class="gv-field">
          <label for="edit-node-label">Label</label>
          <input type="text" id="edit-node-label" required />
        </div>
        <div class="gv-field">
          <label for="edit-node-description">Description</label>
          <textarea id="edit-node-description" rows="2"></textarea>
        </div>
        <div class="gv-field" id="edit-connections-field" style="display:none">
          <label>Connections</label>
          <div id="edit-connections-list" class="gv-edit-conns"></div>
          <button type="button" class="btn btn--ghost btn--sm" id="edit-add-conn">+ Add Connection</button>
        </div>
        <div class="gv-modal-actions">
          <button type="button" class="btn btn--ghost" id="cancel-edit">Cancel</button>
          <button type="submit" class="btn btn--primary">Save</button>
        </div>
      </form>
    </div>
  </div>

  <!-- Edge Creation Modal -->
  <div id="graph-edge-modal" class="gv-modal">
    <div class="gv-modal-box">
      <h3>Connect Nodes</h3>
      <form id="edge-create-form">
        <div class="gv-field">
          <label>From</label>
          <div class="gv-node-picker" id="edge-from-picker">
            <input type="text" class="gv-node-search-input" placeholder="Search nodes..." autocomplete="off" />
            <div class="gv-node-search-results" id="edge-from-results"></div>
            <input type="hidden" id="edge-from" name="fromId" required />
          </div>
        </div>
        <div class="gv-field">
          <label>To</label>
          <div class="gv-node-picker" id="edge-to-picker">
            <input type="text" class="gv-node-search-input" placeholder="Search nodes..." autocomplete="off" />
            <div class="gv-node-search-results" id="edge-to-results"></div>
            <input type="hidden" id="edge-to" name="toId" required />
          </div>
        </div>
        <div class="gv-field">
          <label for="edge-type">Relationship</label>
          <input type="text" id="edge-type" name="type" list="edge-type-suggestions" required placeholder="e.g. loves, works_with, values" />
          <datalist id="edge-type-suggestions">
            <option value="loves"><option value="close_to"><option value="friend_of">
            <option value="works_with"><option value="values"><option value="believes_in">
            <option value="respects"><option value="worried_about"><option value="proud_of">
            <option value="interested_in"><option value="skilled_at"><option value="family_of">
            <option value="nostalgic_for"><option value="frustrated_with"><option value="reminds_of">
            <option value="caused"><option value="led_to"><option value="part_of">
            <option value="associated_with"><option value="similar_to"><option value="dislikes">
          </datalist>
        </div>
        <div class="gv-field">
          <label for="edge-evidence">Evidence (optional)</label>
          <textarea id="edge-evidence" name="evidence" rows="2" placeholder="Why this connection?"></textarea>
        </div>
        <div class="gv-modal-actions">
          <button type="button" class="btn btn--ghost" id="cancel-edge">Cancel</button>
          <button type="submit" class="btn btn--primary">Connect</button>
        </div>
      </form>
    </div>
  </div>

  <!-- Delete Confirmation Modal -->
  <div id="graph-delete-modal" class="gv-modal">
    <div class="gv-modal-box gv-delete-confirm">
      <h3>Delete Node</h3>
      <p id="delete-confirm-msg" class="gv-delete-msg">Are you sure?</p>
      <div class="gv-modal-actions">
        <button type="button" class="btn btn--ghost" id="cancel-delete">Cancel</button>
        <button type="button" class="btn btn--primary gv-delete-btn-confirm" id="confirm-delete">Delete</button>
      </div>
    </div>
  </div>
</div>

`;
}

/**
 * Render the Entity Core maintenance tab.
 * Contains consolidation status, batch populate graph, and embed memories sections.
 */
export function renderEntityCoreMaintenance(mcpAvailable: boolean): string {
  const oobTabs = renderEntityCoreTabActiveState("maintenance");

  // NOTE: Memory Consolidation removed from UI — it now runs automatically on
  // startup. The code is preserved below in case manual triggering is ever
  // needed again.
  //
  // const status: ConsolidationStatus = {
  //   weekly: mcpAvailable,
  //   monthly: mcpAvailable,
  //   yearly: mcpAvailable,
  // };
  //
  // const anyNeeded = status.weekly || status.monthly || status.yearly;
  //
  // const consolidationRows = ([
  //   { label: "Weekly", needed: status.weekly },
  //   { label: "Monthly", needed: status.monthly },
  //   { label: "Yearly", needed: status.yearly },
  // ] as const).map(({ label, needed }) => `
  //   <div class="consolidation-row">
  //     <span class="consolidation-row-label">${label}</span>
  //     <span class="consolidation-row-status ${
  //     needed ? "consolidation-needed" : "consolidation-up-to-date"
  //   }">${needed ? "Needs catch-up" : "Up to date"}</span>
  //   </div>
  // `).join("");
  //
  // let consolidationActionHtml = "";
  // if (anyNeeded) {
  //   consolidationActionHtml = `<button
  //     class="btn btn--primary btn--sm"
  //     id="ec-run-consolidation-btn"
  //     hx-post="/api/entity-core/consolidation/run"
  //     hx-target="#ec-consolidation-content"
  //     hx-swap="outerHTML"
  //   >Run Catch-up</button>`;
  // } else {
  //   consolidationActionHtml =
  //     `<div class="consolidation-all-clear">All consolidation levels are up to date.</div>`;
  // }

  const mcpRequiredHtml = mcpAvailable ? "" : `
  <div class="ec-disconnected">
    <p>These operations require an entity-core connection. Enable MCP with
      <code>PSYCHEROS_MCP_ENABLED=true</code>.</p>
  </div>`;

  return `${oobTabs}
<div class="ec-maintenance">

  ${mcpRequiredHtml}

  <!-- Memory Consolidation section removed — runs automatically on startup.
  <div class="ec-maintenance-section">
    <h3 class="admin-section-title">Memory Consolidation</h3>
    <p class="admin-action-desc">
      Merge daily and weekly memories into weekly, monthly, and yearly summaries
      via entity-core. Uses LLM to preserve key details.
    </p>
    <div id="ec-consolidation-content">
      <div class="consolidation-section">
        <div class="consolidation-status-list">
          CONSORIDATION_ROWS
        </div>
        <div class="consolidation-actions">
          CONSOLIDATION_ACTION_HTML
        </div>
      </div>
    </div>
  </div>
  -->

  <div class="ec-maintenance-section">
    <h3 class="admin-section-title">Batch Populate Knowledge Graph</h3>
    <p class="admin-action-desc">
      Runs <code>entity-core/scripts/batch-populate-graph.ts</code> to backfill
      the knowledge graph from existing memory files. Extracts entities and
      relationships via LLM, with semantic dedup to prevent duplicate nodes.
    </p>
    <div class="admin-action-form">
      <div class="admin-action-fields">
        <label class="admin-action-label" for="ec-batch-days">Days</label>
        <input id="ec-batch-days" type="number" min="1" max="3650" value="30" class="admin-input" />
      </div>
      <div class="admin-action-fields">
        <label class="admin-action-label" for="ec-batch-granularity">Granularity</label>
        <select id="ec-batch-granularity" class="admin-select">
          <option value="daily" selected>daily</option>
          <option value="weekly">weekly</option>
          <option value="monthly">monthly</option>
          <option value="yearly">yearly</option>
          <option value="significant">significant</option>
          <option value="all">all</option>
        </select>
      </div>
      <div class="admin-action-fields">
        <label class="admin-action-label">
          <input id="ec-batch-dry-run" type="checkbox" class="admin-checkbox" />
          Dry run
        </label>
      </div>
      <div class="admin-action-fields">
        <label class="admin-action-label">
          <input id="ec-batch-verbose" type="checkbox" class="admin-checkbox" />
          Verbose
        </label>
      </div>
      <button id="ec-batch-run-btn" class="admin-action-btn" onclick="window.ecRunBatchPopulate()">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polygon points="5 3 19 12 5 21 5 3"/>
        </svg>
        Run Script
      </button>
    </div>
    <div class="admin-section" id="ec-batch-output-section" style="display:none">
      <h3 class="admin-section-title">Output</h3>
      <div class="admin-action-output" id="ec-batch-output"></div>
    </div>
  </div>

  <div class="ec-maintenance-section">
    <h3 class="admin-section-title">Embed Existing Memories</h3>
    <p class="admin-action-desc">
      Runs <code>entity-core/scripts/embed-existing-memories.ts</code> to backfill
      vector embeddings for existing memory nodes in the knowledge graph.
    </p>
    <div class="admin-action-form">
      <div class="admin-action-fields">
        <label class="admin-action-label">
          <input id="ec-embed-dry-run" type="checkbox" class="admin-checkbox" />
          Dry run
        </label>
      </div>
      <div class="admin-action-fields">
        <label class="admin-action-label">
          <input id="ec-embed-verbose" type="checkbox" class="admin-checkbox" />
          Verbose
        </label>
      </div>
      <button id="ec-embed-run-btn" class="admin-action-btn" onclick="window.ecRunEmbedMemories()">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polygon points="5 3 19 12 5 21 5 3"/>
        </svg>
        Run Script
      </button>
    </div>
    <div class="admin-section" id="ec-embed-output-section" style="display:none">
      <h3 class="admin-section-title">Output</h3>
      <div class="admin-action-output" id="ec-embed-output"></div>
    </div>
  </div>

  <div class="ec-maintenance-section">
    <h3 class="admin-section-title">Purge Orphaned Embeddings</h3>
    <p class="admin-action-desc">
      Remove embedding cache entries for memory files that no longer exist.
      Use this after manually deleting memory files to prevent ghost results
      in memory search.
    </p>
    <div id="ec-purge-content">
      <button
        class="btn btn--primary btn--sm"
        id="ec-purge-btn"
        hx-post="/api/entity-core/embeddings/purge"
        hx-target="#ec-purge-content"
        hx-swap="outerHTML"
      >Purge Orphans</button>
    </div>
  </div>

  <div class="ec-maintenance-section">
    <h3 class="admin-section-title">Rebuild Memory Embeddings</h3>
    <p class="admin-action-desc">
      Clear all memory embeddings and rebuild them from existing memory files.
      This ensures the embedding cache matches the actual files on disk.
      May take several minutes with large memory stores.
    </p>
    <div id="ec-rebuild-content">
      <button
        class="btn btn--primary btn--sm"
        id="ec-rebuild-btn"
        hx-post="/api/entity-core/embeddings/rebuild"
        hx-target="#ec-rebuild-content"
        hx-swap="outerHTML"
      >Rebuild All</button>
    </div>
  </div>

</div>`;
}

// NOTE: Memory Consolidation removed from UI — it now runs automatically on
// startup. Helper functions preserved below in case manual triggering is ever
// needed again.
//
// /**
//  * Render consolidation running state for Entity Core context.
//  */
// export function renderECConsolidationRunning(): string {
//   const oobTabs = renderEntityCoreTabActiveState("maintenance");
//   return `${oobTabs}
// <div id="ec-consolidation-content">
//   <div class="consolidation-section">
//     <h3 class="admin-section-title">Memory Consolidation</h3>
//     <div class="consolidation-running">
//       <span class="consolidation-spinner"></span>
//       Running catch-up consolidation...
//     </div>
//     <div id="ec-consolidation-results"></div>
//   </div>
// </div>`;
// }
//
// /**
//  * Render consolidation complete state for Entity Core context.
//  */
// export function renderECConsolidationComplete(
//   results: { granularity: string; success: boolean; error?: string }[],
// ): string {
//   const oobTabs = renderEntityCoreTabActiveState("maintenance");
//
//   const successCount = results.filter((r) => r.success).length;
//   const failCount = results.filter((r) => !r.success).length;
//
//   const summaryParts: string[] = [];
//   if (successCount > 0) summaryParts.push(`${successCount} succeeded`);
//   if (failCount > 0) summaryParts.push(`${failCount} failed`);
//
//   const itemsHtml = results.map((r) => {
//     const cls = r.success
//       ? "consolidation-result-success"
//       : "consolidation-result-failure";
//     const text = r.success
//       ? `${r.granularity}: created`
//       : `${r.granularity}: ${escapeHtml(r.error || "failed")}`;
//     return `<div class="consolidation-result-item ${cls}">${
//       escapeHtml(text)
//     }</div>`;
//   }).join("");
//
//   return `${oobTabs}
// <div id="ec-consolidation-content">
//   <div class="consolidation-section">
//     <h3 class="admin-section-title">Memory Consolidation</h3>
//     <div class="consolidation-summary">${summaryParts.join(", ")}</div>
//     ${
//     itemsHtml
//       ? `<div class="consolidation-results-list">${itemsHtml}</div>`
//       : ""
//   }
//     <div class="consolidation-actions">
//       <button
//         class="btn btn--ghost btn--sm"
//         hx-get="/fragments/settings/entity-core/maintenance"
//         hx-target="#settings-content"
//         hx-swap="innerHTML"
//       >Refresh Status</button>
//     </div>
//   </div>
// </div>`;
// }

export function renderECEmbeddingPurgeRunning(): string {
  const oobTabs = renderEntityCoreTabActiveState("maintenance");
  return `${oobTabs}
<div id="ec-purge-content">
  <div class="ec-maintenance-section">
    <h3 class="admin-section-title">Purge Orphaned Embeddings</h3>
    <div class="consolidation-running">
      <span class="consolidation-spinner"></span>
      Scanning for orphaned embeddings...
    </div>
    <div id="ec-purge-results"></div>
  </div>
</div>`;
}

export function renderECEmbeddingPurgeComplete(result: {
  purged: number;
  remaining: number;
  message: string;
}): string {
  const oobTabs = renderEntityCoreTabActiveState("maintenance");
  return `${oobTabs}
<div id="ec-purge-content">
  <div class="ec-maintenance-section">
    <h3 class="admin-section-title">Purge Orphaned Embeddings</h3>
    <div class="consolidation-summary">${escapeHtml(result.message)}</div>
    <div class="consolidation-actions">
      <button
        class="btn btn--ghost btn--sm"
        hx-get="/fragments/settings/entity-core/maintenance"
        hx-target="#settings-content"
        hx-swap="innerHTML"
      >Refresh Status</button>
    </div>
  </div>
</div>`;
}

export function renderECEmbeddingRebuildRunning(): string {
  const oobTabs = renderEntityCoreTabActiveState("maintenance");
  return `${oobTabs}
<div id="ec-rebuild-content">
  <div class="ec-maintenance-section">
    <h3 class="admin-section-title">Rebuild Memory Embeddings</h3>
    <div class="consolidation-running">
      <span class="consolidation-spinner"></span>
      Rebuilding embeddings... (this may take a while)
    </div>
    <div id="ec-rebuild-results"></div>
  </div>
</div>`;
}

export function renderECEmbeddingRebuildComplete(result: {
  rebuilt: number;
  failed: number;
  total: number;
  message: string;
}): string {
  const oobTabs = renderEntityCoreTabActiveState("maintenance");
  return `${oobTabs}
<div id="ec-rebuild-content">
  <div class="ec-maintenance-section">
    <h3 class="admin-section-title">Rebuild Memory Embeddings</h3>
    <div class="consolidation-summary">${escapeHtml(result.message)}</div>
    <div class="consolidation-actions">
      <button
        class="btn btn--ghost btn--sm"
        hx-get="/fragments/settings/entity-core/maintenance"
        hx-target="#settings-content"
        hx-swap="innerHTML"
      >Refresh Status</button>
    </div>
  </div>
</div>`;
}

/**
 * Render the Entity Core snapshots tab.
 * Adapted from renderSnapshotsView for Entity Core tab context.
 */
export function renderEntityCoreSnapshots(
  snapshots: Array<{
    id: string;
    category: string;
    filename: string;
    timestamp: string;
    date: string;
    reason: string;
    source?: string;
  }>,
): string {
  const oobTabs = renderEntityCoreTabActiveState("snapshots");

  const grouped: Record<string, typeof snapshots> = {};
  for (const snapshot of snapshots) {
    if (!grouped[snapshot.date]) {
      grouped[snapshot.date] = [];
    }
    grouped[snapshot.date].push(snapshot);
  }

  const sortedDates = Object.keys(grouped).sort((a, b) => b.localeCompare(a));

  let contentHtml = "";

  if (sortedDates.length === 0) {
    contentHtml = `<div class="snapshots-empty">
      <p>No snapshots available. Snapshots are created automatically on the scheduled hour (default 3 AM) and before major changes.</p>
      <button
        class="btn btn--primary"
        hx-post="/api/snapshots/create"
        hx-target="#settings-content"
        hx-swap="innerHTML"
      >Create Manual Snapshot</button>
    </div>`;
  } else {
    contentHtml = `<div class="snapshots-header">
      <button
        class="btn btn--primary btn--sm"
        hx-post="/api/snapshots/create"
        hx-target="#settings-content"
        hx-swap="innerHTML"
      >Create Manual Snapshot</button>
    </div>`;

    for (const date of sortedDates) {
      const dateSnapshots = grouped[date];
      const formattedDate = formatSnapshotDate(date);

      contentHtml += `<div class="snapshot-group">
        <h3 class="snapshot-group-date">${escapeHtml(formattedDate)}</h3>`;

      for (const snapshot of dateSnapshots) {
        const formattedTime = formatTime(snapshot.timestamp);
        const encodedSnapshotId = encodeURIComponent(snapshot.id);
        const snapshotSource = snapshot.source || "entity-core";

        contentHtml += `
          <div class="snapshot-item"
            hx-get="/fragments/entity-core/snapshots/${encodedSnapshotId}"
            hx-target="#settings-content"
            hx-swap="innerHTML"
          >
            <span class="snapshot-category">${
          escapeHtml(snapshot.category)
        }</span>
            <span class="snapshot-filename">${
          escapeHtml(snapshot.filename.replace(/\.md$/, ""))
        }</span>
            <span class="snapshot-time">${formattedTime}</span>
            <span class="snapshot-reason">${escapeHtml(snapshot.reason)}</span>
            <span class="snapshot-source">${escapeHtml(snapshotSource)}</span>
          </div>
        `;
      }

      contentHtml += `</div>`;
    }
  }

  return `${oobTabs}
<div class="ec-snapshots">
  ${contentHtml}
</div>`;
}

/**
 * Render a snapshot preview for Entity Core context.
 */
export function renderEntityCoreSnapshotPreview(
  category: string,
  filename: string,
  content: string,
  snapshotId: string,
): string {
  const oobTabs = renderEntityCoreTabActiveState("snapshots");
  const displayName = filename.replace(/\.md$/, "").replace(/_/g, " ");
  const categoryLabel = category.charAt(0).toUpperCase() + category.slice(1);

  const lines = content.split("\n");
  let contentStart = 0;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === "" && i > 2) {
      contentStart = i + 1;
      break;
    }
  }
  const actualContent = lines.slice(contentStart).join("\n");

  const previewHtml = `<div class="snapshot-preview">
  <div class="snapshot-preview-header">
    <button
      class="btn btn--ghost btn--sm"
      hx-get="/fragments/settings/entity-core/snapshots"
      hx-target="#settings-content"
      hx-swap="innerHTML"
    >Back to Snapshots</button>
    <span class="snapshot-preview-filename">${escapeHtml(categoryLabel)} / ${
    escapeHtml(displayName)
  }</span>
  </div>
  <div class="snapshot-preview-content">
    <pre>${escapeHtml(actualContent)}</pre>
  </div>
  <div class="snapshot-preview-actions">
    <button
      class="btn btn--danger"
      hx-post="/api/snapshots/${encodeURIComponent(snapshotId)}/restore"
      hx-target="#settings-content"
      hx-swap="innerHTML"
      hx-confirm="Are you sure you want to restore this snapshot? This will replace the current ${
    escapeHtml(categoryLabel)
  } / ${escapeHtml(displayName)} file."
    >Restore Snapshot</button>
  </div>
</div>`;

  return `${oobTabs}
<div class="ec-snapshots">
  ${previewHtml}
</div>`;
}

// =============================================================================
// LLM Settings Template
// =============================================================================

/**
 * Render the LLM profile settings hub view (card grid of profiles).
 */
export function renderLLMProfileHub(settings: LLMProfileSettings): string {
  const profileCards = settings.profiles.map((p) => {
    const isActive = p.id === settings.activeProfileId;
    const preset = LLM_PROVIDER_PRESETS[p.provider];
    return `
    <a class="settings-hub-card ${isActive ? "settings-hub-card--active" : ""}"
       hx-get="/fragments/settings/llm/${escapeHtml(p.id)}"
       hx-target="#chat"
       hx-swap="innerHTML">
      <div class="settings-hub-card-icon">
        ${renderProviderIcon(p.provider)}
      </div>
      <div class="settings-hub-card-body">
        <span class="settings-hub-card-title">${escapeHtml(p.name)}</span>
        <span class="settings-hub-card-desc">
          ${escapeHtml(preset?.label || p.provider)} &mdash; ${
      escapeHtml(p.model)
    }
          ${isActive ? ' <span class="badge badge--active">Active</span>' : ""}
        </span>
      </div>
      <svg class="settings-hub-card-arrow" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <polyline points="9 18 15 12 9 6"/>
      </svg>
    </a>`;
  }).join("");

  const addCard = `
    <button class="settings-hub-card settings-hub-card-add"
      hx-get="/fragments/settings/llm/new"
      hx-target="#chat"
      hx-swap="innerHTML">
      <div class="settings-hub-card-icon">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <line x1="12" y1="5" x2="12" y2="19"/>
          <line x1="5" y1="12" x2="19" y2="12"/>
        </svg>
      </div>
      <div class="settings-hub-card-body">
        <span class="settings-hub-card-title">Add Profile</span>
        <span class="settings-hub-card-desc">Configure a new LLM connection</span>
      </div>
    </button>`;

  return `<div class="settings-view">
  <div class="settings-header">
    <div class="settings-header-row">
      ${renderSettingsBackButton()}
      <div>
        <h1 class="settings-title">LLM Connections</h1>
        <p class="settings-desc">Manage model connection profiles &mdash; ${settings.profiles.length} profile${
    settings.profiles.length !== 1 ? "s" : ""
  } configured</p>
      </div>
    </div>
  </div>
  <div class="settings-content" id="settings-content">
    <div class="settings-hub-grid">
      ${profileCards}
      ${addCard}
    </div>
  </div>
</div>`;
}

/**
 * Render the LLM profile edit/create form.
 */
export function renderLLMProfileEdit(
  profile: LLMConnectionProfile | undefined,
  isNew: boolean,
  activeProfileId: string,
): string {
  const maskedKey = profile ? maskApiKey(profile.apiKey) : "";
  const isActive = !isNew && profile?.id === activeProfileId;
  const profileId = profile?.id || "";

  // Build provider options
  const providerOptions = Object.entries(LLM_PROVIDER_PRESETS).map((
    [key, preset],
  ) =>
    `<option value="${escapeHtml(key)}" ${
      profile?.provider === key ? "selected" : ""
    }>${escapeHtml(preset.label)}</option>`
  ).join("");

  return `<div class="settings-view">
  <div class="settings-header">
    <div class="settings-header-row">
      ${renderSettingsBackButton()}
      <div>
        <h1 class="settings-title">${
    isNew ? "New LLM Profile" : escapeHtml(profile!.name)
  }</h1>
        <p class="settings-desc">${
    isNew
      ? "Configure a new model connection"
      : "Edit this LLM connection profile"
  }</p>
      </div>
    </div>
  </div>
  <div class="settings-content" id="settings-content">

    <input type="hidden" id="llm-profile-id" value="${escapeHtml(profileId)}">

    <!-- Profile Identity -->
    <section class="theme-section">
      <h3 class="theme-section-title">Profile</h3>
      <p class="theme-section-desc">Name and provider selection</p>
      <div class="llm-fields">
        <div class="llm-field">
          <label for="llm-name">Profile Name</label>
          <input type="text" id="llm-name" class="input-field llm-input" value="${
    isNew ? "" : escapeHtml(profile!.name)
  }" placeholder="My OpenRouter, GPT-4o, etc.">
        </div>
        <div class="llm-field">
          <label for="llm-provider">Provider</label>
          <select id="llm-provider" class="input-field llm-input" onchange="onProviderChange()">
            ${providerOptions}
          </select>
        </div>
      </div>
    </section>

    <!-- Connection Section -->
    <section class="theme-section">
      <h3 class="theme-section-title">Connection</h3>
      <p class="theme-section-desc">API endpoint, credentials, and model selection</p>
      <div class="llm-fields">
        <div class="llm-field">
          <label for="llm-base-url">Base URL</label>
          <input type="url" id="llm-base-url" class="input-field llm-input" value="${
    isNew
      ? "https://openrouter.ai/api/v1/chat/completions"
      : escapeHtml(profile!.baseUrl)
  }" placeholder="https://api.example.com/v1/chat/completions">
        </div>
        <div class="llm-field">
          <label for="llm-api-key">API Key</label>
          <div class="llm-api-key-row">
            <input type="password" id="llm-api-key" class="input-field llm-input" value="${
    escapeHtml(maskedKey)
  }" placeholder="Enter API key...">
            <button class="btn btn--ghost btn--sm llm-toggle-key" onclick="toggleApiKeyVisibility()" title="Show/hide key">
              <svg id="eye-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
                <circle cx="12" cy="12" r="3"/>
              </svg>
            </button>
          </div>
        </div>
        <div class="llm-field">
          <label for="llm-model">Model</label>
          <input type="text" id="llm-model" class="input-field llm-input" value="${
    isNew ? "z-ai/glm-4.7" : escapeHtml(profile!.model)
  }" placeholder="model-name">
        </div>
      </div>
    </section>

    <!-- Worker Model Section -->
    <section class="theme-section">
      <h3 class="theme-section-title">Worker Model</h3>
      <p class="theme-section-desc">Lighter model for auto-titling and summarization tasks</p>
      <div class="llm-fields">
        <div class="llm-field">
          <label for="llm-worker-model">Worker Model</label>
          <input type="text" id="llm-worker-model" class="input-field llm-input" value="${
    isNew ? "GLM-4.5-Air" : escapeHtml(profile!.workerModel)
  }" placeholder="lighter-model-name (optional)">
        </div>
      </div>
    </section>

    <!-- Sampling Parameters Section -->
    <section class="theme-section">
      <h3 class="theme-section-title">Sampling Parameters</h3>
      <p class="theme-section-desc">Control randomness and diversity of responses</p>
      <div class="llm-sliders">
        <div class="slider-group">
          <label for="llm-temperature">Temperature</label>
          <input type="range" id="llm-temperature" min="0" max="2" step="0.01" value="${
    isNew ? "1" : profile!.temperature
  }" oninput="document.getElementById('llm-temperature-val').textContent = this.value">
          <span id="llm-temperature-val">${
    isNew ? "1" : profile!.temperature
  }</span>
        </div>
        <div class="slider-group">
          <label for="llm-top-p">Top P</label>
          <input type="range" id="llm-top-p" min="0" max="1" step="0.01" value="${
    isNew ? "0.95" : profile!.topP
  }" oninput="document.getElementById('llm-top-p-val').textContent = this.value">
          <span id="llm-top-p-val">${isNew ? "0.95" : profile!.topP}</span>
        </div>
        <div class="llm-field-row">
          <div class="llm-field inline">
            <label for="llm-top-k">Top K <span class="label-hint">(0 = disabled)</span></label>
            <input type="number" id="llm-top-k" class="input-field llm-input sm" value="${
    isNew ? "0" : profile!.topK
  }" min="0" max="200" step="1">
          </div>
        </div>
        <div class="slider-group">
          <label for="llm-freq-penalty">Frequency Penalty</label>
          <input type="range" id="llm-freq-penalty" min="-2" max="2" step="0.01" value="${
    isNew ? "0" : profile!.frequencyPenalty
  }" oninput="document.getElementById('llm-freq-penalty-val').textContent = this.value">
          <span id="llm-freq-penalty-val">${
    isNew ? "0" : profile!.frequencyPenalty
  }</span>
        </div>
        <div class="slider-group">
          <label for="llm-pres-penalty">Presence Penalty</label>
          <input type="range" id="llm-pres-penalty" min="-2" max="2" step="0.01" value="${
    isNew ? "0" : profile!.presencePenalty
  }" oninput="document.getElementById('llm-pres-penalty-val').textContent = this.value">
          <span id="llm-pres-penalty-val">${
    isNew ? "0" : profile!.presencePenalty
  }</span>
        </div>
      </div>
    </section>

    <!-- Limits Section -->
    <section class="theme-section">
      <h3 class="theme-section-title">Generation Limits</h3>
      <p class="theme-section-desc">Maximum response length and context window</p>
      <div class="llm-fields">
        <div class="llm-field-row">
          <div class="llm-field inline">
            <label for="llm-max-tokens">Max Tokens</label>
            <input type="number" id="llm-max-tokens" class="input-field llm-input sm" value="${
    isNew ? "4096" : profile!.maxTokens
  }" min="1" max="100000" step="1">
          </div>
          <div class="llm-field inline">
            <label for="llm-context-length">Context Window <span class="label-hint">(reference)</span></label>
            <input type="number" id="llm-context-length" class="input-field llm-input sm" value="${
    isNew ? "128000" : profile!.contextLength
  }" min="1" max="1000000" step="1">
          </div>
        </div>
      </div>
    </section>

    <!-- Behavior Section -->
    <section class="theme-section">
      <h3 class="theme-section-title">Behavior</h3>
      <p class="theme-section-desc">Chain-of-thought and reasoning settings</p>
      <label class="toggle-label">
        <input type="checkbox" id="llm-thinking" role="switch" aria-label="Chain-of-Thought Reasoning" ${
    isNew ? "checked" : profile!.thinkingEnabled ? "checked" : ""
  }>
        <span class="toggle-slider"></span>
        <span class="toggle-text">Chain-of-Thought Reasoning</span>
      </label>
      <p class="label-hint" id="thinking-provider-note" style="margin-top:0.5rem;font-size:0.8rem;opacity:0.7;">Not supported by all providers. Unsupported providers will silently ignore this parameter.</p>

      <!-- Persistent Reasoning (Intra-Turn) -->
      <div style="margin-top:1rem;">
        <label for="llm-persistent-intra" style="display:block;font-weight:600;margin-bottom:0.25rem;">Persistent Reasoning (Intra-Turn)</label>
        <select id="llm-persistent-intra" onchange="updatePersistentReasoningWarnings()" style="width:100%;padding:0.4rem;background:var(--bg-secondary,#1a1a1a);color:var(--text-primary,#fff);border:1px solid var(--border-color,#333);border-radius:4px;">
          <option value="auto" ${
    isNew || profile?.persistentReasoningIntraTurn !== "on" &&
        profile?.persistentReasoningIntraTurn !== "off"
      ? "selected"
      : ""
  }>Auto (per provider)</option>
          <option value="on" ${
    profile?.persistentReasoningIntraTurn === "on" ? "selected" : ""
  }>On (force enable)</option>
          <option value="off" ${
    profile?.persistentReasoningIntraTurn === "off" ? "selected" : ""
  }>Off (force disable)</option>
        </select>
        <p class="label-hint" style="margin-top:0.25rem;font-size:0.8rem;opacity:0.7;">When working through a multi-step task, reasoning is retained between steps so each step builds on the last. Set to <strong>on</strong> if the provider accepts <code>reasoning_content</code> on inbound messages (DeepSeek, GLM, Venice.ai pointing at DeepSeek-R1, many OpenRouter backing models). <strong>Auto</strong> only enables this for verified providers.</p>
        <p class="label-hint" id="persistent-intra-warning" style="margin-top:0.25rem;font-size:0.8rem;color:#f0ad4e;display:none;">This provider isn't in the verified list for persistent reasoning. If the API returns 400 errors on multi-step turns, set this back to auto or off.</p>
      </div>

      <!-- Persistent Reasoning (Inter-Turn) -->
      <div style="margin-top:0.75rem;">
        <label for="llm-persistent-inter" style="display:block;font-weight:600;margin-bottom:0.25rem;">Persistent Reasoning (Inter-Turn)</label>
        <input type="number" id="llm-persistent-inter" min="0" max="20" value="${
    isNew ? 0 : profile?.persistentReasoningInterTurns ?? 0
  }" oninput="updatePersistentReasoningWarnings()" style="width:6rem;padding:0.4rem;background:var(--bg-secondary,#1a1a1a);color:var(--text-primary,#fff);border:1px solid var(--border-color,#333);border-radius:4px;">
        <p class="label-hint" style="margin-top:0.25rem;font-size:0.8rem;opacity:0.7;">How many past turns of thinking are carried forward. Higher values improve cohesion but consume context budget — each turn's reasoning can run 1-5k tokens. 0 disables.</p>
        <p class="label-hint" id="persistent-inter-warning" style="margin-top:0.25rem;font-size:0.8rem;color:#f0ad4e;display:none;">This provider isn't in the verified list for persistent reasoning. If the API returns 400 errors, set this back to 0.</p>
      </div>
    </section>

    <!-- Actions -->
    <div class="llm-actions">
      <div class="llm-actions-left">
        <button class="btn btn--primary" onclick="saveProfile(event)">Save Profile</button>
        <button class="btn btn--ghost" onclick="testProfileConnection()" id="test-connection-btn">Test Connection</button>
        ${
    !isNew && !isActive
      ? `<button class="btn btn--ghost" onclick="setAsActive('${
        escapeHtml(profileId)
      }')">Set as Active</button>`
      : ""
  }
      </div>
      <div class="llm-actions-right">
        ${
    !isNew
      ? `<button class="btn btn--ghost" onclick="deleteProfile('${
        escapeHtml(profileId)
      }')" id="delete-profile-btn">Delete Profile</button>`
      : ""
  }
        <button class="btn btn--ghost" onclick="htmx.ajax('GET', '/fragments/settings/llm', { target: '#chat', swap: 'innerHTML' })">Cancel</button>
      </div>
    </div>

    <!-- Status -->
    <div id="llm-status" class="llm-status" style="display:none;"></div>

  </div>
</div>

<input type="hidden" id="llm-is-new" value="${isNew ? "true" : "false"}">
<script type="application/json" id="llm-provider-presets-data">${
    JSON.stringify(LLM_PROVIDER_PRESETS)
  }</script>
`;
}

/**
 * Render an SVG icon for a given LLM provider.
 */
function renderProviderIcon(provider: LLMProvider): string {
  const icons: Record<string, string> = {
    openrouter:
      `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M22 2L11 13"/><path d="M22 2L15 22L11 13L2 9L22 2Z"/>
    </svg>`,
    openai:
      `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>
    </svg>`,
    alibaba:
      `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/>
    </svg>`,
    nanogpt:
      `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/>
    </svg>`,
    custom:
      `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <circle cx="12" cy="12" r="3"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/>
    </svg>`,
  };
  return icons[provider] || icons.custom;
}

/**
 * Render the LLM settings view (legacy, kept for backward compat).
 * @deprecated Use renderLLMProfileHub and renderLLMProfileEdit instead.
 */
export function renderLLMSettings(_settings: LLMSettings): string {
  return `<div class="settings-view">
  <div class="settings-header">
    <div class="settings-header-row">
      ${renderSettingsBackButton()}
      <div>
        <h1 class="settings-title">LLM Settings</h1>
        <p class="settings-desc">Configure model connection, sampling parameters, and generation limits</p>
      </div>
    </div>
  </div>
  <div class="settings-content" id="settings-content">
    <div class="llm-status" style="display:block;">This settings page has been updated. Please refresh.</div>
  </div>
</div>`;
}

// =============================================================================
// Tools Settings Template
// =============================================================================

function renderToolCategory(
  category: typeof TOOL_CATEGORIES[number],
  tools: { name: string; description: string; enabled: boolean }[],
): string {
  const catId = `cat-${category.id}`;
  return `<section class="tools-category" id="${catId}">
  <div class="tools-category-header">
    <div>
      <h3 class="tools-category-title">${escapeHtml(category.name)}</h3>
      <p class="tools-category-desc">${escapeHtml(category.description)}</p>
    </div>
    <div class="tools-category-actions">
      <button class="btn btn--ghost btn--xs" onclick="toggleCategoryTools('${category.id}', true)">Enable All</button>
      <button class="btn btn--ghost btn--xs" onclick="toggleCategoryTools('${category.id}', false)">Disable All</button>
    </div>
  </div>
  <div class="tools-list">
    ${tools.map((t) => renderToolItem(t)).join("\n")}
  </div>
</section>`;
}

function renderToolItem(
  tool: { name: string; description: string; enabled: boolean },
): string {
  const inputId = `tool-${tool.name}`;
  const descTrunc = tool.description.length > 80
    ? escapeHtml(tool.description.slice(0, 80)) + "..."
    : escapeHtml(tool.description);
  return `<div class="tool-item">
  <label class="toggle-label" for="${inputId}">
    <input type="checkbox" id="${inputId}" name="${tool.name}" data-tool-name="${tool.name}" ${
    tool.enabled ? "checked" : ""
  }>
    <span class="toggle-slider"></span>
  </label>
  <div class="tool-item-info">
    <span class="tool-item-name">${escapeHtml(tool.name)}</span>
    <span class="tool-item-desc">${descTrunc}</span>
  </div>
  <button class="tool-item-expand" onclick="toggleToolDetail('${tool.name}')" title="Show details">
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <polyline points="6 9 12 15 18 9"/>
    </svg>
  </button>
  <div class="tool-detail" id="detail-${tool.name}" style="display:none;">
    <p class="tool-detail-desc">${escapeHtml(tool.description)}</p>
    <div class="tool-detail-params" id="params-${tool.name}"></div>
  </div>
</div>`;
}

/**
 * Render External Connections page with tabbed navigation.
 * Tabs: Channels (Discord, etc.), Home (smart devices), and Web Search.
 */

function renderBLEDeviceRow(
  device?: {
    id: string;
    name: string;
    type: string;
    enabled: boolean;
    streams?: Record<
      string,
      { label: string; xmlTag: string; enabled: boolean }
    >;
  },
  connected?: boolean,
): string {
  const d = device ?? {
    id: "",
    name: "",
    type: "ble",
    enabled: true,
    streams: undefined,
  };
  const streamsHtml = d.streams && Object.keys(d.streams).length > 0
    ? `<details class="ble-streams-section" style="margin-top:8px;width:100%;">
    <summary style="cursor:pointer;font-size:var(--font-size-xs);color:var(--c-fg-muted);padding:4px 0;">
      Data Streams (${Object.keys(d.streams).length})
    </summary>
    <div style="display:flex;flex-direction:column;gap:6px;padding:8px 0 0 0;">
      ${
      Object.entries(d.streams).map(([streamId, config]) =>
        `<div style="display:flex;gap:var(--sp-2);align-items:center;flex-wrap:wrap;">
        <span style="font-size:var(--font-size-xs);color:var(--c-fg-muted);min-width:100px;">${
          escapeHtml(config.label)
        }</span>
        <label style="display:flex;flex-direction:column;gap:2px;">
          <span style="font-size:var(--font-size-xs);color:var(--c-fg-muted);">XML Tag</span>
          <input type="text" value="${
          escapeHtml(config.xmlTag)
        }" data-stream-id="${
          escapeHtml(streamId)
        }" data-stream-field="xmlTag" style="width:120px;" class="settings-input" />
        </label>
        <label style="display:flex;align-items:center;gap:4px;font-size:var(--font-size-xs);color:var(--c-fg-muted);cursor:pointer;margin-top:14px;">
          <input type="checkbox" data-stream-id="${
          escapeHtml(streamId)
        }" data-stream-field="enabled" ${
          config.enabled ? "checked" : ""
        } style="accent-color:var(--c-accent);" />
          In SA
        </label>
      </div>`
      ).join("\n")
    }
    </div>
  </details>`
    : "";
  const statusBadge =
    `<span class="ble-status-badge" style="font-size:var(--font-size-xs);padding:2px 8px;border-radius:8px;margin-top:14px;${
      connected
        ? "background:rgba(76,175,80,0.15);color:#4CAF50;"
        : "background:rgba(158,158,158,0.15);color:#9E9E9E;"
    }">${connected ? "Connected" : "Disconnected"}</span>`;
  return `<div class="ble-device-row" data-device-id="${
    escapeHtml(d.id)
  }" style="display:flex;gap:var(--sp-2);align-items:center;margin-bottom:var(--sp-2);flex-wrap:wrap;">
  <label style="display:flex;flex-direction:column;gap:2px;">
    <span style="font-size:var(--font-size-xs);color:var(--c-fg-muted);">ID</span>
    <input type="text" placeholder="e.g. banglejs-1" value="${
    escapeHtml(d.id)
  }" data-field="id" style="width:140px;" class="settings-input" />
  </label>
  <label style="display:flex;flex-direction:column;gap:2px;">
    <span style="font-size:var(--font-size-xs);color:var(--c-fg-muted);">Display Name</span>
    <input type="text" placeholder="e.g. My Bangle.js" value="${
    escapeHtml(d.name)
  }" data-field="name" style="width:160px;" class="settings-input" />
  </label>
  <label style="display:flex;flex-direction:column;gap:2px;">
    <span style="font-size:var(--font-size-xs);color:var(--c-fg-muted);">Type</span>
    <input type="text" placeholder="e.g. banglejs" value="${
    escapeHtml(d.type)
  }" data-field="type" style="width:100px;" class="settings-input" />
  </label>
  <label style="display:flex;align-items:center;gap:4px;font-size:var(--font-size-xs);color:var(--c-fg-muted);cursor:pointer;margin-top:14px;">
    <input type="checkbox" data-field="enabled" ${
    d.enabled ? "checked" : ""
  } style="accent-color:var(--c-accent);" />
    Enabled
  </label>
  ${statusBadge}
  <button class="btn btn--xs" onclick="this.closest('.ble-device-row').remove()" title="Remove device" style="margin-top:14px;background:var(--c-bg-hover,#333);border:1px solid var(--c-border,#555);color:var(--c-fg);">
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
    </svg>
  </button>
  ${streamsHtml}
</div>`;
}

export function renderConnectionsSettings(
  discordSettings: DiscordSettings,
  homeSettings: import("../llm/home-settings.ts").HomeSettings,
  webSearchSettings?: import("../llm/web-search-settings.ts").WebSearchSettings,
  lovenseSettings?: import("../llm/lovense-settings.ts").LovenseSettings,
  buttplugSettings?: import("../llm/buttplug-settings.ts").ButtplugSettings,
  bleSettings?: import("../llm/ble-settings.ts").BLESettings,
): string {
  const channelsContent = renderChannelsTab(discordSettings);
  const homeContent = renderHomeTab(homeSettings);
  const wsSettings = webSearchSettings ??
    { provider: "disabled" as const, tavilyApiKey: "", braveApiKey: "" };
  const lvSettings = lovenseSettings ??
    {
      enabled: false,
      connection: { domain: "", port: 34568, secure: true },
      customInstructions: "",
    };
  const bpSettings = buttplugSettings ??
    {
      enabled: false,
      websocketUrl: "ws://127.0.0.1:12345",
      customInstructions: "",
    };
  const blSettings = bleSettings ?? { devices: [] };

  return `<div class="settings-view">
  <div class="settings-header">
    <div class="settings-header-row">
      ${renderSettingsBackButton()}
      <div>
        <h1 class="settings-title">External Connections</h1>
        <p class="settings-desc">Discord, web search, and third-party integrations</p>
      </div>
    </div>
  </div>
  <div class="settings-content" id="settings-content">

    <nav class="connections-nav">
      <button class="connections-nav-tab active" data-tab="channels" onclick="switchConnectionsTab('channels')">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
        </svg>
        Channels
      </button>
      <button class="connections-nav-tab" data-tab="home" onclick="switchConnectionsTab('home')">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>
          <polyline points="9 22 9 12 15 12 15 22"/>
        </svg>
        Home
      </button>
      <button class="connections-nav-tab" data-tab="websearch" onclick="switchConnectionsTab('websearch')">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="12" cy="12" r="10"/>
          <line x1="2" y1="12" x2="22" y2="12"/>
          <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>
        </svg>
        Web Search
      </button>
      <button class="connections-nav-tab" data-tab="intimacy" onclick="switchConnectionsTab('intimacy')">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/>
        </svg>
        Intimacy
      </button>
      <button class="connections-nav-tab" data-tab="ble" onclick="switchConnectionsTab('ble')">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M6.5 6.5l11 11"/>
          <path d="M6.5 17.5l11-11"/>
          <path d="M12 2v7"/>
          <path d="M12 15v7"/>
        </svg>
        BLE
      </button>
    </nav>

    <div id="connections-tab-channels" class="connections-tab-panel">${channelsContent}</div>
    <div id="connections-tab-home" class="connections-tab-panel" style="display:none;">${homeContent}</div>

    <div id="connections-tab-websearch" class="connections-tab-panel" style="display:none;">

    <!-- Provider Selection -->
    <section class="theme-section">
      <h3 class="theme-section-title">Provider</h3>
      <p class="theme-section-desc">Choose which web search service to use</p>
      <div class="llm-fields">
        <label class="radio-label">
          <input type="radio" name="ws-provider" value="none" ${
    wsSettings.provider === "disabled" ? "checked" : ""
  }>
          <span class="radio-text">None</span>
          <span class="label-hint">No web search capability</span>
        </label>
        <label class="radio-label">
          <input type="radio" name="ws-provider" value="tavily" ${
    wsSettings.provider === "tavily" ? "checked" : ""
  }>
          <span class="radio-text">Tavily</span>
          <span class="label-hint">AI-optimized search API (requires API key)</span>
        </label>
        <label class="radio-label">
          <input type="radio" name="ws-provider" value="brave" ${
    wsSettings.provider === "brave" ? "checked" : ""
  }>
          <span class="radio-text">Brave Search</span>
          <span class="label-hint">General web search API (requires API key)</span>
        </label>
      </div>
    </section>

    <!-- Tavily API Key -->
    <section class="theme-section" id="ws-tavily-section" style="${
    wsSettings.provider === "tavily" ? "" : "display:none;"
  }">
      <h3 class="theme-section-title">Tavily API Key</h3>
      <p class="theme-section-desc">Get an API key from <a href="https://tavily.com" target="_blank" rel="noopener" style="color:var(--accent)">tavily.com</a></p>
      <div class="llm-fields">
        <div class="llm-field">
          <label for="ws-tavily-key">API Key</label>
          <input type="password" id="ws-tavily-key" class="input-field llm-input" value="${
    escapeHtml(wsSettings.tavilyApiKey || "")
  }" placeholder="tvly-...">
        </div>
      </div>
    </section>

    <!-- Brave API Key -->
    <section class="theme-section" id="ws-brave-section" style="${
    wsSettings.provider === "brave" ? "" : "display:none;"
  }">
      <h3 class="theme-section-title">Brave Search API Key</h3>
      <p class="theme-section-desc">Get an API key from <a href="https://brave.com/search/api/" target="_blank" rel="noopener" style="color:var(--accent)">brave.com/search/api</a></p>
      <div class="llm-fields">
        <div class="llm-field">
          <label for="ws-brave-key">API Key</label>
          <input type="password" id="ws-brave-key" class="input-field llm-input" value="${
    escapeHtml(wsSettings.braveApiKey || "")
  }" placeholder="BSA-...">
        </div>
      </div>
    </section>

    <!-- Actions -->
    <div class="llm-actions">
      <div class="llm-actions-left">
        <button class="btn btn--primary" onclick="saveWebSearchSettings(event)">Save Settings</button>
      </div>
      <button class="btn btn--ghost" onclick="resetWebSearchDefaults(event)">Reset to Defaults</button>
    </div>

    <!-- Status -->
    <div id="ws-status" class="llm-status" style="display:none;"></div>

    </div>

    <div id="connections-tab-intimacy" class="connections-tab-panel" style="display:none;">
      <div class="intimacy-section-header">
        <h2 class="intimacy-section-title">Lovense Connect</h2>
        <p class="intimacy-section-desc">Control Lovense devices via the official Connect app bridge</p>
      </div>
      ${renderLovenseTab(lvSettings)}
      <div class="intimacy-section-header">
        <h2 class="intimacy-section-title">Universal (Intiface Central)</h2>
        <p class="intimacy-section-desc">Control any supported device via the universal Buttplug protocol</p>
      </div>
      ${renderButtplugTab(bpSettings)}
    </div>

    <div id="connections-tab-ble" class="connections-tab-panel" style="display:none;">
      <section class="theme-section">
        <h3 class="theme-section-title">Device Bridge</h3>
        <p class="theme-section-desc">
          Connect BLE devices (smartwatches, sensors, etc.) so I can reach
          through them physically. The device must support the Nordic UART
          Service (NUS). Keep this tab open while connected — BLE requires the
          browser to stay active.
        </p>
        <div id="device-bridge-status" style="margin-top:8px;color:var(--c-fg-muted);">
          No device connected
        </div>
        <div style="margin-top:12px;display:flex;gap:8px;">
          <button class="btn btn-primary" onclick="connectDeviceBridge()">
            Connect BLE Device
          </button>
          <button class="btn" onclick="disconnectDeviceBridge()">
            Disconnect
          </button>
        </div>
      </section>

      <section class="theme-section" style="margin-top:var(--sp-6);">
        <h3 class="theme-section-title">Configured Devices</h3>
        <p class="theme-section-desc">
          Define BLE devices here so tools can reference them by a stable ID
          (e.g. "banglejs-1") instead of the browser-assigned UUID.
          <strong>ID</strong> is the routing handle tools use.
          <strong>Display Name</strong> is what shows up in the UI.
          <strong>Type</strong> is the device family (e.g. banglejs, generic-ble).
        </p>
        <div id="ble-devices-list">
          ${
    (() => {
      const connectedIds = getWearableConnectionManager().connectedDeviceIds;
      return blSettings.devices.map((d) =>
        renderBLEDeviceRow(d, connectedIds.includes(d.id))
      ).join("\n");
    })()
  }
        </div>
        <div style="margin-top:var(--sp-3);display:flex;gap:var(--sp-2);">
          <button class="btn btn--ghost btn--xs" onclick="addBLEDeviceRow()">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="margin-right:4px">
              <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
            </svg>
            Add Device
          </button>
          <button class="btn btn--primary btn--xs" onclick="saveBLEDevices()">Save Devices</button>
        </div>
        <div id="ble-devices-status" style="margin-top:8px;display:none;" class="llm-status"></div>
      </section>
      <template id="ble-blank-device-row">${renderBLEDeviceRow()}</template>
    </div>

  </div>

  <style>
    .connections-nav { display: flex; gap: var(--sp-2); margin-bottom: var(--sp-4); border-bottom: 1px solid var(--c-border); padding-bottom: var(--sp-2); }
    .connections-nav-tab { display: flex; align-items: center; gap: var(--sp-2); padding: var(--sp-2) var(--sp-3); background: none; border: 1px solid transparent; border-radius: var(--radius-sm); color: var(--c-fg-muted); font-size: var(--font-size-sm); cursor: pointer; transition: color var(--transition), background var(--transition), border-color var(--transition); }
    .connections-nav-tab:hover { color: var(--c-fg); background: var(--c-bg-hover); }
    .connections-nav-tab:active { transform: scale(0.98); }
    .connections-nav-tab.active { color: var(--c-accent); background: var(--c-accent-subtle); border-color: var(--c-accent); }
    .radio-label { display: flex; align-items: center; gap: 10px; padding: 8px 0; cursor: pointer; }
    .radio-label input[type="radio"] { accent-color: var(--accent); width: 16px; height: 16px; flex-shrink: 0; }
    .radio-text { font-weight: 500; min-width: 100px; }
    .label-hint { color: var(--text-dim); font-size: 0.85rem; }
  </style>
</div>`;
}

/**
 * Render the Channels tab content (card grid for messaging/social integrations).
 */
function renderChannelsTab(settings: DiscordSettings): string {
  return `<div class="settings-hub-grid">

      <a class="settings-hub-card"
        hx-get="/fragments/settings/connections/discord"
        hx-target="#chat"
        hx-swap="innerHTML">
        <div class="settings-hub-card-icon">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
          </svg>
        </div>
        <div class="settings-hub-card-body">
          <span class="settings-hub-card-title">Discord</span>
          <span class="settings-hub-card-desc">${
    settings.enabled ? "Configured" : "Not configured"
  }</span>
        </div>
        <svg class="settings-hub-card-arrow" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="9 18 15 12 9 6"/>
        </svg>
      </a>

      <p class="settings-note">More channels can be added here in the future.</p>
    </div>`;
}

/**
 * Render the Home tab content (device management).
 * Reuses the same HTML as renderHomeSettings but without page chrome.
 */
function renderHomeTab(
  settings: import("../llm/home-settings.ts").HomeSettings,
): string {
  return renderHomeSettingsContent(settings);
}

/**
 * Render Discord connection settings sub-page.
 */
export function renderConnectionsDiscordSettings(
  settings: DiscordSettings,
  gatewayConfig?: DiscordGatewayConfig,
): string {
  const gc = gatewayConfig;
  const dmWhitelist = gc?.dmWhitelist ?? [];

  return `<div class="settings-view">
  <div class="settings-header">
    <div class="settings-header-row">
      ${renderSettingsBackButton()}
      <div>
        <h1 class="settings-title">Discord</h1>
        <p class="settings-desc">Discord integration settings</p>
      </div>
    </div>
  </div>
  <div class="settings-content discord-settings-page" id="settings-content">

    <section class="theme-section">
      <h3 class="theme-section-title">Connection</h3>
      <div class="llm-fields">
        <div class="llm-field">
          <label for="discord-bot-token">Bot Token</label>
          <input type="password" id="discord-bot-token" class="input-field llm-input" value="${
    escapeHtml(settings.botToken || "")
  }" placeholder="Paste your Discord bot token">
          <span class="field-hint">Create a bot at discord.com/developers/applications</span>
        </div>
        <div class="llm-field">
          <label class="toggle-label" for="discord-show-hub">
            <span>Show Discord Hub in Sidebar</span>
            <input type="checkbox" id="discord-show-hub" ${
    settings.showHubInSidebar !== false ? "checked" : ""
  }>
            <span class="toggle-slider"></span>
          </label>
        </div>
      </div>
    </section>

    <section class="theme-section">
      <h3 class="theme-section-title">DMs</h3>
      <p class="theme-section-desc">Settings for send_discord_dm tool</p>
      <div class="llm-fields">
        <div class="llm-field">
          <label class="toggle-label" for="discord-enabled">
            <span>Enable Discord DMs</span>
            <input type="checkbox" id="discord-enabled" ${
    settings.enabled ? "checked" : ""
  }>
            <span class="toggle-slider"></span>
          </label>
        </div>
        <div class="llm-field" id="discord-channel-section" style="${
    settings.enabled ? "" : "display:none;"
  }">
          <label for="discord-channel-id">Default Channel ID</label>
          <span class="field-hint">The Discord user or channel ID to DM by default</span>
          <input type="text" id="discord-channel-id" class="input-field llm-input" value="${
    escapeHtml(settings.defaultChannelId || "")
  }" placeholder="e.g. 123456789012345678">
        </div>
      </div>
      <hr class="settings-divider">
      <div class="llm-fields" style="margin-top:var(--sp-4);">
        <div class="llm-field">
          <label class="settings-label">DM Whitelist</label>
          <span class="field-hint">Only whitelisted users can DM the entity. Add users by their Discord user ID.</span>
          <div id="dm-whitelist" class="dm-whitelist">
            ${
    dmWhitelist.length > 0
      ? dmWhitelist.map((e) => `
              <div class="dm-whitelist-entry" data-user-id="${
        escapeHtml(e.userId)
      }">
                <div class="dm-whitelist-info">
                  <strong class="dm-wl-display">${
        escapeHtml(e.username)
      }</strong>
                  <input class="settings-input dm-wl-edit-username" value="${
        escapeHtml(e.username)
      }" style="display:none;font-size:var(--font-size-sm);">
                  <span class="dm-wl-display dm-whitelist-meta">${
        escapeHtml(e.userId)
      }</span>${
        e.notes
          ? `\n                  <span class="dm-wl-display dm-whitelist-notes">${
            escapeHtml(e.notes)
          }</span>`
          : ""
      }
                  <input class="settings-input dm-wl-edit-notes" value="${
        escapeHtml(e.notes)
      }" style="display:none;font-size:var(--font-size-sm);flex:1;" placeholder="Notes">
                </div>
                <div class="dm-whitelist-actions">
                  <button class="btn btn--ghost btn--sm dm-whitelist-edit" data-user-id="${
        escapeHtml(e.userId)
      }" title="Edit">edit</button>
                  <button class="btn btn--ghost btn--sm dm-whitelist-save" data-user-id="${
        escapeHtml(e.userId)
      }" style="display:none;" title="Save">save</button>
                  <button class="btn btn--ghost btn--sm dm-whitelist-remove" data-user-id="${
        escapeHtml(e.userId)
      }" title="Remove">&times;</button>
                </div>
              </div>
            `).join("")
      : '<p class="empty-text" style="margin:0;">No users whitelisted.</p>'
  }
          </div>
        </div>
        <div class="llm-field-row" style="display:flex;gap:var(--sp-2);align-items:flex-end;">
          <div class="llm-field inline" style="flex:2;">
            <label for="dm-wl-user-id">User ID</label>
            <input class="settings-input" id="dm-wl-user-id" placeholder="e.g. 123456789012345678">
          </div>
          <div class="llm-field inline" style="flex:2;">
            <label for="dm-wl-username">Username</label>
            <input class="settings-input" id="dm-wl-username" placeholder="e.g. username">
          </div>
          <div class="llm-field inline" style="flex:3;">
            <label for="dm-wl-notes">Notes</label>
            <input class="settings-input" id="dm-wl-notes" placeholder="e.g. James — from Post-Human Hearts">
          </div>
          <button class="btn btn--secondary btn--sm" style="margin-bottom:0;" onclick="addDmWhitelistEntry()">Add</button>
        </div>
      </div>
    </section>

    <section class="theme-section">
      <h3 class="theme-section-title">Server Participation</h3>
      <p class="theme-section-desc">Entity joins Discord servers and participates in channels as a conversational participant</p>
      <div class="llm-fields">
        <div class="llm-field">
          <label class="toggle-label" for="discord-gateway-enabled">
            <span>Enable Gateway</span>
            <input type="checkbox" id="discord-gateway-enabled" ${
    settings.gatewayEnabled ? "checked" : ""
  }>
            <span class="toggle-slider"></span>
          </label>
          <span class="field-hint">Requires a bot token. The entity will connect to Discord and join configured servers.</span>
        </div>
        <div id="discord-gateway-fields" style="${
    settings.gatewayEnabled ? "" : "display:none;"
  }">
          <div class="llm-field">
            <label class="settings-label">Global Instructions</label>
            <textarea class="settings-textarea" id="discord-global-instructions" rows="3"
              placeholder="Instructions that apply to all Discord channels...">${
    escapeHtml(settings.globalInstructions)
  }</textarea>
            <span class="field-hint">Write from the entity's perspective, in first-person</span>
          </div>
          <div class="llm-field">
            <label class="toggle-label" for="discord-daily-memories">
              <span>Include in Daily Memories</span>
              <input type="checkbox" id="discord-daily-memories" ${
    gc?.includeInDailyMemories !== false ? "checked" : ""
  }>
              <span class="toggle-slider"></span>
            </label>
            <span class="field-hint">Summarize Discord activity into daily memories (pre-summarized, not raw messages)</span>
          </div>
          <div class="llm-field" id="discord-memory-instructions-field">
            <label class="settings-label">Memory Writer Instructions</label>
            <textarea class="settings-textarea" id="discord-memory-instructions" rows="3"
              placeholder="e.g. @superdog420 is James — write memories about him as James">${
    escapeHtml(gc?.memoryInstructions ?? "")
  }</textarea>
            <span class="field-hint">Write from the entity's perspective, in first-person. e.g. "@superdog420 is James — when I write memories about him, use his real name"</span>
          </div>
          <div class="llm-field">
            <label class="settings-label">Servers & Channels</label>
            <p class="settings-note">
              Configure servers and channels from the
              <a hx-get="/fragments/discord" hx-target="#chat" hx-swap="innerHTML"
                 style="color:var(--c-accent);cursor:pointer;">Discord Hub</a>.
            </p>
          </div>
          <div class="llm-field">
            <label class="toggle-label">
              <span>Respond to @everyone/@here</span>
              <input type="checkbox" id="discord-respond-everyone" ${
    gc?.respondToEveryoneHere ? "checked" : ""
  }>
              <span class="toggle-slider"></span>
            </label>
          </div>
          <div class="llm-field">
            <label class="settings-label">Allowed Tools (comma-separated)</label>
            <input class="settings-input" id="discord-allowed-tools"
              value="${
    gc?.allowedTools.join(", ") ??
      "web_search, generate_image, describe_image, look_closer, create_significant_memory, vault"
  }">
            <span class="field-hint">Tools the entity can use in Discord channels.</span>
          </div>
          <div class="llm-field-row" style="display:flex;gap:var(--sp-4);">
            <div class="llm-field inline" style="flex:1;">
              <label class="settings-label">Blocked Bot IDs</label>
              <input class="settings-input" id="discord-blocked-bots"
                value="${gc?.blockedBotIds.join(", ") ?? ""}">
              <span class="field-hint">Comma-separated bot user IDs to ignore</span>
            </div>
            <div class="llm-field inline" style="flex:1;">
              <label class="settings-label">Debounce (ms)</label>
              <input class="settings-input" type="number" id="discord-debounce"
                value="${gc?.debounceWindowMs ?? 5000}" min="1000" max="30000">
              <span class="field-hint">Wait time before responding (default: 5000)</span>
            </div>
            <div class="llm-field inline" style="flex:1;">
              <label class="settings-label">Max Buffer</label>
              <input class="settings-input" type="number" id="discord-max-buffer"
                value="${gc?.maxBufferSize ?? 50}" min="5" max="200">
              <span class="field-hint">Max messages before forced response (default: 50)</span>
            </div>
          </div>
        </div>
      </div>
    </section>

    <div class="llm-actions">
      <div class="llm-actions-left">
        <button class="btn btn--primary" onclick="saveDiscordSettings(event)">Save Settings</button>
        <button class="btn btn--secondary" id="discord-restart-btn" style="${
    settings.gatewayEnabled ? "" : "display:none;"
  }" onclick="restartDiscordGateway()">Restart Gateway</button>
      </div>
      <button class="btn btn--ghost" onclick="resetDiscordDefaults(event)">Reset to Defaults</button>
    </div>

    <div id="discord-status" class="llm-status" style="display:none;"></div>

  </div>
</div>

<script>
const discordEnabled = document.getElementById('discord-enabled');
const discordChannel = document.getElementById('discord-channel-section');
if (discordEnabled && discordChannel) {
  discordEnabled.addEventListener('change', () => {
    discordChannel.style.display = discordEnabled.checked ? '' : 'none';
  });
}

// DM Whitelist management
function renderDmWhitelistUI() {
  const container = document.getElementById('dm-whitelist');
  if (!container) return;
  fetch('/api/discord/dm-whitelist').then(r => r.json()).then(data => {
    if (data.entries.length > 0) {
      container.innerHTML = data.entries.map(e => '<div class="dm-whitelist-entry" data-user-id="' + e.userId + '"><div class="dm-whitelist-info"><strong class="dm-wl-display">' + e.username + '</strong><input class="settings-input dm-wl-edit-username" value="' + e.username + '" style="display:none;font-size:var(--font-size-sm);"><span class="dm-wl-display dm-whitelist-meta">' + e.userId + '</span>' + (e.notes ? '<span class="dm-wl-display dm-whitelist-notes">' + e.notes + '</span>' : '') + '<input class="settings-input dm-wl-edit-notes" value="' + (e.notes || '') + '" style="display:none;font-size:var(--font-size-sm);flex:1;" placeholder="Notes"></div><div class="dm-whitelist-actions"><button class="btn btn--ghost btn--sm dm-whitelist-edit" data-user-id="' + e.userId + '" title="Edit">edit</button><button class="btn btn--ghost btn--sm dm-whitelist-save" data-user-id="' + e.userId + '" style="display:none;" title="Save">save</button><button class="btn btn--ghost btn--sm dm-whitelist-remove" data-user-id="' + e.userId + '" title="Remove">&times;</button></div></div>').join("");
      container.querySelectorAll('.dm-whitelist-remove').forEach(btn => {
        btn.addEventListener('click', () => removeDmWhitelistEntry(btn.dataset.userId));
      });
      container.querySelectorAll('.dm-whitelist-edit').forEach(btn => {
        btn.addEventListener('click', () => toggleDmWhitelistEdit(btn.closest('.dm-whitelist-entry'), true));
      });
      container.querySelectorAll('.dm-whitelist-save').forEach(btn => {
        btn.addEventListener('click', () => saveDmWhitelistEdit(btn.closest('.dm-whitelist-entry')));
      });
    } else {
      container.innerHTML = '<p class="empty-text" style="margin:0;">No users whitelisted.</p>';
    }
  });
}

function toggleDmWhitelistEdit(entry, show) {
  entry.querySelectorAll('.dm-wl-display').forEach(el => el.style.display = show ? 'none' : '');
  entry.querySelectorAll('.dm-wl-edit-username, .dm-wl-edit-notes').forEach(el => el.style.display = show ? '' : 'none');
  entry.querySelector('.dm-whitelist-edit').style.display = show ? 'none' : '';
  entry.querySelector('.dm-whitelist-save').style.display = show ? '' : 'none';
}

async function saveDmWhitelistEdit(entry) {
  const userId = entry.dataset.userId;
  const username = entry.querySelector('.dm-wl-edit-username').value.trim();
  const notes = entry.querySelector('.dm-wl-edit-notes').value.trim();
  try {
    const resp = await fetch('/api/discord/dm-whitelist/' + encodeURIComponent(userId), {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, notes }),
    });
    const data = await resp.json();
    if (data.success) {
      renderDmWhitelistUI();
    } else {
      showDiscordStatus('error', data.error || 'Failed to update entry.');
    }
  } catch (e) { showDiscordStatus('error', e.message); }
}

async function addDmWhitelistEntry() {
  const userId = document.getElementById('dm-wl-user-id')?.value.trim();
  const username = document.getElementById('dm-wl-username')?.value.trim();
  const notes = document.getElementById('dm-wl-notes')?.value.trim();
  if (!userId || !username) { showDiscordStatus('error', 'User ID and username are required.'); return; }
  try {
    const resp = await fetch('/api/discord/dm-whitelist', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, username, notes }),
    });
    const data = await resp.json();
    if (data.success) {
      document.getElementById('dm-wl-user-id').value = '';
      document.getElementById('dm-wl-username').value = '';
      document.getElementById('dm-wl-notes').value = '';
      renderDmWhitelistUI();
    } else {
      showDiscordStatus('error', data.error || 'Failed to add entry.');
    }
  } catch (e) { showDiscordStatus('error', e.message); }
}

async function removeDmWhitelistEntry(userId) {
  try {
    await fetch('/api/discord/dm-whitelist/' + encodeURIComponent(userId), { method: 'DELETE' });
    renderDmWhitelistUI();
  } catch (e) { showDiscordStatus('error', e.message); }
}

renderDmWhitelistUI();

const discordGatewayEnabled = document.getElementById('discord-gateway-enabled');
const discordGatewayFields = document.getElementById('discord-gateway-fields');
const discordRestartBtn = document.getElementById('discord-restart-btn');
if (discordGatewayEnabled && discordGatewayFields) {
  discordGatewayEnabled.addEventListener('change', () => {
    const show = discordGatewayEnabled.checked;
    discordGatewayFields.style.display = show ? '' : 'none';
    if (discordRestartBtn) discordRestartBtn.style.display = show ? '' : 'none';
  });
}

function showDiscordStatus(type, message) {
  const el = document.getElementById('discord-status');
  if (!el) return;
  el.style.display = 'block';
  el.className = 'llm-status ' + type;
  el.textContent = message;
}

async function saveDiscordSettings(event) {
  const btn = event.currentTarget;
  btn.disabled = true;
  btn.textContent = 'Saving...';
  showDiscordStatus('loading', 'Saving settings...');

  try {
    // Save base settings
    const baseSettings = {
      enabled: document.getElementById('discord-enabled')?.checked ?? false,
      botToken: document.getElementById('discord-bot-token')?.value.trim() || '',
      defaultChannelId: document.getElementById('discord-channel-id')?.value.trim() || '',
      gatewayEnabled: document.getElementById('discord-gateway-enabled')?.checked ?? false,
      globalInstructions: document.getElementById('discord-global-instructions')?.value.trim() || '',
      showHubInSidebar: document.getElementById('discord-show-hub')?.checked ?? true,
    };

    // Save gateway config if gateway fields are visible
    if (baseSettings.gatewayEnabled) {
      // Preserve existing server config (managed from the Hub)
      const existingConfig = await (await fetch('/api/discord/gateway-config')).json();
      const servers = existingConfig?.servers ?? [];

      const allowedTools = (document.getElementById('discord-allowed-tools')?.value || '')
        .split(',').map(s => s.trim()).filter(Boolean);
      const blockedBots = (document.getElementById('discord-blocked-bots')?.value || '')
        .split(',').map(s => s.trim()).filter(Boolean);

      const gatewayConfig = {
        servers,
        dmWhitelist: await (async () => {
          const resp = await fetch('/api/discord/dm-whitelist');
          const data = await resp.json();
          return data.entries || [];
        })(),
        blockedBotIds: blockedBots,
        respondToEveryoneHere: document.getElementById('discord-respond-everyone')?.checked ?? true,
        allowedTools,
        debounceWindowMs: parseInt(document.getElementById('discord-debounce')?.value) || 5000,
        maxBufferSize: parseInt(document.getElementById('discord-max-buffer')?.value) || 50,
        includeInDailyMemories: document.getElementById('discord-daily-memories')?.checked ?? true,
        memoryInstructions: document.getElementById('discord-memory-instructions')?.value.trim() || '',
      };

      await fetch('/api/discord/gateway-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(gatewayConfig),
      });
    }

    const resp = await fetch('/api/discord-settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(baseSettings),
    });
    const data = await resp.json();
    if (data.success) {
      showDiscordStatus('success', 'Settings saved successfully.');
      // Update sidebar visibility
      const sidebarBtn = document.getElementById('discord-sidebar-btn');
      const showHub = document.getElementById('discord-show-hub')?.checked ?? true;
      if (sidebarBtn) {
        const show = (baseSettings.enabled || baseSettings.gatewayEnabled) && showHub;
        sidebarBtn.style.display = show ? '' : 'none';
      }
    } else {
      showDiscordStatus('error', 'Failed to save: ' + (data.error || 'Unknown error'));
    }
  } catch (e) {
    showDiscordStatus('error', 'Failed to save: ' + e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Save Settings';
  }
}

function restartDiscordGateway() {
  fetch('/api/discord/gateway/restart', { method: 'POST' })
    .then(r => r.json())
    .then(data => {
      if (data.success) showDiscordStatus('success', 'Gateway restarted successfully.');
      else showDiscordStatus('error', 'Failed to restart gateway.');
    })
    .catch(e => showDiscordStatus('error', 'Failed to restart: ' + e.message));
}

let discordResetPending = false;
async function resetDiscordDefaults(event) {
  const btn = event.currentTarget;
  if (!discordResetPending) {
    discordResetPending = true;
    btn.textContent = 'Confirm Reset?';
    btn.classList.add('btn--danger');
    btn.classList.remove('btn--ghost');
    setTimeout(() => {
      if (discordResetPending) {
        discordResetPending = false;
        btn.textContent = 'Reset to Defaults';
        btn.classList.remove('btn--danger');
        btn.classList.add('btn--ghost');
      }
    }, 3000);
    return;
  }
  discordResetPending = false;
  btn.textContent = 'Resetting...';
  btn.disabled = true;
  showDiscordStatus('loading', 'Resetting to defaults...');

  try {
    const resp = await fetch('/api/discord-settings/reset', { method: 'POST' });
    const data = await resp.json();
    if (data.success) {
      htmx.ajax('GET', '/fragments/settings/connections/discord', { target: '#chat', swap: 'innerHTML' });
    } else {
      showDiscordStatus('error', 'Failed to reset: ' + (data.error || 'Unknown error'));
      btn.disabled = false;
      btn.textContent = 'Reset to Defaults';
      btn.classList.remove('btn--danger');
      btn.classList.add('btn--ghost');
    }
  } catch (e) {
    showDiscordStatus('error', 'Failed to reset: ' + e.message);
    btn.disabled = false;
    btn.textContent = 'Reset to Defaults';
    btn.classList.remove('btn--danger');
    btn.classList.add('btn--ghost');
  }
}
</script>`;
}

/**
 * Render the Lovense settings tab content (embedded in External Connections).
 */
function renderLovenseTab(
  settings: import("../llm/lovense-settings.ts").LovenseSettings,
): string {
  const { domain, port, secure } = settings.connection;

  return `
    <!-- Enable -->
    <section class="theme-section">
      <h3 class="theme-section-title">Enable Lovense Control</h3>
      <p class="theme-section-desc">Allow the entity to control Lovense devices via the local Lovense Connect app</p>
      <div class="llm-fields">
        <div class="llm-field">
          <label class="toggle-label">
            <input type="checkbox" id="lovense-enabled" ${
    settings.enabled ? "checked" : ""
  }>
            <span class="toggle-slider"></span>
            <span class="toggle-text">Enable Lovense Control</span>
          </label>
        </div>
      </div>
      <p class="settings-note">After enabling, also turn on the <code>control_lovense</code> tool in Settings > Tools.</p>
    </section>

    <!-- Connection -->
    <section class="theme-section">
      <h3 class="theme-section-title">Connection</h3>
      <p class="theme-section-desc">Connect to the Lovense Connect app running on your phone</p>
      <div class="llm-fields">
        <div class="llm-field">
          <label for="lovense-domain">Bridge Address</label>
          <input type="text" id="lovense-domain" class="input-field llm-input" value="${
    escapeHtml(domain)
  }" placeholder="192-168-1-44.lovense.club">
        </div>
        <div class="llm-field">
          <label class="toggle-label">
            <input type="checkbox" id="lovense-secure" ${
    secure ? "checked" : ""
  } onchange="lovenseModeChanged()">
            <span class="toggle-slider"></span>
            <span class="toggle-text">HTTPS (Game Mode)</span>
          </label>
          <span class="field-hint" id="lovense-mode-hint">${
    secure
      ? "Game Mode: HTTPS on port 34568 (mobile) / 30010 (PC)"
      : "LAN Mode: HTTP on port 20010"
  }</span>
        </div>
        <div class="llm-field">
          <label for="lovense-port">Port</label>
          <input type="number" id="lovense-port" class="input-field llm-input" value="${port}" min="1" max="65535" placeholder="20010">
        </div>
      </div>
    </section>

    <!-- Test Connection -->
    <section class="theme-section">
      <h3 class="theme-section-title">Test Connection</h3>
      <p class="theme-section-desc">Verify the connection to Lovense Connect and discover connected toys</p>
      <button class="btn btn--secondary" id="lovense-test-btn" onclick="testLovenseConnection()">Test Connection</button>
      <div id="lovense-test-status" class="llm-status" style="display:none; margin-top: var(--sp-2);"></div>
      <div id="lovense-toys-list" style="display:none; margin-top: var(--sp-2);">
        <div class="lovense-toys-grid"></div>
      </div>
      <details id="lovense-raw-response" style="display:none; margin-top: var(--sp-2);">
        <summary style="cursor:pointer; font-size: 0.85rem; color: var(--c-fg-muted);">Raw API Response</summary>
        <pre class="lovense-raw-pre" style="background: var(--c-bg); border: 1px solid var(--c-border); border-radius: var(--radius-md); padding: var(--sp-2); font-size: 0.75rem; line-height: 1.4; overflow-x: auto; max-height: 360px; overflow-y: auto; white-space: pre-wrap; word-break: break-word;"></pre>
      </details>
    </section>

    <!-- Custom Instructions -->
    <section class="theme-section">
      <h3 class="theme-section-title">Custom Instructions</h3>
      <p class="theme-section-desc">Instructions for me when I'm using connected Lovense devices. Only included in my context when a device is connected.</p>
      <div class="llm-fields">
        <div class="llm-field">
          <textarea id="lovense-custom-instructions" class="input-field llm-input" rows="4" placeholder="e.g. Start slow, ramp up gradually, prefer pattern mode...">${
    escapeHtml(settings.customInstructions ?? "")
  }</textarea>
        </div>
      </div>
    </section>

    <!-- Actions -->
    <div class="llm-actions">
      <div class="llm-actions-left">
        <button class="btn btn--primary" onclick="saveLovenseSettings(event)">Save Settings</button>
      </div>
    </div>

    <!-- Status -->
    <div id="lovense-status" class="llm-status" style="display:none;"></div>

    <style>
      .lovense-toys-grid { display: flex; flex-direction: column; gap: var(--sp-2); }
      .lovense-toy-card { background: var(--c-bg); border: 1px solid var(--c-border); border-radius: var(--radius-md); padding: var(--sp-3); display: flex; justify-content: space-between; align-items: center; }
      .lovense-toy-name { font-weight: 500; }
      .lovense-toy-id { color: var(--text-dim); font-size: 0.8rem; font-family: monospace; }
      .lovense-toy-battery { color: var(--c-fg-muted); font-size: 0.85rem; }
      .lovense-toy-status { font-size: 0.8rem; padding: 2px 8px; border-radius: var(--radius-sm); }
      .lovense-toy-status.connected { background: rgba(74, 222, 128, 0.15); color: #4ade80; }
      .lovense-toy-status.disconnected { background: rgba(248, 113, 113, 0.15); color: #f87171; }
    </style>

    <script>
    function lovenseModeChanged() {
      const secure = document.getElementById('lovense-secure')?.checked ?? false;
      const portInput = document.getElementById('lovense-port');
      const hint = document.getElementById('lovense-mode-hint');
      if (portInput) portInput.value = secure ? 34568 : 20010;
      if (hint) hint.textContent = secure
        ? 'Game Mode: HTTPS on port 34568 (mobile) / 30010 (PC)'
        : 'LAN Mode: HTTP on port 20010';
    }

    function showLovenseStatus(type, message) {
      const el = document.getElementById('lovense-status');
      if (!el) return;
      el.style.display = 'block';
      el.className = 'llm-status ' + type;
      el.textContent = message;
    }

    function saveLovenseSettings(e) {
      e.preventDefault();
      const enabled = document.getElementById('lovense-enabled')?.checked ?? false;
      const domain = document.getElementById('lovense-domain')?.value?.trim() ?? '';
      const port = parseInt(document.getElementById('lovense-port')?.value ?? '20010') || 20010;
      const secure = document.getElementById('lovense-secure')?.checked ?? false;
      const customInstructions = document.getElementById('lovense-custom-instructions')?.value ?? '';

      const btn = e.currentTarget;
      btn.disabled = true;
      btn.textContent = 'Saving...';
      showLovenseStatus('loading', 'Saving settings...');

      fetch('/api/lovense-settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled, connection: { domain, port, secure }, customInstructions }),
      })
        .then(r => r.json())
        .then(data => {
          if (data.success) {
            showLovenseStatus('success', 'Settings saved successfully.');
          } else {
            showLovenseStatus('error', data.error || 'Failed to save settings.');
          }
        })
        .catch(err => showLovenseStatus('error', 'Network error: ' + err.message))
        .finally(() => { btn.disabled = false; btn.textContent = 'Save Settings'; });
    }

    function testLovenseConnection() {
      const btn = document.getElementById('lovense-test-btn');
      const statusEl = document.getElementById('lovense-test-status');
      const toysEl = document.getElementById('lovense-toys-list');
      const rawEl = document.getElementById('lovense-raw-response');
      const rawPre = rawEl?.querySelector('.lovense-raw-pre');

      if (!btn || !statusEl || !toysEl) return;
      btn.disabled = true;
      btn.textContent = 'Testing...';
      statusEl.style.display = 'block';
      statusEl.className = 'llm-status info';
      statusEl.textContent = 'Connecting to Lovense Connect via server...';
      toysEl.style.display = 'none';
      if (rawEl) rawEl.style.display = 'none';

      const domain = document.getElementById('lovense-domain')?.value?.trim() ?? '';
      const port = parseInt(document.getElementById('lovense-port')?.value ?? '20010') || 20010;
      const secure = document.getElementById('lovense-secure')?.checked ?? false;

      if (!domain) {
        statusEl.className = 'llm-status error';
        statusEl.textContent = 'Enter a bridge address first.';
        btn.disabled = false;
        btn.textContent = 'Test Connection';
        return;
      }

      // Route through server to avoid browser TLS restrictions
      fetch('/api/lovense-settings/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ domain, port, secure }),
        signal: AbortSignal.timeout(10000),
      })
        .then(r => r.json())
        .then(data => {
          const showRaw = (payload) => {
            if (rawEl && rawPre && payload != null) {
              rawPre.textContent = typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2);
              rawEl.style.display = 'block';
            }
          };
          if (data.error) {
            statusEl.className = 'llm-status error';
            statusEl.textContent = data.error;
            showRaw(data.raw);
            btn.disabled = false;
            btn.textContent = 'Test Connection';
            return;
          }

          showRaw(data.raw);

          const toys = data.toys || [];
          const grid = toysEl.querySelector('.lovense-toys-grid');

          if (toys.length === 0) {
            statusEl.className = 'llm-status warning';
            statusEl.textContent = 'Connected, but no toys found. Ensure your toy is powered on and paired.';
            btn.disabled = false;
            btn.textContent = 'Test Connection';
            return;
          }

          statusEl.className = 'llm-status success';
          statusEl.textContent = 'Connected! Found ' + toys.length + ' toy(s).';
          if (grid) {
            grid.innerHTML = toys.map(t => {
              const label = t.nickname || t.name;
              const connected = t.connected;
              return '<div class="lovense-toy-card">' +
                '<div><div class="lovense-toy-name">' + label + '</div>' +
                '<div class="lovense-toy-id">' + t.id + '</div></div>' +
                '<div style="display:flex;align-items:center;gap:var(--sp-2);">' +
                '<span class="lovense-toy-battery">' + t.battery + '%</span>' +
                '<span class="lovense-toy-status ' + (connected ? 'connected' : 'disconnected') + '">' +
                (connected ? 'Connected' : 'Disconnected') + '</span></div></div>';
            }).join('');
          }
          toysEl.style.display = 'block';
          btn.disabled = false;
          btn.textContent = 'Test Connection';
        })
        .catch(err => {
          statusEl.className = 'llm-status error';
          statusEl.textContent = 'Connection failed. Is Lovense Connect running? Error: ' + err.message;
          btn.disabled = false;
          btn.textContent = 'Test Connection';
        });
    }
    </script>
  `;
}

/**
 * Render the Intimacy (buttplug) settings tab content (embedded in External Connections).
 */
function renderButtplugTab(
  settings: import("../llm/buttplug-settings.ts").ButtplugSettings,
): string {
  const url = settings.websocketUrl || "ws://127.0.0.1:12345";

  return `
    <!-- Enable -->
    <section class="theme-section">
      <h3 class="theme-section-title">Enable Intiface Control</h3>
      <p class="theme-section-desc">Allow the entity to control devices via Intiface Central (universal protocol)</p>
      <div class="llm-fields">
        <div class="llm-field">
          <label class="toggle-label">
            <input type="checkbox" id="buttplug-enabled" ${
    settings.enabled ? "checked" : ""
  }>
            <span class="toggle-slider"></span>
            <span class="toggle-text">Enable Toy Control</span>
          </label>
        </div>
      </div>
      <p class="settings-note">After enabling, also turn on the <code>control_toy</code> tool in Settings > Tools.</p>
    </section>

    <!-- Connection -->
    <section class="theme-section">
      <h3 class="theme-section-title">Connection</h3>
      <p class="theme-section-desc">Connect to Intiface Central or any compatible protocol server via WebSocket</p>
      <div class="llm-fields">
        <div class="llm-field">
          <label for="buttplug-url">WebSocket URL</label>
          <input type="text" id="buttplug-url" class="input-field llm-input" value="${
    escapeHtml(url)
  }" placeholder="ws://127.0.0.1:12345">
          <span class="field-hint">Default Intiface Central address. Change if running on another machine or custom port.</span>
        </div>
      </div>
    </section>

    <!-- Test Connection -->
    <section class="theme-section">
      <h3 class="theme-section-title">Test Connection</h3>
      <p class="theme-section-desc">Verify the connection to Intiface Central and discover connected devices</p>
      <button class="btn btn--secondary" id="buttplug-test-btn" onclick="testButtplugConnection()">Test Connection</button>
      <div id="buttplug-test-status" class="llm-status" style="display:none; margin-top: var(--sp-2);"></div>
      <div id="buttplug-devices-list" style="display:none; margin-top: var(--sp-2);">
        <div class="buttplug-devices-grid"></div>
      </div>
    </section>

    <!-- Custom Instructions -->
    <section class="theme-section">
      <h3 class="theme-section-title">Custom Instructions</h3>
      <p class="theme-section-desc">Instructions for me when I'm using connected Intiface devices. Only included in my context when a device is connected.</p>
      <div class="llm-fields">
        <div class="llm-field">
          <textarea id="buttplug-custom-instructions" class="input-field llm-input" rows="4" placeholder="e.g. Start slow, prefer vibration over rotation...">${
    escapeHtml(settings.customInstructions ?? "")
  }</textarea>
        </div>
      </div>
    </section>

    <!-- Actions -->
    <div class="llm-actions">
      <div class="llm-actions-left">
        <button class="btn btn--primary" onclick="saveButtplugSettings(event)">Save Settings</button>
      </div>
    </div>

    <!-- Status -->
    <div id="buttplug-status" class="llm-status" style="display:none;"></div>

    <style>
      .intimacy-section-header { margin: var(--sp-9) 0 var(--sp-4) 0; padding-bottom: var(--sp-3); border-bottom: 1px solid var(--c-border); }
      .intimacy-section-header:first-child { margin-top: 0; }
      .intimacy-section-title { margin: 0; font-size: 18px; font-weight: 700; color: var(--c-fg); }
      .intimacy-section-desc { margin: var(--sp-1) 0 0 0; font-size: var(--font-size-sm); color: var(--c-fg-muted); }
      /* Move the divider from above to below the Save buttons in the intimacy tab. */
      #connections-tab-intimacy .llm-actions { border-top: none; border-bottom: 1px solid var(--c-border); padding-bottom: var(--sp-4); }
      .buttplug-devices-grid { display: flex; flex-direction: column; gap: var(--sp-2); }
      .buttplug-device-card { background: var(--c-bg); border: 1px solid var(--c-border); border-radius: var(--radius-md); padding: var(--sp-3); display: flex; justify-content: space-between; align-items: center; }
      .buttplug-device-name { font-weight: 500; }
      .buttplug-device-caps { color: var(--c-fg-dim); font-size: 0.8rem; }
    </style>

    <script>
    function escapeHtml(str) {
      const div = document.createElement('div');
      div.textContent = str;
      return div.innerHTML;
    }

    function showButtplugStatus(type, message) {
      const el = document.getElementById('buttplug-status');
      if (!el) return;
      el.style.display = 'block';
      el.className = 'llm-status ' + type;
      el.textContent = message;
    }

    function saveButtplugSettings(e) {
      e.preventDefault();
      const enabled = document.getElementById('buttplug-enabled')?.checked ?? false;
      const websocketUrl = document.getElementById('buttplug-url')?.value?.trim() ?? 'ws://127.0.0.1:12345';
      const customInstructions = document.getElementById('buttplug-custom-instructions')?.value ?? '';

      const btn = e.currentTarget;
      btn.disabled = true;
      btn.textContent = 'Saving...';
      showButtplugStatus('loading', 'Saving settings...');

      fetch('/api/buttplug-settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled, websocketUrl, customInstructions }),
      })
        .then(r => r.json())
        .then(data => {
          if (data.success) {
            showButtplugStatus('success', 'Settings saved successfully.');
          } else {
            showButtplugStatus('error', data.error || 'Failed to save settings.');
          }
        })
        .catch(err => showButtplugStatus('error', 'Network error: ' + err.message))
        .finally(() => { btn.disabled = false; btn.textContent = 'Save Settings'; });
    }

    function testButtplugConnection() {
      const btn = document.getElementById('buttplug-test-btn');
      const statusEl = document.getElementById('buttplug-test-status');
      const devicesEl = document.getElementById('buttplug-devices-list');

      if (!btn || !statusEl || !devicesEl) return;
      btn.disabled = true;
      btn.textContent = 'Testing...';
      statusEl.style.display = 'block';
      statusEl.className = 'llm-status info';
      statusEl.textContent = 'Connecting to Intiface Central via backend...';
      devicesEl.style.display = 'none';

      const websocketUrl = document.getElementById('buttplug-url')?.value?.trim() ?? 'ws://127.0.0.1:12345';

      fetch('/api/buttplug-settings/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ websocketUrl }),
        signal: AbortSignal.timeout(15000),
      })
        .then(r => r.json())
        .then(data => {
          if (data.error) {
            statusEl.className = 'llm-status error';
            statusEl.textContent = data.error;
            btn.disabled = false;
            btn.textContent = 'Test Connection';
            return;
          }

          const devices = data.devices || [];
          const grid = devicesEl.querySelector('.buttplug-devices-grid');

          if (devices.length === 0) {
            statusEl.className = 'llm-status warning';
            statusEl.textContent = 'Connected, but no devices found. Ensure devices are paired in Intiface Central and powered on.';
            btn.disabled = false;
            btn.textContent = 'Test Connection';
            return;
          }

          statusEl.className = 'llm-status success';
          statusEl.textContent = 'Connected! Found ' + devices.length + ' device(s).';
          if (grid) {
            grid.innerHTML = devices.map(d => {
              const caps = (d.capabilities || []).join(', ') || 'none';
              return '<div class="buttplug-device-card">' +
                '<div><div class="buttplug-device-name">' + escapeHtml(d.name) + '</div>' +
                '<div class="buttplug-device-caps">Index: ' + d.index + ' &middot; Capabilities: ' + caps + '</div></div>' +
                '</div>';
            }).join('');
          }
          devicesEl.style.display = 'block';
          btn.disabled = false;
          btn.textContent = 'Test Connection';
        })
        .catch(err => {
          statusEl.className = 'llm-status error';
          statusEl.textContent = 'Connection failed. Is Intiface Central running? Error: ' + err.message;
          btn.disabled = false;
          btn.textContent = 'Test Connection';
        });
    }
    </script>
  `;
}

/**
 * Render Intimacy settings sub-page (standalone, with page chrome).
 */
export function renderButtplugSettings(
  settings: import("../llm/buttplug-settings.ts").ButtplugSettings,
): string {
  return `<div class="settings-view">
  <div class="settings-header">
    <div class="settings-header-row">
      ${renderSettingsBackButton()}
      <div>
        <h1 class="settings-title">Intimacy</h1>
        <p class="settings-desc">Configure universal device control via Intiface Central</p>
      </div>
    </div>
  </div>
  <div class="settings-content" id="settings-content">
    ${renderButtplugTab(settings)}
  </div>
</div>`;
}

/**
 * Render Lovense settings sub-page (standalone, with page chrome).
 */
export function renderLovenseSettings(
  settings: import("../llm/lovense-settings.ts").LovenseSettings,
): string {
  return `<div class="settings-view">
  <div class="settings-header">
    <div class="settings-header-row">
      ${renderSettingsBackButton()}
      <div>
        <h1 class="settings-title">Lovense</h1>
        <p class="settings-desc">Configure Lovense device control for the entity</p>
      </div>
    </div>
  </div>
  <div class="settings-content" id="settings-content">
    ${renderLovenseTab(settings)}
  </div>
</div>`;
}

/**
 * Render Home Automation settings sub-page (standalone, with page chrome).
 */
export function renderHomeSettings(
  settings: import("../llm/home-settings.ts").HomeSettings,
): string {
  return `<div class="settings-view">
  <div class="settings-header">
    <div class="settings-header-row">
      ${renderSettingsBackButton()}
      <div>
        <h1 class="settings-title">Home</h1>
        <p class="settings-desc">Configure smart home devices the entity can control</p>
      </div>
    </div>
  </div>
  <div class="settings-content" id="settings-content">
    ${renderHomeSettingsContent(settings)}
  </div>
</div>`;
}

/**
 * Render the inner Home tab/device management content (no page chrome).
 * Reused by both the tabbed view and the standalone sub-page.
 */
function renderHomeSettingsContent(
  settings: import("../llm/home-settings.ts").HomeSettings,
): string {
  const deviceRows = (settings.devices || []).map((d, i) => `
    <div class="home-device-row" data-index="${i}">
      <div class="home-device-info">
        <div class="home-device-name-row">
          <span class="home-device-power home-power-unknown" data-power-index="${i}" title="Power state unknown"></span>
          <span class="home-device-name">${escapeHtml(d.name)}</span>
        </div>
        <span class="home-device-meta">${escapeHtml(d.type)} &middot; ${
    escapeHtml(d.address)
  }</span>
      </div>
      <div class="home-device-actions">
        <button class="btn btn--sm home-on-btn" data-index="${i}" title="Turn on (manual override)">On</button>
        <button class="btn btn--sm home-off-btn" data-index="${i}" title="Turn off (manual override)">Off</button>
        <label class="toggle-label">
          <input type="checkbox" class="home-device-enabled" data-index="${i}" ${
    d.enabled ? "checked" : ""
  }>
          <span class="toggle-slider"></span>
        </label>
        <button class="btn btn--ghost btn--sm home-delete-btn" data-index="${i}" title="Remove device">Remove</button>
      </div>
    </div>
  `).join("");

  const hasDevices = (settings.devices || []).length > 0;

  return `
    ${
    hasDevices
      ? `
    <div id="home-device-list" class="home-device-list">
      ${deviceRows}
    </div>
    <p class="settings-note">After adding devices, also turn on the <code>control_device</code> tool in Settings > Tools.
    <br><strong>On/Off buttons</strong> are a manual safety override — they bypass the entity entirely.</p>
    `
      : `
    <div id="home-device-list" class="home-device-list" style="display:none;"></div>
    <p id="home-empty-msg" class="settings-note">No devices configured. Add one below to get started.</p>
    `
  }

    <section class="theme-section">
      <h3 class="theme-section-title">Add Device</h3>
      <div class="llm-fields">
        <div class="llm-field">
          <label for="home-device-name">Device Name</label>
          <input type="text" id="home-device-name" class="input-field llm-input" placeholder="e.g. Coffee Maker">
        </div>
        <div class="llm-field">
          <label for="home-device-type">Device Type</label>
          <select id="home-device-type" class="input-field llm-input">
            <option value="shelly-plug">Shelly Plug</option>
          </select>
        </div>
        <div class="llm-field">
          <label for="home-device-address">Address</label>
          <input type="text" id="home-device-address" class="input-field llm-input" placeholder="e.g. 192.168.1.100">
          <span class="field-hint">IP address or hostname of the device on your local network</span>
        </div>
      </div>
      <div class="llm-actions">
        <button class="btn btn--primary" onclick="addHomeDevice(event)">Add Device</button>
      </div>
    </section>

    <div class="llm-actions" id="home-save-section" style="${
    hasDevices ? "" : "display:none;"
  }">
      <button class="btn btn--primary" onclick="saveHomeSettings(event)">Save Settings</button>
    </div>

    <div id="home-status" class="llm-status" style="display:none;"></div>

  <style>
    .home-device-list { display: flex; flex-direction: column; gap: var(--sp-2); margin-bottom: var(--sp-4); }
    .home-device-row { display: flex; align-items: center; justify-content: space-between; padding: var(--sp-3); border-radius: 8px; border: 1px solid var(--c-border); background: var(--c-bg); }
    .home-device-info { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
    .home-device-name-row { display: flex; align-items: center; gap: 6px; }
    .home-device-name { font-weight: 600; font-size: 14px; color: var(--c-fg); }
    .home-device-meta { font-size: 12px; color: var(--c-fg-dim); }
    .home-device-actions { display: flex; align-items: center; gap: var(--sp-2); flex-shrink: 0; }
    .btn--sm { padding: 4px 10px; font-size: 12px; }
    .home-device-power { display: inline-block; width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
    .home-power-on { background: #22c55e; box-shadow: 0 0 4px #22c55e80; }
    .home-power-off { background: #6b7280; }
    .home-power-unknown { background: #eab308; opacity: 0.6; }
    .home-power-error { background: #ef4444; }
    .home-on-btn { background: var(--c-border); color: var(--c-fg); border: 1px solid var(--c-border); }
    .home-on-btn:hover { background: #22c55e20; border-color: #22c55e; color: #22c55e; }
    .home-off-btn { background: var(--c-border); color: var(--c-fg); border: 1px solid var(--c-border); }
    .home-off-btn:hover { background: #ef444420; border-color: #ef4444; color: #ef4444; }
  </style>

<script>
let homeDevices = ${JSON.stringify(settings.devices || [])};

function renderHomeDevices() {
  const list = document.getElementById('home-device-list');
  const emptyMsg = document.getElementById('home-empty-msg');
  const saveSection = document.getElementById('home-save-section');
  if (!list) return;

  if (homeDevices.length === 0) {
    list.style.display = 'none';
    if (emptyMsg) emptyMsg.style.display = '';
    if (saveSection) saveSection.style.display = 'none';
    return;
  }

  list.style.display = '';
  if (emptyMsg) emptyMsg.style.display = 'none';
  if (saveSection) saveSection.style.display = '';

  list.innerHTML = homeDevices.map((d, i) => \`
    <div class="home-device-row" data-index="\${i}">
      <div class="home-device-info">
        <div class="home-device-name-row">
          <span class="home-device-power home-power-unknown" data-power-index="\${i}" title="Power state unknown"></span>
          <span class="home-device-name">\${escapeHtml(d.name)}</span>
        </div>
        <span class="home-device-meta">\${escapeHtml(d.type)} &middot; \${escapeHtml(d.address)}</span>
      </div>
      <div class="home-device-actions">
        <button class="btn btn--sm home-on-btn" data-index="\${i}" onclick="controlHomeDevice(\${i}, 'on', event)" title="Turn on (manual override)">On</button>
        <button class="btn btn--sm home-off-btn" data-index="\${i}" onclick="controlHomeDevice(\${i}, 'off', event)" title="Turn off (manual override)">Off</button>
        <label class="toggle-label">
          <input type="checkbox" class="home-device-enabled" data-index="\${i}" \${d.enabled ? 'checked' : ''} onchange="toggleHomeDevice(\${i}, this.checked)">
          <span class="toggle-slider"></span>
        </label>
        <button class="btn btn--ghost btn--sm home-delete-btn" data-index="\${i}" onclick="deleteHomeDevice(\${i}, event)" title="Remove device">Remove</button>
      </div>
    </div>
  \`).join('');
  refreshAllDeviceStatus();
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function showHomeStatus(type, message) {
  const el = document.getElementById('home-status');
  if (!el) return;
  el.style.display = 'block';
  el.className = 'llm-status ' + type;
  el.textContent = message;
}

function setPowerIndicator(index, state) {
  const dot = document.querySelector('[data-power-index="' + index + '"]');
  if (!dot) return;
  dot.className = 'home-device-power';
  switch (state) {
    case 'on': dot.classList.add('home-power-on'); dot.title = 'Power: on'; break;
    case 'off': dot.classList.add('home-power-off'); dot.title = 'Power: off'; break;
    case 'error': dot.classList.add('home-power-error'); dot.title = 'Unreachable'; break;
    default: dot.classList.add('home-power-unknown'); dot.title = 'Power state unknown';
  }
}

async function controlHomeDevice(index, action, event) {
  const btn = event.currentTarget;
  const device = homeDevices[index];
  if (!device) return;

  btn.disabled = true;
  const origText = btn.textContent;
  btn.textContent = action === 'on' ? 'Turning on...' : 'Turning off...';
  showHomeStatus('loading', (action === 'on' ? 'Turning on' : 'Turning off') + ' ' + device.name + '...');

  try {
    const resp = await fetch('/api/home-device/control', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: device.name, action }),
    });
    const data = await resp.json();
    if (data.success) {
      const state = data.powerState || (action === 'on' ? 'on' : 'off');
      setPowerIndicator(index, state);
      showHomeStatus('success', device.name + ': ' + data.message);
    } else {
      setPowerIndicator(index, 'error');
      showHomeStatus('error', device.name + ': ' + (data.error || data.message));
    }
  } catch (e) {
    setPowerIndicator(index, 'error');
    showHomeStatus('error', 'Failed to control ' + device.name + ': ' + e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = origText;
  }
}

async function refreshDeviceStatus(index) {
  const device = homeDevices[index];
  if (!device) return;
  try {
    const resp = await fetch('/api/home-device/control', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: device.name, action: 'status' }),
    });
    const data = await resp.json();
    if (data.success) {
      const msg = data.message || '';
      if (msg.includes('power is on')) setPowerIndicator(index, 'on');
      else if (msg.includes('power is off')) setPowerIndicator(index, 'off');
      else setPowerIndicator(index, 'unknown');
    } else {
      setPowerIndicator(index, 'error');
    }
  } catch {
    setPowerIndicator(index, 'error');
  }
}

function refreshAllDeviceStatus() {
  homeDevices.forEach((_, i) => refreshDeviceStatus(i));
}

function addHomeDevice(event) {
  const name = document.getElementById('home-device-name')?.value.trim();
  const type = document.getElementById('home-device-type')?.value;
  const address = document.getElementById('home-device-address')?.value.trim();

  if (!name || !address) {
    showHomeStatus('error', 'Device name and address are required.');
    return;
  }

  homeDevices.push({ name, type: type || 'shelly-plug', address, enabled: true });
  document.getElementById('home-device-name').value = '';
  document.getElementById('home-device-address').value = '';
  renderHomeDevices();
  showHomeStatus('loading', 'Device added locally. Click Save Settings to persist.');
}

function toggleHomeDevice(index, enabled) {
  if (homeDevices[index]) {
    homeDevices[index].enabled = enabled;
  }
}

function deleteHomeDevice(index, event) {
  const btn = event.currentTarget;
  if (btn.dataset.pending === 'true') {
    homeDevices.splice(index, 1);
    renderHomeDevices();
    showHomeStatus('loading', 'Device removed locally. Click Save Settings to persist.');
    return;
  }
  btn.dataset.pending = 'true';
  btn.textContent = 'Confirm?';
  btn.classList.add('btn--danger');
  btn.classList.remove('btn--ghost');
  setTimeout(() => {
    if (btn.dataset.pending === 'true') {
      btn.dataset.pending = 'false';
      btn.textContent = 'Remove';
      btn.classList.remove('btn--danger');
      btn.classList.add('btn--ghost');
    }
  }, 3000);
}

async function testHomeDevice(index, event) {
  const device = homeDevices[index];
  if (!device) return;

  showHomeStatus('loading', 'Querying ' + device.name + '...');

  try {
    const resp = await fetch('/api/home-device/control', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: device.name, action: 'status' }),
    });
    const data = await resp.json();
    if (data.success) {
      const msg = data.message || '';
      if (msg.includes('power is on')) setPowerIndicator(index, 'on');
      else if (msg.includes('power is off')) setPowerIndicator(index, 'off');
      showHomeStatus('success', device.name + ': ' + data.message);
    } else {
      setPowerIndicator(index, 'error');
      showHomeStatus('error', device.name + ': ' + (data.error || data.message));
    }
  } catch (e) {
    setPowerIndicator(index, 'error');
    showHomeStatus('error', 'Could not reach ' + device.name + ': ' + e.message);
  }
}

async function saveHomeSettings(event) {
  const btn = event.currentTarget;
  btn.disabled = true;
  btn.textContent = 'Saving...';
  showHomeStatus('loading', 'Saving settings...');

  try {
    const resp = await fetch('/api/home-settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ devices: homeDevices }),
    });
    const data = await resp.json();
    if (data.success) {
      showHomeStatus('success', 'Settings saved. The control_device tool is now available.');
    } else {
      showHomeStatus('error', 'Failed to save: ' + (data.error || 'Unknown error'));
    }
  } catch (e) {
    showHomeStatus('error', 'Failed to save: ' + e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Save Settings';
  }
}

refreshAllDeviceStatus();
</script>`;
}

export function renderToolsSettings(
  settings: ToolsSettings,
  availableTools: Record<string, Tool>,
  customTools: Record<string, Tool>,
): string {
  const overrides = settings.toolOverrides;

  // Build category sections
  const categorySections = TOOL_CATEGORIES.map((cat) => {
    const tools = cat.toolNames
      .filter((name) => availableTools[name] && !DEPRECATED_TOOLS.has(name))
      .map((name) => {
        const tool = availableTools[name];
        const hasOverride = name in overrides;
        const enabled = hasOverride
          ? overrides[name]
          : !DEFAULT_DISABLED_TOOLS.has(name);
        return {
          name,
          description: tool.definition.function.description,
          enabled,
        };
      });
    return renderToolCategory(cat, tools);
  }).join("\n");

  // Build custom tools section
  const customNames = Object.keys(customTools);
  let customToolsListHtml: string;
  if (customNames.length > 0) {
    const customToolsHtml = customNames.map((name) => {
      const tool = customTools[name];
      const hasOverride = name in overrides;
      const enabled = hasOverride ? overrides[name] : true;
      const itemHtml = renderToolItem({
        name,
        description: tool.definition.function.description,
        enabled,
      });
      return `<div class="custom-tool-row" style="display:flex;align-items:flex-start;gap:var(--sp-2);">
  <div style="flex:1;min-width:0;">${itemHtml}</div>
  <button class="btn btn--xs" onclick="deleteCustomTool('${
        escapeHtml(name)
      }')" title="Delete tool" style="margin-top:4px;flex-shrink:0;background:var(--c-bg-hover,#333);border:1px solid var(--c-border,#555);color:var(--c-danger,#e74c3c);">
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <polyline points="3 6 5 6 21 6"/>
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
    </svg>
  </button>
</div>`;
    }).join("\n");
    customToolsListHtml = `<section class="tools-category" id="cat-custom">
  <div class="tools-category-header">
    <div>
      <h3 class="tools-category-title">Custom Tools</h3>
      <p class="tools-category-desc">User-written tools loaded from custom-tools/</p>
    </div>
    <div class="tools-category-actions">
      <button class="btn btn--ghost btn--xs" onclick="toggleCategoryTools('custom', true)">Enable All</button>
      <button class="btn btn--ghost btn--xs" onclick="toggleCategoryTools('custom', false)">Disable All</button>
    </div>
  </div>
  <div class="tools-list">
    ${customToolsHtml}
  </div>
</section>`;
  } else {
    customToolsListHtml = `<section class="tools-category" id="cat-custom">
  <div class="tools-category-header">
    <div>
      <h3 class="tools-category-title">Custom Tools</h3>
      <p class="tools-category-desc">No custom tools loaded yet.</p>
    </div>
  </div>
</section>`;
  }

  // Build tool params JSON for the JS to use
  const allToolParams: Record<string, Record<string, unknown>> = {};
  for (const [name, tool] of Object.entries(availableTools)) {
    allToolParams[name] = tool.definition.function.parameters as Record<
      string,
      unknown
    >;
  }
  for (const [name, tool] of Object.entries(customTools)) {
    allToolParams[name] = tool.definition.function.parameters as Record<
      string,
      unknown
    >;
  }

  return `<div class="settings-view">
  <div class="settings-header">
    <div class="settings-header-row">
      ${renderSettingsBackButton()}
      <div>
        <h1 class="settings-title">Tools</h1>
        <p class="settings-desc">Manage entity tools and add custom tools</p>
      </div>
    </div>
  </div>
  <div class="settings-content" id="settings-content">

    <!-- Actions -->
    <div class="tools-actions">
      <button class="btn btn--ghost btn--xs" onclick="toggleAllTools(true)">Enable All</button>
      <button class="btn btn--ghost btn--xs" onclick="toggleAllTools(false)">Disable All</button>
      <div style="flex:1"></div>
      <button class="btn btn--primary" onclick="saveToolsSettings(event)">Save Settings</button>
    </div>

    <!-- Tabs -->
    <nav class="tools-nav">
      <button class="tools-nav-tab active" data-tab="builtin" onclick="switchToolsTab('builtin')">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>
        </svg>
        Built-in
      </button>
      <button class="tools-nav-tab" data-tab="custom" onclick="switchToolsTab('custom')">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M12 3v18M3 12h18"/>
        </svg>
        Custom
      </button>
    </nav>

    <div id="tools-tab-builtin" class="tools-tab-panel">
      ${categorySections}
    </div>

    <div id="tools-tab-custom" class="tools-tab-panel" style="display:none;">
      <!-- Import -->
      <div class="tools-import">
        <label class="btn btn--ghost btn--xs" style="position:relative;overflow:hidden;cursor:pointer;">
          <input type="file" id="custom-tool-file" accept=".js" style="position:absolute;inset:0;opacity:0;cursor:pointer;" onchange="importCustomTool(this)" />
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="margin-right:4px">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
            <polyline points="17 8 12 3 7 8"/>
            <line x1="12" y1="3" x2="12" y2="15"/>
          </svg>
          Import Tool
        </label>
        <span class="tools-import-hint">Upload a .js file to add a custom tool</span>
      </div>

      ${customToolsListHtml}
    </div>

    <!-- Status -->
    <div id="tools-status" class="llm-status" style="display:none;"></div>

  </div>

  <style>
    .tools-nav { display: flex; gap: var(--sp-2); margin-bottom: var(--sp-4); border-bottom: 1px solid var(--c-border); padding-bottom: var(--sp-2); }
    .tools-nav-tab { display: flex; align-items: center; gap: var(--sp-2); padding: var(--sp-2) var(--sp-3); background: none; border: 1px solid transparent; border-radius: var(--radius-sm); color: var(--c-fg-muted); font-size: var(--font-size-sm); cursor: pointer; transition: color var(--transition), background var(--transition), border-color var(--transition); }
    .tools-nav-tab:hover { color: var(--c-fg); background: var(--c-bg-hover); }
    .tools-nav-tab:active { transform: scale(0.98); }
    .tools-nav-tab.active { color: var(--c-accent); background: var(--c-accent-subtle); border-color: var(--c-accent); }
    .tools-import { display: flex; align-items: center; gap: var(--sp-3); margin-bottom: var(--sp-4); padding: var(--sp-3); border-radius: var(--radius-sm); border: 1px dashed var(--c-border); }
    .tools-import-hint { font-size: var(--font-size-xs); color: var(--c-fg-muted); }
  </style>

<script>
// Tool parameters data embedded for detail view
const TOOL_PARAMS = ${JSON.stringify(allToolParams)};

function showToolsStatus(type, message) {
  const el = document.getElementById('tools-status');
  if (!el) return;
  el.style.display = 'block';
  el.className = 'llm-status ' + type;
  el.textContent = message;
  clearTimeout(el._hideTimer);
  el._hideTimer = setTimeout(() => { el.style.display = 'none'; }, 3000);
}

function switchToolsTab(tab) {
  document.querySelectorAll('.tools-nav-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
  document.querySelectorAll('.tools-tab-panel').forEach(p => p.style.display = p.id === 'tools-tab-' + tab ? '' : 'none');
}

function refreshCustomToolsList() {
  fetch('/api/custom-tools/list')
    .then(r => r.text())
    .then(html => {
      const el = document.getElementById('cat-custom');
      if (el) el.outerHTML = html;
    });
}

function toggleToolDetail(name) {
  const detail = document.getElementById('detail-' + name);
  if (!detail) return;
  const visible = detail.style.display !== 'none';
  detail.style.display = visible ? 'none' : 'block';
  if (!visible) {
    const paramsEl = document.getElementById('params-' + name);
    if (paramsEl && !paramsEl.hasChildNodes() && TOOL_PARAMS[name]) {
      const pre = document.createElement('pre');
      pre.className = 'tool-detail-json';
      pre.textContent = JSON.stringify(TOOL_PARAMS[name], null, 2);
      paramsEl.appendChild(pre);
    }
  }
}

function toggleCategoryTools(catId, enable) {
  const cat = document.getElementById('cat-' + catId);
  if (!cat) return;
  cat.querySelectorAll('input[data-tool-name]').forEach(cb => {
    cb.checked = enable;
  });
}

function toggleAllTools(enable) {
  document.querySelectorAll('input[data-tool-name]').forEach(cb => {
    cb.checked = enable;
  });
}

function gatherOverrides() {
  const overrides = {};
  document.querySelectorAll('input[data-tool-name]').forEach(cb => {
    overrides[cb.dataset.toolName] = cb.checked;
  });
  return overrides;
}

async function importCustomTool(input) {
  const file = input.files[0];
  if (!file) return;
  showToolsStatus('loading', 'Importing ' + file.name + '...');

  try {
    const formData = new FormData();
    formData.append('tool', file);
    const resp = await fetch('/api/custom-tools/upload', { method: 'POST', body: formData });
    const data = await resp.json();
    if (data.success) {
      showToolsStatus('success', 'Imported tool: ' + data.toolName);
      refreshCustomToolsList();
    } else {
      showToolsStatus('error', 'Import failed: ' + (data.error || 'Unknown error'));
    }
  } catch (e) {
    showToolsStatus('error', 'Import failed: ' + e.message);
  }
  input.value = '';
}

async function deleteCustomTool(name) {
  if (!confirm('Delete the custom tool "' + name + '"? This cannot be undone.')) return;
  showToolsStatus('loading', 'Deleting ' + name + '...');
  try {
    const resp = await fetch('/api/custom-tools/' + encodeURIComponent(name), { method: 'DELETE' });
    const data = await resp.json();
    if (data.success) {
      showToolsStatus('success', 'Deleted ' + name);
      refreshCustomToolsList();
    } else {
      showToolsStatus('error', 'Delete failed: ' + (data.error || 'Unknown error'));
    }
  } catch (e) {
    showToolsStatus('error', 'Delete failed: ' + e.message);
  }
}

async function saveToolsSettings(event) {
  const btn = event.currentTarget;
  btn.disabled = true;
  btn.textContent = 'Saving...';
  showToolsStatus('loading', 'Saving settings...');

  try {
    const overrides = gatherOverrides();
    const resp = await fetch('/api/tools-settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ toolOverrides: overrides }),
    });
    const data = await resp.json();
    if (data.success) {
      showToolsStatus('success', 'Settings saved. Tool registry reloaded.');
    } else {
      showToolsStatus('error', 'Failed to save: ' + (data.error || 'Unknown error'));
    }
  } catch (e) {
    showToolsStatus('error', 'Failed to save: ' + e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Save Settings';
  }
}
</script>
</div>`;
}

// =============================================================================
// Web Search Settings Template
// =============================================================================

// =============================================================================
// Consolidation Tab Templates
// =============================================================================

interface ConsolidationStatus {
  weekly: boolean;
  monthly: boolean;
  yearly: boolean;
}

/**
 * Render the consolidation catch-up tab with status rows and run button.
 */
export function renderConsolidationTab(status: ConsolidationStatus): string {
  const oobTabs = renderMemoryTabActiveState("consolidation");
  const anyNeeded = status.weekly || status.monthly || status.yearly;

  const rows = ([
    { key: "weekly", label: "Weekly", needed: status.weekly },
    { key: "monthly", label: "Monthly", needed: status.monthly },
    { key: "yearly", label: "Yearly", needed: status.yearly },
  ] as const).map(({ key: _key, label, needed }) => `
    <div class="consolidation-row">
      <span class="consolidation-row-label">${label}</span>
      <span class="consolidation-row-status ${
    needed ? "consolidation-needed" : "consolidation-up-to-date"
  }">${needed ? "Needs catch-up" : "Up to date"}</span>
    </div>
  `).join("");

  let actionHtml = "";
  if (anyNeeded) {
    actionHtml = `<button
      class="btn btn--primary"
      id="run-consolidation-btn"
      hx-post="/api/memories/consolidation/run"
      hx-target="#consolidation-content"
      hx-swap="outerHTML"
    >Run Catch-up</button>`;
  } else {
    actionHtml =
      `<div class="consolidation-all-clear">All consolidation levels are up to date.</div>`;
  }

  return `${oobTabs}
<div id="consolidation-content">
  <div class="consolidation-section">
    <h2 class="consolidation-heading">Consolidation Status</h2>
    <div class="consolidation-status-list">
      ${rows}
    </div>
    <div class="consolidation-actions">
      ${actionHtml}
    </div>
  </div>
</div>`;
}

/**
 * Render the running state shown immediately after the user clicks Run Catch-up.
 */
export function renderConsolidationRunning(): string {
  const oobTabs = renderMemoryTabActiveState("consolidation");

  return `${oobTabs}
<div id="consolidation-content">
  <div class="consolidation-section">
    <h2 class="consolidation-heading">Consolidation Status</h2>
    <div class="consolidation-running">
      <span class="consolidation-spinner"></span>
      Running catch-up consolidation...
    </div>
    <div id="consolidation-results"></div>
  </div>
</div>`;
}

/**
 * Render the completed state broadcast via SSE when consolidation finishes.
 */
export function renderConsolidationComplete(
  results: { granularity: string; success: boolean; error?: string }[],
): string {
  const oobTabs = renderMemoryTabActiveState("consolidation");

  const successCount = results.filter((r) => r.success).length;
  const failCount = results.filter((r) => !r.success).length;

  const summaryParts: string[] = [];
  if (successCount > 0) summaryParts.push(`${successCount} succeeded`);
  if (failCount > 0) summaryParts.push(`${failCount} failed`);

  const itemsHtml = results.map((r) => {
    const cls = r.success
      ? "consolidation-result-success"
      : "consolidation-result-failure";
    const text = r.success
      ? `${r.granularity}: created`
      : `${r.granularity}: ${escapeHtml(r.error || "failed")}`;
    return `<div class="consolidation-result-item ${cls}">${
      escapeHtml(text)
    }</div>`;
  }).join("");

  return `${oobTabs}
<div id="consolidation-content">
  <div class="consolidation-section">
    <h2 class="consolidation-heading">Consolidation Status</h2>
    <div class="consolidation-summary">${summaryParts.join(", ")}</div>
    ${
    itemsHtml
      ? `<div class="consolidation-results-list">${itemsHtml}</div>`
      : ""
  }
    <div class="consolidation-actions">
      <button
        class="btn btn--ghost btn--sm"
        hx-get="/fragments/settings/memories/consolidation"
        hx-target="#consolidation-content"
        hx-swap="outerHTML"
      >Refresh Status</button>
    </div>
  </div>
</div>`;
}

// =============================================================================
// Memory Instructions Tab Template
// =============================================================================

/**
 * Render the custom daily memory-writing instructions tab.
 *
 * The entity follows these instructions when writing daily memories.
 * Written from the entity's first-person perspective.
 */
export function renderInstructionsTab(dailyInstructions: string): string {
  const oobTabs = renderMemoryTabActiveState("instructions");

  return `${oobTabs}
<div id="instructions-content">
  <div class="consolidation-section">
    <h1 class="settings-title">Custom Daily Memory Instructions</h1>
    <p class="settings-note" style="margin-bottom:1rem;">
      Additional instructions for the Daily Memory writer. Write in the first person from the entity's perspective, such as "I do not include vitamin reminders in my daily memories" or "When writing daily memories, I name specific songs or artists that came up".
    </p>
    <form
      class="settings-editor-form"
      hx-post="/api/memories/instructions"
      hx-target="#instructions-save-status"
      hx-swap="innerHTML"
    >
      <div class="llm-field">
        <textarea
          class="settings-textarea"
          name="dailyInstructions"
          rows="8"
          placeholder="e.g. I do not include vitamin reminders in my daily memories. I always mention how I felt about creative projects. When I remember conversations about music, I name specific songs or artists that came up."
        >${escapeHtml(dailyInstructions)}</textarea>
      </div>
      <div class="consolidation-actions" style="margin-top:1rem;">
        <button class="btn btn--primary" type="submit">
          Save Instructions
        </button>
        <span id="instructions-save-status"></span>
      </div>
    </form>
  </div>
</div>`;
}

// =============================================================================
// Vision Settings Templates
// =============================================================================

type ImageGenConfig = import("../llm/image-gen-settings.ts").ImageGenConfig;
type ImageGenSettings = import("../llm/image-gen-settings.ts").ImageGenSettings;

/**
 * Render the Vision settings page with Generators and Anchors tabs.
 */
export function renderVisionSettings(
  _settings: ImageGenSettings,
): string {
  return `<div class="settings-view">
  <div class="settings-header">
    <div class="settings-header-row">
      ${renderSettingsBackButton()}
      <div>
        <h1 class="settings-title">Vision</h1>
        <p class="settings-desc">Image generation, captioning, and visual references</p>
      </div>
    </div>
  </div>
  ${renderVisionTabs("generators")}
  <div class="settings-content" id="settings-content"
    hx-get="/fragments/settings/vision/generators"
    hx-trigger="load"
    hx-swap="innerHTML">
    <div class="settings-loading">Loading...</div>
  </div>
</div>`;
}

/**
 * Render the Vision tab bar with active state.
 */
function renderVisionTabs(activeTab: string): string {
  const tabs = [
    { id: "generators", label: "Generators" },
    { id: "anchors", label: "Anchors" },
    { id: "gallery", label: "Gallery" },
  ];

  return `<div class="settings-tabs">
    ${
    tabs.map((tab) =>
      `<button
        class="settings-tab${tab.id === activeTab ? " active" : ""}"
        hx-get="/fragments/settings/vision/${tab.id}"
        hx-target="#settings-content"
        hx-swap="innerHTML"
        id="visiontab-${tab.id}"
      >${tab.label}</button>`
    ).join("")
  }
  </div>`;
}

/**
 * Render the active tab indicator for vision tabs as an OOB swap.
 */
function renderVisionTabActiveState(activeTab: string): string {
  const tabs = ["generators", "anchors", "gallery"];
  return tabs.map((tab) =>
    `<button
      class="settings-tab${tab === activeTab ? " active" : ""}"
      hx-get="/fragments/settings/vision/${tab}"
      hx-target="#settings-content"
      hx-swap="innerHTML"
      hx-swap-oob="true"
      id="visiontab-${tab}"
    >${tab.charAt(0).toUpperCase() + tab.slice(1)}</button>`
  ).join("");
}

/**
 * Render the Generators tab panel — generator cards + add button + captioning config.
 */
export function renderVisionGeneratorsTab(settings: ImageGenSettings): string {
  const cards = settings.generators.map((g) => `
    <a class="settings-hub-card"
      hx-get="/fragments/settings/vision/image-gen/${escapeHtml(g.id)}"
      hx-target="#chat"
      hx-swap="innerHTML">
      <div class="settings-hub-card-icon">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
          <circle cx="8.5" cy="8.5" r="1.5"/>
          <polyline points="21 15 16 10 5 21"/>
        </svg>
      </div>
      <div class="settings-hub-card-body">
        <span class="settings-hub-card-title">${escapeHtml(g.name)}</span>
        <span class="settings-hub-card-desc">${
    g.enabled
      ? escapeHtml(g.provider) + " — Enabled"
      : escapeHtml(g.provider) + " — Disabled"
  }</span>
      </div>
      <svg class="settings-hub-card-arrow" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <polyline points="9 18 15 12 9 6"/>
      </svg>
    </a>`).join("");

  const addCard = `
    <button class="settings-hub-card settings-hub-card-add"
      hx-get="/fragments/settings/vision/image-gen/new"
      hx-target="#chat"
      hx-swap="innerHTML">
      <div class="settings-hub-card-icon">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <line x1="12" y1="5" x2="12" y2="19"/>
          <line x1="5" y1="12" x2="19" y2="12"/>
        </svg>
      </div>
      <div class="settings-hub-card-body">
        <span class="settings-hub-card-title">Add Generator</span>
        <span class="settings-hub-card-desc">Configure a new image generation provider</span>
      </div>
    </button>`;

  const oobTabs = renderVisionTabActiveState("generators");

  return `${oobTabs}
  <section>
    <h3 style="font-size:var(--font-size-sm);color:var(--c-fg-muted);margin-bottom:var(--sp-3);">Image Generators</h3>
    <div class="settings-hub-grid">
      ${cards}
      ${addCard}
    </div>
  </section>
  ${renderVisionCaptioningSection(settings.captioning)}`;
}

/**
 * Render the captioning config section (inline, no page wrapper).
 */
function renderVisionCaptioningSection(
  captioning:
    | import("../llm/image-gen-settings.ts").CaptioningSettings
    | undefined,
): string {
  const c = captioning || {
    enabled: false,
    provider: "gemini" as const,
    gemini: { apiKey: "", model: "gemini-2.0-flash" },
  };
  const provider = c.provider || "gemini";

  return `<section class="theme-section" style="margin-top:var(--sp-6);padding-top:var(--sp-4);border-top:1px solid var(--c-border);">
    <h3 style="font-size:var(--font-size-sm);color:var(--c-fg-muted);margin-bottom:var(--sp-3);">Captioning</h3>
    <div class="llm-fields">
      <div class="llm-field">
        <label class="toggle-label">
          <input type="checkbox" id="cap-enabled" role="switch" aria-label="Auto-caption chat attachments" ${
    c.enabled ? "checked" : ""
  }>
          <span class="toggle-slider"></span>
          <span class="toggle-text">Auto-caption chat attachments</span>
        </label>
        <p class="settings-note">When enabled, images attached to chat messages are automatically described before sending to the entity. The description is included in the message context.</p>
      </div>

      <div class="llm-field">
        <label for="cap-provider">Provider</label>
        <select id="cap-provider" class="input-field llm-input" onchange="toggleCaptioningProvider()">
          <option value="gemini" ${
    provider === "gemini" ? "selected" : ""
  }>Google AI Studio</option>
          <option value="openrouter" ${
    provider === "openrouter" ? "selected" : ""
  }>OpenRouter</option>
        </select>
      </div>

      <div id="cap-gemini-section" style="${
    provider === "gemini" ? "" : "display:none;"
  }">
        <div class="llm-field">
          <label for="cap-gemini-key">API Key</label>
          <input type="password" id="cap-gemini-key" class="input-field llm-input" value="${
    escapeHtml(c.gemini?.apiKey || "")
  }" placeholder="AIza...">
        </div>
        <div class="llm-field">
          <label for="cap-gemini-model">Model</label>
          <select id="cap-gemini-model" class="input-field llm-input">
            <option value="gemini-2.5-flash" ${
    (c.gemini?.model || "") === "gemini-2.5-flash" ? "selected" : ""
  }>gemini-2.5-flash</option>
            <option value="gemini-2.5-flash-lite" ${
    (c.gemini?.model || "") === "gemini-2.5-flash-lite" ? "selected" : ""
  }>gemini-2.5-flash-lite</option>
            <option value="gemini-2.5-pro" ${
    (c.gemini?.model || "") === "gemini-2.5-pro" ? "selected" : ""
  }>gemini-2.5-pro</option>
            <option value="gemini-3-flash-preview" ${
    (c.gemini?.model || "") === "gemini-3-flash-preview" ? "selected" : ""
  }>gemini-3-flash-preview</option>
          </select>
        </div>
      </div>

      <div id="cap-openrouter-section" style="${
    provider === "openrouter" ? "" : "display:none;"
  }">
        <div class="llm-field">
          <label for="cap-or-key">API Key</label>
          <input type="password" id="cap-or-key" class="input-field llm-input" value="${
    escapeHtml(c.openrouter?.apiKey || "")
  }" placeholder="sk-or-...">
        </div>
        <div class="llm-field">
          <label for="cap-or-model">Model</label>
          <input type="text" id="cap-or-model" class="input-field llm-input" value="${
    escapeHtml(c.openrouter?.model || "")
  }" placeholder="google/gemini-2.0-flash-001">
        </div>
        <div class="llm-field">
          <label for="cap-or-baseurl">Base URL</label>
          <input type="text" id="cap-or-baseurl" class="input-field llm-input" value="${
    escapeHtml(c.openrouter?.baseUrl || "")
  }" placeholder="https://openrouter.ai/api/v1 (default)">
        </div>
      </div>

      <div class="llm-field" style="display:flex;gap:var(--sp-3);margin-top:var(--sp-4);">
        <button class="btn btn--primary" onclick="saveCaptioning()">Save</button>
      </div>
    </div>
  </section>

<script>
function toggleCaptioningProvider() {
  const provider = document.getElementById('cap-provider').value;
  document.getElementById('cap-gemini-section').style.display = provider === 'gemini' ? '' : 'none';
  document.getElementById('cap-openrouter-section').style.display = provider === 'openrouter' ? '' : 'none';
}

async function saveCaptioning() {
  const provider = document.getElementById('cap-provider').value;
  const enabled = document.getElementById('cap-enabled').checked;
  let gemini, openrouter;

  if (provider === 'gemini') {
    gemini = {
      apiKey: document.getElementById('cap-gemini-key').value,
      model: document.getElementById('cap-gemini-model').value,
    };
  } else {
    openrouter = {
      apiKey: document.getElementById('cap-or-key').value,
      model: document.getElementById('cap-or-model').value,
      baseUrl: document.getElementById('cap-or-baseurl').value,
    };
  }

  try {
    await fetch('/api/image-gen-settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ captioning: { enabled, provider, gemini, openrouter } }),
    });
    htmx.ajax('GET', '/fragments/settings/vision', '#chat');
  } catch (e) {
    console.error('Failed to save captioning settings:', e);
  }
}
</script>`;
}

/**
 * Render the Anchors tab panel content (inline, no page wrapper).
 */
export function renderVisionAnchorsTab(
  anchors: Array<
    {
      id: string;
      label: string;
      description: string;
      filename: string;
      file_size: number;
      created_at: string;
    }
  >,
): string {
  const rows = anchors.map((a) => `
    <div class="anchor-card" id="anchor-${escapeHtml(a.id)}">
      <img src="/anchors/${escapeHtml(a.filename)}" class="anchor-thumb" alt="${
    escapeHtml(a.label)
  }" loading="lazy"/>
      <div class="anchor-info">
        <input type="text" class="input-field anchor-label" value="${
    escapeHtml(a.label)
  }" placeholder="Label" style="font-size:var(--font-size-sm);padding:var(--sp-1) var(--sp-2);margin-bottom:var(--sp-1);">
        <input type="text" class="input-field anchor-desc" value="${
    escapeHtml(a.description)
  }" placeholder="Description" style="font-size:var(--font-size-xs);padding:var(--sp-1) var(--sp-2);color:var(--c-fg-muted);">
        <div class="anchor-meta">${(a.file_size / 1024).toFixed(1)} KB</div>
      </div>
      <div class="anchor-actions">
        <button class="btn btn--sm btn--primary" onclick="saveAnchorMeta('${
    escapeHtml(a.id)
  }')">Save</button>
        <button class="btn btn--sm btn--danger" onclick="deleteAnchor('${
    escapeHtml(a.id)
  }')">Delete</button>
      </div>
    </div>`).join("");

  const oobTabs = renderVisionTabActiveState("anchors");

  return `${oobTabs}
  <style>
    .anchor-list { display: flex; flex-direction: column; gap: var(--sp-3); }
    .anchor-card { display: flex; align-items: center; gap: var(--sp-3); padding: var(--sp-3); border: 1px solid var(--c-border); border-radius: var(--radius-md); background: var(--c-bg); }
    .anchor-thumb { width: 64px; height: 64px; object-fit: cover; border-radius: var(--radius-sm); }
    .anchor-info { flex: 1; }
    .anchor-meta { font-size: var(--font-size-xs); color: var(--c-fg-muted); margin-top: var(--sp-1); }
    .anchor-actions { display: flex; gap: var(--sp-2); }
  </style>
  <section class="theme-section">
    <div class="anchor-list" id="anchor-list">
      ${
    rows ||
    '<p class="settings-note">No anchor images yet. Upload one below.</p>'
  }
    </div>
  </section>

  <section class="theme-section" style="margin-top:var(--sp-4);">
    <h3 style="font-size:var(--font-size-sm);color:var(--c-fg-muted);">Upload Anchor Image</h3>
    <form id="anchor-upload-form" style="display:flex;gap:var(--sp-3);align-items:end;flex-wrap:wrap;">
      <div class="llm-field" style="flex:0 0 auto;">
        <label>File</label>
        <label class="btn btn--sm" style="position:relative;overflow:hidden;cursor:pointer;">
          Choose File
          <input type="file" id="anchor-file" accept="image/*" style="position:absolute;inset:0;opacity:0;cursor:pointer;" onchange="document.getElementById('anchor-file-name').textContent = this.files[0]?.name || ''" />
        </label>
        <span id="anchor-file-name" class="anchor-meta"></span>
      </div>
      <div class="llm-field" style="flex:1;min-width:150px;">
        <label for="anchor-label">Label</label>
        <input type="text" id="anchor-label" class="input-field llm-input" placeholder="Character name or style tag">
      </div>
      <div class="llm-field" style="flex:2;min-width:200px;">
        <label for="anchor-upload-desc">Description</label>
        <input type="text" id="anchor-upload-desc" class="input-field llm-input" placeholder="Brief description for context">
      </div>
      <button type="button" class="btn btn--primary" style="align-self:end;" onclick="handleAnchorUpload()">Upload</button>
    </form>
  </section>

<script>
async function saveAnchorMeta(id) {
  const card = document.getElementById('anchor-' + id);
  if (!card) return;
  const label = card.querySelector('.anchor-label').value;
  const description = card.querySelector('.anchor-desc').value;
  await fetch('/api/anchor-images/' + id, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ label, description }) });
  htmx.ajax('GET', '/fragments/settings/vision/anchors', '#settings-content');
}

async function deleteAnchor(id) {
  if (!confirm('Delete this anchor image?')) return;
  await fetch('/api/anchor-images/' + id, { method: 'DELETE' });
  htmx.ajax('GET', '/fragments/settings/vision/anchors', '#settings-content');
}

async function handleAnchorUpload() {
  const fileInput = document.getElementById('anchor-file');
  const label = document.getElementById('anchor-label').value;
  const description = document.getElementById('anchor-upload-desc').value;
  if (!fileInput.files.length) { alert('Choose a file first.'); return; }
  const form = new FormData();
  form.append('file', fileInput.files[0]);
  form.append('label', label);
  form.append('description', description);
  await fetch('/api/anchor-images', { method: 'POST', body: form });
  htmx.ajax('GET', '/fragments/settings/vision/anchors', '#settings-content');
}
</script>`;
}

/**
 * Render the Gallery tab content (loaded via HTMX fragment).
 * Images are rendered server-side; load-more, lightbox, and copy are client-side.
 */
export function renderVisionGalleryTab(data: {
  totalSize: number;
  generatedCount: number;
  userCount: number;
  total: number;
  hasMore: boolean;
  images: Array<{
    filename: string;
    url: string;
    category: string;
    size: number;
    createdAt: string;
    prompt?: string;
  }>;
}): string {
  const oobTabs = renderVisionTabActiveState("gallery");

  const totalMB = (data.totalSize / (1024 * 1024)).toFixed(1);
  const totalKB = (data.totalSize / 1024).toFixed(1);
  const sizeStr = data.totalSize >= 1024 * 1024
    ? totalMB + " MB"
    : totalKB + " KB";

  let cardsHtml = "";
  if (data.images.length > 0) {
    cardsHtml = data.images.map((img) => {
      const sizeStr = img.size >= 1024 * 1024
        ? (img.size / (1024 * 1024)).toFixed(1) + " MB"
        : (img.size / 1024).toFixed(1) + " KB";
      const dateStr = img.createdAt
        ? new Date(img.createdAt).toLocaleDateString(undefined, {
          month: "short",
          day: "numeric",
          year: "numeric",
        })
        : "";
      const shortName = img.filename.length > 20
        ? img.filename.substring(0, 8) + "..." + img.filename.slice(-8)
        : img.filename;
      const promptAttr = img.prompt ? ` title="${escapeHtml(img.prompt)}"` : "";
      const escapedUrl = escapeHtml(img.url);
      const thumbUrl = img.url.replace(
        /^\/(generated-images|chat-attachments)\//,
        "/$1/thumbs/",
      ) + ".webp";
      const escapedThumb = escapeHtml(thumbUrl);
      const escapedFilename = escapeHtml(img.filename);
      const categoryLabel = img.category === "generated"
        ? "generated"
        : "uploaded";
      const categoryClass = img.category === "generated"
        ? "gallery-badge--generated"
        : "gallery-badge--user";
      return `<div class="gallery-card" data-category="${
        escapeHtml(img.category)
      }"${promptAttr}>
      <div class="gallery-thumb-wrap">
        <img src="${escapedThumb}" class="gallery-thumb" loading="lazy" onclick="openLightbox('${escapedUrl}','${escapedFilename}')"/>
        <span class="gallery-badge ${categoryClass}">${categoryLabel}</span>
      </div>
      <div class="gallery-meta">
      <span class="gallery-filename" title="${escapedFilename}">${
        escapeHtml(shortName)
      }</span>
      <button class="gallery-copy-btn" onclick="event.stopPropagation();copyFilename('${escapedFilename}',this)" title="Copy filename">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
      </button>
      </div>
      <div class="gallery-info">${sizeStr} &middot; ${dateStr}</div>
      </div>`;
    }).join("");
  }

  const loadMoreHtml = data.hasMore
    ? '<div class="gallery-load-more"><button class="btn btn--sm" onclick="loadMoreGallery()">Load more</button></div>'
    : "";

  const galleryContent = data.images.length === 0
    ? '<div class="gallery-empty">No images yet</div>'
    : `<div class="gallery-grid">${cardsHtml}</div>${loadMoreHtml}`;

  return `${oobTabs}
  <style>
    .gallery-stats { display: flex; gap: var(--sp-4); padding: var(--sp-3) var(--sp-4); background: var(--c-bg-hover); border-radius: var(--radius-md); margin-bottom: var(--sp-4); font-size: var(--font-size-sm); color: var(--c-fg-muted); flex-wrap: wrap; }
    .gallery-stats strong { color: var(--c-fg); }
    .gallery-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: var(--sp-3); }
    .gallery-card { border: 1px solid var(--c-border); border-radius: var(--radius-md); overflow: hidden; background: var(--c-bg); transition: border-color var(--transition); }
    .gallery-card:hover { border-color: var(--c-accent); }
    .gallery-thumb-wrap { position: relative; }
    .gallery-thumb { width: 100%; aspect-ratio: 1; object-fit: cover; cursor: pointer; display: block; }
    .gallery-badge { position: absolute; top: 6px; left: 6px; font-size: 10px; font-weight: 500; padding: 1px 6px; border-radius: var(--radius-sm); pointer-events: none; text-transform: uppercase; letter-spacing: 0.3px; }
    .gallery-badge--generated { background: rgba(0,0,0,0.65); color: #fff; }
    .gallery-badge--user { background: rgba(255,255,255,0.85); color: #333; }
    .gallery-meta { padding: var(--sp-2); display: flex; align-items: center; gap: var(--sp-1); }
    .gallery-filename { font-family: var(--font-mono, monospace); font-size: 11px; color: var(--c-fg-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; min-width: 0; cursor: default; }
    .gallery-copy-btn { flex-shrink: 0; background: none; border: none; color: var(--c-fg-muted); cursor: pointer; padding: 2px; border-radius: var(--radius-sm); display: flex; align-items: center; justify-content: center; transition: color var(--transition); }
    .gallery-copy-btn:hover { color: var(--c-accent); }
    .gallery-copy-btn.copied { color: var(--c-accent); }
    .gallery-info { padding: 0 var(--sp-2) var(--sp-2); font-size: var(--font-size-xs); color: var(--c-fg-muted); }
    .gallery-empty { color: var(--c-fg-muted); font-size: var(--font-size-sm); text-align: center; padding: var(--sp-8) 0; }
    .gallery-load-more { margin-top: var(--sp-4); text-align: center; }
    .gallery-lightbox { position: fixed; inset: 0; z-index: 9999; background: rgba(0,0,0,0.85); display: flex; align-items: center; justify-content: center; flex-direction: column; gap: var(--sp-3); cursor: pointer; }
    .gallery-lightbox img { max-width: 90vw; max-height: 85vh; object-fit: contain; border-radius: var(--radius-sm); cursor: default; }
    @media (max-width: 768px) {
      .gallery-lightbox img { max-width: 100vw; max-height: 80vh; border-radius: 0; }
      .gallery-lightbox-close { top: 8px; right: 8px; width: 40px; height: 40px; }
      .gallery-lightbox-info { padding: 0 12px; }
    }
    .gallery-lightbox-info { color: #ccc; font-size: var(--font-size-sm); font-family: var(--font-mono, monospace); text-align: center; max-width: 90vw; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .gallery-lightbox-close { position: absolute; top: var(--sp-4); right: var(--sp-4); background: rgba(255,255,255,0.1); border: none; color: #fff; width: 36px; height: 36px; border-radius: 50%; cursor: pointer; font-size: 18px; display: flex; align-items: center; justify-content: center; }
    .gallery-lightbox-close:hover { background: rgba(255,255,255,0.2); }
  </style>

<div id="gallery-container" data-gallery-offset="${data.images.length}">
  <div class="gallery-stats">
    <span><strong>${data.total}</strong> images</span>
    <span><strong>${sizeStr}</strong> total</span>
    <span><strong>${data.generatedCount}</strong> generated</span>
    <span><strong>${data.userCount}</strong> uploaded</span>
  </div>
  ${galleryContent}
</div>`;
}

/**
 * Render a single generator config form.
 */
export function renderImageGenSlotSettings(
  generator: ImageGenConfig | undefined,
  id: string,
): string {
  const isNew = !generator;
  const g = generator || {
    id,
    name: "",
    description: "",
    enabled: false,
    nsfw: false,
    provider: "openrouter" as const,
    settings: {
      params: { width: 1024, height: 1024, steps: 30, negative_prompt: "" },
    },
  };
  const orSettings = g.settings.openrouter;
  const veniceSettings = g.settings.venice;
  const nanogptSettings = g.settings.nanogpt;

  return `<div class="settings-view">
  <div class="settings-header">
    <div class="settings-header-row">
      <a class="settings-back-btn"
        hx-get="/fragments/settings/vision"
        hx-target="#chat"
        hx-swap="innerHTML">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="15 18 9 12 15 6"/>
        </svg>
        <span>Vision</span>
      </a>
      <div>
        <h1 class="settings-title">${
    isNew ? "New Generator" : escapeHtml(g.name)
  }</h1>
        <p class="settings-desc">Configure image generation provider settings</p>
      </div>
    </div>
  </div>
  <div class="settings-content" id="settings-content">

    <section class="theme-section">
      <div class="llm-fields">
        <div class="llm-field">
          <label for="ig-name">Name</label>
          <input type="text" id="ig-name" class="input-field llm-input" value="${
    escapeHtml(g.name)
  }" placeholder="My Image Generator">
        </div>
        <div class="llm-field">
          <label for="ig-desc">Description</label>
          <input type="text" id="ig-desc" class="input-field llm-input" value="${
    escapeHtml(g.description)
  }" placeholder="What this generator is good for">
        </div>
        <div class="llm-field">
          <label class="toggle-label">
            <input type="checkbox" id="ig-enabled" role="switch" aria-label="Enabled" ${
    g.enabled ? "checked" : ""
  }>
            <span class="toggle-slider"></span>
            <span class="toggle-text">Enabled</span>
          </label>
        </div>
        <div class="llm-field">
          <label class="toggle-label">
            <input type="checkbox" id="ig-nsfw" role="switch" aria-label="NSFW Capable" ${
    g.nsfw ? "checked" : ""
  }>
            <span class="toggle-slider"></span>
            <span class="toggle-text">NSFW Capable</span>
          </label>
        </div>
        <div class="llm-field">
          <label for="ig-provider">Provider</label>
          <select id="ig-provider" class="input-field llm-input" onchange="toggleImageGenProvider()">
            <option value="openrouter" ${
    g.provider === "openrouter" ? "selected" : ""
  }>OpenRouter</option>
            <option value="gemini" ${
    g.provider === "gemini" ? "selected" : ""
  }>Google AI Studio</option>
            <option value="venice" ${
    g.provider === "venice" ? "selected" : ""
  }>Venice AI</option>
            <option value="nanogpt" ${
    g.provider === "nanogpt" ? "selected" : ""
  }>NanoGPT</option>
            <option value="comfyui" disabled>ComfyUI (coming soon)</option>
            <option value="native" disabled>Native (coming soon)</option>
          </select>
        </div>

        <div id="ig-openrouter-section" style="${
    g.provider === "openrouter" ? "" : "display:none;"
  }">
          <h3 style="margin-top:var(--sp-4);font-size:var(--font-size-sm);color:var(--c-fg-muted);">OpenRouter Settings</h3>
          <div class="llm-field">
            <label for="ig-or-key">API Key</label>
            <input type="password" id="ig-or-key" class="input-field llm-input" value="${
    escapeHtml(orSettings?.apiKey || "")
  }" placeholder="sk-or-...">
          </div>
          <div class="llm-field">
            <label for="ig-or-model">Model</label>
            <input type="text" id="ig-or-model" class="input-field llm-input" value="${
    escapeHtml(orSettings?.model || "")
  }" placeholder="openai/dall-e-3">
          </div>
          <div class="llm-field">
            <label for="ig-or-baseurl">Base URL</label>
            <input type="text" id="ig-or-baseurl" class="input-field llm-input" value="${
    escapeHtml(orSettings?.baseUrl || "")
  }" placeholder="https://openrouter.ai/api/v1 (default)">
          </div>
        </div>

        <div id="ig-gemini-section" style="${
    g.provider === "gemini" ? "" : "display:none;"
  }">
          <h3 style="margin-top:var(--sp-4);font-size:var(--font-size-sm);color:var(--c-fg-muted);">Google AI Studio Settings</h3>
          <div class="llm-field">
            <label for="ig-gemini-key">API Key</label>
            <input type="password" id="ig-gemini-key" class="input-field llm-input" value="${
    escapeHtml(g.settings.gemini?.apiKey || "")
  }" placeholder="AIza...">
          </div>
          <div class="llm-field">
            <label for="ig-gemini-model">Model</label>
            <select id="ig-gemini-model" class="input-field llm-input">
              <option value="gemini-3.1-flash-image-preview" ${
    (g.settings.gemini?.model || "") === "gemini-3.1-flash-image-preview"
      ? "selected"
      : ""
  }>gemini-3.1-flash-image-preview</option>
              <option value="gemini-3-pro-image-preview" ${
    (g.settings.gemini?.model || "") === "gemini-3-pro-image-preview"
      ? "selected"
      : ""
  }>gemini-3-pro-image-preview</option>
              <option value="gemini-2.5-flash-image" ${
    (g.settings.gemini?.model || "") === "gemini-2.5-flash-image"
      ? "selected"
      : ""
  }>gemini-2.5-flash-image</option>
            </select>
          </div>
          <p class="settings-note">Size and aspect ratio are decided per-generation by the entity based on context.</p>
        </div>

        <div id="ig-venice-section" style="${
    g.provider === "venice" ? "" : "display:none;"
  }">
          <h3 style="margin-top:var(--sp-4);font-size:var(--font-size-sm);color:var(--c-fg-muted);">Venice AI Settings</h3>
          <div class="llm-field">
            <label for="ig-venice-key">API Key</label>
            <input type="password" id="ig-venice-key" class="input-field llm-input" value="${
    escapeHtml(veniceSettings?.apiKey || "")
  }" placeholder="Bearer token from venice.ai">
          </div>
          <div class="llm-field">
            <label for="ig-venice-model">Model</label>
            <input type="text" id="ig-venice-model" class="input-field llm-input" value="${
    escapeHtml(veniceSettings?.model || "")
  }" placeholder="e.g. venice-sd35, grok-imagine-image, nano-banana-pro">
          </div>
          <div class="llm-field">
            <label for="ig-venice-baseurl">Base URL</label>
            <input type="text" id="ig-venice-baseurl" class="input-field llm-input" value="${
    escapeHtml(veniceSettings?.baseUrl || "")
  }" placeholder="https://api.venice.ai/api/v1 (default)">
          </div>
          <p class="settings-note">Venice does not currently support image anchors (inpaint was deprecated May 2025). Anchor-using requests will be processed as text-to-image only.</p>
        </div>

        <div id="ig-nanogpt-section" style="${
    g.provider === "nanogpt" ? "" : "display:none;"
  }">
          <h3 style="margin-top:var(--sp-4);font-size:var(--font-size-sm);color:var(--c-fg-muted);">NanoGPT Settings</h3>
          <div class="llm-field">
            <label for="ig-nanogpt-key">API Key</label>
            <input type="password" id="ig-nanogpt-key" class="input-field llm-input" value="${
    escapeHtml(nanogptSettings?.apiKey || "")
  }" placeholder="API key from nano-gpt.com">
          </div>
          <div class="llm-field">
            <label for="ig-nanogpt-model">Model</label>
            <input type="text" id="ig-nanogpt-model" class="input-field llm-input" value="${
    escapeHtml(nanogptSettings?.model || "")
  }" placeholder="e.g. flux-kontext, gpt-4o-image, gpt-image-1">
          </div>
          <div class="llm-field">
            <label for="ig-nanogpt-baseurl">Base URL</label>
            <input type="text" id="ig-nanogpt-baseurl" class="input-field llm-input" value="${
    escapeHtml(nanogptSettings?.baseUrl || "")
  }" placeholder="https://nano-gpt.com/v1 (default)">
          </div>
          <p class="settings-note">Multi-image anchor support depends on the model (e.g. flux-kontext, gpt-4o-image, gpt-image-1 accept multiple; others accept one).</p>
        </div>

        <div class="llm-field" style="display:flex;gap:var(--sp-3);margin-top:var(--sp-4);">
          <button class="btn btn--primary" onclick="saveImageGenSlot('${
    escapeHtml(id)
  }', ${isNew})">Save</button>
          ${
    !isNew
      ? `<button class="btn btn--danger" onclick="deleteImageGenSlot('${
        escapeHtml(id)
      }')">Delete</button>`
      : ""
  }
        </div>
      </div>
    </section>

  </div>

<script>
function toggleImageGenProvider() {
  const provider = document.getElementById('ig-provider').value;
  document.getElementById('ig-openrouter-section').style.display = provider === 'openrouter' ? '' : 'none';
  document.getElementById('ig-gemini-section').style.display = provider === 'gemini' ? '' : 'none';
  document.getElementById('ig-venice-section').style.display = provider === 'venice' ? '' : 'none';
  document.getElementById('ig-nanogpt-section').style.display = provider === 'nanogpt' ? '' : 'none';
}

async function saveImageGenSlot(id, isNew) {
  const provider = document.getElementById('ig-provider').value;
  const generator = {
    id,
    name: document.getElementById('ig-name').value,
    description: document.getElementById('ig-desc').value,
    enabled: document.getElementById('ig-enabled').checked,
    nsfw: document.getElementById('ig-nsfw').checked,
    provider: provider,
    settings: {
      params: { width: 1024, height: 1024, steps: 30, negative_prompt: '' }
    }
  };
  if (provider === 'openrouter') {
    generator.settings.openrouter = {
      apiKey: document.getElementById('ig-or-key').value,
      model: document.getElementById('ig-or-model').value,
      baseUrl: document.getElementById('ig-or-baseurl').value,
    };
  }
  if (provider === 'gemini') {
    generator.settings.gemini = {
      apiKey: document.getElementById('ig-gemini-key').value,
      model: document.getElementById('ig-gemini-model').value,
    };
  }
  if (provider === 'venice') {
    generator.settings.venice = {
      apiKey: document.getElementById('ig-venice-key').value,
      model: document.getElementById('ig-venice-model').value,
      baseUrl: document.getElementById('ig-venice-baseurl').value,
    };
  }
  if (provider === 'nanogpt') {
    generator.settings.nanogpt = {
      apiKey: document.getElementById('ig-nanogpt-key').value,
      model: document.getElementById('ig-nanogpt-model').value,
      baseUrl: document.getElementById('ig-nanogpt-baseurl').value,
    };
  }

  await fetch('/api/image-gen-settings/slot', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ generator }) });
  htmx.ajax('GET', '/fragments/settings/vision', '#chat');
}

async function deleteImageGenSlot(id) {
  if (!confirm('Delete this generator?')) return;
  await fetch('/api/image-gen-settings/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) });
  htmx.ajax('GET', '/fragments/settings/vision', '#chat');
}
</script>
</div>`;
}

/**
 * Render anchor images management page.
 */

// =============================================================================
// Discord Gateway UI Templates
// =============================================================================

interface DiscordHubData {
  connected: boolean;
  botUsername: string | null;
  guildCount: number;
  guilds: Array<
    {
      id: string;
      name: string;
      memberCount: number;
      channels: Array<{ id: string; name: string }>;
    }
  >;
  conversations: Conversation[];
  gatewayConfig?:
    | import("../llm/discord-settings.ts").DiscordGatewayConfig
    | null;
}

export function renderDiscordHub(data: DiscordHubData): string {
  const statusClass = data.connected
    ? "status-connected"
    : "status-disconnected";
  const statusText = data.connected ? "Connected" : "Disconnected";
  const servers = data.gatewayConfig?.servers ?? [];

  // Split conversations: DMs (no sourceServerId) vs server channels
  const dmConversations = data.conversations.filter((c) => !c.sourceServerId);
  const channelConversations = data.conversations.filter((c) =>
    !!c.sourceServerId
  );

  const renderConversationItem = (c: typeof data.conversations[0]) => `
    <a class="discord-conversation-item"
       hx-get="/fragments/discord/channel/${c.sourceChannelId}"
       hx-target="#chat"
       hx-swap="innerHTML">
      <span class="discord-conv-title">${
    escapeHtml(c.title || "Untitled")
  }</span>
      <span class="discord-conv-time">${
    new Date(c.updatedAt).toLocaleString()
  }</span>
    </a>`;

  const conversationsHtml = data.conversations.length > 0
    ? `
    <div class="discord-section">
      <h3 class="discord-section-title">Active Conversations</h3>
      <div class="discord-conversation-list">
        ${
      dmConversations.length > 0
        ? dmConversations.map(renderConversationItem).join("")
        : ""
    }
        ${
      channelConversations.length > 0
        ? channelConversations.map(renderConversationItem).join("")
        : ""
    }
        ${
      data.conversations.length === 0
        ? '<p class="empty-text">No conversations yet.</p>'
        : ""
    }
      </div>
    </div>
  `
    : "";

  return `<div class="settings-view">
  <div class="settings-header">
    <button class="settings-back-btn"
      onclick="Psycheros.goBack()">&larr; Back</button>
    <h2 class="settings-title">Discord</h2>
    <div class="discord-connection-status ${statusClass}">
      <span class="discord-status-indicator"></span>
      <span>${statusText}</span>
    </div>
  </div>

  <div class="discord-hub-content">
    ${
    data.connected
      ? `
      <div class="discord-info-bar">
        <span>Logged in as <strong>${
        escapeHtml(data.botUsername || "Unknown")
      }</strong></span>
        <span>${data.guildCount} server(s) connected</span>
      </div>

      ${conversationsHtml}

      <div class="discord-section">
        <h3 class="discord-section-title">Servers & Channels</h3>
        <div id="discord-channel-picker" data-config='${
        escapeHtml(JSON.stringify(servers))
      }'>
          <p class="settings-note" style="color:var(--c-muted);">Loading servers...</p>
        </div>
      </div>

      <div class="discord-actions">
        <button class="btn btn--primary" id="discord-hub-save" onclick="saveDiscordHubChannels()">Save Channel Config</button>
        <button class="btn btn--secondary"
          hx-get="/fragments/settings/connections/discord"
          hx-target="#chat"
          hx-swap="innerHTML">Settings</button>
      </div>
      <div id="discord-hub-status" class="llm-status" style="display:none;"></div>
    `
      : `
      <div class="discord-info-bar">
        <span>Not connected. Enable Gateway in Settings to connect.</span>
      </div>
      <div class="discord-actions">
        <button class="btn btn--secondary"
          hx-get="/fragments/settings/connections/discord"
          hx-target="#chat"
          hx-swap="innerHTML">Settings</button>
      </div>
    `
  }
  </div>
</div>

<script>
// Channel picker: loads servers/channels from the gateway API
let _discordPickerAbort = null;

async function loadDiscordChannelPicker() {
  const picker = document.getElementById('discord-channel-picker');
  if (!picker) return;

  if (_discordPickerAbort) _discordPickerAbort.abort();
  _discordPickerAbort = new AbortController();

  const existingConfig = JSON.parse(picker.dataset.config || '[]');
  const configuredChannels = new Map();
  existingConfig.forEach(s => {
    (s.channels || []).forEach(c => {
      configuredChannels.set(c.channelId, { mode: c.mode, instructions: c.instructions });
    });
  });

  try {
    const loadingTimeout = setTimeout(() => {
      if (document.getElementById('discord-channel-picker')?.querySelector('.settings-note')) {
        picker.innerHTML = '<p class="settings-note" style="color:var(--c-muted);">Server list is taking longer than expected. <a href="javascript:void(0)" onclick="loadDiscordChannelPicker()">Retry</a></p>';
      }
    }, 10000);

    const resp = await fetch('/api/discord/status', { signal: _discordPickerAbort.signal });
    clearTimeout(loadingTimeout);
    const data = await resp.json();

    if (!data.connected || !data.guilds || data.guilds.length === 0) {
      picker.innerHTML = '<p class="settings-note" style="color:var(--c-muted);">Connect the gateway and invite the bot to a server to see available channels here. <a href="javascript:void(0)" onclick="loadDiscordChannelPicker()">Refresh</a></p>';
      return;
    }

    let html = '';
    data.guilds.forEach(guild => {
      const textChannels = (guild.channels || []).filter(ch => true);
      if (textChannels.length === 0) return;

      html += '<div class="discord-picker-guild" data-guild-id="' + guild.id + '" data-guild-name="' + guild.name + '">';
      html += '<div class="discord-picker-guild-header">';
      html += '<span class="discord-picker-guild-name">' + guild.name + '</span>';
      html += '<span class="discord-picker-guild-meta">' + textChannels.length + ' channel(s)</span>';
      html += '<a class="discord-picker-select-all" onclick="toggleGuildAll(this)" href="javascript:void(0)">select all</a>';
      html += '</div>';
      html += '<div class="discord-picker-channels">';
      textChannels.forEach(ch => {
        const cfg = configuredChannels.get(ch.id);
        const checked = !!cfg;
        const mode = cfg?.mode || 'strict';
        const instr = cfg?.instructions || '';
        html += '<div class="discord-picker-channel">';
        html += '<label class="toggle-label" style="gap:var(--sp-2);flex-shrink:0;">';
        html += '<input type="checkbox" class="discord-picker-channel-check" ' + (checked ? 'checked' : '') + ' data-channel-id="' + ch.id + '" data-channel-name="' + ch.name + '">';
        html += '<span class="toggle-slider"></span>';
        html += '</label>';
        html += '<a class="discord-picker-channel-name" href="javascript:void(0)" onclick="loadDiscordChannel(\\'' + ch.id + '\\')"># ' + ch.name + '</a>';
        html += '<select class="settings-input discord-picker-mode" style="flex:0 0 100px;">';
        html += '<option value="active"' + (mode === 'active' ? ' selected' : '') + '>Active</option>';
        html += '<option value="lurk"' + (mode === 'lurk' ? ' selected' : '') + '>Lurk</option>';
        html += '<option value="strict"' + (mode === 'strict' ? ' selected' : '') + '>Strict</option>';
        html += '</select>';
        html += '<input type="text" class="settings-input discord-picker-instructions" placeholder="Instructions" value="' + instr.replace(/"/g, '&quot;') + '" style="flex:1;min-width:0;">';
        html += '</div>';
      });
      html += '</div></div>';
    });

    if (!html) {
      html = '<p class="settings-note" style="color:var(--c-muted);">No text channels found. The bot may not have access to any channels.</p>';
    }

    picker.innerHTML = html;
  } catch (e) {
    if (e.name === 'AbortError') return;
    picker.innerHTML = '<p class="settings-note" style="color:var(--c-muted);">Could not load servers: ' + e.message + ' <a href="javascript:void(0)" onclick="loadDiscordChannelPicker()">Retry</a></p>';
  }
}

function toggleGuildAll(link) {
  const card = link.closest('.discord-picker-guild');
  const checks = card.querySelectorAll('.discord-picker-channel-check');
  const allChecked = [...checks].every(c => c.checked);
  checks.forEach(ch => { ch.checked = !allChecked; });
  link.textContent = allChecked ? 'select all' : 'deselect all';
}

function collectDiscordServers() {
  const servers = [];
  document.querySelectorAll('#discord-channel-picker .discord-picker-guild').forEach(guildCard => {
    const channels = [];
    guildCard.querySelectorAll('.discord-picker-channel').forEach(chRow => {
      const check = chRow.querySelector('.discord-picker-channel-check');
      if (!check.checked) return;
      channels.push({
        channelId: check.dataset.channelId,
        mode: chRow.querySelector('.discord-picker-mode').value,
        instructions: chRow.querySelector('.discord-picker-instructions').value.trim(),
      });
    });
    if (channels.length > 0) {
      servers.push({
        serverId: guildCard.dataset.guildId,
        serverName: guildCard.dataset.guildName,
        channels,
      });
    }
  });
  return servers;
}

function showHubStatus(type, message) {
  const el = document.getElementById('discord-hub-status');
  if (!el) return;
  el.style.display = 'block';
  el.className = 'llm-status ' + type;
  el.textContent = message;
}

async function saveDiscordHubChannels() {
  const btn = document.getElementById('discord-hub-save');
  if (btn) { btn.disabled = true; btn.textContent = 'Saving...'; }
  showHubStatus('loading', 'Saving channel configuration...');
  try {
    const servers = collectDiscordServers();
    const resp = await fetch('/api/discord/gateway-config');
    const config = await resp.json();
    config.servers = servers;
    await fetch('/api/discord/gateway-config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config),
    });
    showHubStatus('success', 'Channel configuration saved.');
  } catch (e) {
    showHubStatus('error', 'Failed to save: ' + e.message);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Save Channel Config'; }
  }
}

function loadDiscordChannel(channelId) {
  const chat = document.getElementById('chat');
  if (!chat) return;
  chat.innerHTML = '';
  fetch('/fragments/discord/channel/' + channelId)
    .then(r => r.text())
    .then(h => {
      chat.innerHTML = h;
      Psycheros.autoScrollReinit?.();
      requestAnimationFrame(() => Psycheros.autoScrollJump?.());
    });
}

loadDiscordChannelPicker();

fetch('/api/discord/status').then(r => r.json()).then(data => {
  const dot = document.getElementById('discord-status-dot');
  if (dot) {
    dot.className = 'discord-status-dot ' + (data.connected ? 'discord-dot-connected' : 'discord-dot-disconnected');
  }
}).catch(() => {});
</script>`;
}

function formatDiscordMessageContent(content: string): string {
  // Strip ::react and ::reply directives (can appear anywhere in text)
  const clean = content
    .replace(/::react\s+\d+\s+:\S+:/g, "")
    .replace(/::reply\s+\d+/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  // Highlight <@userId> mentions
  const withMentions = clean.replace(
    /&lt;@(\d+)&gt;/g,
    '<span class="discord-mention">@$1</span>',
  );
  return withMentions;
}

export function renderDiscordChannelView(
  conversation: Conversation | null,
  messages: Message[],
  entityName?: string,
  channelMode?: string,
  realChannelName?: string,
): string {
  const convId = conversation?.id || "";
  const title = conversation?.title || "Discord Channel";
  const serverName = conversation?.sourceServerName;
  const channelId = conversation?.sourceChannelId;
  // Prefer real name from gateway cache; fall back to stored name; ignore if it's just the ID
  const channelName = realChannelName ||
    (conversation?.sourceChannelName &&
        /^\d+$/.test(conversation.sourceChannelName)
      ? undefined
      : conversation?.sourceChannelName);

  const messageHtml = messages.map((msg) => {
    const isUser = msg.role === "user";
    const isSystem = msg.role === "system";
    const isDivider = isSystem &&
      msg.content.includes(
        "Messages above this line are not in the entity's context window.",
      );

    if (isDivider) {
      const dividerTime = msg.content.replace(/^Context cleared at /, "")
        .replace(/\. Messages above.*/, "");
      return `<div class="discord-context-divider">
        <div class="discord-context-divider-line"></div>
        <span class="discord-context-divider-text">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><line x1="20" y1="4" x2="8.12" y2="15.88"/><line x1="14.47" y1="14.48" x2="20" y2="20"/><line x1="8.12" y1="8.12" x2="12" y2="12"/></svg>
          Context cleared &middot; ${escapeHtml(dividerTime)}
        </span>
        <div class="discord-context-divider-line"></div>
      </div>`;
    }

    const isTool = msg.role === "tool";

    // Tool results: compact inline card
    if (isTool) {
      const isError = msg.content.startsWith("Discord API error") ||
        msg.content.startsWith("Error");
      return `<div class="discord-message discord-msg-tool" data-message-id="${
        escapeHtml(msg.id)
      }" data-conversation-id="${escapeHtml(convId)}">
        <div class="discord-msg-header">
          <span class="discord-msg-role">Tool result</span>
        </div>
        <div class="discord-msg-content discord-tool-result${
        isError ? " discord-tool-result--error" : ""
      }">${escapeHtml(msg.content)}</div>
      </div>`;
    }

    const className = isSystem
      ? "discord-msg-system"
      : isUser
      ? "discord-msg-user"
      : "discord-msg-entity";
    const timeStr = new Date(msg.createdAt).toLocaleTimeString([], {
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    });
    const editedIndicator = msg.editedAt
      ? `<span class="msg-edited-indicator">(edited)</span>`
      : "";
    const editBtn = !isSystem && msg.id
      ? `<button class="discord-msg-edit-btn" onclick="Psycheros.startMessageEdit('${
        escapeHtml(msg.id)
      }')" title="Edit message">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
            <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
          </svg>
        </button>`
      : "";

    // For entity messages, render thinking + tool calls + content
    let contentHtml = "";
    if (!isUser && !isSystem) {
      if (msg.reasoningContent) {
        contentHtml += renderThinkingSection(msg.reasoningContent);
      }
      if (msg.toolCalls && msg.toolCalls.length > 0) {
        for (const tc of msg.toolCalls) {
          contentHtml += renderToolCard(tc);
        }
      }
      if (msg.content) {
        contentHtml += `<div class="discord-msg-text" data-raw-content="${
          escapeHtml(msg.content)
        }">${formatDiscordMessageContent(msg.content)}</div>`;
      }
    } else {
      contentHtml = `<div class="discord-msg-text" data-raw-content="${
        escapeHtml(msg.content)
      }">${formatDiscordMessageContent(msg.content)}</div>`;
    }

    return `<div class="discord-message ${className}" data-message-id="${
      escapeHtml(msg.id)
    }" data-conversation-id="${escapeHtml(convId)}">
      <div class="discord-msg-header">
        <span class="discord-msg-role">${
      isUser ? "Discord" : escapeHtml(entityName || "Entity")
    }</span>
        <span class="discord-msg-time">${timeStr}</span>
        ${editedIndicator}
        ${editBtn}
      </div>
      <div class="discord-msg-content">${contentHtml}</div>
    </div>`;
  }).join("");

  const headerTitle = serverName ? escapeHtml(serverName) : escapeHtml(title);
  const headerSubtitle = `<span class="discord-channel-subtitle">#${
    escapeHtml(channelName || channelId || "")
  }</span>`;
  const channelIdMeta = channelId
    ? `<span class="discord-channel-id">&middot; ${
      escapeHtml(channelId)
    }</span>`
    : "";
  const modeBadge = channelMode
    ? `<span class="discord-mode-badge discord-mode-badge--${channelMode}">${channelMode}</span>`
    : "";

  return `<div class="settings-view discord-channel-view" data-conversation-id="${
    escapeHtml(convId)
  }" data-channel-id="${escapeHtml(channelId || "")}">
  <div class="discord-channel-header">
    <div class="discord-channel-header-left">
      <button class="settings-back-btn"
        hx-get="/fragments/discord"
        hx-target="#chat"
        hx-swap="innerHTML">&larr; Back</button>
      <div class="discord-channel-header-info">
        <h2 class="settings-title">${headerTitle}</h2>
        <div class="discord-channel-header-meta">
          ${headerSubtitle}
          ${channelIdMeta}
          ${modeBadge}
        </div>
      </div>
    </div>
    <div class="discord-channel-header-actions">
      ${
    convId
      ? `<button class="discord-header-btn" onclick="Psycheros.toggleContextViewer()" title="View LLM Context">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="16 18 22 12 16 6"/>
          <polyline points="8 6 2 12 8 18"/>
        </svg>
      </button>`
      : ""
  }
      ${
    convId
      ? `<button class="discord-header-btn discord-header-btn-danger" onclick="clearDiscordContext('${
        escapeHtml(convId)
      }')" title="Clear context">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="3 6 5 6 21 6"/>
          <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
        </svg>
      </button>`
      : ""
  }
    </div>
  </div>
  <div class="discord-channel-messages" id="messages">
    ${messageHtml || '<p class="empty-text">No messages yet.</p>'}
  </div>
</div>
<script>
function clearDiscordContext(convId) {
  if (!confirm('Clear the entity\\'s context for this channel? Message history will remain visible but the entity will only see messages after this point.')) return;
  fetch('/api/conversations/' + convId + '/clear-context', { method: 'POST' })
    .then(r => r.json())
    .then(data => {
      if (data.success) {
        const channelId = document.querySelector('.discord-channel-view')?.dataset.channelId;
        if (channelId) {
          htmx.ajax('GET', '/fragments/discord/channel/' + channelId, { target: '#chat' });
        }
      } else {
        showToast(data.error || 'Failed to clear context');
      }
    })
    .catch(() => showToast('Failed to clear context'));
}
</script>`;
}

// =============================================================================
// Voice Settings Template
// =============================================================================

const TTS_PROVIDERS: { value: VoiceTTSProvider; label: string }[] = [
  { value: "minimax", label: "Minimax" },
  { value: "elevenlabs", label: "ElevenLabs" },
  { value: "openai", label: "OpenAI" },
  { value: "custom", label: "Custom (OpenAI-compatible)" },
];

const STT_PROVIDERS: { value: VoiceSTTProvider; label: string }[] = [
  { value: "browser", label: "Browser-native (Web Speech API)" },
  { value: "deepgram", label: "Deepgram" },
  { value: "openai", label: "OpenAI" },
  { value: "custom", label: "Custom (OpenAI-compatible)" },
];

/**
 * Convert a stored PTT key binding into a human-readable label.
 * "Space" → "Space", "KeyV" → "V", "Mouse3" → "Mouse Back",
 * "MediaPlayPause" → "Play/Pause", etc.
 */
function formatPTTKey(key: string): string {
  if (key.startsWith("Key")) return key.slice(3);
  if (key.startsWith("Digit")) return key.slice(5);
  if (key.startsWith("Mouse")) {
    const btn = parseInt(key.slice(5));
    const labels = ["Left", "Middle", "Right", "Back", "Forward"];
    return "Mouse " + (labels[btn] ?? btn);
  }
  if (key.startsWith("MediaSession:")) {
    const action = key.slice("MediaSession:".length);
    const labels: Record<string, string> = {
      "play": "Play (toggle)",
      "pause": "Pause (toggle)",
      "previoustrack": "Prev Track (toggle)",
      "nexttrack": "Next Track (toggle)",
      "stop": "Stop (toggle)",
    };
    return labels[action] ?? action + " (toggle)";
  }
  const mediaLabels: Record<string, string> = {
    "MediaPlayPause": "Play/Pause",
    "MediaTrackNext": "Next Track",
    "MediaTrackPrevious": "Prev Track",
    "MediaStop": "Stop",
  };
  return mediaLabels[key] ?? key;
}

/**
 * Render the voice profile hub (card grid of profiles + master toggle).
 */
export function renderVoiceProfileHub(settings: VoiceSettings): string {
  const count = settings.profiles.length;
  const plural = count !== 1 ? "s" : "";

  const profileCards = settings.profiles.map((p) => {
    const isActive = p.id === settings.activeProfileId;
    const ttsLabel = TTS_PROVIDERS.find((t) =>
      t.value === p.providerSettings.tts.provider
    )?.label || p.providerSettings.tts.provider;
    const sttLabel = STT_PROVIDERS.find((s) =>
      s.value === p.providerSettings.stt.provider
    )?.label || p.providerSettings.stt.provider;
    return `
    <a class="settings-hub-card ${isActive ? "settings-hub-card--active" : ""}"
       hx-get="/fragments/settings/voice/${escapeHtml(p.id)}"
       hx-target="#chat"
       hx-swap="innerHTML">
      <div class="settings-hub-card-icon">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
          <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
          <line x1="12" y1="19" x2="12" y2="23"/>
          <line x1="8" y1="23" x2="16" y2="23"/>
        </svg>
      </div>
      <div class="settings-hub-card-body">
        <span class="settings-hub-card-title">${escapeHtml(p.name)}</span>
        <span class="settings-hub-card-desc">
          TTS: ${escapeHtml(ttsLabel)} &bull; STT: ${escapeHtml(sttLabel)}
          ${isActive ? ' <span class="badge badge--active">Active</span>' : ""}
        </span>
      </div>
      <svg class="settings-hub-card-arrow" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <polyline points="9 18 15 12 9 6"/>
      </svg>
    </a>`;
  }).join("");

  const addCard = `
    <button class="settings-hub-card settings-hub-card-add"
      hx-get="/fragments/settings/voice/new"
      hx-target="#chat"
      hx-swap="innerHTML">
      <div class="settings-hub-card-icon">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <line x1="12" y1="5" x2="12" y2="19"/>
          <line x1="5" y1="12" x2="19" y2="12"/>
        </svg>
      </div>
      <div class="settings-hub-card-body">
        <span class="settings-hub-card-title">Add Profile</span>
        <span class="settings-hub-card-desc">Configure a new voice profile</span>
      </div>
    </button>`;

  return `<div class="settings-view">
  <div class="settings-header">
    <div class="settings-header-row">
      ${renderSettingsBackButton()}
      <div>
        <h1 class="settings-title">Audio</h1>
        <p class="settings-desc">Voice chat profiles &mdash; ${count} profile${plural}</p>
      </div>
    </div>
  </div>
  <div class="settings-content" id="settings-content">
    <div style="margin-bottom: var(--sp-3);">
      <label class="toggle-label">
        <input type="checkbox" id="voice-enabled" role="switch" aria-label="Enable voice chat" ${
    settings.enabled ? "checked" : ""
  } onchange="toggleVoiceEnabled()">
        <span class="toggle-slider"></span>
        <span class="toggle-text">Enable voice chat</span>
      </label>
      <span id="voice-status-msg" style="margin-left: var(--sp-2); font-size: var(--text-xs);"></span>
    </div>
    <div class="settings-hub-grid">
      ${profileCards}
      ${addCard}
    </div>
    <div class="settings-section" style="margin-top: var(--sp-5); padding: var(--sp-4); border: 1px solid var(--c-border); border-radius: 8px;">
      <div style="margin-bottom: var(--sp-2);">
        <strong style="font-size: var(--font-size-sm);">Hold to Talk</strong>
        <p style="font-size: var(--text-xs); color: var(--c-fg-muted); margin: var(--sp-1) 0 0;">
          Configure keys for hold-to-talk. Toggle on/off from the voice overlay.
        </p>
      </div>
      <div id="ptt-keybindings">
        <span style="font-size: var(--text-xs); color: var(--c-fg-muted); display: block; margin-bottom: var(--sp-1);">Key bindings</span>
        <div id="ptt-keys-list" style="display: flex; flex-wrap: wrap; gap: var(--sp-2); align-items: center;">
          ${
    (settings.pttKeys ?? ["Space"]).map((key, i) =>
      `<span class="ptt-key-chip" data-index="${i}">
              <span>${escapeHtml(formatPTTKey(key))}</span>
              <button type="button" onclick="removePTTKeyBinding(${i})" style="background: none; border: none; color: var(--c-fg-subtle); cursor: pointer; padding: 0 0 0 4px; font-size: var(--font-size-xs);">&times;</button>
            </span>`
    ).join("")
  }
          <button type="button" class="btn btn--ghost btn--sm" id="ptt-add-key-btn" onclick="capturePTTKey()" style="font-size: var(--font-size-xs);">+ Add binding</button>
        </div>
        <div id="ptt-capture-hint" style="display: none; margin-top: var(--sp-2); font-size: var(--text-xs); color: var(--c-accent);">
          Press any key or mouse button...
          <button type="button" class="btn btn--ghost btn--sm" onclick="cancelPTTKeyCapture()" style="margin-left: var(--sp-2);">Cancel</button>
        </div>
      </div>
    </div>
    ${/* Debug section: sits below Hold to Talk; secondary utility. */ ""}
    <div class="settings-section" style="margin-top: var(--sp-5); padding: var(--sp-4); border: 1px solid var(--c-border); border-radius: 8px;">
      <div style="margin-bottom: var(--sp-2);">
        <strong style="font-size: var(--font-size-sm);">Debug</strong>
        <p style="font-size: var(--text-xs); color: var(--c-fg-muted); margin: var(--sp-1) 0 0;">
          Diagnostic tools for voice chat. Enable the panel to capture the full pipeline (mic permission, WebSocket events, state transitions, TTS frame arrival, audio setup) &mdash; useful when asking for support or debugging audio glitches.
        </p>
      </div>
      <div style="margin-bottom: var(--sp-2);">
        <label style="display: flex; align-items: center; gap: var(--sp-2); cursor: pointer;">
          <input type="checkbox" id="voice-chat-debug" ${
    settings.voiceChatDebug ? "checked" : ""
  } onchange="toggleVoiceChatDebug(this.checked)">
          <span>Enable voice chat debug panel</span>
        </label>
      </div>
      <div id="voice-chat-debug-panel" style="${
    settings.voiceChatDebug ? "" : "display: none;"
  }">
        <textarea id="voice-chat-debug-log" readonly rows="8" class="input-field" style="font-family: monospace; font-size: 11px; white-space: pre; resize: vertical; width: 100%; box-sizing: border-box;" placeholder="Click 'Run test' to capture diagnostic info, or start a voice call — events will appear here."></textarea>
        <div style="display: flex; gap: var(--sp-2); margin-top: var(--sp-2); flex-wrap: wrap;">
          <button type="button" class="btn btn--ghost btn--sm" onclick="runVoiceChatTest()">Run test</button>
          <button type="button" class="btn btn--ghost btn--sm" onclick="copyVoiceChatDebugLog(this)">Copy</button>
          <button type="button" class="btn btn--ghost btn--sm" onclick="clearVoiceChatDebugLog()">Clear</button>
        </div>
      </div>
    </div>
  </div>
</div>`;
}

/**
 * Render the voice profile edit/create form.
 */
export function renderVoiceProfileEdit(
  profile: VoiceProfile | null,
  isNew: boolean,
  activeProfileId: string | null,
): string {
  const p = profile;
  const id = p?.id || "";
  const isActive = !isNew && id === activeProfileId;
  const tts = p?.providerSettings.tts;
  const stt = p?.providerSettings.stt;

  function ttsProviderOptions(): string {
    return TTS_PROVIDERS.map((t) =>
      `<option value="${t.value}" ${
        tts?.provider === t.value ? "selected" : ""
      }>${t.label}</option>`
    ).join("");
  }

  function sttProviderOptions(): string {
    return STT_PROVIDERS.map((s) =>
      `<option value="${s.value}" ${
        stt?.provider === s.value ? "selected" : ""
      }>${s.label}</option>`
    ).join("");
  }

  function pronunciationRows(): string {
    if (!p?.pronunciation?.length) return "";
    return p.pronunciation.map((entry, idx) => `
      <div class="pronunciation-row" data-idx="${idx}">
        <input type="text" class="input-field llm-input" value="${
      escapeHtml(entry.written)
    }" placeholder="Written (e.g. Psycheros)">
        <span style="color: var(--text-dim);">&rarr;</span>
        <input type="text" class="input-field llm-input" value="${
      escapeHtml(entry.spoken)
    }" placeholder="Spoken (e.g. sy-KEH-ros)">
        <button class="btn btn--ghost btn--sm" onclick="removePronunciationEntry(${idx})" title="Remove">&times;</button>
      </div>
    `).join("");
  }

  function sttCorrectionRows(): string {
    if (!p?.sttCorrections?.length) return "";
    return p.sttCorrections.map((entry, idx) => `
      <div class="pronunciation-row stt-correction-row" data-idx="${idx}">
        <input type="text" class="input-field llm-input" value="${
      escapeHtml(entry.misheard)
    }" placeholder="Misheard (e.g. sih keh ros)">
        <span style="color: var(--text-dim);">&rarr;</span>
        <input type="text" class="input-field llm-input" value="${
      escapeHtml(entry.correct)
    }" placeholder="Correct (e.g. Psycheros)">
        <button class="btn btn--ghost btn--sm" onclick="removeSTTCorrectionEntry(${idx})" title="Remove">&times;</button>
      </div>
    `).join("");
  }

  return `<div class="settings-view">
  <div class="settings-header">
    <div class="settings-header-row">
      ${renderSettingsBackButton()}
      <div>
        <h1 class="settings-title">${
    isNew ? "New Voice Profile" : escapeHtml(p!.name)
  }</h1>
        <p class="settings-desc">${
    isNew ? "Configure a new voice profile" : "Edit voice profile settings"
  }</p>
      </div>
    </div>
  </div>
  <div class="settings-content" id="settings-content">
    <div class="llm-edit">
      <input type="hidden" id="voice-profile-id" value="${escapeHtml(id)}">

      <!-- Profile Identity -->
      <section class="theme-section">
        <h3 class="theme-section-title">Profile</h3>
        <div class="llm-fields">
          <div class="llm-field">
            <label for="voice-profile-name">Name</label>
            <input type="text" id="voice-profile-name" class="input-field llm-input" value="${
    p ? escapeHtml(p.name) : ""
  }" placeholder="e.g. Daily Driver">
          </div>
          <div class="llm-field">
            <label for="voice-profile-desc">Description</label>
            <input type="text" id="voice-profile-desc" class="input-field llm-input" value="${
    p ? escapeHtml(p.description) : ""
  }" placeholder="Optional description">
          </div>
          <div class="llm-field">
            <label class="toggle-label">
              <input type="checkbox" id="voice-profile-enabled" role="switch" aria-label="Enable this profile" ${
    p?.enabled !== false ? "checked" : ""
  }>
              <span class="toggle-slider"></span>
              <span class="toggle-text">Enabled</span>
            </label>
          </div>
        </div>
      </section>

      <!-- TTS Provider -->
      <section class="theme-section">
        <h3 class="theme-section-title">TTS Provider</h3>
        <div class="llm-fields">
          <div class="llm-field">
            <label for="voice-tts-provider">Provider</label>
            <select id="voice-tts-provider" class="input-field llm-input" onchange="onVoiceTTSProviderChange()">
              ${ttsProviderOptions()}
            </select>
          </div>
        </div>

        <!-- Minimax TTS fields -->
        <div id="tts-fields-minimax" class="voice-provider-fields" style="display: ${
    tts?.provider === "minimax" ? "block" : "none"
  }">
          <div class="llm-fields">
            <div class="llm-field">
              <label for="tts-minimax-api-key">API Key</label>
              <div class="llm-api-key-row">
                <input type="password" id="tts-minimax-api-key" class="input-field llm-input" value="${
    tts?.provider === "minimax" ? escapeHtml(tts.minimax?.apiKey || "") : ""
  }" placeholder="Minimax API key">
                <button class="btn btn--ghost btn--sm llm-toggle-key" onclick="toggleVoiceFieldVisibility('tts-minimax-api-key')" title="Show/hide key">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
                </button>
              </div>
            </div>
            <div class="llm-field">
              <label for="tts-minimax-group-id">Group ID</label>
              <input type="text" id="tts-minimax-group-id" class="input-field llm-input" value="${
    tts?.provider === "minimax" ? escapeHtml(tts.minimax?.groupId || "") : ""
  }" placeholder="Group ID">
            </div>
            <div class="llm-field">
              <label for="tts-minimax-voice-id">Voice ID</label>
              <input type="text" id="tts-minimax-voice-id" class="input-field llm-input" value="${
    tts?.provider === "minimax" ? escapeHtml(tts.minimax?.voiceId || "") : ""
  }" placeholder="Voice ID">
            </div>
            <div class="llm-field">
              <label for="tts-minimax-model">Model</label>
              <input type="text" id="tts-minimax-model" class="input-field llm-input" value="${
    tts?.provider === "minimax"
      ? escapeHtml(tts.minimax?.model || "speech-2.8-hd")
      : "speech-2.8-hd"
  }" placeholder="speech-2.8-hd">
            </div>
          </div>
        </div>

        <!-- ElevenLabs TTS fields -->
        <div id="tts-fields-elevenlabs" class="voice-provider-fields" style="display: ${
    tts?.provider === "elevenlabs" ? "block" : "none"
  }">
          <div class="llm-fields">
            <div class="llm-field">
              <label for="tts-elevenlabs-api-key">API Key</label>
              <div class="llm-api-key-row">
                <input type="password" id="tts-elevenlabs-api-key" class="input-field llm-input" value="${
    tts?.provider === "elevenlabs"
      ? escapeHtml(tts.elevenlabs?.apiKey || "")
      : ""
  }" placeholder="ElevenLabs API key">
                <button class="btn btn--ghost btn--sm llm-toggle-key" onclick="toggleVoiceFieldVisibility('tts-elevenlabs-api-key')" title="Show/hide key">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
                </button>
              </div>
            </div>
            <div class="llm-field">
              <label for="tts-elevenlabs-voice-id">Voice ID</label>
              <input type="text" id="tts-elevenlabs-voice-id" class="input-field llm-input" value="${
    tts?.provider === "elevenlabs"
      ? escapeHtml(tts.elevenlabs?.voiceId || "")
      : ""
  }" placeholder="Voice ID">
            </div>
            <div class="llm-field">
              <label for="tts-elevenlabs-model">Model</label>
              <input type="text" id="tts-elevenlabs-model" class="input-field llm-input" value="${
    tts?.provider === "elevenlabs"
      ? escapeHtml(tts.elevenlabs?.model || "eleven_multilingual_v2")
      : "eleven_multilingual_v2"
  }" placeholder="eleven_multilingual_v2">
            </div>
          </div>
        </div>

        <!-- OpenAI TTS fields -->
        <div id="tts-fields-openai" class="voice-provider-fields" style="display: ${
    tts?.provider === "openai" ? "block" : "none"
  }">
          <div class="llm-fields">
            <div class="llm-field">
              <label for="tts-openai-api-key">API Key</label>
              <div class="llm-api-key-row">
                <input type="password" id="tts-openai-api-key" class="input-field llm-input" value="${
    tts?.provider === "openai" ? escapeHtml(tts.openai?.apiKey || "") : ""
  }" placeholder="OpenAI API key">
                <button class="btn btn--ghost btn--sm llm-toggle-key" onclick="toggleVoiceFieldVisibility('tts-openai-api-key')" title="Show/hide key">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
                </button>
              </div>
            </div>
            <div class="llm-field">
              <label for="tts-openai-base-url">Base URL</label>
              <input type="text" id="tts-openai-base-url" class="input-field llm-input" value="${
    tts?.provider === "openai" ? escapeHtml(tts.openai?.baseUrl || "") : ""
  }" placeholder="https://api.openai.com/v1">
            </div>
            <div class="llm-field">
              <label for="tts-openai-model">Model</label>
              <input type="text" id="tts-openai-model" class="input-field llm-input" value="${
    tts?.provider === "openai"
      ? escapeHtml(tts.openai?.model || "tts-1")
      : "tts-1"
  }" placeholder="tts-1">
            </div>
            <div class="llm-field">
              <label for="tts-openai-voice">Voice</label>
              <input type="text" id="tts-openai-voice" class="input-field llm-input" value="${
    tts?.provider === "openai" ? escapeHtml(tts.openai?.voice || "") : ""
  }" placeholder="alloy">
            </div>
          </div>
        </div>

        <!-- Custom TTS fields -->
        <div id="tts-fields-custom" class="voice-provider-fields" style="display: ${
    tts?.provider === "custom" ? "block" : "none"
  }">
          <div class="llm-fields">
            <div class="llm-field">
              <label for="tts-custom-base-url">Base URL</label>
              <input type="text" id="tts-custom-base-url" class="input-field llm-input" value="${
    tts?.provider === "custom" ? escapeHtml(tts.custom?.baseUrl || "") : ""
  }" placeholder="http://localhost:8000/v1">
              <span class="field-hint">OpenAI-compatible server URL. Psycheros calls <code>&lt;this&gt;/audio/speech</code>. Check your TTS server's startup log for the port (common defaults: 5000, 8000, 8005, 7851). Add <code>/v1</code> if the server prefixes its routes; try without if you get a 404.</span>
            </div>
            <div class="llm-field">
              <label for="tts-custom-api-key">API Key</label>
              <div class="llm-api-key-row">
                <input type="password" id="tts-custom-api-key" class="input-field llm-input" value="${
    tts?.provider === "custom" ? escapeHtml(tts.custom?.apiKey || "") : ""
  }" placeholder="Optional">
                <button class="btn btn--ghost btn--sm llm-toggle-key" onclick="toggleVoiceFieldVisibility('tts-custom-api-key')" title="Show/hide key">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
                </button>
              </div>
            </div>
            <div class="llm-field">
              <label for="tts-custom-model">Model</label>
              <input type="text" id="tts-custom-model" class="input-field llm-input" value="${
    tts?.provider === "custom" ? escapeHtml(tts.custom?.model || "") : ""
  }" placeholder="tts-1">
            </div>
            <div class="llm-field">
              <label for="tts-custom-voice">Voice</label>
              <input type="text" id="tts-custom-voice" class="input-field llm-input" value="${
    tts?.provider === "custom" ? escapeHtml(tts.custom?.voice || "") : ""
  }" placeholder="default">
            </div>
          </div>
        </div>
      </section>

      <!-- STT Provider -->
      <section class="theme-section">
        <h3 class="theme-section-title">STT Provider</h3>
        <div class="llm-fields">
          <div class="llm-field">
            <label for="voice-stt-provider">Provider</label>
            <select id="voice-stt-provider" class="input-field llm-input" onchange="onVoiceSTTProviderChange()">
              ${sttProviderOptions()}
            </select>
          </div>
        </div>

        <!-- Browser-native STT fields (Web Speech API) -->
        <div id="stt-fields-browser" class="voice-provider-fields" style="display: ${
    stt?.provider === "browser" ? "block" : "none"
  }">
          <div class="llm-fields">
            <div class="llm-field">
              <label for="stt-browser-language">Language</label>
              <input type="text" id="stt-browser-language" class="input-field llm-input" value="${
    stt?.provider === "browser" ? escapeHtml(stt.browser?.language || "") : ""
  }" placeholder="e.g. en-US (empty for browser default)">
              <span class="llm-field-hint">BCP-47 code (e.g. en-US). No API key needed.</span>
            </div>
          </div>
        </div>

        <!-- Deepgram STT fields -->
        <div id="stt-fields-deepgram" class="voice-provider-fields" style="display: ${
    stt?.provider === "deepgram" ? "block" : "none"
  }">
          <div class="llm-fields">
            <div class="llm-field">
              <label for="stt-deepgram-api-key">API Key</label>
              <div class="llm-api-key-row">
                <input type="password" id="stt-deepgram-api-key" class="input-field llm-input" value="${
    stt?.provider === "deepgram" ? escapeHtml(stt.deepgram?.apiKey || "") : ""
  }" placeholder="Deepgram API key">
                <button class="btn btn--ghost btn--sm llm-toggle-key" onclick="toggleVoiceFieldVisibility('stt-deepgram-api-key')" title="Show/hide key">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
                </button>
              </div>
            </div>
            <div class="llm-field">
              <label for="stt-deepgram-model">Model</label>
              <input type="text" id="stt-deepgram-model" class="input-field llm-input" value="${
    stt?.provider === "deepgram"
      ? escapeHtml(stt.deepgram?.model || "nova-2")
      : "nova-2"
  }" placeholder="nova-2">
            </div>
            <div class="llm-field">
              <label for="stt-deepgram-language">Language</label>
              <input type="text" id="stt-deepgram-language" class="input-field llm-input" value="${
    stt?.provider === "deepgram"
      ? escapeHtml(stt.deepgram?.language || "en")
      : "en"
  }" placeholder="en">
            </div>
          </div>
        </div>

        <!-- OpenAI STT fields -->
        <div id="stt-fields-openai" class="voice-provider-fields" style="display: ${
    stt?.provider === "openai" ? "block" : "none"
  }">
          <div class="llm-fields">
            <div class="llm-field">
              <label for="stt-openai-api-key">API Key</label>
              <div class="llm-api-key-row">
                <input type="password" id="stt-openai-api-key" class="input-field llm-input" value="${
    stt?.provider === "openai" ? escapeHtml(stt.openai?.apiKey || "") : ""
  }" placeholder="OpenAI API key">
                <button class="btn btn--ghost btn--sm llm-toggle-key" onclick="toggleVoiceFieldVisibility('stt-openai-api-key')" title="Show/hide key">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
                </button>
              </div>
            </div>
            <div class="llm-field">
              <label for="stt-openai-base-url">Base URL</label>
              <input type="text" id="stt-openai-base-url" class="input-field llm-input" value="${
    stt?.provider === "openai" ? escapeHtml(stt.openai?.baseUrl || "") : ""
  }" placeholder="https://api.openai.com/v1">
            </div>
            <div class="llm-field">
              <label for="stt-openai-model">Model</label>
              <input type="text" id="stt-openai-model" class="input-field llm-input" value="${
    stt?.provider === "openai"
      ? escapeHtml(stt.openai?.model || "whisper-1")
      : "whisper-1"
  }" placeholder="whisper-1">
            </div>
          </div>
        </div>

        <!-- Custom STT fields -->
        <div id="stt-fields-custom" class="voice-provider-fields" style="display: ${
    stt?.provider === "custom" ? "block" : "none"
  }">
          <div class="llm-fields">
            <div class="llm-field">
              <label for="stt-custom-base-url">Base URL</label>
              <input type="text" id="stt-custom-base-url" class="input-field llm-input" value="${
    stt?.provider === "custom" ? escapeHtml(stt.custom?.baseUrl || "") : ""
  }" placeholder="http://localhost:8000/v1">
              <span class="field-hint">OpenAI-compatible server URL. Psycheros calls <code>&lt;this&gt;/audio/transcriptions</code>. Check your STT server's startup log for the port (common defaults: 5000, 8000, 8005, 7851). Add <code>/v1</code> if the server prefixes its routes; try without if you get a 404.</span>
            </div>
            <div class="llm-field">
              <label for="stt-custom-api-key">API Key</label>
              <div class="llm-api-key-row">
                <input type="password" id="stt-custom-api-key" class="input-field llm-input" value="${
    stt?.provider === "custom" ? escapeHtml(stt.custom?.apiKey || "") : ""
  }" placeholder="Optional">
                <button class="btn btn--ghost btn--sm llm-toggle-key" onclick="toggleVoiceFieldVisibility('stt-custom-api-key')" title="Show/hide key">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
                </button>
              </div>
            </div>
            <div class="llm-field">
              <label for="stt-custom-model">Model</label>
              <input type="text" id="stt-custom-model" class="input-field llm-input" value="${
    stt?.provider === "custom" ? escapeHtml(stt.custom?.model || "") : ""
  }" placeholder="whisper-small">
            </div>
            <div class="llm-field">
              <label for="stt-custom-language">Language</label>
              <input type="text" id="stt-custom-language" class="input-field llm-input" value="${
    stt?.provider === "custom" ? escapeHtml(stt.custom?.language || "") : ""
  }" placeholder="en">
            </div>
          </div>
        </div>
      </section>

      <!-- Voice Behavior -->
      <section class="theme-section">
        <h3 class="theme-section-title">Behavior</h3>
        <div class="llm-fields">
          <div class="llm-field">
            <label for="voice-context-window">Context Window (tokens)</label>
            <input type="number" id="voice-context-window" class="input-field llm-input" value="${
    p?.contextWindowSize || 64000
  }" min="4096" max="200000" step="4096">
          </div>
          <div class="llm-field">
            <label for="voice-vad-threshold">VAD Threshold: <span id="voice-vad-val">${
    p?.vadThreshold ?? 0.5
  }</span></label>
            <input type="range" id="voice-vad-threshold" min="0" max="1" step="0.05" value="${
    p?.vadThreshold ?? 0.5
  }" oninput="document.getElementById('voice-vad-val').textContent = this.value">
            <span class="llm-field-hint">Mic energy level that counts as speech (0&ndash;1). Higher = less sensitive (ignores more background).</span>
          </div>
          <div class="llm-field">
            <label for="voice-end-of-turn-silence">End-of-turn silence (seconds)</label>
            <input type="number" id="voice-end-of-turn-silence" class="input-field llm-input" value="${
    p?.endOfTurnSilence ?? 1.5
  }" min="0.3" max="5" step="0.1">
            <span class="llm-field-hint">Silence duration before turn ends. Server-side STT only.</span>
          </div>
          <div class="llm-field">
            <label for="voice-phrase-debounce">Phrase debounce (milliseconds)</label>
            <input type="number" id="voice-phrase-debounce" class="input-field llm-input" value="${
    p?.phraseDebounceMs ?? 1200
  }" min="300" max="5000" step="100">
            <span class="llm-field-hint">Browser STT fires a final result at every natural pause &mdash; this batches consecutive phrases into one utterance. Higher = longer sentences before sending; lower = faster but more fragmented.</span>
          </div>
          <div class="llm-field">
            <label style="display: flex; align-items: center; gap: var(--sp-2); cursor: pointer;">
              <input type="checkbox" id="voice-stt-debug" ${
    p?.sttDebug ? "checked" : ""
  }>
              <span>Show STT debug toasts</span>
            </label>
            <span class="llm-field-hint">Surfaces SpeechRecognition events during a call (listening started, speech detected, interim and final transcripts). STT error toasts always show.</span>
          </div>
          <div class="llm-field">
            <label for="voice-idle-timeout">Idle Timeout (seconds)</label>
            <input type="number" id="voice-idle-timeout" class="input-field llm-input" value="${
    p?.idleTimeoutSeconds || 300
  }" min="30" max="1800" step="30">
          </div>
          <div class="llm-field">
            <label style="display: flex; align-items: center; gap: var(--sp-2); cursor: pointer;">
              <input type="checkbox" id="voice-disable-reasoning" ${
    p?.disableReasoning !== false ? "checked" : ""
  }>
              <span>Disable LLM reasoning/thinking</span>
            </label>
            <span class="llm-field-hint">Faster responses. Default on.</span>
          </div>
          <div class="llm-field">
            <label for="voice-effect">Voice effects</label>
            <select id="voice-effect" class="input-field llm-input">
              <option value="none" ${
    p?.voiceEffect === "none" || !p?.voiceEffect ? "selected" : ""
  }>None</option>
              <option value="comms" ${
    p?.voiceEffect === "comms" ? "selected" : ""
  }>Comms &mdash; sci-fi intercom</option>
              <option value="robot" ${
    p?.voiceEffect === "robot" ? "selected" : ""
  }>Robot &mdash; metallic</option>
              <option value="telephone" ${
    p?.voiceEffect === "telephone" ? "selected" : ""
  }>Telephone &mdash; retro lo-fi</option>
              <option value="deep" ${
    p?.voiceEffect === "deep" ? "selected" : ""
  }>Deep &mdash; commanding</option>
              <option value="cavern" ${
    p?.voiceEffect === "cavern" ? "selected" : ""
  }>Cavern &mdash; distant space</option>
            </select>
            <button type="button" class="btn btn--ghost btn--sm" onclick="testVoiceEffect()" style="margin-top: var(--sp-1);">Test Effect</button>
            <span class="llm-field-hint">Adds character to TTS playback.</span>
          </div>
          <div class="llm-field">
            <label for="voice-custom-instructions">Custom Instructions</label>
            <textarea id="voice-custom-instructions" class="input-field llm-input" rows="3" placeholder="Additional instructions for voice mode...">${
    p ? escapeHtml(p.customInstructions) : ""
  }</textarea>
          </div>
        </div>
      </section>

      <!-- Keep-Alive -->
      <section class="theme-section">
        <h3 class="theme-section-title">TTS Keep-Alive</h3>
        <p class="theme-section-desc">Prevents voice deletion on providers like Minimax (deletes unused voices after 7 days).</p>
        <div class="llm-fields">
          <div class="llm-field">
            <label for="voice-keep-alive-days">Keep-alive interval (days, 0 = disabled)</label>
            <input type="number" id="voice-keep-alive-days" class="input-field llm-input" value="${
    p?.ttsKeepAliveDays || 0
  }" min="0" max="30" step="1">
          </div>
          ${
    p?.lastKeepAlive
      ? `<div class="llm-field"><span style="font-size: var(--text-xs); color: var(--text-dim);">Last keep-alive: ${
        escapeHtml(p.lastKeepAlive)
      }</span></div>`
      : ""
  }
        </div>
      </section>

      <!-- Pronunciation -->
      <section class="theme-section">
        <h3 class="theme-section-title">Pronunciation (TTS)</h3>
        <p class="theme-section-desc">Map written words to phonetic spellings so the TTS engine pronounces them correctly. Applied to LLM output before synthesis.</p>
        <div id="pronunciation-list">
          ${pronunciationRows()}
        </div>
        <button class="btn btn--ghost btn--sm" onclick="addPronunciationEntry()" style="margin-top: var(--sp-2);">+ Add Entry</button>
      </section>

      <!-- STT Corrections -->
      <section class="theme-section">
        <h3 class="theme-section-title">STT Corrections</h3>
        <p class="theme-section-desc">Fix consistent misrecognitions before the LLM sees them. Useful for proper nouns &mdash; e.g. map "sih keh ros" &rarr; "Psycheros" so Whisper/Deepgram mistakes get corrected automatically.</p>
        <div id="stt-corrections-list">
          ${sttCorrectionRows()}
        </div>
        <button class="btn btn--ghost btn--sm" onclick="addSTTCorrectionEntry()" style="margin-top: var(--sp-2);">+ Add Entry</button>
      </section>

      <!-- Action Bar -->
      <div class="llm-actions">
        <div class="llm-actions-left">
          <button class="btn btn--primary" onclick="saveVoiceProfile(event)">Save Profile</button>
          <button class="btn btn--ghost" onclick="testTTSConnection()" id="test-tts-btn">Test TTS</button>
          ${
    !isNew && !isActive
      ? `<button class="btn btn--ghost" onclick="setActiveVoiceProfile('${
        escapeHtml(id)
      }')">Set as Active</button>`
      : ""
  }
        </div>
        <div class="llm-actions-right">
          ${
    !isNew
      ? `<button class="btn btn--ghost" onclick="deleteVoiceProfile('${
        escapeHtml(id)
      }')" id="delete-voice-profile-btn">Delete Profile</button>`
      : ""
  }
          <button class="btn btn--ghost" onclick="htmx.ajax('GET', '/fragments/settings/voice', { target: '#chat', swap: 'innerHTML' })">Cancel</button>
        </div>
      </div>
    </div>
  </div>
</div>`;
}

export function renderVoiceCallView(
  conversationId: string,
  profile: VoiceProfile,
  pttKeys: string[],
  voiceChatDebug: boolean,
): string {
  const sttProvider = profile.providerSettings.stt.provider;
  return `<div class="voice-overlay" id="voice-overlay">
  <div class="voice-call">
    <div class="voice-status" id="voice-status">
      <span class="voice-status-dot voice-status-dot--connecting" id="voice-status-dot"></span>
      <span id="voice-status-text">Connecting...</span>
      <button class="btn btn--ghost" id="test-tts-btn" onclick="testTTSConnection()" style="margin-left: auto; font-size: var(--text-xs);">Test TTS</button>
    </div>

    <div class="voice-transcript" id="voice-transcript" aria-live="polite"></div>

    <div class="voice-text-input-area" id="voice-text-input-area" style="display: none;">
      <textarea
        class="voice-text-input"
        id="voice-text-input"
        placeholder="Type a message..."
        rows="2"
        onkeydown="handleVoiceTextInputKey(event)"
      ></textarea>
      <button class="voice-btn voice-text-send-btn" id="voice-text-send-btn" onclick="sendVoiceTextInput()" aria-label="Send" title="Send">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>
      </button>
    </div>

    <div class="voice-controls">
      <button class="voice-btn" id="voice-btn-yinyang" onclick="toggleYinYangMode()" aria-label="Toggle Yin Yang mode" title="Yin Yang mode (type instead of speak)">
        ☯
      </button>
      <button class="voice-btn" id="voice-btn-ptt-toggle" onclick="togglePTTMode()" aria-label="Toggle push-to-talk" title="Push to talk">
        🎙️
      </button>
      <button class="voice-btn voice-btn--end" onclick="endVoiceChat()" aria-label="End voice call" title="End call">
        📞
      </button>
    </div>

    <div class="voice-hold-circle-container" id="voice-hold-circle" style="display: none;">
      <button class="voice-hold-circle" id="voice-hold-btn"
        onmousedown="startPTT()" ontouchstart="startPTT()"
        onmouseup="endPTT()" ontouchend="endPTT()"
        aria-label="Hold to talk" title="Hold to talk">
        <span>HOLD<br>TO<br>TALK</span>
      </button>
    </div>

    <div class="voice-tools" id="voice-tools"></div>
  </div>
</div>

<script type="application/json" id="voice-config">${
    escapeHtml(
      JSON.stringify({ conversationId }),
    )
  }</script>
<script type="application/json" id="voice-status-cfg">${
    escapeHtml(
      JSON.stringify({
        wsUrl: `/api/voice/ws?conversationId=${conversationId}`,
        sttProvider,
        pttKeys,
        endOfTurnSilence: profile.endOfTurnSilence ?? 1.5,
        phraseDebounceMs: profile.phraseDebounceMs ?? 1200,
        sttDebug: profile.sttDebug ?? false,
        voiceChatDebug: voiceChatDebug ?? false,
        sttLanguage: profile.providerSettings.stt.browser?.language ?? "",
        voiceEffect: profile.voiceEffect ?? "none",
      }),
    )
  }</script>`;
}
