# entity-shell

My virtual body for hanging out in game worlds — a MUSH first, other worlds
later. entity-shell is the shell half of the pair with
[entity-core](../entity-core/): **core is who I am, shell is the body I go out
in.**

This package is the **suit**, harness-agnostic by construction — it imports
nothing from Psycheros. A home harness plugs an entity in through the port spec
in [`src/ports.ts`](src/ports.ts): identity, model, retrieval, session context,
bridged tools, credentials, events. Optimized for Psycheros, but any companion
harness can implement the same couplings.

## Playing from Psycheros

The bundled plugin at `packages/psycheros/bundled-plugins/entity-shell/`
registers the `play` tool: plain `play` enters the configured game (the session
runs alongside the conversation), `play({action: "stop"})` leaves and returns
the session summary, and `play({game: "…"})` picks from the game registry
(`src/games/` — PennMUSH is adapter #1, with a single `command` tool: any game
command, as if typed).

Configure per install via plugin secrets —
`<dataRoot>/.psycheros/plugin-secrets/entity-shell.env`:

```dotenv
PSYCHEROS_PLUGIN_ENTITY_SHELL_USER=CharacterName
PSYCHEROS_PLUGIN_ENTITY_SHELL_PASSWORD=…
# optional:
PSYCHEROS_PLUGIN_ENTITY_SHELL_HOST=127.0.0.1
PSYCHEROS_PLUGIN_ENTITY_SHELL_PORT=4201
PSYCHEROS_PLUGIN_ENTITY_SHELL_NAME=EntityDisplayName
PSYCHEROS_PLUGIN_ENTITY_SHELL_GAME=pennmush
PSYCHEROS_PLUGIN_ENTITY_SHELL_PROFILE=Some Connection Profile
PSYCHEROS_PLUGIN_ENTITY_SHELL_DEBOUNCE_MS=5000   # quiet time before game lines become one turn
```

Identity comes from the install's own identity directory; the brain is any
Psycheros connection profile (`PROFILE` by id or name, else the active profile).
Sessions cap at 90 minutes and stop cleanly with a summary; restarting the
daemon ends any live session.

## Standalone play

```bash
SHELL_LLM_BASE_URL=… SHELL_LLM_API_KEY=… SHELL_LLM_MODEL=glm-4.7 \
  deno run -A scripts/play.ts --user <name> --pass <pw> --minutes 5 --verbose 1
```

Design and build state: [`docs/design.md`](docs/design.md). Remaining v1:
transcript DB, initiative turns.
