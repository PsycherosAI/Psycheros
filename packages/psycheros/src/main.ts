/**
 * Psycheros Daemon Entry Point
 *
 * Starts the persistent entity harness server.
 */

import "@std/dotenv/load";
import { initLogCapture } from "./server/logger.ts";
initLogCapture();

import { Server } from "./server/mod.ts";
import { createMCPClient, type MCPClient } from "./mcp-client/mod.ts";
import { initialize } from "./init/mod.ts";
import { prepareVectorExtension } from "./db/mod.ts";
import { getDefaultWebSearchSettings } from "./llm/web-search-settings.ts";
import { loadEntityCoreLLMSettings } from "./llm/entity-core-settings.ts";
import { join } from "@std/path";
import { VERSION } from "./version.ts";

/**
 * Parse the PSYCHEROS_TOOLS environment variable into an array of tool names.
 * Empty/unset means "all tools" — the downstream tool registry treats `[]` as
 * a wildcard (see `getEnabledToolNames` in `src/tools/tools-settings.ts`).
 * Use PSYCHEROS_TOOLS=none to disable all non-auto tools.
 * Use PSYCHEROS_TOOLS=tool1,tool2 to enable specific tools.
 */
function parseAllowedTools(): string[] {
  const toolsEnv = Deno.env.get("PSYCHEROS_TOOLS");
  if (!toolsEnv || toolsEnv.trim() === "") {
    return [];
  }
  return toolsEnv
    .split(",")
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t.length > 0);
}

/**
 * Parse the PSYCHEROS_RAG_ENABLED environment variable.
 * Defaults to true (RAG enabled by default).
 */
function parseRagEnabled(): boolean {
  const env = Deno.env.get("PSYCHEROS_RAG_ENABLED");
  if (env === undefined || env === "") {
    return true; // Default to enabled
  }
  return env.toLowerCase() === "true" || env === "1";
}

// Configuration from environment or defaults
const allowedTools = parseAllowedTools();
const ragEnabled = parseRagEnabled();
const projectRoot = Deno.cwd();
// PSYCHEROS_DATA_DIR lets the launcher (or operators) point runtime state at
// a stable location independent of where psycheros source lives. When unset
// dataRoot falls back to projectRoot, preserving today's `deno task start`
// behaviour exactly. See packages/launcher-v2/docs/architecture.md for the
// launcher-side context.
const dataRoot = Deno.env.get("PSYCHEROS_DATA_DIR") || projectRoot;
const config = {
  port: parseInt(Deno.env.get("PSYCHEROS_PORT") || "3000"),
  hostname: Deno.env.get("PSYCHEROS_HOST") || "0.0.0.0",
  projectRoot,
  dataRoot,
  allowedTools,
  ragConfig: {
    enabled: ragEnabled,
    maxChunks: parseInt(Deno.env.get("PSYCHEROS_RAG_MAX_CHUNKS") || "8"),
    maxTokens: parseInt(Deno.env.get("PSYCHEROS_RAG_MAX_TOKENS") || "2000"),
    minScore: parseFloat(Deno.env.get("PSYCHEROS_RAG_MIN_SCORE") || "0.3"),
  },
};

console.log(`
╔═══════════════════════════════════════╗
║  Psycheros v${VERSION}                     ║
║  Entity Harness Daemon                ║
╚═══════════════════════════════════════╝
`);

// Initialize user data directories from templates. Reads templates from
// projectRoot (source bundle), writes to dataRoot (runtime state location).
await initialize(config.projectRoot, config.dataRoot);

console.log(`Starting server on http://${config.hostname}:${config.port}`);
console.log(`Project root: ${config.projectRoot}`);
if (config.dataRoot !== config.projectRoot) {
  console.log(`Data root:    ${config.dataRoot}`);
}
console.log(
  `Tools enabled (PSYCHEROS_TOOLS): ${
    allowedTools.length > 0 ? allowedTools.join(", ") : "(default — all tools)"
  }`,
);
console.log(`RAG enabled: ${ragEnabled}`);
const webSearchDefaults = getDefaultWebSearchSettings();
console.log(`Web search: ${webSearchDefaults.provider}`);
console.log(`Press Ctrl+C to stop\n`);

// Initialize MCP client if enabled
let mcpClient: MCPClient | undefined;
const mcpEnabled = Deno.env.get("PSYCHEROS_MCP_ENABLED") !== "false";

// Load LLM profile settings for entity-core env vars
const { loadProfileSettings, getActiveProfile } = await import("./llm/mod.ts");
const activeProfile = getActiveProfile(
  await loadProfileSettings(config.dataRoot),
);
if (activeProfile) {
  console.log(
    `Active LLM profile: "${activeProfile.name}" (${activeProfile.provider}) — ${activeProfile.model}`,
  );
}

if (mcpEnabled) {
  const mcpCommand = Deno.env.get("PSYCHEROS_MCP_COMMAND") || "deno";
  const entityCoreRoot = Deno.env.get("PSYCHEROS_ENTITY_CORE_PATH") ||
    join(config.projectRoot, "..", "entity-core");
  // Build argv as a proper array — the previous "interpolate path into one
  // string then split(' ')" pattern shattered paths containing spaces (e.g.
  // macOS launcher installs at `~/Library/Application Support/...`). The
  // env-var override still uses naive split for backwards compat; callers
  // setting PSYCHEROS_MCP_ARGS are expected to handle escaping themselves.
  const customArgs = Deno.env.get("PSYCHEROS_MCP_ARGS");
  const mcpArgs: string[] = customArgs
    ? customArgs.split(" ")
    : ["run", "-A", `${entityCoreRoot}/src/mod.ts`];
  const mcpInstance = Deno.env.get("PSYCHEROS_MCP_INSTANCE") || "psycheros";
  const entityCoreDataDir = Deno.env.get("PSYCHEROS_ENTITY_CORE_DATA_DIR") ||
    `${entityCoreRoot}/data`;

  console.log(`MCP enabled: connecting to entity-core as ${mcpInstance}`);

  // Load entity-core LLM overrides (model/temperature/maxTokens independent of chat model)
  const ecLLMSettings = await loadEntityCoreLLMSettings(config.dataRoot);
  const ecTemperature = ecLLMSettings.temperature ?? 0.3;
  const ecMaxTokens = ecLLMSettings.maxTokens ?? 8000;

  mcpClient = createMCPClient({
    command: mcpCommand,
    args: mcpArgs,
    instanceId: mcpInstance,
    env: {
      ENTITY_CORE_DATA_DIR: entityCoreDataDir,
      PSYCHEROS_PLUGIN_DIR: join(config.dataRoot, ".psycheros", "plugins"),
      // Entity-core LLM settings — prefer entity-core override, then active profile, then ZAI_* vars
      ENTITY_CORE_LLM_API_KEY: Deno.env.get("ENTITY_CORE_LLM_API_KEY") ||
        activeProfile?.apiKey || Deno.env.get("ZAI_API_KEY") || "",
      ENTITY_CORE_LLM_BASE_URL: Deno.env.get("ENTITY_CORE_LLM_BASE_URL") ||
        activeProfile?.baseUrl || Deno.env.get("ZAI_BASE_URL") || "",
      ENTITY_CORE_LLM_MODEL: ecLLMSettings.model ||
        Deno.env.get("ENTITY_CORE_LLM_MODEL") || activeProfile?.model ||
        Deno.env.get("ZAI_MODEL") || "",
      ENTITY_CORE_LLM_TEMPERATURE:
        Deno.env.get("ENTITY_CORE_LLM_TEMPERATURE") || String(ecTemperature),
      ENTITY_CORE_LLM_MAX_TOKENS: Deno.env.get("ENTITY_CORE_LLM_MAX_TOKENS") ||
        String(ecMaxTokens),
      // Also pass ZAI_* directly for any code paths that read those
      ZAI_API_KEY: Deno.env.get("ZAI_API_KEY") || "",
      ZAI_BASE_URL: Deno.env.get("ZAI_BASE_URL") || "",
      ZAI_MODEL: Deno.env.get("ZAI_MODEL") || "",
    },
    syncOnStartup: true,
    offlineFallback: true,
    localBasePath: config.dataRoot,
  });

  // Await connection before server init to avoid race conditions
  try {
    const connected = await mcpClient.connect();
    if (connected) {
      console.log("[MCP] Connected to entity-core");
    } else {
      console.log("[MCP] Running in offline mode (will sync when available)");
    }
  } catch (error) {
    console.error("[MCP] Connection failed:", error);
    console.log("[MCP] Running in offline mode");
  }
}

// Ensure sqlite-vec extension is available before database initialization
await prepareVectorExtension(config.projectRoot);

const server = new Server({
  ...config,
  mcpClient,
});

await server.init();

// Handle graceful shutdown
async function shutdown() {
  console.log("\nShutting down...");

  // Disconnect MCP client (triggers final sync)
  if (mcpClient) {
    console.log("[MCP] Syncing and disconnecting...");
    await mcpClient.disconnect();
  }

  await server.stop();
  Deno.exit(0);
}

Deno.addSignalListener("SIGINT", shutdown);
Deno.addSignalListener("SIGTERM", shutdown);

await server.start();
