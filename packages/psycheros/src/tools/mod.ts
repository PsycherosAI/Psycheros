/**
 * Tools Module
 *
 * This module provides the tool execution system for the Psycheros entity.
 * Tools enable the entity to perform actions like executing shell commands,
 * file operations, and other system interactions.
 *
 * @module
 *
 * @example
 * ```typescript
 * import { createDefaultRegistry, type ToolContext } from "./tools/mod.ts";
 *
 * const registry = createDefaultRegistry();
 *
 * // Get definitions for LLM
 * const definitions = registry.getDefinitions();
 *
 * // Build context for tool execution
 * const context: Omit<ToolContext, "toolCallId"> = {
 *   conversationId: "conv_123",
 *   db: dbClient,
 *   config: entityConfig,
 * };
 *
 * // Execute a tool call from LLM response
 * const result = await registry.execute({
 *   id: "call_123",
 *   type: "function",
 *   function: {
 *     name: "shell",
 *     arguments: JSON.stringify({ command: "echo hello" })
 *   }
 * }, context);
 * ```
 */

// Re-export types (only those used externally)
export type { ShellToolArgs, Tool, ToolContext } from "./types.ts";

// Re-export registry and catalog
export {
  AVAILABLE_TOOLS,
  createDefaultRegistry,
  ToolRegistry,
} from "./registry.ts";

// Re-export tools settings
export {
  DEFAULT_DISABLED_TOOLS,
  DEPRECATED_TOOLS,
  getEnabledToolNames,
  loadToolsSettings,
  saveToolsSettings,
  TOOL_CATEGORIES,
} from "./tools-settings.ts";
export type {
  ToolCategory,
  ToolEntry,
  ToolsSettings,
} from "./tools-settings.ts";

// Re-export custom tools loader
export { loadCustomTools } from "./custom-loader.ts";
