/**
 * UI Update Generation
 *
 * Generates HTML fragments for reactive UI updates when tools modify state.
 * Maps region names to rendered HTML that can be swapped into the DOM.
 *
 * @module
 */

import type { DBClient } from "../db/mod.ts";
import type { UIUpdate } from "../types.ts";
import { renderConversationList, renderHeaderTitle } from "./templates.ts";

/**
 * Configuration for a UI region.
 */
interface UIRegionConfig {
  target: string;
  swap?: string;
  classes?: string;
}

/**
 * Map of UI region names to their CSS selectors, swap strategies, and element classes.
 * The `classes` field is used when rendering OOB swaps to preserve element styling.
 */
const UI_REGIONS: Record<string, UIRegionConfig> = {
  "conv-list": { target: "#conv-list", swap: "innerHTML" },
  "header-title": {
    target: "#header-title",
    swap: "innerHTML",
    classes: "logo-sub",
  },
};

/**
 * Reverse lookup map from CSS selector to region config.
 * Pre-computed for O(1) lookup in renderAsOobSwaps.
 */
const UI_REGIONS_BY_TARGET: Map<string, UIRegionConfig> = new Map(
  Object.values(UI_REGIONS).map((config) => [config.target, config]),
);

/**
 * Generate UI updates for the specified regions.
 *
 * @param regions - Array of region names to update
 * @param db - Database client for fetching fresh data
 * @param conversationId - Optional conversation ID (for context-specific updates like header-title)
 * @returns Array of UIUpdate objects ready to send to the client
 */
export function generateUIUpdates(
  regions: string[],
  db: DBClient,
  conversationId?: string,
): UIUpdate[] {
  const updates: UIUpdate[] = [];

  for (const region of regions) {
    const regionConfig = UI_REGIONS[region];
    if (!regionConfig) {
      console.warn(`Unknown UI region: ${region}`);
      continue;
    }

    const html = renderRegion(region, db, conversationId);
    if (html !== null) {
      updates.push({
        target: regionConfig.target,
        html,
        swap: regionConfig.swap,
      });
    }
  }

  return updates;
}

/**
 * Render the HTML for a specific UI region.
 *
 * @param region - The region name to render
 * @param db - Database client for fetching data
 * @param conversationId - Optional conversation ID (required for header-title)
 * @returns HTML string or null if region is unknown or cannot be rendered
 */
function renderRegion(
  region: string,
  db: DBClient,
  conversationId?: string,
): string | null {
  switch (region) {
    case "conv-list": {
      const conversations = db.listConversations();
      const allPulses = db.listPulses({ enabled: true });
      const pulseConversationIds = new Set<string>();
      for (const pulse of allPulses) {
        if (pulse.conversationId) {
          pulseConversationIds.add(pulse.conversationId);
        }
      }
      return renderConversationList(conversations, pulseConversationIds);
    }
    case "header-title": {
      // Skip header-title if no conversationId provided
      if (!conversationId) {
        return null;
      }
      const conversation = db.getConversation(conversationId);
      return renderHeaderTitle(conversation?.title);
    }
    default:
      return null;
  }
}

/**
 * Convert UI updates to HTMX out-of-band swap HTML.
 * Used by API endpoints to return reactive updates in responses.
 *
 * @param updates - Array of UIUpdate objects
 * @returns HTML string with OOB swap elements
 */
export function renderAsOobSwaps(updates: UIUpdate[]): string {
  return updates
    .map((update) => {
      // Extract element ID from target selector (assumes "#id" format)
      const id = update.target.startsWith("#")
        ? update.target.slice(1)
        : update.target;

      // Get classes for this region if defined (O(1) lookup via pre-computed map)
      const regionConfig = UI_REGIONS_BY_TARGET.get(update.target);
      const classAttr = regionConfig?.classes
        ? ` class="${regionConfig.classes}"`
        : "";

      // Determine the appropriate element tag based on the target
      const tag = getElementTag(id);

      return `<${tag}${classAttr} id="${id}" hx-swap-oob="true">${update.html}</${tag}>`;
    })
    .join("");
}

/**
 * Get the appropriate HTML tag for a region ID.
 * Defaults to "div" for unknown regions.
 */
function getElementTag(id: string): string {
  switch (id) {
    case "header-title":
      return "span";
    case "conv-list":
      return "nav";
    default:
      return "div";
  }
}
