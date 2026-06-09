/**
 * Tests for model-capabilities.ts — model family detection and parameter filtering.
 */

import { assert, assertEquals, assertFalse } from "@std/assert";
import {
  detectModelCapabilities,
  filterSamplingParams,
} from "../src/llm/model-capabilities.ts";

// =============================================================================
// detectModelCapabilities
// =============================================================================

Deno.test("detectModelCapabilities: OpenAI o3-mini", () => {
  const caps = detectModelCapabilities("o3-mini");
  assertEquals(caps.family, "openai-o-series");
  assertEquals(caps.usesMaxCompletionTokens, true);
  assertFalse(caps.supportedParams.has("temperature"));
  assertFalse(caps.supportedParams.has("topP"));
  assert(caps.supportedParams.has("maxTokens"));
});

Deno.test("detectModelCapabilities: o1-preview", () => {
  const caps = detectModelCapabilities("o1-preview");
  assertEquals(caps.family, "openai-o-series");
  assertEquals(caps.usesMaxCompletionTokens, true);
});

Deno.test("detectModelCapabilities: o4-mini", () => {
  const caps = detectModelCapabilities("o4-mini");
  assertEquals(caps.family, "openai-o-series");
});

Deno.test("detectModelCapabilities: GPT-4o", () => {
  const caps = detectModelCapabilities("gpt-4o");
  assertEquals(caps.family, "openai-gpt");
  assert(caps.supportedParams.has("temperature"));
  assert(caps.supportedParams.has("topP"));
  assertFalse(caps.supportedParams.has("topK"));
  assert(caps.supportedParams.has("frequencyPenalty"));
  assert(caps.supportedParams.has("presencePenalty"));
  assertEquals(caps.usesMaxCompletionTokens, false);
});

Deno.test("detectModelCapabilities: GPT-4.1", () => {
  const caps = detectModelCapabilities("gpt-4.1");
  assertEquals(caps.family, "openai-gpt");
});

Deno.test("detectModelCapabilities: GPT-3.5-turbo", () => {
  const caps = detectModelCapabilities("gpt-3.5-turbo");
  assertEquals(caps.family, "openai-gpt");
});

Deno.test("detectModelCapabilities: GPT-5-turbo", () => {
  const caps = detectModelCapabilities("gpt-5-turbo");
  assertEquals(caps.family, "openai-gpt5");
  assertEquals(caps.usesMaxCompletionTokens, true);
  assertFalse(caps.supportedParams.has("temperature"));
  assertFalse(caps.supportedParams.has("topP"));
  assert(caps.supportedParams.has("maxTokens"));
});

Deno.test("detectModelCapabilities: GPT-5.5 via OpenRouter", () => {
  const caps = detectModelCapabilities("openai/gpt-5.5");
  assertEquals(caps.family, "openai-gpt5");
  assertEquals(caps.usesMaxCompletionTokens, true);
  assertFalse(caps.supportedParams.has("temperature"));
  assertFalse(caps.supportedParams.has("topP"));
  assert(caps.supportedParams.has("maxTokens"));
});

Deno.test("detectModelCapabilities: Claude direct", () => {
  const caps = detectModelCapabilities("claude-sonnet-4-20250514");
  assertEquals(caps.family, "claude");
  assert(caps.supportedParams.has("temperature"));
  assert(caps.supportedParams.has("topP"));
  assert(caps.supportedParams.has("topK"));
  assertFalse(caps.supportedParams.has("frequencyPenalty"));
  assertFalse(caps.supportedParams.has("presencePenalty"));
  assertEquals(caps.usesMaxCompletionTokens, false);
});

Deno.test("detectModelCapabilities: Claude via OpenRouter", () => {
  const caps = detectModelCapabilities("anthropic/claude-sonnet-4-20250514");
  assertEquals(caps.family, "claude");
  assert(caps.supportedParams.has("topK"));
});

Deno.test("detectModelCapabilities: DeepSeek reasoner", () => {
  const caps = detectModelCapabilities("deepseek-r1");
  assertEquals(caps.family, "deepseek-reasoner");
  assertFalse(caps.supportedParams.has("temperature"));
  assertFalse(caps.supportedParams.has("topP"));
  assert(caps.supportedParams.has("maxTokens"));
});

Deno.test("detectModelCapabilities: DeepSeek chat", () => {
  const caps = detectModelCapabilities("deepseek-chat");
  assertEquals(caps.family, "deepseek-chat");
  assert(caps.supportedParams.has("temperature"));
  assert(caps.supportedParams.has("topP"));
  assertFalse(caps.supportedParams.has("topK"));
});

Deno.test("detectModelCapabilities: DeepSeek via OpenRouter", () => {
  const caps = detectModelCapabilities("deepseek/deepseek-chat-v3-0324");
  assertEquals(caps.family, "deepseek-chat");
});

Deno.test("detectModelCapabilities: Gemini direct", () => {
  const caps = detectModelCapabilities("gemini-2.0-flash-001");
  assertEquals(caps.family, "gemini");
  assert(caps.supportedParams.has("topK"));
  assertFalse(caps.supportedParams.has("frequencyPenalty"));
});

Deno.test("detectModelCapabilities: Gemini via OpenRouter", () => {
  const caps = detectModelCapabilities("google/gemini-2.0-flash-001");
  assertEquals(caps.family, "gemini");
});

Deno.test("detectModelCapabilities: Gemma", () => {
  const caps = detectModelCapabilities("gemma-3-27b-it");
  assertEquals(caps.family, "gemma");
  assert(caps.supportedParams.has("topK"));
  assertFalse(caps.supportedParams.has("frequencyPenalty"));
});

Deno.test("detectModelCapabilities: Gemma via OpenRouter", () => {
  const caps = detectModelCapabilities("google/gemma-3-27b-it");
  assertEquals(caps.family, "gemma");
});

Deno.test("detectModelCapabilities: Qwen", () => {
  const caps = detectModelCapabilities("qwen-max");
  assertEquals(caps.family, "qwen");
  assert(caps.supportedParams.has("temperature"));
  assert(caps.supportedParams.has("topK"));
  assert(caps.supportedParams.has("presencePenalty"));
  assertFalse(caps.supportedParams.has("frequencyPenalty"));
});

Deno.test("detectModelCapabilities: GLM-4.7", () => {
  const caps = detectModelCapabilities("glm-4.7");
  assertEquals(caps.family, "glm");
  assert(caps.supportedParams.has("temperature"));
  assert(caps.supportedParams.has("topP"));
  assertFalse(caps.supportedParams.has("topK"));
  assertFalse(caps.supportedParams.has("frequencyPenalty"));
  assertFalse(caps.supportedParams.has("presencePenalty"));
});

Deno.test("detectModelCapabilities: GLM case insensitive", () => {
  const caps = detectModelCapabilities("GLM-4.5-Air");
  assertEquals(caps.family, "glm");
});

Deno.test("detectModelCapabilities: Llama", () => {
  const caps = detectModelCapabilities("llama-4-maverick");
  assertEquals(caps.family, "llama");
  assert(caps.supportedParams.has("topK"));
  assert(caps.supportedParams.has("frequencyPenalty"));
});

Deno.test("detectModelCapabilities: Llama via OpenRouter (meta-llama/)", () => {
  const caps = detectModelCapabilities("meta-llama/llama-4-maverick");
  assertEquals(caps.family, "llama");
});

Deno.test("detectModelCapabilities: Mistral", () => {
  const caps = detectModelCapabilities("mistral-large-latest");
  assertEquals(caps.family, "mistral");
  assert(caps.supportedParams.has("frequencyPenalty"));
  assertFalse(caps.supportedParams.has("topK"));
});

Deno.test("detectModelCapabilities: Kimi", () => {
  const caps = detectModelCapabilities("kimi-latest");
  assertEquals(caps.family, "kimi");
  assertFalse(caps.supportedParams.has("frequencyPenalty"));
});

Deno.test("detectModelCapabilities: Moonshot", () => {
  const caps = detectModelCapabilities("moonshot-v1-8k");
  assertEquals(caps.family, "kimi");
});

Deno.test("detectModelCapabilities: unknown model returns permissive default", () => {
  const caps = detectModelCapabilities("my-custom-finetune-v2");
  assertEquals(caps.family, "unknown");
  assert(caps.supportedParams.has("temperature"));
  assert(caps.supportedParams.has("topP"));
  assert(caps.supportedParams.has("topK"));
  assert(caps.supportedParams.has("frequencyPenalty"));
  assert(caps.supportedParams.has("presencePenalty"));
  assert(caps.supportedParams.has("maxTokens"));
  assertEquals(caps.usesMaxCompletionTokens, false);
});

// =============================================================================
// filterSamplingParams
// =============================================================================

Deno.test("filterSamplingParams: o3-mini strips temperature, topP, penalties", () => {
  const { params, stripped } = filterSamplingParams("o3-mini", {
    temperature: 0.7,
    topP: 0.95,
    topK: 0,
    frequencyPenalty: 0,
    presencePenalty: 0,
    maxTokens: 4096,
  });
  assertEquals(params.temperature, undefined);
  assertEquals(params.topP, undefined);
  assertEquals(params.frequencyPenalty, undefined);
  assertEquals(params.presencePenalty, undefined);
  assertEquals(params.maxTokens, 4096);
  assertEquals(stripped.length, 2); // temperature, topP (zero-value topK/freqPenalty/presPenalty silently skipped)
});

Deno.test("filterSamplingParams: GPT-4o keeps all except topK", () => {
  const { params, stripped } = filterSamplingParams("gpt-4o", {
    temperature: 0.7,
    topP: 0.95,
    topK: 40,
    frequencyPenalty: 0.1,
    presencePenalty: 0.1,
    maxTokens: 4096,
  });
  assertEquals(params.temperature, 0.7);
  assertEquals(params.topP, 0.95);
  assertEquals(params.maxTokens, 4096);
  assertEquals(params.frequencyPenalty, 0.1);
  assertEquals(params.presencePenalty, 0.1);
  assertEquals(stripped.length, 1);
  assertEquals(stripped[0].param, "topK");
  assertEquals(stripped[0].value, 40);
});

Deno.test("filterSamplingParams: GLM strips penalties and topK", () => {
  const { params, stripped } = filterSamplingParams("glm-4.7", {
    temperature: 1,
    topP: 0.95,
    topK: 20,
    frequencyPenalty: 0,
    presencePenalty: 0,
    maxTokens: 4096,
  });
  assertEquals(params.temperature, 1);
  assertEquals(params.topP, 0.95);
  assertEquals(params.maxTokens, 4096);
  assertEquals(params.topK, undefined);
  assertEquals(params.frequencyPenalty, undefined);
  assertEquals(params.presencePenalty, undefined);
  assertEquals(stripped.length, 1); // topK=20 (zero-value freqPenalty/presPenalty silently skipped)
});

Deno.test("filterSamplingParams: Claude strips penalties but keeps topK", () => {
  const { params, stripped } = filterSamplingParams(
    "claude-sonnet-4-20250514",
    {
      temperature: 0.7,
      topP: 0.9,
      topK: 40,
      frequencyPenalty: 0.1,
      presencePenalty: 0.1,
      maxTokens: 4096,
    },
  );
  assertEquals(params.temperature, 0.7);
  assertEquals(params.topP, 0.9);
  assertEquals(params.topK, 40);
  assertEquals(params.maxTokens, 4096);
  assertEquals(stripped.length, 2); // freqPenalty, presPenalty
});

Deno.test("filterSamplingParams: undefined values are not stripped", () => {
  const { params, stripped } = filterSamplingParams("o3-mini", {
    temperature: undefined,
    topP: undefined,
    maxTokens: 4096,
  });
  assertEquals(stripped.length, 0);
  assertEquals(params.maxTokens, 4096);
});

Deno.test("filterSamplingParams: DeepSeek reasoner strips temperature and topP", () => {
  const { params, stripped } = filterSamplingParams("deepseek-r1", {
    temperature: 0.3,
    topP: 0.9,
    frequencyPenalty: 0,
    maxTokens: 8192,
  });
  assertEquals(params.maxTokens, 8192);
  assertEquals(params.temperature, undefined);
  assertEquals(params.topP, undefined);
  assert(stripped.length >= 2); // at least temperature + topP
});

Deno.test("filterSamplingParams: Llama supports all params", () => {
  const { params, stripped } = filterSamplingParams("llama-4-maverick", {
    temperature: 0.6,
    topP: 0.9,
    topK: 40,
    frequencyPenalty: 0.1,
    presencePenalty: 0.1,
    maxTokens: 4096,
  });
  assertEquals(params.temperature, 0.6);
  assertEquals(params.topP, 0.9);
  assertEquals(params.topK, 40);
  assertEquals(params.frequencyPenalty, 0.1);
  assertEquals(params.presencePenalty, 0.1);
  assertEquals(params.maxTokens, 4096);
  assertEquals(stripped.length, 0);
});

Deno.test("filterSamplingParams: unknown model keeps everything", () => {
  const { params, stripped } = filterSamplingParams("my-custom-model", {
    temperature: 0.5,
    topP: 0.9,
    topK: 50,
    frequencyPenalty: 0.2,
    presencePenalty: 0.2,
    maxTokens: 2048,
  });
  assertEquals(params.temperature, 0.5);
  assertEquals(params.topP, 0.9);
  assertEquals(params.topK, 50);
  assertEquals(params.frequencyPenalty, 0.2);
  assertEquals(params.presencePenalty, 0.2);
  assertEquals(params.maxTokens, 2048);
  assertEquals(stripped.length, 0);
});

Deno.test("filterSamplingParams: OpenRouter prefixed names work", () => {
  const { params } = filterSamplingParams("openai/o3-mini", {
    temperature: 0.7,
    topP: 0.95,
    maxTokens: 4096,
  });
  assertEquals(params.temperature, undefined);
  assertEquals(params.topP, undefined);
  assertEquals(params.maxTokens, 4096);
});

Deno.test("detectModelCapabilities: GPT-4o via OpenRouter", () => {
  const caps = detectModelCapabilities("openai/gpt-4o");
  assertEquals(caps.family, "openai-gpt");
});

Deno.test("detectModelCapabilities: GLM via OpenRouter", () => {
  const caps = detectModelCapabilities("z-ai/glm-4.7");
  assertEquals(caps.family, "glm");
});

Deno.test("filterSamplingParams: Qwen supports presencePenalty but not frequencyPenalty", () => {
  const { params, stripped } = filterSamplingParams("qwen-max", {
    temperature: 0.7,
    topP: 0.9,
    frequencyPenalty: 0.1,
    presencePenalty: 0.1,
    maxTokens: 4096,
  });
  assertEquals(params.presencePenalty, 0.1);
  assertEquals(params.frequencyPenalty, undefined);
  assertEquals(stripped.length, 1);
  assertEquals(stripped[0].param, "frequencyPenalty");
});
