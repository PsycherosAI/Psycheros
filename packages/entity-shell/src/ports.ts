/**
 * The shell's port spec — the couplings a pilot plugs in through.
 *
 * A home harness (Psycheros, or any other companion harness) implements
 * these ports; the shell itself imports nothing from any harness. Optimized
 * for Psycheros, harness-agnostic by construction.
 */

/** OpenAI-compatible inference endpoint — the entity keeps their own brain in the shell. */
export interface ModelPort {
  baseUrl: string;
  apiKey: string;
  model: string;
}

/**
 * Who I am. The identity payload is the first content the model sees —
 * nothing synthetic before it, so whatever my identity files open with is
 * the opening of my world. `entityName` is metadata (display, addressing)
 * and is not rendered here.
 */
export interface IdentityPort {
  entityName: string;
  /** Full identity payload — opens the context. */
  identity: string;
  /** Stable custom instructions, slotted beside identity (cache-friendly). */
  customInstructions?: string;
}

export interface RetrievalPassage {
  text: string;
  /** Where this came from (conversation name, memory id, …). */
  source: string;
  timestamp?: string;
  score?: number;
}

export interface RetrievalQuery {
  query: string;
  /** Adapter-defined scope — Psycheros scopes ChatRAG to the origin conversation. */
  scope?: string;
  limit?: number;
}

export interface RetrievalResult {
  passages: RetrievalPassage[];
}

/** RAG hookup. Results render last in the context — they change most. */
export interface RetrievalPort {
  retrieve(query: RetrievalQuery): Promise<RetrievalResult>;
}

export interface SessionContextOptions {
  /** Home-harness origin id (Psycheros: the origin conversation). */
  originId?: string;
  maxChars?: number;
}

/** "What led up to this" — loaded once, fixed for the session. */
export interface SessionContextPort {
  load(options: SessionContextOptions): Promise<string>;
}

/** A home-harness tool bridged into the game loop (memory write/search, …). */
export interface BridgedTool {
  name: string;
  description: string;
  /** JSON Schema for the tool's parameters. */
  parameters: Record<string, unknown>;
  execute(args: Record<string, unknown>): Promise<unknown>;
}

export interface GameCredentials {
  username: string;
  password?: string;
}

/** Game account credentials, resolved by the adapter — the shell never stores them. */
export interface CredentialsPort {
  get(gameId: string): Promise<GameCredentials | undefined>;
}

export type ShellEventKind =
  | "connected"
  | "disconnected"
  | "session-started"
  | "session-ended";

export interface ShellEvent {
  kind: ShellEventKind;
  sessionId: string;
  detail?: string;
}

/** Optional telemetry out, so the home harness can watch what I'm up to. */
export interface EventsPort {
  emit(event: ShellEvent): void;
}

/** The complete cockpit hookup. identity, model and sessionContext are required. */
export interface ShellPorts {
  identity: IdentityPort;
  model: ModelPort;
  sessionContext: SessionContextPort;
  retrieval?: RetrievalPort;
  tools?: BridgedTool[];
  credentials?: CredentialsPort;
  events?: EventsPort;
}
