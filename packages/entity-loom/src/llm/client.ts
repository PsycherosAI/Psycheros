/**
 * Entity Loom — LLM Client
 *
 * OpenAI-compatible LLM client for memory generation and analysis.
 * Supports chat completion (streaming and non-streaming), JSON mode,
 * and prompt caching for repeated prefixes (saves cost on memory generation).
 */

import type { LLMMessage } from "../types.ts";

export interface LLMClientConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  maxRetries?: number;
  /** Per-request timeout in milliseconds. Default: 120000 (2 minutes). */
  requestTimeoutMs?: number;
  /** Enable prompt caching headers. Default: true.
   *  Most providers (OpenRouter, Anthropic, OpenAI) support caching on
   *  repeated prompt prefixes. Since entity-loom sends many calls with
   *  identical system messages, this can reduce costs significantly. */
  enableCaching?: boolean;
}

export interface ChatOptions {
  temperature?: number;
  maxTokens?: number;
  jsonMode?: boolean;
  signal?: AbortSignal;
}

/**
 * Build provider-specific caching headers.
 *
 * Different providers use different header formats for prompt caching:
 * - Anthropic: anthropic-beta: prompt-caching-2024-07-31
 * - OpenRouter: Passes through provider-specific headers
 * - OpenAI: Automatic caching, no headers needed
 * - Z.ai (api.z.ai): Fully automatic — no headers needed. Server detects
 *   repeated message content and caches it. Cached tokens billed at 50%.
 *   Works on both /api/coding/paas/v4/ and /api/paas/v4/ endpoints.
 *   Response includes usage.prompt_tokens_details.cached_tokens for tracking.
 */
function buildCachingHeaders(_baseUrl: string): Record<string, string> {
  const headers: Record<string, string> = {};

  // Most modern providers handle caching automatically:
  // - Z.ai: Automatic content-similarity detection, no headers needed
  // - OpenAI: Automatic prefix caching
  // - OpenRouter: Passes through provider-specific caching

  // Only Anthropic requires explicit opt-in via header
  const url = _baseUrl.toLowerCase();
  if (url.includes("anthropic.com") || url.includes("anthropic")) {
    headers["anthropic-beta"] = "prompt-caching-2024-07-31";
  }

  // OpenRouter requires HTTP-Referer or X-Title to identify the calling app.
  // Without it, requests return "Missing Authentication header".
  if (url.includes("openrouter.ai")) {
    headers["HTTP-Referer"] = "https://github.com/anthropics/psycheros";
    headers["X-Title"] = "Psycheros";
  }

  return headers;
}

export class LLMClient {
  private config: Required<LLMClientConfig>;
  private cachingHeaders: Record<string, string>;

  constructor(config: LLMClientConfig) {
    this.config = {
      maxRetries: 3,
      requestTimeoutMs: 120000,
      enableCaching: true,
      ...config,
    };
    this.cachingHeaders = this.config.enableCaching
      ? buildCachingHeaders(this.config.baseUrl)
      : {};
  }

  /** Get the base headers for API requests (used by both complete and stream) */
  private getHeaders(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${this.config.apiKey}`,
      ...this.cachingHeaders,
    };
  }

  /**
   * Determine whether a model requires `max_completion_tokens` instead of `max_tokens`.
   *
   * OpenAI's newer models (o-series, gpt-5.x) reject `max_tokens` and require
   * `max_completion_tokens` instead. This check is model-name-based so it works
   * regardless of which provider is routing the request.
   */
  private usesMaxCompletionTokens(): boolean {
    const lower = this.config.model.toLowerCase();
    if (/^o[134]/.test(lower)) return true;
    if (/^gpt-5/.test(lower)) return true;
    return false;
  }

  /** Apply the max-tokens parameter using the correct field name for the model. */
  private applyMaxTokens(
    body: Record<string, unknown>,
    maxTokens: number,
  ): void {
    if (this.usesMaxCompletionTokens()) {
      body.max_completion_tokens = maxTokens;
    } else {
      body.max_tokens = maxTokens;
    }
  }

  /**
   * Detect whether the current model supports the `temperature` parameter.
   * OpenAI o-series and GPT-5.x models reject it; DeepSeek reasoner ignores it.
   */
  private modelSupportsTemperature(): boolean {
    const lower = this.config.model.toLowerCase();
    if (/^o[134]/.test(lower)) return false;
    if (/^gpt-5/.test(lower)) return false;
    if (/deepseek-r/.test(lower)) return false;
    return true;
  }

  /**
   * Send a chat completion request and return the full text response.
   * Implements exponential backoff retry on rate limits and timeouts.
   */
  async complete(
    messages: LLMMessage[],
    options?: ChatOptions,
  ): Promise<string> {
    let lastError: Error | null = null;
    // Default 120s timeout per attempt to prevent hangs
    const controller = options?.signal ? null : new AbortController();
    const timeout = setTimeout(
      () => controller?.abort(),
      this.config.requestTimeoutMs,
    );

    for (let attempt = 0; attempt < this.config.maxRetries; attempt++) {
      try {
        if (attempt > 0) {
          // Exponential backoff: 2s, 4s, 8s
          const delay = Math.min(2000 * Math.pow(2, attempt - 1), 60000);
          await new Promise((resolve) => setTimeout(resolve, delay));
        }

        const body: Record<string, unknown> = {
          model: this.config.model,
          messages: messages.map((m) => ({ role: m.role, content: m.content })),
          stream: false,
        };

        if (options?.temperature !== undefined) {
          if (this.modelSupportsTemperature()) {
            body.temperature = options.temperature;
          } else {
            console.warn(
              `[LLM] Model "${this.config.model}" does not support temperature — stripped from request`,
            );
          }
        }
        if (options?.maxTokens !== undefined) {
          this.applyMaxTokens(body, options.maxTokens);
        }
        if (options?.jsonMode) {
          body.response_format = { type: "json_object" };
        }

        const response = await fetch(
          `${this.config.baseUrl}/chat/completions`,
          {
            method: "POST",
            headers: this.getHeaders(),
            body: JSON.stringify(body),
            signal: options?.signal || controller?.signal,
          },
        );

        if (response.status === 429) {
          // Rate limited — retry
          const retryAfter = response.headers.get("retry-after");
          if (retryAfter) {
            const seconds = parseInt(retryAfter) || 2;
            await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
          }
          continue;
        }

        if (!response.ok) {
          const errorBody = await response.text();
          throw new Error(`LLM API error ${response.status}: ${errorBody}`);
        }

        const data = await response.json();
        clearTimeout(timeout);
        return data.choices?.[0]?.message?.content || "";
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (lastError.message.includes("LLM API error")) {
          clearTimeout(timeout);
          throw lastError;
        }
        // Network error or timeout — retry
        continue;
      }
    }

    clearTimeout(timeout);
    throw lastError || new Error("LLM request failed after retries");
  }

  /**
   * Send a chat completion request and stream the response.
   * Yields content chunks as they arrive.
   */
  async *stream(
    messages: LLMMessage[],
    options?: ChatOptions,
  ): AsyncGenerator<string> {
    const body: Record<string, unknown> = {
      model: this.config.model,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
      stream: true,
    };

    if (options?.temperature !== undefined) {
      if (this.modelSupportsTemperature()) {
        body.temperature = options.temperature;
      } else {
        console.warn(
          `[LLM] Model "${this.config.model}" does not support temperature — stripped from request`,
        );
      }
    }
    if (options?.maxTokens !== undefined) {
      this.applyMaxTokens(body, options.maxTokens);
    }

    const response = await fetch(`${this.config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: this.getHeaders(),
      body: JSON.stringify(body),
      signal: options?.signal,
    });

    if (!response.ok || !response.body) {
      const errorBody = await response.text();
      throw new Error(`LLM API error ${response.status}: ${errorBody}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith("data: ")) continue;
        const data = trimmed.slice(6);
        if (data === "[DONE]") return;

        try {
          const parsed = JSON.parse(data);
          const content = parsed.choices?.[0]?.delta?.content;
          if (content) yield content;
        } catch {
          // Skip malformed SSE data
          continue;
        }
      }
    }
  }

  /**
   * Estimate token count for a string (~4 chars per token for English).
   * Used for cost estimation and context window management.
   */
  estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }

  /**
   * Test the LLM connection by sending a minimal request.
   * Returns success/failure with latency and model info.
   */
  async testConnection(): Promise<
    { ok: boolean; model: string; latencyMs: number; error?: string }
  > {
    const start = performance.now();
    try {
      const response = await this.complete(
        [{ role: "user", content: "Say hello in one word." }],
        { maxTokens: 50 },
      );
      const latency = Math.round(performance.now() - start);
      if (response.trim()) {
        return { ok: true, model: this.config.model, latencyMs: latency };
      }
      // Some models return null/empty on very short requests — treat as success
      // if we got a 200 OK without an exception
      return {
        ok: true,
        model: this.config.model,
        latencyMs: latency,
        error: undefined,
      };
    } catch (error) {
      const latency = Math.round(performance.now() - start);
      return {
        ok: false,
        model: this.config.model,
        latencyMs: latency,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
