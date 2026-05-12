/**
 * Psycheros Shared Type Definitions
 *
 * Core types used throughout the Psycheros daemon for messages,
 * tools, SSE events, and conversations.
 */

// =============================================================================
// Message Types
// =============================================================================

/**
 * Represents a message in a conversation.
 */
export interface Message {
  id: string;
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCallId?: string;
  toolCalls?: ToolCall[];
  reasoningContent?: string;
  createdAt: Date;
  /** When this message was last edited (if ever) */
  editedAt?: Date;
  /** If this message was triggered by a Pulse, the Pulse's ID */
  pulseId?: string;
  /** If this message was triggered by a Pulse, the Pulse's display name */
  pulseName?: string;
}

// =============================================================================
// Tool Types
// =============================================================================

/**
 * Represents a tool call made by the assistant.
 */
export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

/**
 * Defines a tool that can be called by the LLM.
 */
export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

/**
 * Result of executing a tool call.
 */
export interface ToolResult {
  toolCallId: string;
  content: string;
  isError?: boolean;
  /** UI regions affected by this tool execution (for reactive updates) */
  affectedRegions?: string[];
}

/**
 * Represents a UI update to be sent to the client.
 * Used for reactive DOM updates when tools modify state.
 */
export interface UIUpdate {
  /** CSS selector for the target element */
  target: string;
  /** HTML fragment to swap in */
  html: string;
  /** HTMX swap strategy (default: innerHTML) */
  swap?: string;
}

// =============================================================================
// SSE Event Types (Hybrid Streaming)
// =============================================================================

/**
 * A Server-Sent Event for streaming to clients.
 *
 * Event types:
 * - thinking: Extended thinking/reasoning content
 * - content: Main response content
 * - tool_call: Tool invocation request
 * - tool_result: Result from tool execution
 * - dom_update: Reactive UI update with HTML fragment and swap target
 * - status: Status updates (e.g., "processing", "complete")
 * - metrics: Streaming performance metrics for the turn
 * - done: Stream completion signal
 * - message_id: Message ID assignment for streaming-created DOM elements
 */
export interface SSEEvent {
  type:
    | "thinking"
    | "content"
    | "tool_call"
    | "tool_result"
    | "dom_update"
    | "status"
    | "metrics"
    | "context"
    | "done"
    | "message_id"
    | "image_generated";
  data: string;
}

// =============================================================================
// Conversation/Session Types
// =============================================================================

/**
 * Represents a conversation session.
 */
export interface Conversation {
  id: string;
  title?: string;
  createdAt: Date;
  updatedAt: Date;
  /** Where this conversation originated: "web", "discord", or "pulse" */
  sourceType?: "web" | "discord" | "pulse";
  /** Discord server (guild) ID when sourceType is "discord" */
  sourceServerId?: string;
  /** Discord server name */
  sourceServerName?: string;
  /** Discord channel ID when sourceType is "discord" */
  sourceChannelId?: string;
  /** Discord channel name */
  sourceChannelName?: string;
}

// =============================================================================
// Metrics Types
// =============================================================================

/**
 * Streaming performance metrics for a single conversation turn.
 * Captures timing data to diagnose API latency issues.
 */
export interface TurnMetrics {
  id: string;
  conversationId: string;
  /** ID of the assistant message these metrics belong to (for persistence) */
  messageId?: string;
  /** ISO timestamp of when the request started */
  requestStartedAt: string;
  /** Time to first byte from API (ms) */
  ttfb: number | null;
  /** Time to first content token (ms) */
  ttfc: number | null;
  /** Largest delay between chunks (ms) */
  maxChunkGap: number | null;
  /** Number of chunk gaps exceeding 500ms threshold */
  slowChunkCount: number;
  /** End-to-end stream time (ms) */
  totalDuration: number | null;
  /** Total chunks received */
  chunkCount: number;
  /** Why the stream ended (stop, tool_calls, etc.) */
  finishReason: string | null;
  /** ISO timestamp of when metrics were recorded */
  createdAt: string;
}

// =============================================================================
// Context Snapshot Types
// =============================================================================

/**
 * Snapshot of the full context sent to the LLM for a single turn.
 * Used for debugging and prompt inspection.
 */
export interface LLMContextSnapshot {
  /** ISO timestamp when context was built */
  timestamp: string;
  /** Conversation ID this context belongs to */
  conversationId: string;
  /** User message that triggered this context */
  userMessage: string;
  /** The system message with all identity files and RAG context */
  systemMessage: string;
  /** Base instructions loaded from identity/self/base_instructions.md */
  baseInstructions: string;
  /** Self content loaded from self/ directory */
  selfContent: string;
  /** User content loaded from user/ directory */
  userContent: string;
  /** Relationship content loaded from relationship/ directory */
  relationshipContent: string;
  /** Custom content loaded from custom/ directory */
  customContent?: string;
  /** RAG-retrieved memories content */
  memoriesContent?: string;
  /** ChatRAG-retrieved chat history context */
  chatHistoryContent?: string;
  /** Lorebook-triggered world info content */
  lorebookContent?: string;
  /** Knowledge graph context */
  graphContent?: string;
  /** Vault document content from Data Vault RAG */
  vaultContent?: string;
  /** Situational awareness content injected into context */
  situationalAwarenessContent?: string;
  /** The messages array sent to the LLM (excluding system) */
  messages: Array<{
    role: string;
    content: string;
    toolCalls?: ToolCall[];
    toolCallId?: string;
  }>;
  /** Tool definitions available for this turn */
  toolDefinitions: ToolDefinition[];
  /** Metrics about context size */
  metrics: {
    systemMessageLength: number;
    totalMessages: number;
    estimatedTokens: number;
    /** Model context window size in tokens (from active profile) */
    contextLength?: number;
    /** Token budget available for history messages after system/tools/reservation */
    budgetAvailable?: number;
    /** Number of oldest messages removed by context budget trimming */
    messagesTruncated?: number;
  };
}

/** Persisted context snapshot with DB metadata */
export interface ContextSnapshotRecord {
  id: string;
  conversationId: string;
  turnIndex: number;
  iteration: number;
  timestamp: string;
  userMessage: string;
  systemMessage: string;
  baseInstructionsContent?: string;
  selfContent?: string;
  userContent?: string;
  relationshipContent?: string;
  customContent?: string;
  memoriesContent?: string;
  chatHistoryContent?: string;
  lorebookContent?: string;
  graphContent?: string;
  vaultContent?: string;
  situationalAwarenessContent?: string;
  messagesJson: string;
  toolDefinitionsJson: string;
  metricsJson: string;
  createdAt: string;
}

// =============================================================================
// Pulse Types
// =============================================================================

/**
 * A Pulse is a user- or entity-defined prompt that executes on a schedule
 * or in response to external triggers, enabling the entity to act autonomously.
 */
export interface PulseRow {
  id: string;
  name: string;
  description: string | null;
  promptText: string;
  chatMode: "visible" | "silent";
  conversationId: string | null;
  enabled: boolean;
  triggerType: "cron" | "inactivity" | "webhook" | "filesystem";
  cronExpression: string | null;
  intervalSeconds: number | null;
  randomIntervalMin: number | null;
  randomIntervalMax: number | null;
  runAt: string | null;
  inactivityThresholdSeconds: number | null;
  chainPulseIds: string[];
  maxChainDepth: number;
  source: "user" | "entity";
  autoDelete: boolean;
  webhookToken: string | null;
  filesystemWatchPath: string | null;
  successCount: number;
  errorCount: number;
  lastRunAt: string | null;
  lastStatus: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Input for creating a new Pulse. */
export interface CreatePulseInput {
  name: string;
  description?: string | null;
  promptText: string;
  chatMode?: "visible" | "silent";
  conversationId?: string | null;
  enabled?: boolean;
  triggerType?: "cron" | "inactivity" | "webhook" | "filesystem";
  cronExpression?: string | null;
  intervalSeconds?: number | null;
  randomIntervalMin?: number | null;
  randomIntervalMax?: number | null;
  runAt?: string | null;
  inactivityThresholdSeconds?: number | null;
  chainPulseIds?: string[];
  maxChainDepth?: number;
  source?: "user" | "entity";
  autoDelete?: boolean;
  webhookToken?: string;
  filesystemWatchPath?: string | null;
}

/** Input for updating an existing Pulse (all fields optional). */
export interface UpdatePulseInput {
  name?: string;
  description?: string | null;
  promptText?: string;
  chatMode?: "visible" | "silent";
  conversationId?: string | null;
  enabled?: boolean;
  triggerType?: "cron" | "inactivity" | "webhook" | "filesystem";
  cronExpression?: string | null;
  intervalSeconds?: number | null;
  randomIntervalMin?: number | null;
  randomIntervalMax?: number | null;
  runAt?: string | null;
  inactivityThresholdSeconds?: number | null;
  chainPulseIds?: string[];
  maxChainDepth?: number;
  autoDelete?: boolean;
  filesystemWatchPath?: string | null;
}

/** A record of a single Pulse execution. */
export interface PulseRunRow {
  id: string;
  pulseId: string;
  conversationId: string | null;
  triggerSource: string;
  startedAt: string;
  completedAt: string | null;
  durationMs: number | null;
  status: string;
  resultSummary: string | null;
  errorMessage: string | null;
  toolCallsCount: number;
  outputContent: string | null;
  chainDepth: number;
  chainParentRunId: string | null;
  createdAt: string;
}
