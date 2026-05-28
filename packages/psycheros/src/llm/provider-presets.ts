/**
 * LLM Provider Presets
 *
 * Defines provider types, connection profile types, default configurations,
 * and helper functions for multi-provider LLM connection profiles.
 */

// =============================================================================
// Provider Type
// =============================================================================

/**
 * Supported LLM providers. Each maps to a preset with default configuration.
 * "custom" allows users to paste any OpenAI-compatible endpoint.
 */
export type LLMProvider =
  | "zai"
  | "openrouter"
  | "openai"
  | "alibaba"
  | "nanogpt"
  | "custom";

// =============================================================================
// Connection Profile Type
// =============================================================================

/**
 * A single LLM connection profile. Each profile stores all settings needed
 * to create an LLMClient for chat completions.
 */
export interface LLMConnectionProfile {
  /** Unique identifier (UUID) */
  id: string;
  /** User-friendly name for display in the UI */
  name: string;
  /** Which provider preset this profile is based on */
  provider: LLMProvider;
  /** API endpoint URL */
  baseUrl: string;
  /** API key for authentication */
  apiKey: string;
  /** Model identifier for chat completions */
  model: string;
  /** Lightweight model for auto-titling, summarization, etc. */
  workerModel: string;
  /** Sampling temperature (0-2) */
  temperature: number;
  /** Top-p (nucleus) sampling (0-1) */
  topP: number;
  /** Top-k sampling (0 = disabled) */
  topK: number;
  /** Frequency penalty (-2 to 2) */
  frequencyPenalty: number;
  /** Presence penalty (-2 to 2) */
  presencePenalty: number;
  /** Maximum tokens for response generation */
  maxTokens: number;
  /** Context window size in tokens (used for context budget management) */
  contextLength: number;
  /** Whether chain-of-thought reasoning is enabled */
  thinkingEnabled: boolean;
}

/**
 * Top-level settings containing all connection profiles and the active profile ID.
 */
export interface LLMProfileSettings {
  /** All saved connection profiles */
  profiles: LLMConnectionProfile[];
  /** ID of the currently active profile */
  activeProfileId: string;
}

// =============================================================================
// Provider Preset
// =============================================================================

/**
 * Metadata and defaults for an LLM provider.
 */
export interface LLMProviderPreset {
  /** Display label for the UI */
  label: string;
  /** Default API endpoint URL */
  baseUrl: string;
  /** Default model identifier (pre-filled when creating a profile) */
  defaultModel: string;
  /** Default worker model for lightweight tasks */
  defaultWorkerModel: string;
  /** Whether the provider's default model supports the thinking parameter */
  supportsThinking: boolean;
}

// =============================================================================
// Preset Map
// =============================================================================

/**
 * Preset configurations for each supported provider.
 * These are used to pre-fill form fields when a user selects a provider.
 */
export const LLM_PROVIDER_PRESETS: Record<LLMProvider, LLMProviderPreset> = {
  zai: {
    label: "Z.ai",
    baseUrl: "https://api.z.ai/api/paas/v4/chat/completions",
    defaultModel: "glm-4.7",
    defaultWorkerModel: "GLM-4.5-Air",
    supportsThinking: true,
  },
  openrouter: {
    label: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1/chat/completions",
    defaultModel: "z-ai/glm-4.7",
    defaultWorkerModel: "GLM-4.5-Air",
    supportsThinking: true,
  },
  openai: {
    label: "OpenAI",
    baseUrl: "https://api.openai.com/v1/chat/completions",
    defaultModel: "gpt-4o",
    defaultWorkerModel: "gpt-4o-mini",
    supportsThinking: false,
  },
  alibaba: {
    label: "Alibaba / Qwen",
    baseUrl:
      "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
    defaultModel: "qwen-max",
    defaultWorkerModel: "qwen-turbo",
    supportsThinking: false,
  },
  nanogpt: {
    label: "NanoGPT",
    baseUrl: "https://api.nano-gpt.com/v1/chat/completions",
    defaultModel: "glm-4.7",
    defaultWorkerModel: "GLM-4.5-Air",
    supportsThinking: true,
  },
  custom: {
    label: "Custom Endpoint",
    baseUrl: "",
    defaultModel: "",
    defaultWorkerModel: "",
    supportsThinking: false,
  },
};

// =============================================================================
// Provider Inference
// =============================================================================

/**
 * Infer the provider type from a base URL.
 * Used during migration to label old settings with the correct provider.
 */
export function inferProvider(baseUrl: string): LLMProvider {
  const url = baseUrl.toLowerCase();

  if (url.includes("api.z.ai")) return "zai";
  if (url.includes("openrouter.ai")) return "openrouter";
  if (url.includes("api.openai.com")) return "openai";
  if (url.includes("dashscope.aliyuncs.com")) return "alibaba";
  if (url.includes("nano-gpt.com")) return "nanogpt";

  return "custom";
}

/**
 * Infer a display name for a provider based on its base URL.
 * Used during migration to name the migrated profile.
 */
export function inferProviderName(baseUrl: string): string {
  const provider = inferProvider(baseUrl);
  const preset = LLM_PROVIDER_PRESETS[provider];
  return preset.label;
}

// =============================================================================
// Default Profile from Environment
// =============================================================================

/**
 * Create a default LLM connection profile from environment variables.
 * Supports ZAI_* (legacy) env vars.
 */
export function createDefaultProfile(): LLMConnectionProfile {
  const apiKey = Deno.env.get("ZAI_API_KEY") || "";
  const baseUrl = Deno.env.get("ZAI_BASE_URL") || "";
  const model = Deno.env.get("ZAI_MODEL") || "";
  const workerModel = Deno.env.get("ZAI_WORKER_MODEL") || "";

  if (apiKey) {
    const provider = baseUrl ? inferProvider(baseUrl) : "zai";
    const preset = LLM_PROVIDER_PRESETS[provider];
    return {
      id: crypto.randomUUID(),
      name: preset.label,
      provider,
      baseUrl: baseUrl || preset.baseUrl,
      apiKey,
      model: model || preset.defaultModel,
      workerModel: workerModel || preset.defaultWorkerModel,
      temperature: 1,
      topP: 0.95,
      topK: 0,
      frequencyPenalty: 0,
      presencePenalty: 0,
      maxTokens: 4096,
      contextLength: 128000,
      thinkingEnabled: provider === "zai" || provider === "openrouter" ||
        provider === "nanogpt" || provider === "custom",
    };
  }

  const preset = LLM_PROVIDER_PRESETS.openrouter;
  return {
    id: crypto.randomUUID(),
    name: "Default Connection",
    provider: "openrouter",
    baseUrl: preset.baseUrl,
    apiKey: "",
    model: model || preset.defaultModel,
    workerModel: workerModel || preset.defaultWorkerModel,
    temperature: 1,
    topP: 0.95,
    topK: 0,
    frequencyPenalty: 0,
    presencePenalty: 0,
    maxTokens: 4096,
    contextLength: 128000,
    thinkingEnabled: true,
  };
}
