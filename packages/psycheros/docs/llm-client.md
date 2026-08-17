# LLM Client and Model Capabilities

Deep reference for `src/llm/client.ts` — the OpenAI-compatible LLM client — and
`src/llm/model-capabilities.ts`. It handles chat completion (streaming and
non-streaming), provider-specific headers, and model parameter filtering. For
the trap list (provider misroute recovery, required OpenRouter headers), see
"LLM client and model capabilities" in [`../CLAUDE.md`](../CLAUDE.md).

## Model capabilities

`src/llm/model-capabilities.ts` — an ordered array of model-family rules that
detects which sampling parameters a model supports from its name string. First
match wins. `filterSamplingParams()` strips unsupported parameters before the
API call and logs what was removed. Zero-value no-op params (`topK=0`,
`frequencyPenalty=0`, `presencePenalty=0`) are silently skipped rather than
stripped — they're defaults, not intentional user choices. Non-zero values on
unsupported models still warn. Unknown models get a permissive default (send
everything). The rules cover OpenAI o-series, GPT-5.x (including 5.5),
GPT-4.x/3.5, Claude, DeepSeek, Gemini, Qwen, GLM, Llama, Mistral, Kimi, and
Gemma — including OpenRouter-prefixed names like
`anthropic/claude-sonnet-4-20250514`. GPT-5.x only supports `maxTokens`
(sampling params rejected like o-series).

The same module gates vision via `supportsVision()` — extend that table for new
model families rather than adding ad-hoc model-name checks elsewhere. Unknown
models default to vision-capable (permissive, same philosophy as sampling
params).

## Reasoning parameters

Gated on provider in `buildRequest()`:

- **Z.ai / NanoGPT**: sends `thinking: { type: "enabled" }` — enables Z.ai's
  chain-of-thought return. When persistent reasoning is on (intra-turn), also
  sends `clear_thinking: false` so Z.ai's Preserved Thinking retains reasoning
  across iterations of the agent loop instead of wiping it.
- **OpenRouter**: sends `reasoning: {}` — tells OpenRouter to return reasoning
  tokens (ignored without it).
- **Other providers**: no parameter sent; reasoning tokens returned
  automatically if the model supports them.

## Persistent reasoning (two scopes, both opt-in per LLM profile)

- **Intra-turn** (`persistentReasoningIntraTurn: "auto" | "on" | "off"` on
  `LLMConnectionProfile`): threads `reasoning_content` back to the next
  inference call within one entity turn — between tool-call iterations. Required
  by DeepSeek's spec on tool-call turns and essential for Z.ai Preserved
  Thinking coherence on multi-step tool chains. Without it, the agent loop at
  `loop.ts:1519` would push assistant messages without their reasoning, and
  DeepSeek would 400 on the next call. `"auto"` resolves to
  `preset.supportsPersistentReasoning && thinkingEnabled` in
  `createClientFromProfile`; `"on"` is an unconditional override for unverified
  endpoints (Venice, Together, self-hosted vLLM, OpenRouter backing models known
  to honor the field). Voice and worker clients force it off via
  `createClientFromProfile`'s options override.
- **Inter-turn** (`persistentReasoningInterTurns: number`): how many past entity
  turns carry their `reasoning_content` into the next request. Counted in
  user-visible turns (user→entity exchanges), not DB rows — each turn may
  contribute multiple assistant rows from its agent loop.
  `selectReasoningEligibleHistory()` in `loop.ts` walks newest→oldest treating
  each user message as a turn boundary. 0 disables.

## Token-budget two-pass trim

`token-budget.ts`: when reasoning replay is enabled, a single assistant message
can carry 1–5k tokens of reasoning (DeepSeek-R1 can hit 10k+). Naive FIFO would
drop the whole turn plus cascade via sanitization (orphaned tool_calls). The
walk does three branches per message: fits-with-reasoning → keep;
fits-without-reasoning → strip `reasoning_content` and keep; fits-neither →
break. Stripped messages get a fresh object with `reasoning_content: undefined`
so input data isn't mutated. `BudgetResult.reasoningStripped` /
`reasoningRetained` are recomputed after sanitization (the sanitizer may drop
messages that were originally counted in either bucket). Both surface in the
Context Inspector Metrics tab and the `[Context] Truncated` log line.

## Reasoning response parsing

`processChunk()` checks four SSE delta fields in priority order:
`reasoning_content` (Z.ai), `reasoning` (OpenRouter/DeepSeek), `thinking`
(Claude via OpenRouter), `reasoning_details` (OpenRouter structured array —
extracts `text` from entries with `type: "reasoning.text"`). Adding a new
provider that returns reasoning in a different field means extending this chain.

## Provider headers

`buildProviderHeaders()` adds provider-specific HTTP headers:

- **OpenRouter**: `HTTP-Referer` + `X-Title` (required, or requests fail with
  "Missing Authentication header")
- **Anthropic**: `anthropic-beta: prompt-caching-2024-07-31`
