/**
 * Model Capabilities
 *
 * I detect which sampling parameters a model supports based on its family,
 * and strip unsupported parameters before I send requests. Different model
 * families accept different subsets of the OpenAI-compatible parameter set —
 * sending an unsupported parameter causes HTTP 400 errors from some providers.
 *
 * I match model names against an ordered list of regex patterns. First match
 * wins. Unknown models get a permissive default (I send everything and let
 * the API reject if it must) — this avoids silently dropping params for
 * custom or fine-tuned models that might actually support them.
 */

// =============================================================================
// Types
// =============================================================================

/**
 * Sampling parameters I know how to filter.
 * Each maps to an OpenAI-compatible API field name.
 */
export type SamplingParam =
  | "temperature"
  | "topP"
  | "topK"
  | "frequencyPenalty"
  | "presencePenalty"
  | "maxTokens";

/**
 * Capabilities I detect for a model family.
 */
export interface ModelFamilyCapabilities {
  /** Human-readable family name for log messages */
  family: string;
  /** Sampling parameters this model family supports */
  supportedParams: ReadonlySet<SamplingParam>;
  /** Whether the model requires max_completion_tokens instead of max_tokens */
  usesMaxCompletionTokens: boolean;
}

/**
 * Result of filtering parameters against a model's capabilities.
 */
export interface FilterResult {
  /** The filtered parameter set, ready for the API request */
  params: {
    temperature?: number;
    topP?: number;
    topK?: number;
    frequencyPenalty?: number;
    presencePenalty?: number;
    maxTokens?: number;
  };
  /** Which parameters were stripped (for diagnostic logging) */
  stripped: Array<{ param: SamplingParam; value: number }>;
}

// =============================================================================
// Model Family Rules
// =============================================================================

interface ModelFamilyRule {
  /** Regex tested against the lowercased model name */
  pattern: RegExp;
  /** Capabilities for models matching this pattern */
  capabilities: ModelFamilyCapabilities;
}

/**
 * Ordered rules for model family detection.
 * First match wins. More specific patterns must come before broader ones
 * (e.g., deepseek-reasoner before deepseek, gpt-5 before gpt-4).
 */
const MODEL_FAMILY_RULES: ReadonlyArray<ModelFamilyRule> = [
  // --- OpenAI o-series reasoning models ---
  // o1, o3, o4-mini. Reject temperature, top_p, freq/presence penalty.
  // OpenRouter prefix: openai/o3-mini, openai/o1-preview
  {
    pattern: /(?:openai\/)?o[134]/,
    capabilities: {
      family: "openai-o-series",
      supportedParams: new Set(["maxTokens"]),
      usesMaxCompletionTokens: true,
    },
  },

  // --- OpenAI GPT-5.x (including 5.5) ---
  // Reject temperature, top_p, freq/presence penalty — like o-series.
  // OpenRouter prefix: openai/gpt-5-turbo, openai/gpt-5.5
  {
    pattern: /(?:openai\/)?gpt-5/,
    capabilities: {
      family: "openai-gpt5",
      supportedParams: new Set(["maxTokens"]),
      usesMaxCompletionTokens: true,
    },
  },

  // --- OpenAI GPT-4.x / GPT-3.5 ---
  // OpenRouter prefix: openai/gpt-4o
  {
    pattern: /(?:openai\/)?gpt-?[34]/,
    capabilities: {
      family: "openai-gpt",
      supportedParams: new Set([
        "temperature",
        "topP",
        "frequencyPenalty",
        "presencePenalty",
        "maxTokens",
      ]),
      usesMaxCompletionTokens: false,
    },
  },

  // --- Claude (Anthropic) ---
  // Via OpenRouter: anthropic/claude-*, direct: claude-*
  {
    pattern: /(?:anthropic\/)?claude-/,
    capabilities: {
      family: "claude",
      supportedParams: new Set(["temperature", "topP", "topK", "maxTokens"]),
      usesMaxCompletionTokens: false,
    },
  },

  // --- DeepSeek reasoner ---
  // Must come before the general deepseek rule.
  {
    pattern: /deepseek-r/,
    capabilities: {
      family: "deepseek-reasoner",
      supportedParams: new Set(["maxTokens"]),
      usesMaxCompletionTokens: false,
    },
  },

  // --- DeepSeek chat ---
  {
    pattern: /deepseek/,
    capabilities: {
      family: "deepseek-chat",
      supportedParams: new Set(["temperature", "topP", "maxTokens"]),
      usesMaxCompletionTokens: false,
    },
  },

  // --- Gemini ---
  {
    pattern: /(?:google\/)?gemini/,
    capabilities: {
      family: "gemini",
      supportedParams: new Set(["temperature", "topP", "topK", "maxTokens"]),
      usesMaxCompletionTokens: false,
    },
  },

  // --- Gemma ---
  {
    pattern: /(?:google\/)?gemma/,
    capabilities: {
      family: "gemma",
      supportedParams: new Set(["temperature", "topP", "topK", "maxTokens"]),
      usesMaxCompletionTokens: false,
    },
  },

  // --- Qwen ---
  {
    pattern: /qwen/,
    capabilities: {
      family: "qwen",
      supportedParams: new Set([
        "temperature",
        "topP",
        "topK",
        "maxTokens",
        "presencePenalty",
      ]),
      usesMaxCompletionTokens: false,
    },
  },

  // --- GLM (Zhipu / Z.ai) ---
  // OpenRouter prefix: z-ai/glm-4.7
  {
    pattern: /(?:z-ai\/)?glm/,
    capabilities: {
      family: "glm",
      supportedParams: new Set(["temperature", "topP", "maxTokens"]),
      usesMaxCompletionTokens: false,
    },
  },

  // --- Llama ---
  {
    pattern: /(?:meta-llama\/|meta\/)?llama/,
    capabilities: {
      family: "llama",
      supportedParams: new Set([
        "temperature",
        "topP",
        "topK",
        "frequencyPenalty",
        "presencePenalty",
        "maxTokens",
      ]),
      usesMaxCompletionTokens: false,
    },
  },

  // --- Mistral ---
  {
    pattern: /mistral/,
    capabilities: {
      family: "mistral",
      supportedParams: new Set([
        "temperature",
        "topP",
        "frequencyPenalty",
        "presencePenalty",
        "maxTokens",
      ]),
      usesMaxCompletionTokens: false,
    },
  },

  // --- Kimi / Moonshot ---
  {
    pattern: /(?:moonshot|kimi)/,
    capabilities: {
      family: "kimi",
      supportedParams: new Set(["temperature", "topP", "maxTokens"]),
      usesMaxCompletionTokens: false,
    },
  },
];

/**
 * Default capabilities for unknown models.
 * Permissive — I send everything and let the API reject if it must.
 */
const DEFAULT_CAPABILITIES: ModelFamilyCapabilities = {
  family: "unknown",
  supportedParams: new Set<SamplingParam>([
    "temperature",
    "topP",
    "topK",
    "frequencyPenalty",
    "presencePenalty",
    "maxTokens",
  ]),
  usesMaxCompletionTokens: false,
};

// =============================================================================
// Detection
// =============================================================================

/**
 * Detect the model family and its capabilities from a model name string.
 *
 * I test patterns against the lowercased model name in rule order.
 * First match wins. If no rule matches, I return a permissive default
 * that includes all parameters.
 *
 * The model name may be a bare name ("gpt-4o") or an OpenRouter-prefixed
 * name ("openai/gpt-4o", "anthropic/claude-sonnet-4-20250514"). I handle
 * both by testing against the full lowercased string.
 */
export function detectModelCapabilities(
  model: string,
): ModelFamilyCapabilities {
  const lower = model.toLowerCase();

  for (const rule of MODEL_FAMILY_RULES) {
    if (rule.pattern.test(lower)) {
      return rule.capabilities;
    }
  }

  return DEFAULT_CAPABILITIES;
}

// =============================================================================
// Filtering
// =============================================================================

/**
 * Filter sampling parameters against a model's supported set.
 *
 * I take the raw config values and strip any parameter the detected
 * model family does not support. Returns both the filtered set and
 * a list of what was stripped (for diagnostic logging).
 */
export function filterSamplingParams(
  model: string,
  config: {
    temperature?: number;
    topP?: number;
    topK?: number;
    frequencyPenalty?: number;
    presencePenalty?: number;
    maxTokens?: number;
  },
): FilterResult {
  const capabilities = detectModelCapabilities(model);
  const supported = capabilities.supportedParams;
  const params: FilterResult["params"] = {};
  const stripped: FilterResult["stripped"] = [];

  const entries: Array<[SamplingParam, number | undefined]> = [
    ["temperature", config.temperature],
    ["topP", config.topP],
    ["topK", config.topK],
    ["frequencyPenalty", config.frequencyPenalty],
    ["presencePenalty", config.presencePenalty],
    ["maxTokens", config.maxTokens],
  ];

  for (const [param, value] of entries) {
    if (value === undefined) continue;
    if (
      (param === "topK" || param === "frequencyPenalty" ||
        param === "presencePenalty") && value === 0
    ) continue;
    if (supported.has(param)) {
      (params as Record<string, number>)[param] = value;
    } else {
      stripped.push({ param, value });
    }
  }

  return { params, stripped };
}
