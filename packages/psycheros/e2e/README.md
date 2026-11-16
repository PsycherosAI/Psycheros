# Accessibility browser specs

Opt-in Playwright checks for the interaction issues a source-level test cannot
see: focus movement, tab order, and target size. They live outside `deno test`
on purpose, mirroring `packages/launcher-v2/e2e/`, so CI stays unchanged.

`disclosure_keyboard.e2e.mjs` verifies that Enter and Space operate disclosure
buttons while keeping their expanded state synchronized.

The `*.e2e.mjs` suffix keeps `deno test` from collecting these files.

## Prerequisites

- A running dev server on `http://127.0.0.1:3000`. Prefer a scratch data root so
  a spec cannot write conversations or graph nodes into the checkout:

  ```bash
  PSYCHEROS_PORT=3000 PSYCHEROS_DATA_DIR=/tmp/<scratch> \
    PSYCHEROS_ENTITY_CORE_DATA_DIR=/tmp/<scratch>/entity-core deno task start
  ```

  Stop it by port (`fuser -k -INT -n tcp 3000`). `deno task stop` signals every
  running `deno.*main.ts`, so it is an awkward way to stop just this server.
- Playwright Chromium. Install the browser once, then run the suite from
  `packages/psycheros/`:

  ```bash
  npx playwright install chromium
  deno task test:e2e
  ```

  `run.mjs` is a plain script, so it also runs under `node e2e/run.mjs` where
  Playwright is installed globally. Pass `CONV=<id>` for a populated
  conversation.

## Environment

- `BASE_URL` (default `http://127.0.0.1:3000`) - the server under test.
- `CONV` (optional) - a conversation id; tests that need messages or the graph
  toggle should point at a populated conversation.

## Specs

- `skip_link.e2e.mjs` - the skip link is the first tab stop and targets `#main`.
- `focus_modal.e2e.mjs` - the delete dialog is labelled/modal, traps Tab, and
  restores focus on Escape.
- `focus_hidden_panels.e2e.mjs` - the closed sidebar and graph node panel are
  `inert`, so Tab never reaches them.
- `graph_keyboard.e2e.mjs` - every filtered graph node is reachable, card focus
  survives rerenders, and List/Network state is exposed.
- `target_size.e2e.mjs` - icon-only controls meet 24x24 (2.5.8).
- `voice_modal.e2e.mjs` - the voice call owns focus and Escape dismissal even
  when an old push-to-talk setting bound Escape.
- `whats_new_modal.e2e.mjs` - the What's New splash is a labelled modal that
  traps Tab, closes on Escape, restores its opener, and inerts the app.
- `tts_keyboard.e2e.mjs` - Test TTS keeps focus and announces its result, and
  adding or removing pronunciation and correction rows preserves focus.

`run.mjs` runs them all in sequence. Each prints an `ok`/`FAIL` line per check
and exits non-zero on failure.

## Manual checks

These cannot be asserted from a bounding box and stay manual:

- 2.4.11 Focus Not Obscured (Minimum) - a focused control must not be fully
  hidden by sticky headers or the on-screen keyboard.
- Forced-colors focus (base.css has a `CanvasText` outline fallback) - verify
  under a Windows high-contrast / `forced-colors: active` theme.
- Real screen-reader passes (VoiceOver, NVDA) for the transient status
  announcements and the chat transcript live region.

## Policy

A failure here is a finding: fix it in place when the change is small and in
scope, and otherwise note it in the issue or PR that adds the spec.
