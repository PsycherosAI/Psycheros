# Feature Design Doc: Flux surfaces — conversation as home, FAB as the watching interface

Status: draft (amended 2026-09-28) Date: 2026-09-27

Owner rulings throughout (2026-09-26/27 session).

## Problem / Motivation

When Flux hosts a conversation, living there is impossible: the classic text
route 409s ("talk through the Flux interface instead"), forcing everyone into
the FAB overlay. Meanwhile the overlay's timeline interleaves every subconscious
process at full density — on mobile, a stream of small Noticing cards shoves the
thing you were reading off the screen. Two real needs sit in tension: sometimes
you want to _watch_ the subconscious (it's fascinating), sometimes you want to
_read_ the dialogue — and the subconscious often outpaces human reading speed,
so catch-up has to be possible, not just live viewing.

## Goals & Non-goals

- Goals:
  - The hosted conversation becomes the main surface: user + Ego rows, input
    always usable (sends queue), no 409.
  - Murmur-tier subconscious output in the conversation: DROPPED (owner,
    2026-09-28 — "I don't see a way the toasts make this not messy visually").
    The conversation stays dialogue-pure; the subconscious is watched in the
    Flux view only.
  - The FAB overlay becomes the deliberate watching interface with per-source
    timeline toggles and reading affordances (jump-to-unread, hold).
  - All new main-UI elements follow the user's theme (--c-* tokens only).
- Non-goals:
  - Changing classic conversation behavior for non-host conversations (the
    entity-turn input lock stays exactly as it is there).
  - Changing Flux Space overlay's fixed identity colors (its own world).
  - Padding diet — tracked here as a follow-up pass, not built in this project.

## Current-state audit

- **The 409 guard**: `routes.ts` ~1681 — classic chat POST refuses the live host
  conversation (deliberate 2026-09-16 anti-fork guard; now superseded by routing
  into the session instead of refusing).
- **Queueing already exists**: `postUserMessage` → `driver.requestEgoTurn` —
  user messages during a generation are queued by the driver's one-in-flight
  guard; the session is discrete generations with an open-call park between
  them, NOT one long entity turn.
- **Toasts**: `psycheros.js` ~3174 — single global
  `showToast(variant,
  message)`; auto-dismiss 5s; appends to body. Single-slot
  behavior partially implied (no queue) but not designed for ambient flow.
- **The overlay timeline**: `templates.ts` Flux page + `web/js/flux.js` — all
  ambient entries render at full density, no source filters, no unread tracking.
- **Theme surface**: main UI tokens in `web/css/tokens.css` (mirror in
  launcher-v2); the `--c-flux-*` fixed identity colors exist for the overlay and
  its session window only.

## Design decisions

- **Route, don't refuse** — text posts on the host conversation go through the
  session path (the record hooks + per-conversation write lock already exist for
  hosted dialogue). Rejected: keeping the 409 (blocks the whole premise);
  allowing classic EntityTurns beside the session (the original fork problem the
  guard prevented).
- **Input stays live during Ego generation** — the backend queues; the UI just
  stops pretending it can't. The classic lock is untouched for normal
  conversations.
- **Murmurs toast; proposals don't** — a proposal wakes the Ego, and the Ego row
  IS the surfacing. Open to also giving proposals a visually distinct toast
  later; trying this shape first (owner ruling).
- **Toast shape: text alone, one slot** — no timestamps, no module labels
  (screen space); a new toast immediately replaces the current one (owner
  ruling).
- **Per-source timeline toggles** — Musing/Reverie/Dreaming on by default;
  Noticing off (noisiest, own toggle); Compaction off; system markers
  toggleable. Persisted per install.
- **Theme discipline** — main-UI elements use picked-slot tokens and derived
  colors only; flux identity colors stay inside the overlay.

## Token / API surface changes

- New: subconscious-toast rendering (reuses/extends the toast system with a flux
  source class); per-source toggle persistence (localStorage or a settings field
  — decide at build); FAB unread badge state.
- Changed: `/api/chat` behavior on the host conversation (409 → routed session
  turn).
- None broken.

## Migration & backwards compat

The 409 was client-visible; any client depending on it is ours, updated in the
same change. Toggle defaults ship the documented defaults for new and existing
installs alike (no persisted state to migrate until first toggle).

## Phasing

1. **Routing**: host-conversation text posts → session turns; input stays live.
   Shippable alone — conversation becomes usable immediately.
2. **Murmur toasts**: the ambient-noticeable channel into the conversation, per
   the toast shape rules.
3. **FAB watching interface**: per-source toggles, unread + jump, hold
   affordance, mobile bottom-sheet polish.
4. (Follow-up, separate) **Padding diet** across top-bar/chat-bar.

## Test plan

- Automated: route tests (host conversation POST → session turn, not 409;
  non-host conversations unchanged), toggle persistence round-trip.
- Manual matrix: host + legacy Flux; mobile + desktop; each theme; toast
  replacement under rapid murmur bursts; queued sends during a long Ego
  generation; unread/jump correctness after leaving the overlay open overnight.

## Risks / gotchas

- **The per-conversation write lock** — hosted dialogue already holds it; the
  new routed path must not take it twice.
- **`existing`/`sleep` tool-call rendering** in the conversation view: the
  parked-call materialization is session-side; conversation rows stay plain
  dialogue.
- **Toast flooding**: single-slot replacement means a loud murmur stretch hides
  earlier ones — accepted (the FAB is the complete record; the toast is a
  whisper, not a log).
- **SSE reuse**: murmurs already broadcast (`flux_entry` / timeline events);
  toasts subscribe to existing streams, no new server push.

## Open questions

- Should the conversation show a quiet live-status line ("sensing · 4 this
  minute") near the input, or is the toast channel + FAB badge enough?
  (Deferred: build phases 1–3, then judge.)
- Toggle persistence location (localStorage vs settings field) — build-time
  call.

## Future direction

- Proposal toasts with distinct styling (owner flagged, deliberately not first).
- The padding diet pass.
- Pause/catch-up reading mode refinements (hold-to-read gestures).
