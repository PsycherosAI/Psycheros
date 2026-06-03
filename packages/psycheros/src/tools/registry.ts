/**
 * Tool Registry
 *
 * Manages registration and execution of tools available to the entity.
 * Provides a central registry for looking up tool definitions and executors.
 */

import type { ToolCall, ToolDefinition, ToolResult } from "../types.ts";
import type { Tool, ToolContext } from "./types.ts";
import { shellTool } from "./shell.ts";
import { updateTitleTool } from "./update_title.ts";
import { getMetricsTool } from "./get_metrics.ts";
import { createSignificantMemoryTool } from "./create-significant-memory.ts";
import { syncMcpTool } from "./sync-mcp.ts";
// Identity tools
import { maintainIdentityTool } from "./identity-maintain.ts";
import { listIdentitySnapshotsTool } from "./identity-maintain.ts";
import { customFileTool } from "./identity-custom.ts";
// Graph tools (disabled — entity-core handles graph automatically via memory extraction + eager RAG)
// import { graphQueryTool } from "./graph-read.ts";
// import { graphMutateTool, graphWriteBatchTool } from "./graph-write.ts";
// Vault tools
import { vaultTool } from "./vault-tools.ts";
// Web search tool
import { webSearchTool } from "./web-search.ts";
// Pulse tools
import { pulseTool } from "./pulse-tools.ts";
// Push notification tool (disabled — buggy with Android webapp)
// import { sendNotificationTool } from "./send-notification.ts";
// Discord DM tool
import { sendDiscordDmTool } from "./send-discord-dm.ts";
// Discord action tool (reply, react)
import { actInDiscordTool } from "./discord-action.ts";
// Home automation tool
import { controlDeviceTool } from "./control-device.ts";
// Lovense device control tool
import { controlLovenseTool } from "./control-lovense.ts";
// Buttplug device control tool
import { controlButtplugTool } from "./control-buttplug.ts";
// BLE device bridge tool
import { bleDeviceTool } from "./ble-device.ts";
// Image generation tool
import { generateImageTool } from "./generate-image.ts";
// Image captioning tool
import { describeImageTool } from "./describe-image.ts";
// Look closer tool
import { lookCloserTool } from "./look-closer.ts";
// Conversation peek tool
import { conversationPeekTool } from "./conversation-peek.ts";

// =============================================================================
// Available Tools Catalog
// =============================================================================

/**
 * All tools that can be enabled via the PSYCHEROS_TOOLS environment variable.
 * Each tool is keyed by its name (lowercase).
 */
export const AVAILABLE_TOOLS: Record<string, Tool> = {
  shell: shellTool,
  update_title: updateTitleTool,
  get_metrics: getMetricsTool,
  create_significant_memory: createSignificantMemoryTool,
  sync_mcp: syncMcpTool,
  // Identity tools
  maintain_identity: maintainIdentityTool,
  list_identity_snapshots: listIdentitySnapshotsTool,
  // Custom identity file tool
  custom_identity_file: customFileTool,
  // Graph tools (disabled — entity-core handles graph automatically via memory extraction + eager RAG)
  // graph_query: graphQueryTool,
  // graph_mutate: graphMutateTool,
  // graph_write_batch: graphWriteBatchTool,
  // Vault tools (entity document management)
  vault: vaultTool,
  // Web search tool (Tavily / Brave)
  web_search: webSearchTool,
  // Pulse tools (autonomous entity prompts)
  pulse: pulseTool,
  // Push notification tool (disabled — buggy with Android webapp)
  // send_notification: sendNotificationTool,
  // Discord DM tool
  send_discord_dm: sendDiscordDmTool,
  // Discord action tool (reply, react in channels during Discord turns)
  act_in_discord: actInDiscordTool,
  // Home automation tool
  control_device: controlDeviceTool,
  // Lovense device control tool
  control_lovense: controlLovenseTool,
  // Universal toy control tool
  control_toy: controlButtplugTool,
  // BLE device bridge tool
  ble_device: bleDeviceTool,
  // Image generation tool
  generate_image: generateImageTool,
  describe_image: describeImageTool,
  look_closer: lookCloserTool,
  // Conversation peek
  conversation_peek: conversationPeekTool,
};

/**
 * Registry for managing available tools.
 *
 * The registry stores tools by name and provides methods for:
 * - Registering new tools
 * - Getting all tool definitions (for LLM requests)
 * - Executing tool calls
 */
export class ToolRegistry {
  private tools: Map<string, Tool> = new Map();

  /**
   * Mutex that serializes tool execution across concurrent turns.
   *
   * Prevents race conditions when multiple turns (e.g., background stream +
   * new conversation, or Pulse + user chat) execute tools that modify shared
   * resources like identity files, the knowledge graph, or memory files.
   *
   * Pattern: replace the promise BEFORE awaiting to avoid the microtask race
   * where two callers both pass `await` before either sets the new promise.
   */
  private toolLock: Promise<void> = Promise.resolve();

  /**
   * Register a tool in the registry.
   *
   * @param tool - The tool to register
   * @throws Error if a tool with the same name is already registered
   */
  register(tool: Tool): void {
    const name = tool.definition.function.name;

    if (this.tools.has(name)) {
      throw new Error(`Tool '${name}' is already registered`);
    }

    this.tools.set(name, tool);
  }

  /**
   * Get all tool definitions for sending to the LLM.
   *
   * @returns Array of tool definitions
   */
  getDefinitions(): ToolDefinition[] {
    return Array.from(this.tools.values()).map((tool) => tool.definition);
  }

  /**
   * Execute a tool call with the given context.
   *
   * Parses the arguments from the tool call's JSON string,
   * finds the tool by name, and executes it with context.
   *
   * @param toolCall - The tool call to execute
   * @param baseContext - The execution context (without toolCallId, which is added automatically)
   * @returns The result of the tool execution
   */
  async execute(
    toolCall: ToolCall,
    baseContext: Omit<ToolContext, "toolCallId">,
  ): Promise<ToolResult> {
    const toolName = toolCall.function.name;
    const tool = this.tools.get(toolName);

    // Build complete context with toolCallId
    const ctx: ToolContext = {
      ...baseContext,
      toolCallId: toolCall.id,
    };

    // Handle unknown tool
    if (!tool) {
      const availableTools = Array.from(this.tools.keys()).join(", ") ||
        "(none)";
      return {
        toolCallId: toolCall.id,
        content:
          `Error: Unknown tool '${toolName}'. Available tools: ${availableTools}`,
        isError: true,
      };
    }

    // Parse arguments from JSON string
    let args: Record<string, unknown>;
    try {
      const argsString = toolCall.function.arguments;
      args = argsString.trim() === "" ? {} : JSON.parse(argsString);

      if (typeof args !== "object" || args === null || Array.isArray(args)) {
        throw new Error("Arguments must be a JSON object");
      }
    } catch (error) {
      const errorMessage = error instanceof Error
        ? error.message
        : String(error);
      return {
        toolCallId: toolCall.id,
        content: `Error parsing tool arguments: ${errorMessage}`,
        isError: true,
      };
    }

    // Execute the tool with context
    try {
      const result = await tool.execute(args, ctx);
      // Ensure the result has the correct toolCallId
      return {
        ...result,
        toolCallId: toolCall.id,
      };
    } catch (error) {
      const errorMessage = error instanceof Error
        ? error.message
        : String(error);
      return {
        toolCallId: toolCall.id,
        content: `Error executing tool '${toolName}': ${errorMessage}`,
        isError: true,
      };
    }
  }

  /**
   * Execute multiple tool calls in parallel, serialized across concurrent turns.
   *
   * Acquires a mutex lock before executing any tools, ensuring that shared
   * resources (identity files, knowledge graph, memories) are never modified
   * by two turns simultaneously. Tools within a single call still run in
   * parallel via Promise.all.
   *
   * @param toolCalls - Array of tool calls to execute
   * @param baseContext - The execution context (toolCallId added per-call)
   * @returns Array of tool results in the same order as input
   */
  async executeAll(
    toolCalls: ToolCall[],
    baseContext: Omit<ToolContext, "toolCallId">,
  ): Promise<ToolResult[]> {
    // Acquire lock: replace the promise before awaiting to prevent the
    // microtask race where two callers both pass `await` on the same promise.
    let release!: () => void;
    const myTurn = new Promise<void>((resolve) => {
      release = resolve;
    });
    const previous = this.toolLock;
    this.toolLock = myTurn;

    await previous;

    try {
      return await Promise.all(
        toolCalls.map((toolCall) => this.execute(toolCall, baseContext)),
      );
    } finally {
      release();
    }
  }
}

/**
 * Create a registry with only the specified tools enabled.
 *
 * @param allowedTools - Array of tool names to enable. Special values:
 *   - ["all"] or including "all": enable all available tools (default)
 *   - ["none"] or empty array: no tools enabled
 *   - ["tool1", "tool2"]: enable specific tools only
 * @returns A new ToolRegistry with only allowed tools registered
 *
 * @example
 * ```typescript
 * // Enable all tools (default)
 * const registry = createDefaultRegistry(["all"]);
 *
 * // Enable only shell tool
 * const registry = createDefaultRegistry(["shell"]);
 *
 * // No tools enabled
 * const registry = createDefaultRegistry(["none"]);
 * ```
 */
export function createDefaultRegistry(
  allowedTools: string[] = ["all"],
): ToolRegistry {
  const registry = new ToolRegistry();

  // Normalize tool names to lowercase for matching
  const normalizedAllowed = new Set(allowedTools.map((t) => t.toLowerCase()));

  // Handle special "none" value
  if (normalizedAllowed.has("none")) {
    return registry;
  }

  // If "all" is specified, enable all available tools
  if (normalizedAllowed.has("all")) {
    for (const tool of Object.values(AVAILABLE_TOOLS)) {
      registry.register(tool);
    }
    return registry;
  }

  // Register only specified tools
  for (const toolName of normalizedAllowed) {
    const tool = AVAILABLE_TOOLS[toolName];
    if (tool) {
      registry.register(tool);
    } else {
      console.warn(
        `Warning: Unknown tool '${toolName}' in PSYCHEROS_TOOLS. ` +
          `Available tools: ${Object.keys(AVAILABLE_TOOLS).join(", ")}`,
      );
    }
  }

  return registry;
}
