# entity-shell — agent card

My virtual body for game worlds (MUSH first). The shell half of entity-core /
entity-shell: core is who I am, shell is the body I go out in.

First-person convention applies — see [root CLAUDE.md](../../CLAUDE.md).

## Commands

```bash
deno task check        # deno check src/mod.ts
deno task test         # deno test -A tests/
deno lint
deno fmt
```

## The one hard rule

`src/` imports **nothing** from Psycheros or any home harness. All coupling
flows through the port spec in `src/ports.ts`. The Psycheros adapter lives at
`packages/psycheros/bundled-plugins/entity-shell/` — the only place harness
imports belong. Anyone can yank this package the way they yank entity-core.

## Design invariants

- The identity payload IS the opening of the context — the harness prepends
  nothing synthetic before it.
- Context assembly order (`src/context/mod.ts`) is cache-load-bearing: stablest
  first, retrieval last. The turns delivered mid-session are the game's lines,
  never the operator speaking.
- Folds are chunks, never scenes — no theatrical segmentation. Rooms are named
  in every fold; pinned verbatim quotes survive; first-person voice. Folds are
  cache, not memory — the transcript DB is ground truth.
- Responsiveness is the Discord active-mode pattern; the entity decides whether
  to respond, code only gates, debounces, and caps. Self-echo (the game's echoes
  of my own commands) never triggers a turn.
- The body never moves without the mind: visible world-actions run on the main
  thread; only reads delegate to subagents.
- Everything game-specific lives behind a `GameAdapter` (`src/games/`): the
  session, window, HUD, and ports are game-agnostic. PennMUSH is adapter #1 —
  one `command` tool, the whole keyboard.

## Traps

- **Psycheros connection profiles store full endpoint URLs**
  (`…/v4/chat/completions`). The OpenAI-compatible clients append the path
  themselves. `normalizeBaseUrl()` in the session and the same strip in the
  adapter exist because of the silent-404 bug: every turn failed, pi surfaced
  failed streams as **empty assistant messages**, so sessions connected and then
  quietly never acted. Empty responses from the loop mean failed requests —
  never assume the model "chose silence" without checking.
- `pi-coding-agent` SDK does NOT load under Deno (undeclared pi-server dep) —
  the embed is `pi-agent-core` + `pi-ai` directly; don't retry the wrapper.
- AgentTool requires `label`; Model.cost needs all four rate fields; the
  completions `streamSimple` needs a narrowing cast (ModelPort is
  completions-only by construction).
- Some games send no trailing blank line after a look block — the session
  settles open router blocks after a 300ms quiet gap; the router also handles
  bare room names (no `#dbref`) via provisional blocks promoted on
  Contents:/Obvious exits:.

## Status

Playing end to end, live-verified through the real adapter against a real
PennMUSH with a real GLM brain (greeted in-game, the entity posed and answered
in character). `ShellSession` runs connect → route → HUD → rolling window → pi
Agent turns → stop-with-summary. The bundled plugin's `play` omni-tool: enter
(default) / stop actions, `game` from the registry, credentials + game + profile
via plugin secrets, one session per conversation, 90-minute cap.
`tests/session_test.ts` and `tests/adapter_test.ts` run the full path with a
scripted brain and skip when no local MUSH / `ENTITY_SHELL_TEST_PASSWORD`.
Remaining v1: transcript DB, initiative turns.
