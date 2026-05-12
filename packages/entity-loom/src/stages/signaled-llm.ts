/**
 * Entity Loom — Signaled LLM Client
 *
 * Thin wrapper around LLMClient that injects an AbortSignal into
 * every complete() call. This allows existing MemoryWriter and
 * GraphWriter to be used without modification, since they call
 * this.llm.complete() internally.
 */

import { LLMClient } from "../llm/client.ts";
import type { ChatOptions, LLMClientConfig } from "../llm/client.ts";
import type { LLMMessage } from "../types.ts";

export class SignaledLLMClient extends LLMClient {
  private signal: AbortSignal | null;

  constructor(config: LLMClientConfig, signal?: AbortSignal) {
    super(config);
    this.signal = signal || null;
  }

  /** Override complete() to inject the abort signal */
  override async complete(
    messages: LLMMessage[],
    options?: ChatOptions,
  ): Promise<string> {
    return super.complete(messages, {
      ...options,
      signal: this.signal || options?.signal,
    });
  }
}
