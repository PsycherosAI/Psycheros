# LLM Settings Standardization Across the Psycheros Ecosystem

**Status:** TODO — needs dedicated implementation sprint **Created:** 2026-06-12

## The Problem

LLM configuration is handled independently across three packages, each with
different conventions for provider-specific parameters, thinking/reasoning mode,
token limits, and other settings. This creates maintenance burden and
inconsistency.

### Current State

| Package                        | Where LLM config lives                                                    | How thinking is handled                                                           | How provider specials work                                               |
| ------------------------------ | ------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| **psycheros** (daemon + voice) | `src/llm/client.ts`, `src/llm/settings.ts`, `src/llm/provider-presets.ts` | `thinkingEnabled` bool on profile; sends `{thinking: {type: "enabled"}}` for Z.ai | Hardcoded provider checks (`if provider === "zai"`) throughout client.ts |
| **entity-core** (MCP server)   | `src/llm-client.ts`                                                       | Unknown / inconsistent                                                            | Unknown                                                                  |

Note: the Pipecat Python sidecar that previously handled voice chat LLM calls
was shelved 2026-06-14 in favour of a Deno-native walkie-talkie pipeline. Voice
now uses the daemon's `LLMClient` directly via `createClientFromProfile` — see
`packages/psycheros/pipecat-shelved/SHELVED.md`.

### Specific Inconsistencies

1. **Thinking/reasoning toggle** — psycheros daemon has `thinkingEnabled` as a
   profile setting. Voice profiles have `disableReasoning` which inverts and
   forwards to the LLM client. Entity-core may not handle it at all.

2. **Provider-specific parameter pass-through** — Z.ai needs `thinking`,
   OpenRouter needs `reasoning`, others may need their own fields. Each client
   reimplements these checks.

3. **Model capabilities detection** — `model-capabilities.ts` in psycheros knows
   about `max_completion_tokens` vs `max_tokens`. Entity-core doesn't use this.

4. **API key and base URL handling** — Two different implementations of the same
   openai-compatible client pattern (daemon + entity-core).

5. **Reasoning content extraction** — Z.ai returns `delta.reasoning_content`,
   Claude/OpenRouter returns `delta.thinking`. Each client handles this
   differently.

## The Goal

A shared understanding (ideally shared code) for:

- Which LLM parameters exist and what they mean
- Which providers need which special handling
- How thinking/reasoning mode is configured and toggled
- How reasoning content is detected, classified, and (optionally) surfaced
- How model capabilities (token limits, supported features) are detected

## Scope

- **Voice chat settings UI** needs LLM selection/model switching (currently
  inherits active profile only)
- **All three packages** should use the same conventions
- **entity-core** is canonical for identity/memory but consumes LLM for its own
  processing — it needs the same provider awareness

## Proposed Approach

1. **Shared types** — Define canonical LLM config types (provider settings,
   thinking mode, model capabilities) in a shared location. Since packages don't
   share TypeScript code directly, this might be a shared `@psycheros/llm-types`
   package or a conventions doc with reference implementations.

2. **Provider registry pattern** — Instead of `if provider === "zai"` scattered
   everywhere, a registry that maps provider → required parameters, thinking
   field name, reasoning content field name, etc.

3. **Voice chat LLM config** — Allow voice profiles to specify their own LLM
   model/provider (or inherit from active profile). This means the voice
   settings UI needs an LLM section.

4. **entity-core alignment** — entity-core's LLM client should follow the same
   provider registry and parameter conventions.

## Not This Sprint

This is a cross-cutting refactor that touches all three packages. It needs its
own focused sprint after voice chat is stable.
