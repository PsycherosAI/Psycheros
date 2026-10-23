# Context assembly — the baseline turn builder

> **This is the source of truth for how a Psycheros turn's context is assembled,
> unless explicitly specified otherwise. No new turn type gets built that
> doesn't compose this kit.** New context sections slot in via the placement
> rubric below — they never get their own assembly. (Owner's ruling,
> 2026-09-26.)

The code is [`src/entity/turn-context.ts`](../src/entity/turn-context.ts):
`buildStableCore` + `buildDynamicBlock` (+ `buildSituationalAwareness`). Classic
EntityTurn composes it per turn; the Flux session composes it per generation
(stable prefix + dynamic late block); voice and Discord ride EntityTurn with
their mode blocks. The old 15-parameter `buildSystemMessage` is gone —
`context.ts` reduces to a stable+dynamic renderer for the leading-message shape.

## The canonical order

**Stable core** — byte-identical across turns; the prompt-cache anchor. Nothing
volatile may live here.

1. Base instructions (`identity/self/base_instructions.md`, MCP-canonical)
2. Identity files: self → user → relationship → custom
3. Image-gen anchors (capability list — changes rarely)

**Dynamic block** — assembled last, ordered by escalating recency:

4. **The RAG layer** (all retrieved knowledge, query-triggered): lorebook
   triggers → vault → memories → chat RAG → graph
5. **Live State** — the situational-awareness block (time, conversation, last
   user message, devices, wearables). Environmental fact only.
6. **The active working set** — held skills, then plugin prompt-hooks.
7. **The mode block** — LAST, closest to generation: the per-mode behavioral
   frame. Flux's presence framing + mood/mode snapshots, Discord channel
   context, the self-initiated/Pulse directive.

The principle in one line: **facts get less provisional, instructions get more
binding, as you descend.**

## Placement: regular vs cache-friendly

Cache-friendliness is a _model_ property — the choice lives on the LLM
connection profile (`contextStyle`), not in global settings.

- **regular** (default): stable core + dynamic block render as one leading
  system message, before history. Works everywhere.
- **cache-friendly**: the leading system message is the stable core alone; the
  dynamic block is emitted as a **trailing system message after the history and
  the current user message**. Everything before it is byte-identical across
  turns, so providers that cache prompts reuse the whole prefix. Only for
  providers that accept system messages after user messages — some ignore or
  garble them, which is exactly why this is opt-in per profile.

The user message precedes the dynamic block in cache-friendly mode because the
RAG layer needs it as the retrieval query.

## The placement rubric — where does a new block go?

- **Does it change per turn/generation?** → the dynamic block. **Is it identity
  or capability that rarely changes?** → the stable core. (Byte-stability is the
  cache anchor — anything volatile placed there defeats the gradient for
  everyone.)
- Within the dynamic block, ask what it _is_:
  - **Retrieved knowledge** — anything query-triggered, from any store (a new
    RAG source, a new trigger system) → **the RAG layer**.
  - **Environmental fact** — time, location, devices, sensors, where the user
    was → **Live State**.
  - **Active working set or injected instruction** — held content the entity is
    working with, third-party prompt injections → **the held-skills/plugins
    slot**.
  - **Behavioral framing for how to be right now** — mode voices, directives,
    per-turn state the entity reads as itself → **the mode block, last**.

One kit, two callers, no third assembly. If a change touches what the entity
sees in context, it lands here — verify with the Context Inspector before and
after.
