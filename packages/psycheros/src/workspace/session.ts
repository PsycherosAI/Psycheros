/**
 * Workspace Session Runtime Types
 *
 * Runtime-only types for workspace sessions — separate from the persisted
 * `WorkspaceSession` row in `types.ts`. These describe in-flight state that
 * doesn't get serialized to the DB.
 */

import type {
  WorkspaceBriefing,
  WorkspaceMode,
  WorkspaceSession,
} from "../types.ts";

/**
 * Options for opening a new workspace session.
 */
export interface OpenWorkspaceOptions {
  mode: WorkspaceMode;
  briefing: WorkspaceBriefing;
  partyhard?: boolean;
  /** Override the default session timeout (sync mode). */
  timeoutMs?: number;
}

/**
 * Result of running an OpenCode session — parsed from `opencode run --format json`.
 * Each event is one line of JSON; we surface the structured shape here.
 */
export interface OpenCodeRunResult {
  /** OpenCode's session ID (ses_...). */
  sessionId: string;
  /** Final assistant message text, if any. */
  finalText?: string;
  /** Token usage if reported. */
  tokensUsed?: number;
  /** Whether the run completed normally. */
  ok: boolean;
  /** Error message if !ok. */
  error?: string;
  /** Raw events for debugging / coordination layer consumption. */
  rawEvents: OpenCodeEvent[];
  /**
   * True if the run exited because ask_user / ask_origin_conversation fired
   * and the workspace should suspend waiting for the user's answer.
   * `ok` is still true — suspend is not an error. The caller marks the
   * session `suspended` instead of `complete`.
   */
  suspended?: boolean;
}

/**
 * Subset of the OpenCode JSON event schema we care about.
 */
export interface OpenCodeEvent {
  type: string;
  timestamp?: number;
  sessionID?: string;
  [key: string]: unknown;
}

/**
 * Snapshot of what the supervisor currently knows about a session — used
 * for the active-session badge in the chat header.
 */
export interface WorkspaceSessionSnapshot {
  session: WorkspaceSession;
  /** True if `opencode run` is currently executing for this session. */
  isRunning: boolean;
  /** True if waiting on a query-back response from main chat. */
  awaitingResponse: boolean;
}

/**
 * Capabilities detected for the local install — surfaced via /api/workspace/status.
 */
export interface WorkspaceCapabilities {
  opencodeInstalled: boolean;
  opencodePath?: string;
  opencodeVersion?: string;
  /** Whether bwrap sandbox is available (Linux only). */
  bwrapInstalled: boolean;
}
