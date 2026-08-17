/**
 * Psycheros Shared Type Definitions
 *
 * Core types used throughout the Psycheros daemon for messages,
 * tools, SSE events, and conversations.
 */

import type { SkillFile } from "./workspace/skills.ts";

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
  /**
   * True if this message was spoken via voice chat (either the user's
   * transcribed speech or the entity's TTS response). Authoritative —
   * the `[Voice Chat] ` prefix in content is derived from this flag at
   * read time, never stored.
   */
  isVoice?: boolean;
  /**
   * Tool-result sidecar metadata. Currently used to carry generated-image
   * data (path, descriptions) so the LLM-visible `content` can stay plain
   * text without `[IMAGE:...]` markers. Parsed from JSON in rowToMessage.
   */
  metadata?: MessageMetadata;
  /**
   * When non-undefined, this message has been soft-deleted (tombstoned).
   * The row stays for conversation-flow continuity; content is replaced
   * with a tombstone notice at read time. Original content is archived
   * inside `metadata.tombstone` for recovery.
   */
  deletedAt?: Date;
  /**
   * True if this message's content is corrupted/unreadable (typically from
   * past bugs). UI renders as a placeholder so the user can see something
   * is wrong without breaking conversation flow. Entity can repair via
   * write_entity_data.
   */
  isGlitched?: boolean;
}

/**
 * Sidecar metadata stored on tool-result messages. The `image` shape is
 * populated by `generate_image`; the `fade` shape is populated by tools whose
 * result content should be replaced with a shorter version after the
 * IMAGE_DESCRIPTION_FADE_TURNS threshold (describe_image, look_closer).
 */
export interface MessageMetadata {
  image?: {
    /** URL path for `<img src>` (e.g. "/generated-images/abc.png") */
    path: string;
    /** Path relative to .psycheros/ for send_discord_dm image_path */
    filePath: string;
    prompt: string;
    generatorName: string;
    description?: string;
    shortDescription?: string;
  };
  fade?: {
    /** Content text to swap in after IMAGE_DESCRIPTION_FADE_TURNS */
    replacementContent: string;
  };
  /**
   * Tombstone metadata — populated when a message is soft-deleted. The
   * original content lives here so it can be recovered if the deletion
   * was a mistake. The visible `content` field is replaced with a
   * "[deleted by ...]" notice at read time.
   */
  tombstone?: {
    /** Original content before deletion. */
    originalContent: string;
    /** Who initiated the deletion ("entity", "user", "system"). */
    deletedBy: string;
    /** Optional reason for the deletion. */
    reason?: string;
  };
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
  /**
   * Optional sidecar metadata. Persisted as-is to the tool-message
   * `metadata` column. generate_image populates `metadata.image`;
   * describe_image and look_closer populate `metadata.fade`.
   */
  metadata?: MessageMetadata;
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
    | "image_generated"
    | "thinking_corrected"
    | "ping";
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
  /** Where this conversation originated: "web", "discord", "pulse", or "workspace" */
  sourceType?: "web" | "discord" | "pulse" | "workspace";
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
  /** "Skills I'm holding" block injected into the dynamic system section */
  heldSkillsContent?: string;
  /** Trusted local plugin context I add to my prompt */
  pluginContent?: string;
  /** Per-hook detail for Context Inspector — what each hook contributed */
  pluginHooks?: PluginHookDetail[];
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
    /**
     * Plugin prompt-hook context budget consumed on this turn, in chars.
     * Set when a plugin manager is configured and buildPromptContent ran.
     * Includes the `<plugin_context>` wrapper bytes, so this slightly
     * overestimates the pure payload — matches how the cap is enforced
     * (the cap also counts wrappers).
     */
    pluginBudgetUsed?: number;
    /**
     * Aggregate plugin prompt-hook context cap that was in effect on this
     * turn, in chars. Pairs with pluginBudgetUsed for the
     * "X / Y chars (Z%)" meter in the Context Inspector and the Plugins
     * Settings health card.
     */
    pluginBudgetMax?: number;
  };
}

/** Per-hook detail captured during buildPromptContent for Context Inspector */
export interface PluginHookDetail {
  pluginId: string;
  hookName: string;
  priority: number;
  /** The raw text the hook returned (before truncation). Undefined if skipped/failed. */
  output?: string;
  /** Chars that made it into the system prompt (after truncation + wrapper). */
  charsUsed: number;
  truncated: boolean;
  /** Hook threw or timed out — a `<plugin_failure>` fallback was injected instead. */
  degraded: boolean;
  /** Skipped due to budget exhaustion — no output at all. */
  budgetSkipped: boolean;
  /** Execution time in milliseconds. */
  elapsedMs: number;
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
  heldSkillsContent?: string;
  messagesJson: string;
  toolDefinitionsJson: string;
  metricsJson: string;
  /** JSON-serialized PluginHookDetail[] for the Context Inspector tab. */
  pluginHooksJson?: string;
  createdAt: string;
}

// =============================================================================
// Pulse Types
// =============================================================================

/**
 * A Pulse is a user- or entity-defined prompt that executes on a schedule
 * or in response to external triggers, enabling the entity to act autonomously.
 *
 * Run statistics (success/error counts, last run timestamp, last status)
 * are derived on demand from the scheduler's `job_runs` table — see
 * {@link PulseStats} and `DBClient.getPulseStats()`.
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
  createdAt: string;
  updatedAt: string;
}

/**
 * Derived run statistics for a pulse, computed from the scheduler's
 * `job_runs` table on demand. Returned by `DBClient.getPulseStats()`.
 */
export interface PulseStats {
  successCount: number;
  errorCount: number;
  lastRunAt: string | null;
  lastCompletedAt: string | null;
  lastStatus: string | null;
  lastDurationMs: number | null;
  lastResult: string | null;
  lastError: string | null;
}

/**
 * Projection of a single pulse execution from the scheduler's `job_runs`
 * table. Returned by `DBClient.listPulseRuns()` and `getPulseRun()` so
 * the existing pulse history UI keeps working unchanged.
 */
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

/**
 * Pulse log filter labels — the three category pills shown above the run
 * table. Each maps to one or more `job_runs` statuses (`fired` → `success`,
 * `error` → `error`+`dead`, `skipped` → `skipped`).
 */
export type PulseLogFilter = "fired" | "error" | "skipped";

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

// =============================================================================
// Workspace Types
// =============================================================================
//
// Workspace sessions are OpenCode-as-faculty: supervised subprocesses the entity
// spawns via the `workspace` omni-tool for detailed technical work. Each session
// is its own conversation (sourceType: "workspace") with workspace_sessions
// holding the workspace-specific metadata (sandbox path, OpenCode session ID,
// status, briefing, summary).

export type WorkspaceMode = "sync" | "async" | "collaborative" | "engaged";

/**
 * Isolation axis — orthogonal to WorkspaceMode. Controls whether the OpenCode
 * subprocess runs inside an OS-level sandbox (Sandboxed) or directly on the
 * host (Feral).
 *
 * Per plan §4: Sandboxed uses bwrap (Linux) / sandbox-exec (macOS) for
 * kernel-level isolation. Feral skips OS sandbox for "help me with my
 * computer" workflows. Tier 5 protection (daemon files) holds across both —
 * enforced via classifyPath() in the coordination layer, not the OS sandbox.
 */
export type WorkspaceIsolation = "sandboxed" | "feral";

export type WorkspaceStatus =
  | "pending" // created, not yet started
  | "running" // OpenCode session in progress
  | "paused" // legacy: waiting on approval — superseded by `suspended` for query-back
  | "suspended" // waiting on user answer to ask_origin/ask_user (plan §14 suspend model)
  | "complete" // finished normally, summary available
  | "failed" // OpenCode crashed or errored
  | "cancelled"; // user or entity cancelled

/**
 * The briefing the entity writes when opening a workspace session. The entity's
 * active-recall of relevant context — there is no auto-summary of the origin
 * conversation. Pinned messages are verbatim quotes from origin.
 */
export interface WorkspaceBriefing {
  /** What the entity wants the workspace to accomplish. */
  goal: string;
  /** Background context the entity chose to share (active recall). */
  context?: string;
  /** Message IDs from the origin conversation to include verbatim. */
  pinnedMessageIds?: string[];
  /** ID of the conversation this workspace was spawned from. */
  originConversationId?: string;
  /** Optional timeout for sync mode, in milliseconds. */
  timeoutMs?: number;
  /**
   * Names of my skills bundled into the sandbox at spawn (via the workspace
   * tool's `skills` param) so OpenCode follows the same procedures.
   */
  bundledSkills?: string[];
}

/**
 * A workspace session row. Mirrors the `workspace_sessions` table.
 */
export interface WorkspaceSession {
  id: string;
  /** The workspace conversation (sourceType: "workspace"). */
  conversationId: string;
  /** Conversation that spawned this workspace, if any. */
  originConversationId?: string;
  /** Filesystem path to the sandbox dir. */
  sandboxPath: string;
  status: WorkspaceStatus;
  mode: WorkspaceMode;
  /** Isolation level for this session — 'sandboxed' (default, OS sandbox active) or 'feral' (no OS sandbox). */
  isolation: WorkspaceIsolation;
  /** Whether partyhard (skip Tier 2/4 prompts) is active for this session. */
  partyhard: boolean;
  /** OpenCode's session ID once spawned (ses_...). */
  opencodeSessionId?: string;
  /** The original briefing. */
  briefing: WorkspaceBriefing;
  /** Final summary — set when status becomes "complete". */
  summary?: string;
  /** Token usage counter. */
  tokenUsage: number;
  createdAt: string;
  /** When the session ended (any terminal status). */
  endedAt?: string;
  /** Last activity timestamp (heartbeat). */
  lastActivityAt: string;
  /** Error message if status is "failed". */
  error?: string;
  /**
   * True if the entity has signaled end-of-session via workspace end_session
   * action. Engaged-runner polls this after each entity turn (per §13a) to
   * decide whether to continue the turn-based loop. Always false for sync /
   * async (delegation) modes — those don't have an entity in the loop.
   */
  endRequested: boolean;
  /**
   * Exempt from sandbox retention — the user/entity marked this session as
   * a long-running project to pick back up later. Pin via the workspace
   * `pin` action or the Settings > Workspace management list.
   */
  pinned?: boolean;
  /**
   * Existing host folder this session works on in place (bound rw via the
   * OS sandbox). Undefined for plain scratch sessions.
   */
  workdir?: string;
}

/**
 * Input for opening a new workspace session.
 */
export interface CreateWorkspaceInput {
  mode: WorkspaceMode;
  briefing: WorkspaceBriefing;
  partyhard?: boolean;
  /**
   * Isolation level for this session. Falls back to the per-entity default
   * from workspace-settings.json (`defaultIsolation`) when unset.
   */
  isolation?: WorkspaceIsolation;
  /**
   * Existing host folder to work on in place (e.g. reorganizing an existing
   * project). Bound read-write via the OS sandbox — the kernel-scoped
   * alternative to Feral. Refused for Tier 5 / protected paths; every bind
   * passes a user approval toast before the session spawns.
   */
  workdir?: string;
  /**
   * Entity skills to copy into the sandbox alongside the built-in workspace
   * skills (validated + loaded by the workspace tool before spawn).
   */
  skillFiles?: SkillFile[];
}
