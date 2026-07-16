/**
 * LLM Client Type Definitions
 *
 * Types specific to the LLM client for communicating with the Z.ai API.
 * These types handle the OpenAI-compatible protocol with Z.ai extensions
 * like thinking/reasoning content.
 */

import type { ToolCall, ToolDefinition } from "../types.ts";

// =============================================================================
// Configuration Types
// =============================================================================

/**
 * Configuration for the LLM client.
 */
export interface LLMConfig {
  /** Base URL for the API endpoint */
  baseUrl: string;
  /** API key for authentication */
  apiKey: string;
  /** Model identifier to use */
  model: string;
  /** Whether to enable chain-of-thought reasoning */
  thinkingEnabled: boolean;
  /**
   * Provider type. Used to gate provider-specific request parameters:
   * - "zai" / "nanogpt": send `thinking: { type: "enabled" }`
   * - "openrouter": send `reasoning: {}`
   * Other providers may still return reasoning in SSE deltas automatically.
   */
  provider?: string;
  /** Default sampling temperature (0-2) */
  temperature?: number;
  /** Default top-p (nucleus) sampling (0-1) */
  topP?: number;
  /** Default top-k sampling (0 = disabled) */
  topK?: number;
  /** Default frequency penalty (-2 to 2) */
  frequencyPenalty?: number;
  /** Default presence penalty (-2 to 2) */
  presencePenalty?: number;
  /** Default max tokens for responses */
  maxTokens?: number;
  /** Timeout in ms for the initial API connection (default: 180000) */
  connectTimeout?: number;
  /** Timeout in ms waiting for the first stream chunk after connection (default: 180000) */
  firstChunkTimeout?: number;
  /** Timeout in ms for silence between stream chunks after first chunk arrives (default: 120000) */
  streamStallTimeout?: number;
  /** Max retries on transient errors (rate limit, 5xx, network) with exponential backoff (default: 3) */
  maxRetries?: number;
}

// =============================================================================
// Request Types
// =============================================================================

/**
 * Message format for chat requests.
 */
export interface ChatTextPart {
  type: "text";
  text: string;
}

export interface ChatImageUrlPart {
  type: "image_url";
  image_url: {
    url: string;
    detail?: "auto" | "low" | "high";
  };
}

export type ChatContentPart = ChatTextPart | ChatImageUrlPart;
export type ChatContent = string | ChatContentPart[];

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: ChatContent;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
}

/**
 * Request body for chat completions.
 * Note: Internal to llm module, not re-exported from mod.ts.
 */
export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  stream: boolean;
  /** Z.ai / NanoGPT: enables chain-of-thought reasoning */
  thinking?: { type: "enabled" | "disabled" };
  /** OpenRouter: controls reasoning token behavior */
  reasoning?: {
    enabled?: boolean;
    effort?: string;
    max_tokens?: number;
    exclude?: boolean;
  };
  tools?: ToolDefinition[];
  tool_choice?: "auto";
  temperature?: number;
  max_tokens?: number;
  max_completion_tokens?: number;
  top_p?: number;
  top_k?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
}

// =============================================================================
// Response Types (internal to llm module - not re-exported from mod.ts)
// =============================================================================

/**
 * Delta object in a streaming response chunk.
 */
export interface ChatDelta {
  content?: string;
  /** Zhipu/Z.ai chain-of-thought reasoning (stripped by some proxies like OpenRouter) */
  reasoning_content?: string;
  /** Alternative field name used by some providers for reasoning */
  reasoning?: string;
  /** Claude via OpenRouter returns thinking in this field */
  thinking?: string;
  /** OpenRouter structured reasoning details */
  reasoning_details?: Array<{
    type: string;
    text?: string;
    summary?: string;
    data?: string;
    id?: string | null;
    format?: string;
    index?: number;
  }>;
  tool_calls?: Array<{
    index: number;
    id?: string;
    function?: {
      name?: string;
      arguments?: string;
    };
  }>;
}

/**
 * Choice object in a streaming response chunk.
 */
export interface ChatChoice {
  index: number;
  delta: ChatDelta;
  finish_reason?:
    | "stop"
    | "tool_calls"
    | "length"
    | "network_error"
    | string
    | null;
}

/**
 * A single chunk from a streaming chat response.
 */
export interface ChatResponseChunk {
  id: string;
  created?: number;
  choices: ChatChoice[];
}

// =============================================================================
// Stream Chunk Types
// =============================================================================

/**
 * Parsed stream chunk with classified content type.
 * Used to provide a clean interface for consumers of the streaming API.
 */
export type StreamChunk =
  | { type: "thinking"; content: string }
  | { type: "content"; content: string }
  | { type: "tool_call"; toolCall: ToolCall }
  | { type: "done"; finishReason: string };

// =============================================================================
// Error Types
// =============================================================================

/**
 * Custom error class for LLM client errors.
 *
 * Provides structured error information including:
 * - Error code for programmatic handling
 * - HTTP status code when available
 */
export class LLMError extends Error {
  constructor(
    message: string,
    public readonly code?: string,
    public readonly statusCode?: number,
  ) {
    super(message);
    this.name = "LLMError";
  }
}
