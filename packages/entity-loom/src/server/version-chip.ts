/**
 * Version chip helper for entity-loom's static HTML.
 *
 * Both wizard.html and graph.html embed a `<!--VERSION_CHIP-->` marker
 * just before `</body>`. The server substitutes it at startup with the
 * rendered chip (clickable for public builds, non-interactive for staging
 * builds). Tooltip reports entity-loom + entity-core versions together
 * since users routinely care about both — the graph engine version often
 * matters more than the wrapper's.
 */

import {
  FLAVOR_LABEL,
  IS_PRERELEASE,
  IS_STAGING,
  VERSION,
  VERSION_BASE,
  VERSION_SUFFIX,
} from "../version.ts";
import entityCoreDenoJson from "../../../entity-core/deno.json" with {
  type: "json",
};

const ENTITY_CORE_VERSION: string = entityCoreDenoJson.version;

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const CHIP_STYLES = `<style>
  .psy-version-chip {
    position: fixed;
    bottom: 8px;
    right: 12px;
    font-family: monospace;
    font-size: 0.75rem;
    color: var(--fg-muted, #8b949e);
    text-decoration: none;
    padding: 2px 6px;
    border-radius: 4px;
    background: var(--bg-raised, transparent);
    border: 1px solid var(--border, transparent);
    transition: color 0.2s ease, background-color 0.2s ease;
    z-index: 9999;
  }
  .psy-version-chip:hover {
    color: var(--accent, #58a6ff);
    background-color: var(--accent-subtle, rgba(56, 139, 253, 0.15));
  }
  .psy-version-chip--staging,
  .psy-version-chip--staging:hover {
    color: var(--fg-muted, #8b949e);
    background: var(--bg-raised, transparent);
    cursor: default;
  }
  .psy-version-chip__flavor {
    color: var(--warn, #d29922);
    font-style: italic;
  }
</style>`;

export function renderVersionChip(): string {
  const baseHtml = escapeHtml(VERSION_BASE);
  const tooltip = escapeHtml(
    `entity-loom ${VERSION} · entity-core ${ENTITY_CORE_VERSION}`,
  );
  if (IS_PRERELEASE) {
    return `${CHIP_STYLES}<span class="psy-version-chip psy-version-chip--staging" title="${tooltip}">v${baseHtml}<span class="psy-version-chip__flavor"> · ${
      escapeHtml(FLAVOR_LABEL)
    }</span></span>`;
  }
  const href =
    `https://github.com/PsycherosAI/Psycheros/releases/tag/entity-loom-v${
      encodeURIComponent(VERSION_BASE)
    }`;
  return `${CHIP_STYLES}<a class="psy-version-chip" href="${href}" target="_blank" rel="noopener" title="${tooltip}">v${baseHtml}</a>`;
}

/**
 * Substitute the `<!--VERSION_CHIP-->` marker in an HTML document.
 * Idempotent: if the marker is missing, returns the html unchanged.
 */
export function injectVersionChip(html: string): string {
  return html.replace("<!--VERSION_CHIP-->", renderVersionChip());
}

export interface VersionPayload {
  name: string;
  version: string;
  version_base: string;
  version_suffix: string;
  is_staging: boolean;
  is_prerelease: boolean;
  flavor: string;
  entity_core_version: string;
}

export function getVersionPayload(): VersionPayload {
  return {
    name: "entity-loom",
    version: VERSION,
    version_base: VERSION_BASE,
    version_suffix: VERSION_SUFFIX,
    is_staging: IS_STAGING,
    is_prerelease: IS_PRERELEASE,
    flavor: FLAVOR_LABEL,
    entity_core_version: ENTITY_CORE_VERSION,
  };
}
