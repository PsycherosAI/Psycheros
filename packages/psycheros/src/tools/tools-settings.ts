/**
 * Tools Settings
 *
 * Manages tool enable/disable state persistence and resolution.
 * Tools settings are stored in `.psycheros/tools-settings.json` and
 * take precedence over the PSYCHEROS_TOOLS env var once saved.
 */

import { join } from "@std/path";

// =============================================================================
// Types
// =============================================================================

export interface ToolCategory {
  id: string;
  name: string;
  description: string;
  toolNames: string[];
}

export interface ToolEntry {
  name: string;
  description: string;
  category: string;
  enabled: boolean;
  parameters?: Record<string, unknown>;
}

export interface ToolsSettings {
  /** Map of tool name -> explicit enabled state.
   *  Only contains entries the user has explicitly toggled. */
  toolOverrides: Record<string, boolean>;
}

// =============================================================================
// Tool Categories
// =============================================================================

// =============================================================================
// Default-Disabled & Deprecated Tools
// =============================================================================

/** Tools that start OFF on fresh installs. Requires external configuration to be useful. */
export const DEFAULT_DISABLED_TOOLS: ReadonlySet<string> = new Set([
  "shell",
  "control_device",
  "control_lovense",
  "control_toy",
]);

/** Tools that are deprecated and hidden from both the UI and the LLM. Kept in AVAILABLE_TOOLS for potential resurrection. */
export const DEPRECATED_TOOLS: ReadonlySet<string> = new Set([
  "sync_mcp",
]);

// =============================================================================
// Tool Categories
// =============================================================================

export const TOOL_CATEGORIES: ToolCategory[] = [
  {
    id: "system",
    name: "System",
    description: "Shell execution, metrics, and system operations",
    toolNames: ["shell", "update_title", "get_metrics"],
  },
  {
    id: "identity",
    name: "Identity",
    description: "Self, user, and relationship identity management",
    toolNames: [
      "maintain_identity",
      "list_identity_snapshots",
      "custom_identity_file",
    ],
  },
  {
    id: "vault",
    name: "Data Vault",
    description: "Document storage and retrieval",
    toolNames: ["vault"],
  },
  {
    id: "web-search",
    name: "Web Search",
    description: "Search the web for current information",
    toolNames: ["web_search"],
  },
  {
    id: "pulse",
    name: "Pulse",
    description: "Autonomous entity prompts and scheduling",
    toolNames: ["pulse"],
  },
  {
    id: "memory",
    name: "Memory",
    description: "Significant memory creation",
    toolNames: ["create_significant_memory"],
  },
  {
    id: "discord",
    name: "Discord",
    description: "Send Discord direct messages to the user",
    toolNames: ["send_discord_dm"],
  },
  {
    id: "home-automation",
    name: "Home Automation",
    description: "Control smart home devices",
    toolNames: ["control_device"],
  },
  {
    id: "intimacy",
    name: "Intimacy",
    description: "Control Lovense devices and universal protocol toys",
    toolNames: ["control_lovense", "control_toy"],
  },
  {
    id: "vision",
    name: "Vision",
    description: "Image generation, captioning, and visual analysis",
    toolNames: ["generate_image", "describe_image", "look_closer"],
  },
];

// =============================================================================
// Defaults
// =============================================================================

const DEFAULT_TOOLS_SETTINGS: ToolsSettings = {
  toolOverrides: {},
};

// =============================================================================
// Load / Save
// =============================================================================

/**
 * Load tools settings from the settings file.
 * Returns defaults if the file doesn't exist or is invalid.
 */
export async function loadToolsSettings(
  dataRoot: string,
): Promise<ToolsSettings> {
  const settingsPath = join(dataRoot, ".psycheros", "tools-settings.json");

  try {
    const text = await Deno.readTextFile(settingsPath);
    const saved = JSON.parse(text) as Partial<ToolsSettings>;
    return {
      ...DEFAULT_TOOLS_SETTINGS,
      ...saved,
      toolOverrides: { ...(saved.toolOverrides ?? {}) },
    };
  } catch {
    return { ...DEFAULT_TOOLS_SETTINGS };
  }
}

/**
 * Save tools settings to the settings file.
 * Creates the `.psycheros/` directory if it doesn't exist.
 */
export async function saveToolsSettings(
  dataRoot: string,
  settings: ToolsSettings,
): Promise<void> {
  const settingsDir = join(dataRoot, ".psycheros");
  const settingsPath = join(settingsDir, "tools-settings.json");

  await Deno.mkdir(settingsDir, { recursive: true });
  await Deno.writeTextFile(
    settingsPath,
    JSON.stringify(settings, null, 2) + "\n",
  );
}

// =============================================================================
// Resolution
// =============================================================================

/**
 * Resolve the final list of enabled tool names by merging env var,
 * user overrides, and auto-enabled tools.
 *
 * Priority:
 * 1. Deprecated tools are always excluded (never sent to LLM).
 * 2. If toolOverrides has an entry for a tool, use that value.
 * 3. Default-disabled tools are off unless explicitly enabled or auto-enabled.
 * 4. Otherwise, if the env var list includes the tool, it's enabled.
 * 5. Auto-enabled tools are always enabled regardless.
 *
 * @param settings - The loaded tools settings
 * @param allToolNames - All known tool names (built-in + custom)
 * @param envToolNames - Tools from PSYCHEROS_TOOLS env var
 * @param autoEnabledToolNames - Tools that should always be enabled (e.g. web_search when provider configured)
 */
export function getEnabledToolNames(
  settings: ToolsSettings,
  allToolNames: string[],
  envToolNames: string[],
  autoEnabledToolNames: string[],
): string[] {
  const envSet = new Set(envToolNames.map((t) => t.toLowerCase()));
  const autoSet = new Set(autoEnabledToolNames.map((t) => t.toLowerCase()));
  const overrides = settings.toolOverrides;

  // Empty/unset env var is equivalent to "all" — enable everything unless overridden
  const envAllowsAll = envSet.has("all") || envToolNames.length === 0;

  // If env says "none" and no overrides exist, only auto-enabled tools
  if (envSet.has("none") && Object.keys(overrides).length === 0) {
    return autoEnabledToolNames.filter((n) =>
      !DEPRECATED_TOOLS.has(n.toLowerCase())
    );
  }

  const enabled: string[] = [];

  for (const name of allToolNames) {
    const lower = name.toLowerCase();

    // Deprecated tools are always excluded
    if (DEPRECATED_TOOLS.has(lower)) continue;

    // Explicit override takes precedence
    if (lower in overrides) {
      if (overrides[lower]) {
        enabled.push(name);
      }
      continue;
    }

    // Auto-enabled tools are always on (even if default-disabled)
    if (autoSet.has(lower)) {
      enabled.push(name);
      continue;
    }

    // Default-disabled tools are off unless explicitly enabled above
    if (DEFAULT_DISABLED_TOOLS.has(lower)) continue;

    // Fall back to env var list
    if (envAllowsAll || envSet.has(lower)) {
      enabled.push(name);
    }
  }

  return enabled;
}
