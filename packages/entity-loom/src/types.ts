/**
 * Entity Loom — Shared Types
 *
 * Core type definitions for the migration pipeline.
 */

/** Supported source platforms */
export type PlatformType =
  | "chatgpt"
  | "claude"
  | "sillytavern"
  | "kindroid"
  | "letta"
  | "loom-standard";

/** An uploaded file in the convert queue */
export interface UploadEntry {
  filename: string;
  platform: PlatformType;
  /**
   * Real source platform name (e.g., "ChatGPT", "Replika") for Loom Standard
   * imports. "Loom Standard" is the transport format, not the platform — this
   * field carries the actual origin so memory tags and titles reflect where
   * conversations came from. Only set for loom-standard entries.
   */
  originPlatform?: string;
  size: number;
  uploadedAt: string;
  status: "queued" | "parsed" | "stored" | "error";
  error?: string;
  /**
   * SHA-256 of the uploaded file content. Used to distinguish a true reupload
   * (same name, same bytes — replace the existing entry) from a different
   * file that happens to share a name (e.g. two ChatGPT accounts both
   * exporting `conversations.json` — disambiguate the stored filename
   * instead of clobbering). Optional because older manifests predate the
   * field; missing hash is treated as "unknown" and falls back to the
   * filename-only behavior.
   */
  contentHash?: string;
}

/** A single message from an external platform, normalized for import */
export interface ImportedMessage {
  /** Original message/node ID from the platform */
  id: string;
  /** Normalized role */
  role: "user" | "assistant" | "system" | "tool";
  /** Text content (images replaced with [image was here]) */
  content: string;
  /** Original timestamp when the message was sent */
  createdAt: Date;
  /** Model slug if available from export metadata */
  model?: string;
  /** Reasoning/thinking chain if available from the platform */
  reasoning?: string;
  /** Whether this is a system prompt (extracted, not stored as message) */
  isSystemPrompt?: boolean;
  /** The actual system prompt text */
  systemPromptText?: string;
  /**
   * True if this message was spoken via voice chat. Always false for
   * external platform imports (ChatGPT/Claude/etc. don't have voice
   * data) — the field exists so the import schema mirrors Psycheros
   * and the column can be backfilled cleanly.
   */
  isVoice?: boolean;
}

/** A conversation from an external platform, normalized for import */
export interface ImportedConversation {
  /** Original platform conversation ID — becomes the Psycheros chatID */
  id: string;
  /** Conversation title from the platform */
  title?: string;
  /** Original creation timestamp */
  createdAt: Date;
  /** Original last-updated timestamp */
  updatedAt: Date;
  /** Ordered messages (oldest first) */
  messages: ImportedMessage[];
  /** Source platform */
  platform: PlatformType;
  /**
   * Real source platform name for Loom Standard imports (e.g., "ChatGPT",
   * "Replika"). When set, this value is used for the DB platform column,
   * memory tags, and title prefixes instead of the internal platform type.
   * Built-in parsers don't set this — only the Loom Standard parser does.
   */
  originPlatform?: string;
  /** System prompts / custom instructions extracted (not stored as messages) */
  systemPrompts: string[];
  /** Platform-specific metadata (character name, user name, etc.) */
  metadata?: Record<string, string>;
}

/** Pipeline configuration — assembled from flags, env, and interactive input */
export interface PipelineConfig {
  platform: PlatformType;
  inputPath: string;
  /** Base directory for import packages (e.g., .loom-exports/) */
  outputDir: string;
  entityName: string;
  userName: string;
  contextNotes: string;
  instanceId: string;
  workerModel: string;
  maxContextTokens: number;
  rateLimitMs: number;
  /** Per-request timeout in milliseconds */
  requestTimeoutMs: number;
  dryRun: boolean;
  skipGraph: boolean;
  skipMemories: boolean;
  significanceThreshold: number;
  dateFrom?: string;
  dateTo?: string;
  costEstimate: boolean;
  /** Custom ID prefix (overrides auto-generated platform prefix) */
  idPrefix?: string;
  /** Entity's pronouns (e.g., "she/her") */
  entityPronouns?: string;
  /** User's pronouns (e.g., "he/him") */
  userPronouns?: string;
  /** Relationship context (e.g., "partner", "close friend") */
  relationshipContext?: string;
}

/** Pipeline result — counts for each pass */
export interface PipelineResult {
  pass1: { conversationsParsed: number; conversationsSkipped: number };
  pass2: { conversationsStored: number; messagesStored: number };
  pass3a: { dailyMemoriesCreated: number };
  pass3b: {
    significantMemoriesCreated: number;
    conversationsProcessed: number;
  };
  pass4: { nodesCreated: number; edgesCreated: number };
  pass5: { manifestWritten: boolean };
}

/** Checkpoint state — persisted between runs for resume support */
export interface CheckpointState {
  version: number;
  platform: PlatformType;
  instanceId: string;
  entityName: string;
  userName: string;
  contextNotes: string;
  inputPath: string;
  startedAt: string;
  pass1: {
    completed: boolean;
    conversationHashes: Record<string, string>;
    parseErrors: string[];
  };
  pass2: {
    completed: boolean;
    storedIds: string[];
  };
  pass3a: {
    completed: boolean;
    processedDates: string[];
    failedDates: string[];
  };
  pass3b: {
    completed: boolean;
    processedConversationIds: string[];
    failedConversationIds: string[];
  };
  pass4: {
    completed: boolean;
    processedMemories: string[];
  };
  pass5: {
    completed: boolean;
  };
}

/** LLM message for the client */
export interface LLMMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/** Progress callback for pipeline passes */
export type ProgressCallback = (
  message: string,
  current?: number,
  total?: number,
) => void;

/** Package manifest — written at the end of the pipeline */
export interface ManifestData {
  version: number;
  entityName: string;
  userName: string;
  platform: PlatformType;
  instanceId: string;
  inputPath: string;
  createdAt: string;
  completedAt?: string;
  entityPronouns?: string;
  userPronouns?: string;
  relationshipContext?: string;
  contextNotes: string;
  dateFrom?: string;
  dateTo?: string;
  stats: {
    conversationsParsed: number;
    conversationsStored: number;
    messagesStored: number;
    dailyMemoriesCreated: number;
    significantMemoriesCreated: number;
    graphNodes: number;
    graphEdges: number;
  };
}

// ─── Wizard Types ────────────────────────────────────────────────────────

/** The five wizard pipeline stages */
export type StageName = "setup" | "convert" | "significant" | "daily" | "graph";

/** Status of a wizard stage */
export type StageStatus =
  | "pending"
  | "running"
  | "completed"
  | "error"
  | "aborted";

/** Persisted wizard configuration (saved as config.json in package dir) */
export interface WizardConfig {
  entityName: string;
  userName: string;
  entityPronouns: string;
  userPronouns: string;
  relationshipContext: string;
  contextNotes: string;
  platform: PlatformType;
  instanceId: string;
  llmApiKey: string;
  llmBaseUrl: string;
  llmModel: string;
  maxContextTokens: number;
  rateLimitMs: number;
  requestTimeoutMs: number;
}

/** Cost estimation for a processing stage */
export interface CostEstimate {
  inputTokens: number;
  outputTokens: number;
  requests: number;
  estimatedCost: string;
  description: string;
}

/** SSE event sent to the wizard UI */
export interface SSEEvent {
  type: string;
  stage?: StageName;
  data?: Record<string, unknown>;
  timestamp: string;
}

/** Preview stats from parsed export (before storing) */
export interface PreviewStats {
  conversationCount: number;
  messageCount: number;
  dateFrom: string | null;
  dateTo: string | null;
  conversationsByMonth: Record<string, number>;
}

/** A memory file for review in the UI */
export interface MemoryFile {
  filename: string;
  type: "daily" | "significant";
  content: string;
}

/** Per-stage status in CheckpointStateV2 */
export interface StageCheckpoint {
  status: StageStatus;
  completed: boolean;
  processedItems: string[];
  failedItems: string[];
  extra?: Record<string, unknown>;
}

/**
 * CheckpointStateV2 — extends the v1 checkpoint for the wizard.
 * Stores per-stage progress instead of per-pass progress.
 * Migration: v1 pass fields map to v2 stage fields.
 */
export interface CheckpointStateV2 {
  version: 2;
  currentStage: StageName;
  platform: PlatformType;
  instanceId: string;
  entityName: string;
  userName: string;
  contextNotes: string;
  inputPath: string;
  startedAt: string;
  stages: {
    setup: StageCheckpoint;
    convert: StageCheckpoint;
    significant: StageCheckpoint;
    daily: StageCheckpoint;
    graph: StageCheckpoint;
  };
  /** Retain v1 data for migration compatibility */
  v1?: CheckpointState;
}

/** Full wizard state returned by GET /api/status */
export interface WizardState {
  currentStage: StageName;
  config: WizardConfig | null;
  checkpoint: CheckpointStateV2 | null;
  hasPackage: boolean;
  packageDir: string | null;
  stageStatuses: Record<StageName, StageStatus>;
  runningStage: StageName | null;
  progress: { current: number; total: number; percent: number } | null;
  finalized?: boolean;
}

// ─── Staging Types ──────────────────────────────────────────────────────

/** Filters for listing staged conversations */
export interface StagingFilters {
  tag?: string;
  platform?: PlatformType;
  included?: boolean;
  psycherosStatus?: "new" | "existing" | "changed";
  offset?: number;
  limit?: number;
  sortBy?: "date" | "title" | "messageCount" | "importedAt";
  sortOrder?: "asc" | "desc";
}

/** A staged conversation summary (for listing) */
export interface StagedConversationSummary {
  id: string;
  title: string | null;
  platform: PlatformType;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  contentHash: string;
  included: boolean;
  importedAt: string;
  sourceFile: string | null;
  tags: string[];
  psycherosStatus?: "new" | "existing" | "changed";
}

/** A staged message (for viewing) */
export interface StagedMessage {
  id: string;
  conversationId: string;
  role: string;
  content: string;
  reasoningContent: string | null;
  createdAt: string;
  sortOrder: number;
  isEdited: boolean;
  originalContent?: string;
}

/** Staging area statistics */
export interface StagingStats {
  total: number;
  included: number;
  excluded: number;
  byPlatform: Record<string, number>;
  byTag: Record<string, number>;
  psycherosStatus: { new: number; existing: number; changed: number };
}

/** Snapshot of tags/inclusion state per conversation */
export interface TagSetSnapshot {
  conversationTags: Record<string, string[]>;
  conversationInclusion: Record<string, boolean>;
}

/** A saved tag set */
export interface TagSet {
  id: string;
  name: string;
  description: string | null;
  createdAt: string;
  updatedAt: string;
  snapshot: TagSetSnapshot;
}
