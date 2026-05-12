/**
 * LLM Client
 *
 * Simple LLM client for entity-core internal processing.
 * Used for extraction, summarization, and other background tasks.
 *
 * Uses OpenAI-compatible API protocol.
 */

/**
 * Configuration for the LLM client.
 */
export interface LLMConfig {
  /** API key for authentication */
  apiKey: string;
  /** Base URL for the API */
  baseUrl: string;
  /** Model to use */
  model: string;
  /** Temperature for sampling (0-2, lower = more deterministic) */
  temperature?: number;
  /** Maximum tokens in response */
  maxTokens?: number;
  /** Max retries on transient errors (rate limit, 5xx, network) with exponential backoff (default: 3) */
  maxRetries?: number;
}

/**
 * Chat message for the API.
 */
interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/**
 * Response from the completion API.
 */
interface CompletionResponse {
  choices: Array<{
    message: {
      role: string;
      content: string;
    };
    finish_reason: string;
  }>;
}

/**
 * Error from the LLM API.
 */
export class LLMError extends Error {
  constructor(
    message: string,
    public readonly code?: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "LLMError";
  }
}

/** Promise-based delay for retry backoff. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Simple LLM client for entity-core.
 * Provides non-streaming completion for background tasks.
 */
export class LLMClient {
  private readonly config: LLMConfig;

  constructor(config: LLMConfig) {
    this.config = config;
  }

  /**
   * Complete a prompt with a simple string response.
   *
   * @param prompt - The prompt to complete
   * @param options - Optional parameters
   * @returns The completion text
   */
  async complete(
    prompt: string,
    options?: {
      systemPrompt?: string;
      temperature?: number;
      maxTokens?: number;
    },
  ): Promise<string> {
    const messages: ChatMessage[] = [];

    if (options?.systemPrompt) {
      messages.push({ role: "system", content: options.systemPrompt });
    }

    messages.push({ role: "user", content: prompt });

    const response = await this.makeRequest(messages, options);

    if (!response.ok) {
      await this.handleErrorResponse(response);
    }

    const data = await response.json() as CompletionResponse;

    if (!data.choices || data.choices.length === 0) {
      throw new LLMError("No completion returned", "NO_COMPLETION");
    }

    return data.choices[0].message.content;
  }

  /**
   * Complete with a JSON response.
   * Attempts to parse the response as JSON.
   */
  async completeJSON<T>(
    prompt: string,
    options?: {
      systemPrompt?: string;
      temperature?: number;
      maxTokens?: number;
    },
  ): Promise<T> {
    const response = await this.complete(prompt, options);

    // Try to extract JSON from the response
    // Sometimes models wrap JSON in markdown code blocks
    let jsonStr = response.trim();

    // Remove markdown code blocks if present
    const jsonMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) {
      jsonStr = jsonMatch[1].trim();
    }

    try {
      return JSON.parse(jsonStr) as T;
    } catch (firstError) {
      // Attempt to repair truncated JSON (common when response hits token limit)
      let repaired = jsonStr;

      // Strategy 1: Strip partial trailing content (incomplete string, trailing comma before EOF)
      repaired = repaired.replace(/,\s*$/, "");
      repaired = repaired.replace(/"[^"]*$/, "");

      // Strategy 2: Close unclosed brackets/braces
      const openBrackets = (repaired.match(/\[/g) || []).length -
        (repaired.match(/\]/g) || []).length;
      const openBraces = (repaired.match(/\{/g) || []).length -
        (repaired.match(/\}/g) || []).length;
      repaired += "]".repeat(Math.max(0, openBrackets)) +
        "}".repeat(Math.max(0, openBraces));

      try {
        return JSON.parse(repaired) as T;
      } catch {
        throw new LLMError(
          `Failed to parse JSON response: ${
            firstError instanceof Error
              ? firstError.message
              : String(firstError)
          }`,
          "PARSE_ERROR",
        );
      }
    }
  }

  /**
   * Make the HTTP request to the API.
   * Retries on transient errors (rate limit, 5xx, network) with exponential backoff.
   */
  private async makeRequest(
    messages: ChatMessage[],
    options?: { temperature?: number; maxTokens?: number },
  ): Promise<Response> {
    const body: Record<string, unknown> = {
      model: this.config.model,
      messages,
      stream: false,
    };

    // Use option override, then config default
    const temperature = options?.temperature ?? this.config.temperature;
    if (temperature !== undefined) {
      body.temperature = temperature;
    }

    const maxTokens = options?.maxTokens ?? this.config.maxTokens;
    if (maxTokens !== undefined) {
      body.max_tokens = maxTokens;
    }

    const maxRetries = this.config.maxRetries ?? 3;
    const baseDelayMs = 1000;
    const jitterMs = 500;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      let response: Response;
      try {
        response = await fetch(this.config.baseUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.config.apiKey}`,
          },
          body: JSON.stringify(body),
        });
      } catch (error) {
        const message = error instanceof Error
          ? error.message
          : "Unknown network error";
        if (attempt < maxRetries) {
          const delay = baseDelayMs * (2 ** attempt) + Math.random() * jitterMs;
          console.warn(
            `[LLM] Network error, retry ${attempt + 1}/${maxRetries} after ${
              Math.round(delay)
            }ms: ${message}`,
          );
          await sleep(delay);
          continue;
        }
        throw new LLMError(`Network error: ${message}`, "NETWORK_ERROR");
      }

      // Retry on rate limit or server errors
      const status = response.status;
      if (status === 429 || status >= 500) {
        if (attempt < maxRetries) {
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
          await response.body?.cancel();
          await sleep(retryAfterMs);
          continue;
        }
        return response;
      }

      return response;
    }

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
      errorMessage = `${errorMessage}: ${response.statusText}`;
    }

    throw new LLMError(errorMessage, errorCode, response.status);
  }
}

/**
 * Create an LLM client from environment variables.
 *
 * Required env vars (passed by Psycheros or set manually):
 * - ENTITY_CORE_LLM_API_KEY: API key for the LLM
 * - ENTITY_CORE_LLM_BASE_URL: API base URL
 * - ENTITY_CORE_LLM_MODEL: Model to use
 *
 * Optional env vars:
 * - ENTITY_CORE_LLM_TEMPERATURE: Temperature for sampling (default: 0.3 for extraction)
 * - ENTITY_CORE_LLM_MAX_TOKENS: Max tokens in response (default: 8000)
 *
 * Falls back to Psycheros env vars (ZAI_*) if entity-core specific vars not set.
 */
export function createLLMClient(): LLMClient | null {
  // Try entity-core specific vars first, fall back to Psycheros vars
  const apiKey = Deno.env.get("ENTITY_CORE_LLM_API_KEY") ||
    Deno.env.get("ZAI_API_KEY");

  if (!apiKey) {
    console.log(
      "[LLM] No ENTITY_CORE_LLM_API_KEY or ZAI_API_KEY set - extraction features disabled",
    );
    return null;
  }

  const baseUrl = Deno.env.get("ENTITY_CORE_LLM_BASE_URL") ||
    Deno.env.get("ZAI_BASE_URL");

  if (!baseUrl) {
    console.log(
      "[LLM] No ENTITY_CORE_LLM_BASE_URL or ZAI_BASE_URL set - extraction features disabled",
    );
    return null;
  }

  const model = Deno.env.get("ENTITY_CORE_LLM_MODEL") ||
    Deno.env.get("ZAI_MODEL");

  if (!model) {
    console.log(
      "[LLM] No ENTITY_CORE_LLM_MODEL or ZAI_MODEL set - extraction features disabled",
    );
    return null;
  }

  const temperatureStr = Deno.env.get("ENTITY_CORE_LLM_TEMPERATURE");
  const temperature = temperatureStr ? parseFloat(temperatureStr) : 0.3; // Lower temp for extraction

  const maxTokensStr = Deno.env.get("ENTITY_CORE_LLM_MAX_TOKENS");
  const maxTokens = maxTokensStr ? parseInt(maxTokensStr, 10) : 8000;

  const config: LLMConfig = {
    apiKey,
    baseUrl,
    model,
    temperature,
    maxTokens,
  };

  console.log(
    `[LLM] Client initialized with model: ${config.model}, temperature: ${config.temperature}, maxTokens: ${config.maxTokens}`,
  );
  return new LLMClient(config);
}
