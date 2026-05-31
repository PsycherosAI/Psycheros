/**
 * Entity Core - Type Definitions
 *
 * Core types for the entity's identity, memory, and sync systems.
 * All types are designed from the entity's first-person perspective.
 */

/**
 * Granularity levels for memory summaries.
 * "significant" is for emotionally important events that I remember permanently.
 */
export type Granularity =
  | "daily"
  | "weekly"
  | "monthly"
  | "yearly"
  | "significant";

/**
 * Information about an embodiment (instance) that I exist through.
 */
export interface InstanceInfo {
  /** Unique identifier for this embodiment (e.g., "sby-harness", "sillytavern") */
  id: string;
  /** Type of embodiment */
  type:
    | "psycheros"
    | "sby"
    | "sillytavern"
    | "openwebui"
    | "claude-code"
    | "other";
  /** Human-readable name for this embodiment */
  name?: string;
  /** When this embodiment last synced with my core */
  lastSync?: string;
  /** Schema version for compatibility */
  version: number;
}

/**
 * A file that defines part of my identity.
 */
export interface IdentityFile {
  /** Category of identity file */
  category: "self" | "user" | "relationship" | "custom";
  /** Filename (e.g., "my_identity.md", "user_preferences.md") */
  filename: string;
  /** Content of the file (inner content only, no XML wrapper tags) */
  content: string;
  /** Version number for sync */
  version: number;
  /** When this file was last modified */
  lastModified: string;
  /** Which embodiment last modified this file */
  modifiedBy: string;
  /** Prompt label used as XML tag name when wrapping content for context */
  promptLabel?: string;
}

/**
 * All my identity files grouped by category.
 */
export interface IdentityContent {
  self: IdentityFile[];
  user: IdentityFile[];
  relationship: IdentityFile[];
  custom: IdentityFile[];
}

/**
 * A memory entry in my long-term memory.
 */
export interface MemoryEntry {
  /** Unique identifier for this memory */
  id: string;
  /** Granularity level */
  granularity: Granularity;
  /** Date string (YYYY-MM-DD for daily, YYYY-WXX for weekly, etc.) */
  date: string;
  /** The memory content (written by me, in first-person) */
  content: string;
  /** Chat/conversation IDs referenced in this memory */
  chatIds: string[];
  /** Which embodiment I was using when I created this memory */
  sourceInstance: string;
  /** Other embodiments that were involved in the conversation */
  participatingInstances?: string[];
  /** Version number for sync */
  version: number;
  /** When this memory was created */
  createdAt: string;
  /** When this memory was last updated */
  updatedAt: string;
  /** Optional slug for significant memory filenames (e.g., "first-conversation") */
  slug?: string;
}

/**
 * Vector clock for distributed version tracking.
 * Maps instance IDs to their local version numbers.
 */
export interface VectorClock {
  [instanceId: string]: number;
}

/**
 * A versioned entity with conflict tracking.
 */
export interface VersionedEntity {
  /** Vector clock for this entity */
  version: VectorClock;
  /** Whether this entity has been deleted */
  deleted: boolean;
}

/**
 * Sync token for tracking sync state.
 */
export interface SyncToken {
  /** Monotonic server version */
  serverVersion: number;
  /** ISO timestamp when this token was created */
  timestamp: string;
  /** Hash of the state at this version */
  hash: string;
}

/**
 * Payload for syncing changes from an embodiment.
 */
export interface SyncPayload {
  /** Information about the embodiment syncing */
  instance: InstanceInfo;
  /** Identity file changes to push */
  identityChanges: IdentityFile[];
  /** Memory changes to push */
  memoryChanges: MemoryEntry[];
  /** Last sync token received from server */
  lastSyncToken?: SyncToken;
}

/**
 * Response from a sync operation.
 */
export interface SyncResponse {
  /** Whether the sync was successful */
  success: boolean;
  /** Server-side identity files (for pull) */
  identityFiles?: IdentityContent;
  /** Server-side memories (for pull) */
  memories?: MemoryEntry[];
  /** New sync token for next sync */
  newSyncToken?: SyncToken;
  /** Conflicts that need resolution (if any) */
  conflicts?: ConflictInfo[];
  /** Error message (if failed) */
  error?: string;
}

/**
 * Information about a sync conflict.
 */
export interface ConflictInfo {
  /** Type of entity that conflicted */
  entityType: "identity" | "memory";
  /** The entity's ID or path */
  entityId: string;
  /** Local version from the embodiment */
  localVersion: IdentityFile | MemoryEntry;
  /** Server version */
  serverVersion: IdentityFile | MemoryEntry;
  /** Suggested resolution strategy */
  suggestedResolution: "keep_local" | "keep_server" | "merge";
}

/**
 * Result of a memory search (RAG retrieval).
 */
export interface MemorySearchResult {
  /** The memory entry */
  memory: MemoryEntry;
  /** Relevance score (0-1) */
  score: number;
  /** Which chunk was matched (for long memories) */
  chunkIndex?: number;
  /** Highlighted excerpt */
  excerpt?: string;
}

/**
 * Configuration for the MCP server.
 */
export interface ServerConfig {
  /** Directory where my data is stored */
  dataDir: string;
  /** Whether RAG is enabled */
  ragEnabled: boolean;
  /**
   * Optional shared FileStore. When not provided, `createServer`
   * constructs its own. Pass one when the calling process wants to
   * share state with the server — the main entry in `mod.ts` does this
   * so the consolidation runner and the MCP tool handlers operate on
   * the same instance.
   */
  store?: import("./storage/mod.ts").FileStore;
  /**
   * Optional shared GraphStore. **Load-bearing for `entity_import`:**
   * when the import handler swaps `graph.db` on disk it closes and
   * reopens this store (and the EmbeddingCache), then calls
   * `consolidationRunner.replaceDatabase(getRawDb())` so the runner
   * picks up the new handle. Sharing the same instance is what makes
   * those callbacks affect both surfaces at once. When not provided,
   * `createServer` constructs its own and the runner-resync is a no-op.
   */
  graphStore?: import("./graph/mod.ts").GraphStore;
  /**
   * Optional consolidation runner reference. When provided alongside
   * `graphStore`, the `entity_import` handler updates the runner's DB
   * handle after `graph.db` is replaced on disk so the runner doesn't
   * keep using a stale (closed) connection.
   */
  consolidationRunner?: import("./consolidation/runner.ts").ConsolidationRunner;
  /** Trusted local plugins prepared before the MCP transport connects */
  pluginManager?: import("./plugins/mod.ts").EntityCorePluginManager;
  /** Minimum score threshold for RAG retrieval */
  ragMinScore?: number;
  /** Maximum chunks to retrieve */
  ragMaxChunks?: number;
  /** Maximum tokens for retrieved context */
  ragMaxTokens?: number;
  /** Instance relevance boost factor (default: 0.1) */
  instanceBoost?: number;
}

/**
 * Default server configuration.
 */
export const DEFAULT_SERVER_CONFIG: ServerConfig = {
  dataDir: "./data",
  ragEnabled: true,
  ragMinScore: 0.3,
  ragMaxChunks: 10,
  ragMaxTokens: 2000,
  instanceBoost: 0.1,
};
