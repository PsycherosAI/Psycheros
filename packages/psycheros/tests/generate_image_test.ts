/**
 * Tests for generate-image.ts — OpenRouter model-family detection and base URL
 * normalization. These are the two fixes from issue #11: image-only families
 * must not request text output, and a full pasted endpoint URL must not
 * double the path.
 */

import { assert, assertEquals, assertFalse } from "@std/assert";
import {
  isOpenRouterImageOnlyModel,
  normalizeOpenRouterBaseUrl,
} from "../src/tools/generate-image.ts";

// =============================================================================
// isOpenRouterImageOnlyModel
// =============================================================================

Deno.test("isOpenRouterImageOnlyModel: Flux via Black Forest Labs", () => {
  assert(isOpenRouterImageOnlyModel("black-forest-labs/flux.2-max"));
});

Deno.test("isOpenRouterImageOnlyModel: bare flux id", () => {
  assert(isOpenRouterImageOnlyModel("flux.2-max"));
});

Deno.test("isOpenRouterImageOnlyModel: Recraft", () => {
  assert(isOpenRouterImageOnlyModel("recraft/recraft-v3"));
});

Deno.test("isOpenRouterImageOnlyModel: Seedream", () => {
  assert(isOpenRouterImageOnlyModel("bytedance/seedream-v3"));
});

Deno.test("isOpenRouterImageOnlyModel: Grok Imagine", () => {
  assert(isOpenRouterImageOnlyModel("x-ai/grok-imagine-1"));
});

Deno.test("isOpenRouterImageOnlyModel: GPT-image is text-capable", () => {
  assertFalse(isOpenRouterImageOnlyModel("openai/gpt-5-image"));
});

Deno.test("isOpenRouterImageOnlyModel: case-insensitive", () => {
  assert(isOpenRouterImageOnlyModel("Black-Forest-Labs/Flux.2-Max"));
});

// =============================================================================
// normalizeOpenRouterBaseUrl
// =============================================================================

Deno.test("normalizeOpenRouterBaseUrl: bare api base unchanged", () => {
  assertEquals(
    normalizeOpenRouterBaseUrl("https://openrouter.ai/api/v1"),
    "https://openrouter.ai/api/v1",
  );
});

Deno.test("normalizeOpenRouterBaseUrl: trailing slash stripped", () => {
  assertEquals(
    normalizeOpenRouterBaseUrl("https://openrouter.ai/api/v1/"),
    "https://openrouter.ai/api/v1",
  );
});

Deno.test("normalizeOpenRouterBaseUrl: full endpoint collapsed to base", () => {
  assertEquals(
    normalizeOpenRouterBaseUrl(
      "https://openrouter.ai/api/v1/chat/completions",
    ),
    "https://openrouter.ai/api/v1",
  );
});

Deno.test("normalizeOpenRouterBaseUrl: full endpoint with trailing slash", () => {
  assertEquals(
    normalizeOpenRouterBaseUrl(
      "https://openrouter.ai/api/v1/chat/completions/",
    ),
    "https://openrouter.ai/api/v1",
  );
});

Deno.test("normalizeOpenRouterBaseUrl: whitespace trimmed", () => {
  assertEquals(
    normalizeOpenRouterBaseUrl("  https://openrouter.ai/api/v1  "),
    "https://openrouter.ai/api/v1",
  );
});
