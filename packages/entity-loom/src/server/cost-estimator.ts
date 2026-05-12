/**
 * Entity Loom — Cost Estimator
 *
 * Estimates token usage and API cost for processing stages
 * without making any LLM calls. Uses ~4 chars/token estimation.
 */

import type { CostEstimate } from "../types.ts";

/** Rough pricing table ($/1M tokens) for common models */
const PRICING: Record<string, { input: number; output: number }> = {
  "google/gemini-2.5-flash": { input: 0.15, output: 0.60 },
  "google/gemini-2.5-pro": { input: 1.25, output: 10.0 },
  "anthropic/claude-sonnet-4": { input: 3.0, output: 15.0 },
  "anthropic/claude-opus-4": { input: 15.0, output: 75.0 },
  "openai/gpt-4o-mini": { input: 0.15, output: 0.60 },
  "openai/gpt-4o": { input: 2.5, output: 10.0 },
};

/** Get pricing for a model (fallback to generic estimate) */
function getPricing(model: string): { input: number; output: number } {
  const lower = model.toLowerCase();
  for (const [key, price] of Object.entries(PRICING)) {
    if (lower.includes(key.toLowerCase())) return price;
  }
  // Default estimate for unknown models
  return { input: 1.0, output: 4.0 };
}

/**
 * Build a cost estimate for a stage.
 */
export function buildCostEstimate(
  model: string,
  inputChars: number,
  avgResponseChars = 500,
  requestCount: number,
  description: string,
): CostEstimate {
  const pricing = getPricing(model);
  const inputTokens = Math.ceil(inputChars / 4);
  const outputTokens = Math.ceil(avgResponseChars / 4) * requestCount;
  const inputCost = (inputTokens / 1_000_000) * pricing.input;
  const outputCost = (outputTokens / 1_000_000) * pricing.output;
  const totalCost = inputCost + outputCost;

  let costStr: string;
  if (totalCost < 0.01) costStr = "< $0.01";
  else if (totalCost < 1) costStr = `~$${totalCost.toFixed(2)}`;
  else costStr = `~$${totalCost.toFixed(1)}`;

  return {
    inputTokens,
    outputTokens,
    requests: requestCount,
    estimatedCost: costStr,
    description,
  };
}
