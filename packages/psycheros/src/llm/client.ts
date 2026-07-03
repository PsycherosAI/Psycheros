/**
 * LLM Client
 *
 * Handles communication with LLM APIs using the OpenAI-compatible protocol.
 * Supports streaming requests, tool calling, and chain-of-thought reasoning.
 * Works with any OpenAI-compatible endpoint (OpenRouter, OpenAI, Alibaba, etc.).
 */

import type { ToolDefinition } from "../types.ts";
import type { LLMConnectionProfile } from "./provider-presets.ts";
import type {
  ChatContent,
  ChatMessage,
  ChatRequest,
  ChatResponseChunk,
  LLMConfig,
  StreamChunk,
} from "./types.ts";
import { LLMError } from "./types.ts";
import type { MetricsCollector } from "../metrics/mod.ts";
import { recordChunk, recordFirstByte } from "../metrics/mod.ts";
import {
  detectModelCapabilities,
  filterSamplingParams,
} from "./model-capabilities.ts";

/**
 * Accumulator for building tool calls from streamed chunks.
 */
interface ToolCallAccumulator {
  id: string;
  name: string;
  arguments: string;
}

/**
 * Emit accumulated tool calls as StreamChunks.
 * Clears the accumulator map after emitting.
 */
function* emitAccumulatedToolCalls(
  accumulators: Map<number, ToolCallAccumulator>,
): Generator<StreamChunk, void, unknown> {
  for (const [index, acc] of accumulators) {
    if (acc.id && acc.name) {
      yield {
        type: "tool_call",
        toolCall: {
          id: acc.id,
          type: "function",
          function: {
            name: acc.name,
            arguments: acc.arguments,
          },
        },
      };
    }
    accumulators.delete(index);
  }
}

/** Promise-based delay for retry backoff. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Build provider-specific HTTP headers.
 *
 * OpenRouter requires an `HTTP-Referer` or `X-Title` header to identify
 * the calling application. Without it, requests return
 * "Missing Authentication header". I send both headers so OpenRouter
 * can attribute traffic correctly regardless of which header it checks.
 */
function buildProviderHeaders(baseUrl: string): Record<string, string> {
  const headers: Record<string, string> = {};
  const lower = baseUrl.toLowerCase();

  if (lower.includes("openrouter.ai")) {
    headers["HTTP-Referer"] = "https://github.com/anthropics/psycheros";
    headers["X-Title"] = "Psycheros";
  }

  return headers;
}

function estimateContentChars(content: ChatContent): number {
  if (typeof content === "string") return content.length;
  return content.reduce((sum, part) => {
    if (part.type === "text") return sum + part.text.length;
    // Image tokens vary by provider and resolution. I keep this conservative
    // for request logging without pretending data URL bytes are prompt text.
    return sum + 1200;
  }, 0);
}

/**
 * Client for communicating with the LLM API.
 */
export class LLMClient {
  private readonly config: LLMConfig;
  private readonly providerHeaders: Record<string, string>;
  private _loggedReasoningField = false;

  constructor(config: LLMConfig) {
    this.config = config;
    this.providerHeaders = buildProviderHeaders(config.baseUrl);
  }

  /**
   * Make a streaming chat request.
   *
   * Yields parsed chunks that classify the content type for easy consumption.
   * Tool calls are accumulated across chunks and emitted when complete.
   *
   * @param messages - The conversation messages
   * @param tools - Optional tool definitions
   * @param options - Optional request parameters including metrics collector
   * @yields StreamChunk objects with classified content
   */
  async *chatStream(
    messages: ChatMessage[],
    tools?: ToolDefinition[],
    options?: {
      temperature?: number;
      maxTokens?: number;
      metricsCollector?: MetricsCollector;
    },
  ): AsyncGenerator<StreamChunk, void, unknown> {
    const request = this.buildRequest(messages, tools, true, options);
    const firstChunkTimeout = this.config.firstChunkTimeout ?? 180_000;
    const streamStallTimeout = this.config.streamStallTimeout ?? 120_000;

    // Log the outgoing request for observability
    const toolCount = tools?.length ?? 0;
    const messageCount = messages.length;
    // Rough token estimate: ~4 chars per token across all message content + tool defs
    const payloadChars =
      messages.reduce((acc, m) => acc + estimateContentChars(m.content), 0) +
      (tools ? JSON.stringify(tools).length : 0);
    const estimatedTokens = Math.ceil(payloadChars / 4);
    console.log(
      `[LLM] Sending request to ${this.config.baseUrl} — model=${this.config.model}, ` +
        `messages=${messageCount}, tools=${toolCount}, thinking=${this.config.thinkingEnabled}, ` +
        `~${estimatedTokens} tokens (${payloadChars} chars)`,
    );
    const requestStart = Date.now();

    const response = await this.makeRequest(request);

    const connectMs = Date.now() - requestStart;
    console.log(
      `[LLM] Connected in ${connectMs}ms — HTTP ${response.status} ${response.statusText}`,
    );

    // Record first byte timing if metrics collector is provided
    if (options?.metricsCollector) {
      recordFirstByte(options.metricsCollector);
    }

    if (!response.ok) {
      await this.handleErrorResponse(response);
    }

    if (!response.body) {
      throw new LLMError("Response body is null", "NO_BODY");
    }

    // Validate response content-type — if the upstream didn't return SSE,
    // the stream parser will silently produce 0 content chunks.
    const contentType = response.headers.get("content-type") || "";
    if (
      !contentType.includes("text/event-stream") &&
      !contentType.includes("text/plain")
    ) {
      throw new LLMError(
        `Upstream returned non-streaming response (content-type: ${
          contentType || "missing"
        }) — ` +
          "check that the base URL points to the chat completions endpoint " +
          "(e.g. https://openrouter.ai/api/v1/chat/completions)",
        "INVALID_RESPONSE_TYPE",
      );
    }

    // Track tool calls being accumulated across chunks
    const toolCallAccumulators = new Map<number, ToolCallAccumulator>();

    // Track the last finish reason we saw (to use in done event)
    let lastFinishReason: string | null = null;
    // Track if we've already emitted a done event
    let doneEmitted = false;
    // Track content chunks for stall/empty detection
    let contentChunkCount = 0;
    let thinkingChunkCount = 0;
    // Track consecutive malformed chunks
    let consecutiveMalformed = 0;
    const MAX_CONSECUTIVE_MALFORMED = 5;
    // Track whether we've received any data yet (first chunk gets a longer timeout)
    let receivedFirstChunk = false;
    // Collect raw lines for diagnostics when stream produces 0 content.
    // Captures ALL non-empty lines (not just data: lines) so non-SSE
    // responses (e.g. JSON errors, HTML pages) are also visible.
    const rawLines: string[] = [];
    const MAX_RAW_LINES = 20;

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        // First read gets a longer timeout since the model may be thinking before
        // producing any output. Subsequent reads use the shorter stall timeout.
        const timeout = receivedFirstChunk
          ? streamStallTimeout
          : firstChunkTimeout;
        const { done, value } = await this.readWithTimeout(reader, timeout);

        if (done) {
          // Flush any remaining bytes from the decoder
          buffer += decoder.decode();
          break;
        }

        if (!receivedFirstChunk) {
          receivedFirstChunk = true;
          const firstChunkMs = Date.now() - requestStart;
          console.log(`[LLM] First stream data arrived in ${firstChunkMs}ms`);
        }

        buffer += decoder.decode(value, { stream: true });

        // Process complete lines from the buffer
        const lines = buffer.split("\n");
        buffer = lines.pop() || ""; // Keep incomplete line in buffer

        for (const line of lines) {
          const trimmed = line.trim();
          // Collect non-empty lines for diagnostics
          if (trimmed.length > 0) {
            if (rawLines.length >= MAX_RAW_LINES) rawLines.shift();
            rawLines.push(trimmed);
          }

          const chunk = this.parseSSELine(line);

          if (chunk === null) {
            consecutiveMalformed = 0; // Reset on valid (empty/comment) lines
            continue; // Empty line or comment
          }

          if (chunk === "done") {
            const elapsed = Date.now() - requestStart;
            console.log(
              `[LLM] Stream complete — ${contentChunkCount} content chunks (${thinkingChunkCount} thinking) in ${elapsed}ms, ` +
                `finish_reason=${lastFinishReason || "stop"}`,
            );
            // Emit any remaining tool calls before done
            yield* emitAccumulatedToolCalls(toolCallAccumulators);
            // Only emit done if we haven't already (from finish_reason)
            if (!doneEmitted) {
              yield { type: "done", finishReason: lastFinishReason || "stop" };
              doneEmitted = true;
            }
            return;
          }

          if (chunk === "malformed") {
            consecutiveMalformed++;
            if (consecutiveMalformed >= MAX_CONSECUTIVE_MALFORMED) {
              throw new LLMError(
                `Received ${MAX_CONSECUTIVE_MALFORMED} consecutive malformed SSE chunks from the API — ` +
                  "the upstream response may be corrupted",
                "MALFORMED_STREAM",
              );
            }
            continue;
          }

          consecutiveMalformed = 0; // Reset on valid parsed chunk

          // Detect upstream error responses in the SSE stream.
          // Some providers (e.g. OpenRouter) return errors with HTTP 200 in the
          // stream body: {"error":{"message":"...","code":"..."}} instead of the
          // normal {"choices":[...]} format. Without this check, error responses
          // are silently dropped by processChunk (which returns early on missing
          // choices), resulting in 0 content chunks and no visible error.
          const rawChunk = chunk as unknown as Record<string, unknown>;
          if (
            "error" in rawChunk && rawChunk.error &&
            typeof rawChunk.error === "object"
          ) {
            const err = rawChunk.error as Record<string, unknown>;
            const errMsg = typeof err.message === "string"
              ? err.message
              : JSON.stringify(err);
            const errCode = typeof err.code === "string"
              ? err.code
              : "UPSTREAM_STREAM_ERROR";
            console.error(
              `[LLM] Upstream error in SSE stream: ${errMsg} (code=${errCode})`,
            );
            throw new LLMError(`Upstream API error: ${errMsg}`, errCode);
          }

          // Process the chunk
          for (
            const streamChunk of this.processChunk(
              chunk,
              toolCallAccumulators,
            )
          ) {
            // Track finish reason but don't emit done yet - wait for [DONE] signal
            if (streamChunk.type === "done") {
              lastFinishReason = streamChunk.finishReason;
              // Don't yield the done chunk here - we'll emit it when we see [DONE]
              continue;
            }
            if (
              streamChunk.type === "content" || streamChunk.type === "thinking"
            ) {
              contentChunkCount++;
              if (streamChunk.type === "thinking") thinkingChunkCount++;
            }
            // Record chunk timing for metrics
            if (options?.metricsCollector) {
              const isContent = streamChunk.type === "content" ||
                streamChunk.type === "thinking";
              recordChunk(options.metricsCollector, isContent);
            }
            yield streamChunk;
          }
        }
      }

      // Process any remaining buffer
      if (buffer.trim()) {
        const chunk = this.parseSSELine(buffer);
        if (chunk && chunk !== "done" && chunk !== "malformed") {
          for (
            const streamChunk of this.processChunk(
              chunk,
              toolCallAccumulators,
            )
          ) {
            if (streamChunk.type === "done") {
              lastFinishReason = streamChunk.finishReason;
              continue;
            }
            if (
              streamChunk.type === "content" || streamChunk.type === "thinking"
            ) {
              contentChunkCount++;
              if (streamChunk.type === "thinking") thinkingChunkCount++;
            }
            // Record chunk timing for metrics
            if (options?.metricsCollector) {
              const isContent = streamChunk.type === "content" ||
                streamChunk.type === "thinking";
              recordChunk(options.metricsCollector, isContent);
            }
            yield streamChunk;
          }
        }
      }

      // If we never got a [DONE] signal but the stream ended, emit done now
      if (!doneEmitted) {
        const elapsed = Date.now() - requestStart;
        console.warn(
          `[LLM] Stream ended without [DONE] signal — ${contentChunkCount} content chunks (${thinkingChunkCount} thinking) in ${elapsed}ms, ` +
            `finish_reason=${lastFinishReason || "unknown"}`,
        );
        // When 0 content chunks were received, dump all raw lines for diagnosis.
        // This catches non-SSE responses, upstream errors, or format mismatches
        // that would otherwise be completely invisible.
        if (contentChunkCount === 0) {
          if (rawLines.length > 0) {
            console.error(
              "[LLM] Raw response data (0 content chunks — possible non-SSE response or upstream error):\n" +
                rawLines.map((l) => `  ${l}`).join("\n"),
            );
          } else {
            console.error(
              "[LLM] Stream ended with 0 content chunks and received no parseable data at all",
            );
          }
        }
        // Emit any remaining tool calls
        yield* emitAccumulatedToolCalls(toolCallAccumulators);
        yield { type: "done", finishReason: lastFinishReason || "stop" };
      }
    } finally {
      try {
        reader.releaseLock();
      } catch {
        // Reader may already be released after cancel() in timeout path
      }
    }
  }

  /**
   * Read from a stream reader with a stall timeout.
   * If no data arrives within the timeout period, throws an LLMError.
   */
  private readWithTimeout(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    timeoutMs: number,
  ): Promise<ReadableStreamReadResult<Uint8Array>> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        // Cancel the reader to tear down the underlying TCP connection.
        // This also resolves the pending read() with { done: true },
        // but since our promise is already rejected, that's a no-op.
        reader.cancel().catch(() => {});
        reject(
          new LLMError(
            `LLM stream timed out — no data received for ${
              Math.round(timeoutMs / 1000)
            }s. ` +
              "The upstream API may be overloaded or the connection was dropped.",
            "STREAM_STALL_TIMEOUT",
          ),
        );
      }, timeoutMs);

      reader.read().then(
        (result) => {
          clearTimeout(timer);
          resolve(result);
        },
        (error) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  }

  /**
   * Build a chat request object.
   */
  private buildRequest(
    messages: ChatMessage[],
    tools: ToolDefinition[] | undefined,
    stream: boolean,
    options?: { temperature?: number; maxTokens?: number },
  ): ChatRequest {
    const request: ChatRequest = {
      model: this.config.model,
      messages,
      stream,
    };

    if (this.config.thinkingEnabled) {
      const provider = this.config.provider?.toLowerCase() || "";
      const baseUrl = this.config.baseUrl.toLowerCase();

      if (
        provider === "zai" || provider === "nanogpt" ||
        baseUrl.includes("api.z.ai") || baseUrl.includes("nano-gpt")
      ) {
        // Z.ai / NanoGPT: use the thinking parameter to enable reasoning
        request.thinking = { type: "enabled" };
      } else if (
        provider === "openrouter" || baseUrl.includes("openrouter.ai")
      ) {
        // OpenRouter: use the reasoning parameter to enable reasoning tokens
        request.reasoning = {};
      }
      // Other providers: reasoning tokens returned automatically if model supports them
    }

    if (tools && tools.length > 0) {
      request.tools = tools;
      request.tool_choice = "auto";
    }

    // Gather effective values: per-call options override config-level defaults
    const effectiveTemperature = options?.temperature ??
      this.config.temperature;
    const effectiveMaxTokens = options?.maxTokens ?? this.config.maxTokens;

    // Filter parameters against the model's capabilities
    const { params, stripped } = filterSamplingParams(this.config.model, {
      temperature: effectiveTemperature,
      topP: this.config.topP,
      topK: this.config.topK,
      frequencyPenalty: this.config.frequencyPenalty,
      presencePenalty: this.config.presencePenalty,
      maxTokens: effectiveMaxTokens,
    });

    if (stripped.length > 0) {
      const family = detectModelCapabilities(this.config.model).family;
      console.warn(
        `[LLM] Model "${this.config.model}" (${family}) does not support: ` +
          stripped.map((s) => `${s.param}=${s.value}`).join(", ") +
          " — stripped from request",
      );
    }

    if (params.temperature !== undefined) {
      request.temperature = params.temperature;
    }

    if (params.maxTokens !== undefined) {
      const capabilities = detectModelCapabilities(this.config.model);
      if (capabilities.usesMaxCompletionTokens) {
        request.max_completion_tokens = params.maxTokens;
      } else {
        request.max_tokens = params.maxTokens;
      }
    }

    if (params.topP !== undefined) {
      request.top_p = params.topP;
    }

    if (params.topK !== undefined && params.topK > 0) {
      request.top_k = params.topK;
    }

    if (params.frequencyPenalty !== undefined) {
      request.frequency_penalty = params.frequencyPenalty;
    }

    if (params.presencePenalty !== undefined) {
      request.presence_penalty = params.presencePenalty;
    }

    return request;
  }

  /**
   * Make the HTTP request to the API with a connection timeout.
   * Retries on transient errors (rate limit, 5xx, network) with exponential backoff.
   *
   * @throws LLMError on permanent failures or after exhausting retries
   */
  private async makeRequest(request: ChatRequest): Promise<Response> {
    const maxRetries = this.config.maxRetries ?? 3;
    const baseDelayMs = 1000;
    const jitterMs = 500;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const connectTimeout = this.config.connectTimeout ?? 180_000;
      const controller = new AbortController();
      const timer = setTimeout(() => {
        console.error(
          `[LLM] Connection timeout — no HTTP response from API after ${
            Math.round(connectTimeout / 1000)
          }s. Aborting request.`,
        );
        controller.abort();
      }, connectTimeout);

      let response: Response;
      try {
        response = await fetch(this.config.baseUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.config.apiKey}`,
            ...this.providerHeaders,
          },
          body: JSON.stringify(request),
          signal: controller.signal,
        });
      } catch (error) {
        clearTimeout(timer);
        if (error instanceof DOMException && error.name === "AbortError") {
          if (attempt < maxRetries) {
            const delay = baseDelayMs * (2 ** attempt) +
              Math.random() * jitterMs;
            console.warn(
              `[LLM] Connection timeout, retry ${
                attempt + 1
              }/${maxRetries} after ${Math.round(delay)}ms`,
            );
            await sleep(delay);
            continue;
          }
          throw new LLMError(
            `LLM API connection timed out after ${connectTimeout}ms — the upstream API may be down or unreachable`,
            "CONNECT_TIMEOUT",
          );
        }
        // Network error
        if (attempt < maxRetries) {
          const delay = baseDelayMs * (2 ** attempt) + Math.random() * jitterMs;
          console.warn(
            `[LLM] Network error, retry ${attempt + 1}/${maxRetries} after ${
              Math.round(delay)
            }ms`,
          );
          await sleep(delay);
          continue;
        }
        const message = error instanceof Error
          ? error.message
          : "Unknown network error";
        throw new LLMError(`Network error: ${message}`, "NETWORK_ERROR");
      }

      clearTimeout(timer);

      // Check if the response status warrants a retry
      const status = response.status;
      if (status === 429 || status >= 500) {
        if (attempt < maxRetries) {
          // Parse retry-after header if present (seconds or HTTP date)
          let retryAfterMs = baseDelayMs * (2 ** attempt) +
            Math.random() * jitterMs;
          const retryAfter = response.headers.get("retry-after");
          if (retryAfter) {
            const parsed = parseInt(retryAfter, 10);
            if (!isNaN(parsed)) {
              retryAfterMs = parsed * 1000 + Math.random() * jitterMs;
            }
          }
          console.warn(
            `[LLM] HTTP ${status}, retry ${attempt + 1}/${maxRetries} after ${
              Math.round(retryAfterMs)
            }ms`,
          );
          // Consume the body so the connection can be reused
          await response.body?.cancel();
          await sleep(retryAfterMs);
          continue;
        }
        // Exhausted retries — return the error response and let the caller handle it
        return response;
      }

      return response;
    }

    // Should not reach here, but satisfy the compiler
    throw new LLMError("Unexpected retry loop exit", "INTERNAL_ERROR");
  }

  /**
   * Handle an error response from the API.
   */
  private async handleErrorResponse(response: Response): Promise<never> {
    let errorMessage = `API request failed with status ${response.status}`;
    let errorCode: string | undefined;

    try {
      const errorBody = await response.json();
      if (errorBody.error) {
        errorMessage = errorBody.error.message || errorMessage;
        errorCode = errorBody.error.code;
      }
    } catch {
      // If we can't parse the error body, use the status text
      errorMessage = `${errorMessage}: ${response.statusText}`;
    }

    console.error(
      `[LLM] API error — HTTP ${response.status}, code=${
        errorCode || "none"
      }, message=${errorMessage}`,
    );

    throw new LLMError(errorMessage, errorCode, response.status);
  }

  /**
   * Parse a single SSE line.
   *
   * @returns The parsed chunk, "done" for end signal, or null for empty/comment lines
   */
  private parseSSELine(
    line: string,
  ): ChatResponseChunk | "done" | "malformed" | null {
    const trimmed = line.trim();

    // Skip empty lines and comments
    if (!trimmed || trimmed.startsWith(":")) {
      return null;
    }

    // Check for data prefix
    if (!trimmed.startsWith("data:")) {
      return null;
    }

    // Extract the data content
    const data = trimmed.slice(5).trim();

    // Check for done signal
    if (data === "[DONE]") {
      return "done";
    }

    // Parse JSON
    try {
      return JSON.parse(data) as ChatResponseChunk;
    } catch {
      console.warn("[LLM] Failed to parse SSE chunk:", data.substring(0, 200));
      return "malformed";
    }
  }

  /**
   * Process a parsed chunk and yield stream chunks.
   *
   * Note: This yields a "done" chunk when finish_reason is present, but
   * the caller should intercept this to track the finish reason rather
   * than forwarding it directly to consumers. The actual done event
   * should be emitted when the [DONE] SSE signal is received.
   */
  private *processChunk(
    chunk: ChatResponseChunk,
    toolCallAccumulators: Map<number, ToolCallAccumulator>,
  ): Generator<StreamChunk, void, unknown> {
    // Guard against missing or empty choices array
    if (!chunk.choices || chunk.choices.length === 0) {
      return;
    }

    for (const choice of chunk.choices) {
      const delta = choice.delta;

      // Guard against missing delta
      if (!delta) {
        continue;
      }

      // Handle thinking/reasoning content
      // Check multiple fields used by different providers:
      // - reasoning_content: Zhipu/Z.ai direct
      // - reasoning: OpenRouter, DeepSeek, some proxies
      // - thinking: Claude via OpenRouter
      // - reasoning_details: OpenRouter structured reasoning array
      let reasoning: string | undefined;
      let detectedField: string | undefined;
      if (delta.reasoning_content) {
        reasoning = delta.reasoning_content;
        detectedField = "reasoning_content";
      } else if (delta.reasoning) {
        reasoning = delta.reasoning;
        detectedField = "reasoning";
      } else if (delta.thinking) {
        reasoning = delta.thinking;
        detectedField = "thinking";
      } else if (
        delta.reasoning_details && delta.reasoning_details.length > 0
      ) {
        reasoning = delta.reasoning_details
          .filter((d) => d.type === "reasoning.text" && d.text)
          .map((d) => d.text)
          .join("");
        if (reasoning) detectedField = "reasoning_details";
      }
      if (reasoning) {
        if (!this._loggedReasoningField) {
          console.log(
            `[LLM] Detected reasoning via delta.${detectedField} — model supports chain-of-thought`,
          );
          this._loggedReasoningField = true;
        }
        yield { type: "thinking", content: reasoning };
      }

      // Handle main content
      if (delta.content) {
        yield { type: "content", content: delta.content };
      }

      // Handle tool calls (accumulate across chunks)
      if (delta.tool_calls) {
        for (const toolCallDelta of delta.tool_calls) {
          const index = toolCallDelta.index;

          // Get or create accumulator for this tool call index
          let acc = toolCallAccumulators.get(index);
          if (!acc) {
            acc = { id: "", name: "", arguments: "" };
            toolCallAccumulators.set(index, acc);
          }

          // Accumulate the tool call data
          if (toolCallDelta.id) {
            acc.id = toolCallDelta.id;
          }
          if (toolCallDelta.function?.name) {
            acc.name = toolCallDelta.function.name;
          }
          if (toolCallDelta.function?.arguments) {
            acc.arguments += toolCallDelta.function.arguments;
          }
        }
      }

      // Handle finish reason
      if (choice.finish_reason) {
        // Log non-standard finish reasons with the full raw chunk for diagnostics
        const expectedReasons = new Set(["stop", "tool_calls", "length"]);
        if (!expectedReasons.has(choice.finish_reason)) {
          console.error(
            `[LLM] Unexpected finish_reason="${choice.finish_reason}" — raw chunk: ` +
              JSON.stringify(chunk),
          );
        }

        // Emit completed tool calls when we hit tool_calls finish reason
        if (choice.finish_reason === "tool_calls") {
          yield* emitAccumulatedToolCalls(toolCallAccumulators);
        }

        // Yield done with the actual finish reason
        // (caller should intercept this and emit later with [DONE])
        yield { type: "done", finishReason: choice.finish_reason };
      }
    }
  }
}

/**
 * Create an LLM client with the default configuration.
 *
 * If no API key is provided via options or ZAI_API_KEY env var, returns an
 * unconfigured placeholder client. The server will still start and the user
 * can configure a key through the web UI. Actual API calls will fail until
 * a key is set.
 *
 * @param options - Optional configuration overrides
 */
export function createDefaultClient(
  options?: Partial<LLMConfig>,
): LLMClient {
  const apiKey = options?.apiKey || Deno.env.get("ZAI_API_KEY");

  if (!apiKey) {
    // No key yet — return an unconfigured client so the server can start.
    // The user can set a key via Settings > LLM Settings in the web UI.
    return new LLMClient({
      baseUrl: "",
      apiKey: "",
      model: "",
      thinkingEnabled: false,
      provider: "custom",
    });
  }

  const config: LLMConfig = {
    baseUrl: options?.baseUrl ||
      Deno.env.get("ZAI_BASE_URL") ||
      "https://api.z.ai/api/paas/v4/chat/completions",
    apiKey,
    model: options?.model || Deno.env.get("ZAI_MODEL") || "glm-4.7",
    thinkingEnabled: options?.thinkingEnabled ?? true,
    provider: options?.provider ?? "custom",
    ...parseTimeoutEnvVars(options),
  };

  return new LLMClient(config);
}

/**
 * Create an LLM client configured for the worker model.
 *
 * Uses the same API credentials but with a lighter model (ZAI_WORKER_MODEL)
 * suitable for quick tasks like auto-titling conversations.
 *
 * @param options - Optional configuration overrides
 */
export function createWorkerClient(
  options?: Partial<LLMConfig>,
): LLMClient {
  const apiKey = options?.apiKey || Deno.env.get("ZAI_API_KEY");

  if (!apiKey) {
    return new LLMClient({
      baseUrl: "",
      apiKey: "",
      model: "",
      thinkingEnabled: false,
      provider: "custom",
    });
  }

  const config: LLMConfig = {
    baseUrl: options?.baseUrl ||
      Deno.env.get("ZAI_BASE_URL") ||
      "https://api.z.ai/api/paas/v4/chat/completions",
    apiKey,
    model: options?.model || Deno.env.get("ZAI_WORKER_MODEL") || "GLM-4.5-Air",
    thinkingEnabled: options?.thinkingEnabled ?? false, // Worker model doesn't need thinking
    ...parseTimeoutEnvVars(options),
  };

  return new LLMClient(config);
}

/**
 * Create an LLM client from a connection profile.
 *
 * @param profile - The connection profile to use
 * @param options - Optional overrides:
 *   - useWorker: Use the profile's workerModel instead of the main model
 *   - thinkingEnabled: Override the profile's thinking setting
 * @throws LLMError if the profile has no API key
 */
export function createClientFromProfile(
  profile: LLMConnectionProfile,
  options?: { useWorker?: boolean; thinkingEnabled?: boolean },
): LLMClient {
  if (!profile.apiKey) {
    throw new LLMError(
      "API key is required in the connection profile.",
      "MISSING_API_KEY",
    );
  }

  const config: LLMConfig = {
    baseUrl: profile.baseUrl,
    apiKey: profile.apiKey,
    model: options?.useWorker && profile.workerModel
      ? profile.workerModel
      : profile.model,
    thinkingEnabled: options?.thinkingEnabled ??
      (options?.useWorker ? false : profile.thinkingEnabled),
    provider: profile.provider,
    temperature: profile.temperature,
    topP: profile.topP,
    topK: profile.topK,
    frequencyPenalty: profile.frequencyPenalty,
    presencePenalty: profile.presencePenalty,
    maxTokens: profile.maxTokens,
    ...parseTimeoutEnvVars(),
  };

  return new LLMClient(config);
}

/**
 * Parse timeout-related env vars, with options taking precedence.
 */
function parseTimeoutEnvVars(
  options?: Partial<LLMConfig>,
): Pick<
  LLMConfig,
  "connectTimeout" | "firstChunkTimeout" | "streamStallTimeout"
> {
  const result: Pick<
    LLMConfig,
    "connectTimeout" | "firstChunkTimeout" | "streamStallTimeout"
  > = {};

  const connectTimeout = options?.connectTimeout ??
    parseEnvInt("ZAI_CONNECT_TIMEOUT");
  if (connectTimeout !== undefined) result.connectTimeout = connectTimeout;

  const firstChunkTimeout = options?.firstChunkTimeout ??
    parseEnvInt("ZAI_FIRST_CHUNK_TIMEOUT");
  if (firstChunkTimeout !== undefined) {
    result.firstChunkTimeout = firstChunkTimeout;
  }

  const streamStallTimeout = options?.streamStallTimeout ??
    parseEnvInt("ZAI_STREAM_STALL_TIMEOUT");
  if (streamStallTimeout !== undefined) {
    result.streamStallTimeout = streamStallTimeout;
  }

  return result;
}

/**
 * Parse an environment variable as an integer (milliseconds). Returns undefined if not set or invalid.
 */
function parseEnvInt(name: string): number | undefined {
  const raw = Deno.env.get(name);
  if (!raw) return undefined;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}
