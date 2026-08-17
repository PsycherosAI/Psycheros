/**
 * Tool-Specific Type Definitions
 *
 * Types for the tool execution system that extends the shared types
 * from src/types.ts.
 */

import type { DBClient } from "../db/mod.ts";
import type { ToolDefinition, ToolResult } from "../types.ts";
import type { EntityConfig } from "../entity/loop.ts";

// =============================================================================
// Tool Context Types
// =============================================================================

/**
 * Context passed to every tool execution.
 * Provides access to app services and execution metadata.
 */
export interface ToolContext {
  /** The unique ID of this tool call (for result tracking) */
  toolCallId: string;
  /** The conversation this tool is executing within */
  conversationId: string;
  /** Database client for persistence operations */
  db: DBClient;
  /** Entity configuration (project root, etc.) */
  config: EntityConfig;
}

// =============================================================================
// Tool Executor Types
// =============================================================================

/**
 * A function that executes a tool with the given arguments and context.
 * Arguments are parsed from the JSON string provided in the tool call.
 *
 * @param args - The parsed arguments object
 * @param ctx - The execution context with services and metadata
 * @returns A promise resolving to the tool execution result
 */
export type ToolExecutor = (
  args: Record<string, unknown>,
  ctx: ToolContext,
) => Promise<ToolResult>;

// =============================================================================
// Tool Registration Types
// =============================================================================

/**
 * Subset of {@link ToolContext} used for per-turn visibility filtering.
 *
 * Tools that only make sense in specific conversation contexts (workspace
 * sessions, plugin-authoring flows, etc.) set a `visibleIn` predicate. The
 * registry consults the predicate when building the tool list for an entity
 * turn and hides tools whose predicate returns false. Predicates run per turn,
 * so they should be cheap (an in-memory lookup or a single indexed DB read).
 */
export interface ToolVisibilityContext {
  /** The conversation this turn is executing within */
  conversationId: string;
  /** Database client for conversation/session lookups */
  db: DBClient;
}

/**
 * A complete tool registration entry containing both the definition
 * (sent to the LLM) and the executor (used to run the tool).
 */
export interface Tool {
  /** The tool definition that describes the tool to the LLM */
  definition: ToolDefinition;
  /** The function that executes the tool with context */
  execute: ToolExecutor;
  /**
   * Optional predicate that gates whether this tool appears in the LLM's tool
   * list for a given turn. When omitted, the tool is always visible. Use this
   * to hide workspace-only or context-specific tools from conversations where
   * they'd waste tokens or confuse escalation paths.
   */
  visibleIn?: (ctx: ToolVisibilityContext) => boolean;
}

// =============================================================================
// Shell Tool Specific Types
// =============================================================================

/**
 * Arguments for the shell tool.
 */
export interface ShellToolArgs {
  /** The shell command to execute */
  command: string;
  /** Optional working directory for the command */
  workingDir?: string;
  /** Optional timeout in milliseconds (default: 30000) */
  timeout?: number;
}
